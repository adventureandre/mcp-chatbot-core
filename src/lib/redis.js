import { createClient } from 'redis'
import { config } from '../config.js'
import { logger } from './logger.js'

/**
 * Singleton de Redis com:
 *  - lazy connect (so conecta no primeiro uso)
 *  - lock pra evitar race de duas tools conectando em paralelo
 *  - reconnect automatico do client SDK (backoff exponencial)
 *  - timeout curto na primeira conexao pra falhar rapido (3s) — o MCP
 *    nao pode segurar a IA por 30s esperando Redis morto
 *  - timeout por comando (2s) pra evitar travas em runtime
 *  - shutdown limpo (quit) chamado pelo entrypoint em SIGTERM/SIGINT
 *
 * Quando Redis cai e volta, o client SDK reconecta sozinho. A diferenca
 * versao antiga: agora um command durante a queda falha em 2s em vez de
 * pendurar pra sempre.
 */

let client = null
let connectingPromise = null

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Redis ${label} timeout (${ms}ms)`))
    }, ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

async function connect() {
  const c = createClient({
    url: config.redis.url,
    socket: {
      connectTimeout: config.redis.connectTimeoutMs,
      // reconnectStrategy: backoff capado em 5s — evita storm e nao desiste.
      reconnectStrategy: (attempts) => Math.min(50 * Math.pow(2, attempts), 5000),
    },
  })

  c.on('error', (err) => {
    // O cliente emite 'error' por reconnect failure tambem — logamos mas
    // nao crasheamos. Comandos posteriores vao falhar com timeout proprio.
    logger.warn('redis_client_error', { err: err.message })
  })
  c.on('reconnecting', () => logger.info('redis_reconnecting'))
  c.on('ready', () => logger.info('redis_ready'))

  await withTimeout(c.connect(), config.redis.connectTimeoutMs, 'connect')
  return c
}

/**
 * Devolve o client. Conecta na primeira chamada; subsequentes reusam.
 * Se a conexao falhar, descarta o client e tenta de novo na proxima
 * chamada (evita ficar preso a um client morto pra sempre).
 */
export async function getRedis() {
  if (client?.isOpen) return client
  if (connectingPromise) return connectingPromise

  connectingPromise = (async () => {
    try {
      client = await connect()
      return client
    } catch (err) {
      client = null
      throw err
    } finally {
      connectingPromise = null
    }
  })()

  return connectingPromise
}

/**
 * Wrapper de comando com timeout. Use em vez de chamar r.get/set direto
 * pra garantir que um Redis lento nao trava o MCP por 30s.
 */
export function withCommandTimeout(promise, label) {
  return withTimeout(promise, config.redis.commandTimeoutMs, label)
}

export async function closeRedis() {
  if (!client) return
  try {
    await client.quit()
    logger.info('redis_closed')
  } catch (err) {
    logger.warn('redis_close_error', { err: err.message })
  } finally {
    client = null
  }
}
