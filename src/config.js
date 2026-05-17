/**
 * Config do MCP. Le env vars uma vez no boot, valida tipos basicos e
 * congela o objeto pra impedir mutacao acidental em tempo de runtime.
 */

function requireString(name, fallback) {
  const v = process.env[name]
  if (typeof v === 'string' && v.length > 0) return v
  if (fallback !== undefined) return fallback
  throw new Error(`[CONFIG] env ${name} obrigatoria nao definida`)
}

function readInt(name, fallback) {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) {
    throw new Error(`[CONFIG] env ${name} deve ser numero, recebido: ${v}`)
  }
  return n
}

export const config = Object.freeze({
  redis: {
    url: requireString('REDIS_URL', 'redis://localhost:6379'),
    // Timeout curto pra falhar rapido se Redis estiver indisponivel — o
    // MCP nao deve segurar a IA por 30s esperando.
    connectTimeoutMs: readInt('REDIS_CONNECT_TIMEOUT_MS', 3000),
    commandTimeoutMs: readInt('REDIS_COMMAND_TIMEOUT_MS', 2000),
  },
  waha: {
    baseUrl: requireString('WAHA_BASE_URL', 'http://localhost:3000'),
    session: requireString('WAHA_SESSION', 'default'),
    apiKey: process.env.WAHA_API_KEY || '',
    timeoutMs: readInt('WAHA_TIMEOUT_MS', 10000),
  },
  // Limites de payload pra evitar abuso/JSON-bomb via tool args.
  limits: {
    keyMaxLength: readInt('TEMP_KEY_MAX_LENGTH', 128),
    dataMaxBytes: readInt('TEMP_DATA_MAX_BYTES', 64 * 1024), // 64 KB
    ttlMaxSeconds: readInt('TEMP_TTL_MAX_SECONDS', 24 * 60 * 60), // 24h
    ttlDefaultSeconds: readInt('TEMP_TTL_DEFAULT_SECONDS', 3600), // 1h
    messageMaxLength: readInt('WAHA_MESSAGE_MAX_LENGTH', 4096),
  },
})
