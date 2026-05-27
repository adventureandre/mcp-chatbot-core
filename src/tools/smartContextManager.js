import { z } from 'zod'
import { getRedis, withCommandTimeout } from '../lib/redis.js'
import { ok, fail, runTool } from '../lib/response.js'

/**
 * Detector heuristico de pedido de reset de contexto.
 *
 * SMELL: hoje esse tool toca direto na key `openai:thread:{userId}` que
 * pertence ao thread storage interno do Aurora. Se o Aurora renomear
 * essa key, a feature quebra silenciosamente. Idealmente a IA chamaria
 * um endpoint dedicado do Aurora ("conversation reset") em vez de um MCP
 * mexer no storage interno. Mantido aqui por compatibilidade — mover na
 * proxima onda de refator.
 */

const description =
  'Detecta se o usuario quer ZERAR o contexto da conversa (pedidos como ' +
  '"esquece tudo", "limpa conversa", "vamos comecar do zero", "mudando de assunto"). ' +
  'Chame ANTES de responder quando suspeitar dessa intencao. Se confirmar, limpa o ' +
  'historico e a proxima mensagem comeca do zero. ' +
  'NAO chame em todas as mensagens — so quando o texto sugerir reset explicito ou ' +
  'mudanca clara de topico.'

const explicitClearIndicators = [
  'esqueca isso', 'esquece isso', 'esqueca tudo', 'esquece tudo',
  'limpa conversa', 'limpe a conversa', 'limpar conversa', 'limpar historico',
  'zerar conversa', 'resetar conversa', 'comecar de novo', 'comecar do zero',
  'recomecar conversa', 'nova conversa',
]

const topicChangeIndicators = [
  'mudando de assunto', 'mudar de assunto', 'novo assunto',
  'outro assunto', 'deixa pra la', 'nao importa', 'vamos falar de outra coisa',
]

// Mensagens que sugerem um workflow EM ANDAMENTO — nesses casos NUNCA
// limpamos o contexto, mesmo que apareca alguma palavra ambigua.
const activeWorkflowIndicators = [
  'oferta', 'ofertas', 'criar', 'criando', 'registro', 'registrar',
  'confirma', 'confirmar', 'prosseguir', 'continuar', 'proximo', 'proxima',
  'aguarde', 'processando', 'analisando',
]

function matchAny(text, list) {
  for (const ind of list) if (text.includes(ind)) return ind
  return null
}

const inputSchema = {
  userId: z
    .string()
    .min(1)
    .max(256)
    .describe('Identificador do usuario na conversa (chatId WhatsApp ou userId interno)'),
  currentMessage: z
    .string()
    .min(1)
    .max(10000)
    .describe('Mensagem atual do usuario — usada pra detectar intencao de reset'),
}

async function handler({ userId, currentMessage }) {
  return runTool('smartContextManager', async () => {
    const text = currentMessage.toLowerCase()

    const activeMatch = matchAny(text, activeWorkflowIndicators)
    if (activeMatch) {
      return ok({
        action: 'keep_context',
        reason: `workflow ativo: "${activeMatch}"`,
      })
    }

    const explicitMatch = matchAny(text, explicitClearIndicators)
    const topicMatch = explicitMatch ? null : matchAny(text, topicChangeIndicators)

    if (!explicitMatch && !topicMatch) {
      return ok({
        action: 'keep_context',
        reason: 'sem indicador de mudanca',
      })
    }

    let redis
    try {
      redis = await getRedis()
    } catch (err) {
      return fail('REDIS_UNAVAILABLE',
        'Nao consegui acessar o storage de conversa pra limpar. Tente de novo em alguns segundos.',
        { toolName: 'smartContextManager', retryable: true, details: { err: err.message } },
      )
    }

    const threadKey = `openai:thread:${userId}`
    try {
      await withCommandTimeout(redis.del(threadKey), 'del')
    } catch (err) {
      return fail('REDIS_TIMEOUT',
        'Timeout ao limpar contexto.',
        { toolName: 'smartContextManager', retryable: true, details: { err: err.message } },
      )
    }

    return ok({
      action: 'context_cleared',
      reason: explicitMatch ? `solicitacao explicita: "${explicitMatch}"` : `mudanca de topico: "${topicMatch}"`,
      message: 'Contexto limpo — proxima resposta comeca do zero.',
    })
  })
}

export const smartContextManager = {
  name: 'smartContextManager',
  description,
  inputSchema,
  handler,
}
