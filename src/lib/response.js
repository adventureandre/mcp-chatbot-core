import { logger } from './logger.js'

/**
 * Helpers de resposta MCP. Todas as tools devolvem texto (`content[0].type ===
 * 'text'`) com JSON dentro — a IA parseia o JSON e decide o que fazer.
 */

function txt(text) {
  return { content: [{ type: 'text', text }] }
}

function jsonTxt(obj) {
  return txt(JSON.stringify(obj, null, 2))
}

/**
 * Sucesso padronizado. `data` vai direto pra raiz pra IA achar sem aninhar.
 */
export function ok(data = {}) {
  return jsonTxt({ success: true, ...data })
}

/**
 * Erro padronizado.
 *
 *  - `code`: string estavel pra IA poder se preparar pra falha (ex:
 *    REDIS_DOWN, INVALID_KEY, MISSING_TARGET). NUNCA use a mensagem
 *    interna do exception aqui — coloca um valor que faca parte de um
 *    enum.
 *  - `message`: texto human-readable pra IA explicar pro usuario.
 *  - `retryable`: se a IA pode tentar de novo (default true pra IO).
 *  - `details`: extras pra debug — vai no log mas nao na resposta.
 */
export function fail(code, message, opts = {}) {
  const { retryable = true, details, toolName } = opts
  logger.warn('tool_failed', { code, toolName, details })
  return jsonTxt({
    success: false,
    error: { code, message, retryable },
  })
}

/**
 * Wrapper que captura excecoes inesperadas e devolve fail() generico
 * sem vazar stack pro modelo.
 */
export async function runTool(toolName, fn) {
  const startedAt = Date.now()
  try {
    const result = await fn()
    logger.info('tool_ok', { toolName, durationMs: Date.now() - startedAt })
    return result
  } catch (err) {
    logger.error('tool_uncaught', {
      toolName,
      durationMs: Date.now() - startedAt,
      err: err.message,
      stack: err.stack,
    })
    return fail('INTERNAL_ERROR', `Erro interno em ${toolName}. Tente de novo em alguns segundos.`, {
      toolName,
      retryable: true,
      details: { message: err.message },
    })
  }
}
