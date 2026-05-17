import { z } from 'zod'
import { getRedis, withCommandTimeout } from '../lib/redis.js'
import { ok, fail, runTool } from '../lib/response.js'
import { config } from '../config.js'

const description =
  'Bloco de notas TEMPORARIO em key/value (Redis-backed, TTL configuravel) pra voce ' +
  'rastrear estado QUE EVOLUI ao longo da conversa ou entre tool calls. ' +
  '\n\n' +
  'USE sempre que coletar/agregar informacao em PEDACOS que precisarao ser usadas ou ' +
  'confirmadas em turnos subsequentes — independente do dominio. Domain-agnostic. ' +
  '\n\n' +
  'CENARIOS GENERICOS de uso (mapeie pra qualquer dominio): ' +
  '\n - Estado em CONSTRUCAO multi-turno: o usuario fornece informacao em pedacos ' +
  '   (pedido/carrinho/agendamento/formulario/cadastro/orcamento/levantamento). ' +
  '\n - TODO LIST das suas tarefas longas: checklist de etapas com flag done/pending. ' +
  '\n - RESULTADOS PARCIAIS de tool calls que serao agregados na resposta final. ' +
  '\n - RASCUNHOS que serao revisados ou confirmados antes de uma acao definitiva. ' +
  '\n\n' +
  'PADRAO MULTI-TURNO (independe de dominio): ' +
  '\n 1. Usuario fornece um pedaco de info -> SAVE com estado completo ate aqui. ' +
  '\n 2. Usuario altera/adiciona/remove -> SAVE de novo (sobrescreve, atualiza TTL). ' +
  '\n 3. Antes de confirmar/resumir/processar -> chame getTemporaryData pra ler exato. ' +
  '\n 4. Acao final concluida -> deixe expirar OU sobrescreva com status final. ' +
  '\n\n' +
  'CONVENCAO DE CHAVE recomendada: combine um proposito + identificador unico do ' +
  'contexto. Ex: "<proposito>_<userId>" ou "<proposito>_<sessionId>". Garante ' +
  'isolamento entre usuarios e fluxos. ' +
  '\n\n' +
  'NAO use para: ' +
  '\n - Fatos duraveis sobre o usuario (preferencias, perfil) -> memoria de longo prazo. ' +
  '\n - Log/auditoria de acoes. ' +
  '\n - Dados que precisam sobreviver mais de 24h. ' +
  '\n\n' +
  'REGRA-CHAVE: nao confie apenas na memoria do contexto da conversa. Em conversas ' +
  'longas o LLM pode esquecer/inventar detalhes. Se voce salvou algo, LEIA antes de ' +
  'confirmar. ' +
  '\n\n' +
  'TTL default: 1h. Aumente se a tarefa for longa (ex: ttl=14400 pra 4h, 86400 pra 24h).'

// Restringe a key pra prefixo seguro (evita colisao com outras namespaces
// do Redis: thread, ratelimit, etc).
const KEY_REGEX = /^[a-z0-9][a-z0-9_:-]*$/i

const inputSchema = {
  // Provido pelo orquestrador (sistema que chama esse MCP) — a IA nao
  // precisa controlar esse campo. Garante isolamento entre usuarios
  // (multi-tenant) pra que cliente A nao leia/sobrescreva o scratch do
  // cliente B mesmo se a IA usar a mesma key.
  userId: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'Identificador do usuario/sessao. Preenchido AUTOMATICAMENTE pelo ' +
      'sistema que chama esse MCP — a IA nao precisa fornecer. Usado pra ' +
      'isolar o storage per-usuario no namespace do Redis.',
    ),
  key: z
    .string()
    .min(1)
    .max(config.limits.keyMaxLength)
    .regex(KEY_REGEX, 'key deve ser alfanumerica (_ - : permitidos)')
    .describe(
      'Nome curto e descritivo do proposito. Ex: "pedido", "carrinho", ' +
      '"agendamento", "cadastro". NAO precisa incluir userId — o sistema ' +
      'isola automaticamente por usuario.',
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

async function handler({ userId, key, data, ttl }) {
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

    // Namespace per-user: cliente A nunca le/escreve no scratch do cliente B
    // mesmo se a IA usar a mesma key humana ("pedido", "carrinho", etc).
    const redisKey = `temp:${userId}:${key}`
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
