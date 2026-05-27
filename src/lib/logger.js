/**
 * Logger JSONL pra stderr.
 *
 * Stdout e o canal do MCP STDIO transport — qualquer caractere fora do
 * protocolo quebra a comunicacao com o cliente. Por isso TUDO vai pra
 * stderr (que o Aurora captura nos logs separadamente).
 *
 * Formato JSONL e o que o Aurora consegue parsear no log aggregator;
 * texto livre vira ruido.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const minLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info

function emit(level, msg, ctx) {
  if (LEVELS[level] < minLevel) return
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'mcp-chatbot-core',
    msg,
    ...(ctx ?? {}),
  }
  // Stringify defensivo — context com referencias circulares nao quebra o log.
  let line
  try {
    line = JSON.stringify(entry)
  } catch {
    line = JSON.stringify({ ...entry, _ctxError: 'serialization_failed' })
  }
  process.stderr.write(line + '\n')
}

export const logger = {
  debug: (msg, ctx) => emit('debug', msg, ctx),
  info: (msg, ctx) => emit('info', msg, ctx),
  warn: (msg, ctx) => emit('warn', msg, ctx),
  error: (msg, ctx) => emit('error', msg, ctx),
}
