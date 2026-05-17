import { z } from 'zod'
import { getRedis, withCommandTimeout } from '../lib/redis.js'
import { ok, fail, runTool } from '../lib/response.js'
import { config } from '../config.js'

const description =
  'Bloco de notas TEMPORARIO pra voce usar como "TODO list" durante tarefas longas ou ' +
  'multi-etapa. Use para registrar o que ja fez, o que falta, dados parciais coletados ' +
  'entre tool calls. Voce mesma le de volta com getTemporaryData no proximo passo pra ' +
  'continuar de onde parou. ' +
  '\n\n' +
  'EXEMPLOS de uso correto: ' +
  '\n - carrinho/pedido em construcao antes do usuario confirmar ' +
  '\n - lista de etapas de um fluxo: [{id:1,what:"consultar DB",done:true}, {id:2,what:"enviar email",done:false}] ' +
  '\n - IDs/resultados parciais coletados de tools que ainda vao ser usados ' +
  '\n - rascunho que sera revisado antes do envio final ' +
  '\n\n' +
  'NAO use para: ' +
  '\n - fatos duraveis sobre o usuario (preferencias, perfil) → memoria de longo prazo ' +
  '\n - log/auditoria de acoes ' +
  '\n - dados que precisam sobreviver mais de 24h ' +
  '\n\n' +
  'Sobrescrever a mesma chave atualiza o conteudo (util pra marcar etapa concluida). ' +
  'TTL default: 1h.'

// Restringe a key pra prefixo seguro (evita colisao com outras namespaces
// do Redis: thread, ratelimit, etc).
const KEY_REGEX = /^[a-z0-9][a-z0-9_:-]*$/i

const inputSchema = {
  key: z
    .string()
    .min(1)
    .max(config.limits.keyMaxLength)
    .regex(KEY_REGEX, 'key deve ser alfanumerica (_ - : permitidos)')
    .describe(
      'Chave descritiva da sua memoria temporaria. Ex: "carrinho_user_5562", "etapas_pedido_42"',
    ),
  data: z
    .union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.any()), z.record(z.any())])
    .describe('Conteudo a salvar — qualquer JSON serializavel'),
  ttl: z
    .number()
    .int()
    .min(1)
    .max(config.limits.ttlMaxSeconds)
    .optional()
    .default(config.limits.ttlDefaultSeconds)
    .describe(
      `Tempo de vida em segundos. Default ${config.limits.ttlDefaultSeconds} (1h). ` +
      `Max ${config.limits.ttlMaxSeconds} (24h). ` +
      'AJUSTE pra cima se voce sabe que a tarefa e longa (ex: ttl=14400 pra 4h, ' +
      'ttl=43200 pra 12h, ttl=86400 pra 24h). ' +
      'Re-salvar a mesma chave RESETA o TTL pra o novo valor — use isso pra estender ' +
      'durante uma tarefa em andamento.',
    ),
}

async function handler({ key, data, ttl }) {
  return runTool('saveTemporaryData', async () => {
    // Limite de payload pra evitar JSON-bomba/explosao de memoria Redis.
    const payload = JSON.stringify({
      data,
      savedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    })
    if (Buffer.byteLength(payload, 'utf8') > config.limits.dataMaxBytes) {
      return fail('PAYLOAD_TOO_LARGE',
        `Dados excedem o limite de ${config.limits.dataMaxBytes} bytes. Divida em chaves menores.`,
        { toolName: 'saveTemporaryData', retryable: false },
      )
    }

    let redis
    try {
      redis = await getRedis()
    } catch (err) {
      return fail('REDIS_UNAVAILABLE',
        'Armazenamento temporario indisponivel agora. Tente novamente em alguns segundos ou explique pro usuario que voce nao consegue salvar a memoria temporaria.',
        { toolName: 'saveTemporaryData', retryable: true, details: { err: err.message } },
      )
    }

    const redisKey = `temp:${key}`
    try {
      await withCommandTimeout(redis.setEx(redisKey, ttl, payload), 'setEx')
    } catch (err) {
      return fail('REDIS_TIMEOUT',
        'Timeout ao salvar — o Redis demorou demais. Tente novamente.',
        { toolName: 'saveTemporaryData', retryable: true, details: { err: err.message } },
      )
    }

    return ok({
      key,
      ttlSeconds: ttl,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      message: `Dados salvos em "${key}" por ${Math.round(ttl / 60)} minutos`,
    })
  })
}

export const saveTemporaryData = { name: 'saveTemporaryData', description, inputSchema, handler }
