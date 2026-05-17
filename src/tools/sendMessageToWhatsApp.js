import { z } from 'zod'
import { wahaClient, toChatId } from '../lib/waha.js'
import { getRedis, withCommandTimeout } from '../lib/redis.js'
import { logger } from '../lib/logger.js'
import { ok, fail, runTool } from '../lib/response.js'
import { config } from '../config.js'

const description =
  'Envia uma mensagem de texto para um numero de WhatsApp via WAHA. ' +
  'Use quando o usuario pedir explicitamente para mandar mensagem pra outra pessoa, ' +
  'ou quando o fluxo da IA exigir notificar terceiros. ' +
  'NAO use para responder ao proprio usuario na conversa atual — isso e feito ' +
  'automaticamente pelo retorno do chat.'

const inputSchema = {
  phoneNumber: z
    .string()
    .min(1)
    .optional()
    .describe('Numero ou chatId do destinatario. Ex: "5562999540017" ou "5562999540017@c.us"'),
  to: z
    .string()
    .min(1)
    .optional()
    .describe('Alias de phoneNumber (compatibilidade). Prefira phoneNumber.'),
  message: z
    .string()
    .min(1)
    .max(config.limits.messageMaxLength)
    .describe('Texto da mensagem (max 4096 chars)'),
  mentions: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Lista de numeros pra mencionar (@) na mensagem'),
  context: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'Contexto opcional a anexar na thread do destinatario (visivel pra IA na proxima mensagem dele).',
    ),
}

/**
 * Best-effort: anexa marcadores na thread do destinatario pra IA ter
 * visibilidade do que foi enviado a ele.
 *
 * SMELL: o MCP nao deveria conhecer o formato interno do thread storage
 * do Aurora (`openai:thread:{chatId}`). Idealmente isso seria emitido
 * como evento e o Aurora consome do lado dele. Mantido aqui por
 * compatibilidade com o comportamento atual; mover quando refatorar o
 * pipeline de outbound messages.
 */
async function appendToRecipientThread(chatId, message, context) {
  try {
    const redis = await getRedis()
    const threadKey = `openai:thread:${chatId}`
    const raw = await withCommandTimeout(redis.get(threadKey), 'get')
    if (!raw) return // sem thread ativa — nada a anexar

    let thread
    try {
      thread = JSON.parse(raw)
    } catch {
      return // formato inesperado — ignora silenciosamente
    }
    if (!Array.isArray(thread?.messages)) return

    if (context) {
      thread.messages.push({ role: 'assistant', content: `[CONTEXTO PRINCIPAL]: ${context}` })
    }
    thread.messages.push({
      role: 'assistant',
      content: `[PRIMEIRA MENSAGEM DA AURORA]: ${message}`,
    })
    await withCommandTimeout(redis.set(threadKey, JSON.stringify(thread)), 'set')
    await withCommandTimeout(redis.expire(threadKey, 24 * 60 * 60), 'expire')
  } catch (err) {
    // Nao queremos que falha de thread-append derrube o envio bem-sucedido.
    logger.warn('thread_append_failed', { err: err.message, chatId })
  }
}

async function handler({ phoneNumber, to, message, mentions, context }) {
  return runTool('sendMessageToWhatsApp', async () => {
    const target = phoneNumber || to
    if (!target) {
      return fail('MISSING_TARGET',
        'phoneNumber ou to e obrigatorio.',
        { toolName: 'sendMessageToWhatsApp', retryable: false },
      )
    }

    const chatId = toChatId(target)
    const payload = {
      chatId,
      text: message,
      session: config.waha.session,
    }
    if (mentions && mentions.length > 0) {
      // WAHA espera lista de numeros sem @c.us
      payload.mentions = mentions.map((m) => m.replace(/@c\.us$/i, '').replace(/[^\d]/g, ''))
    }

    try {
      await wahaClient.post('/api/sendText', payload)
    } catch (err) {
      const status = err.response?.status
      const code =
        status === 401 ? 'WAHA_UNAUTHORIZED' :
        status === 404 ? 'WAHA_CHAT_NOT_FOUND' :
        status >= 500 ? 'WAHA_UPSTREAM_ERROR' :
        err.code === 'ECONNABORTED' ? 'WAHA_TIMEOUT' :
        err.code === 'ECONNREFUSED' ? 'WAHA_UNREACHABLE' :
        'WAHA_SEND_FAILED'
      const human = {
        WAHA_UNAUTHORIZED: 'Credenciais do WhatsApp invalidas — fale com o admin.',
        WAHA_CHAT_NOT_FOUND: 'Chat nao encontrado no WhatsApp.',
        WAHA_UPSTREAM_ERROR: 'WhatsApp instavel agora. Tente em alguns segundos.',
        WAHA_TIMEOUT: 'WhatsApp demorou a responder. Tente de novo.',
        WAHA_UNREACHABLE: 'WhatsApp offline no momento.',
        WAHA_SEND_FAILED: 'Nao consegui enviar a mensagem.',
      }[code]
      return fail(code, human, {
        toolName: 'sendMessageToWhatsApp',
        retryable: code !== 'WAHA_UNAUTHORIZED' && code !== 'WAHA_CHAT_NOT_FOUND',
        details: { status, err: err.message, chatId },
      })
    }

    // Best-effort: anexa na thread do destinatario (ver smell na helper).
    // Roda APOS o envio bem-sucedido — se falhar, nao reverte a mensagem.
    await appendToRecipientThread(chatId, message, context)

    return ok({
      message: 'Mensagem enviada com sucesso',
      chatId,
    })
  })
}

export const sendMessageToWhatsApp = {
  name: 'sendMessageToWhatsApp',
  description,
  inputSchema,
  handler,
}
