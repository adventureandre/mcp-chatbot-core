import { z } from 'zod'
import { getRedis, withCommandTimeout } from '../lib/redis.js'
import { ok, fail, runTool } from '../lib/response.js'
import { config } from '../config.js'

const description =
  'Le o bloco de notas temporario que voce salvou previamente com saveTemporaryData. ' +
  'Use no inicio de cada passo de uma tarefa longa pra checar o que ja foi feito antes ' +
  'de decidir o proximo passo, retomar um carrinho/rascunho, ou consultar dados parciais ' +
  'coletados antes. ' +
  '\n\n' +
  'Retorna `found=false` (mas success=true) se a chave nao existe ou expirou — nesse ' +
  'caso, assuma que precisa comecar a tarefa do zero.'

const KEY_REGEX = /^[a-z0-9][a-z0-9_:-]*$/i

const inputSchema = {
  key: z
    .string()
    .min(1)
    .max(config.limits.keyMaxLength)
    .regex(KEY_REGEX, 'key invalida')
    .describe('Mesma chave usada no saveTemporaryData'),
}

async function handler({ key }) {
  return runTool('getTemporaryData', async () => {
    let redis
    try {
      redis = await getRedis()
    } catch (err) {
      return fail('REDIS_UNAVAILABLE',
        'Armazenamento temporario indisponivel agora.',
        { toolName: 'getTemporaryData', retryable: true, details: { err: err.message } },
      )
    }

    const redisKey = `temp:${key}`
    let raw
    try {
      raw = await withCommandTimeout(redis.get(redisKey), 'get')
    } catch (err) {
      return fail('REDIS_TIMEOUT',
        'Timeout ao buscar dados — tente novamente.',
        { toolName: 'getTemporaryData', retryable: true, details: { err: err.message } },
      )
    }

    if (!raw) {
      return ok({
        found: false,
        message: `Nada encontrado para "${key}". Pode ter expirado ou nunca foi salvo.`,
      })
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      // Dado corrompido — apaga pra nao envenenar futuras leituras.
      await withCommandTimeout(redis.del(redisKey), 'del').catch(() => {})
      return fail('CORRUPTED_DATA',
        `Dados em "${key}" estavam corrompidos e foram descartados. Salve de novo se precisar.`,
        { toolName: 'getTemporaryData', retryable: false, details: { err: err.message } },
      )
    }

    return ok({
      found: true,
      key,
      data: parsed.data,
      savedAt: parsed.savedAt,
      expiresAt: parsed.expiresAt,
    })
  })
}

export const getTemporaryData = { name: 'getTemporaryData', description, inputSchema, handler }
