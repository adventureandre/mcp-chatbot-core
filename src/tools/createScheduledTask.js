import { z } from 'zod'
import { auroraClient } from '../lib/aurora.js'
import { logger } from '../lib/logger.js'
import { ok, fail, runTool } from '../lib/response.js'

const description =
  'Cria um agendamento que a IA executa automaticamente no futuro — uma vez (once/in) ou recorrente (hourly/daily/weekly/monthly).\n\n' +
  'USE quando o usuário pedir pra agendar/lembrar algo:\n' +
  ' - "me lembre amanhã às 9h de ligar pro cliente" → once\n' +
  ' - "daqui 5 minutos me avisa" → preset in (relativo)\n' +
  ' - "todo dia às 9h me manda o resumo no email" → daily\n\n' +
  'COMO PREENCHER:\n' +
  ' - `instruction`: o CONTEÚDO final que o destinatário vai receber (a mensagem em si), NÃO uma confirmação de agendamento.\n' +
  ' - `preset`: quando executar (veja os formatos no campo).\n' +
  ' - `deliveryType` + `target`: por onde entregar. Herde do contexto: se o pedido anterior foi por e-mail, agende por e-mail pro mesmo endereço.\n\n' +
  'EXEMPLO:\n' +
  'user: "daqui 5 min manda no meu email joao@x.com um aviso pra revisar o relatório"\n' +
  'ia → createScheduledTask({\n' +
  '  title: "Aviso: revisar relatório",\n' +
  '  instruction: "Diga: Lembrete — revise o relatório, por favor.",\n' +
  '  deliveryType: "email",\n' +
  '  target: "joao@x.com",\n' +
  '  preset: { kind: "in", minutes: 5 }\n' +
  '})\n' +
  'ia (fala final ao usuário): "Pronto! Daqui 5 minutos envio o aviso pro joao@x.com."'

const inputSchema = {
  aiId: z
    .string()
    .min(1)
    .optional()
    .describe('Preenchido AUTOMATICAMENTE pelo sistema — a IA NÃO fornece.'),
  userId: z
    .string()
    .min(1)
    .optional()
    .describe('Preenchido AUTOMATICAMENTE pelo sistema — a IA NÃO fornece.'),
  title: z
    .string()
    .min(3)
    .max(200)
    .describe(
      'Título curto da tarefa (ex: "Lembrete reunião", "Resumo diário"). Vira o ASSUNTO do e-mail.',
    ),
  instruction: z
    .string()
    .max(5000)
    .optional()
    .describe(
      'A MENSAGEM/TEXTO final que o destinatário deve RECEBER quando a tarefa rodar. ' +
      'Para um lembrete, escreva a mensagem prefixada com "Diga: " (ex: "Diga: Não esqueça da reunião às 15h."). ' +
      'Para uma tarefa, descreva o que gerar (ex: "Gere um resumo das vendas de hoje."). ' +
      'NUNCA escreva uma confirmação de agendamento aqui (ex: "agendei...", "pronto, vou enviar...", "vou te lembrar...") — ' +
      'isso é o que VOCÊ responde ao usuário agora, não o conteúdo da tarefa. (Aceita também o alias `message`.)',
    ),
  // Alias de compatibilidade: modelos costumam mandar `message`/`text` em vez de
  // `instruction`. Aceitamos e normalizamos no handler em vez de falhar.
  message: z
    .string()
    .max(5000)
    .optional()
    .describe('Alias de `instruction` (compatibilidade). Prefira `instruction`.'),
  deliveryType: z
    .enum(['internal', 'email', 'whatsapp'])
    .describe(
      'Por onde entregar o resultado:\n' +
      '- "email": envia por e-mail. Requer `target` com um e-mail válido. Use quando o usuário deu/pediu por e-mail.\n' +
      '- "whatsapp": envia no WhatsApp. Requer `target` com o número (ex: "5562999990000"). Use só quando há um número na conversa.\n' +
      '- "internal": só executa (tools + histórico), SEM notificar ninguém. Use para tarefas de bastidor (ex: indexar, processar) — não para avisar o usuário.\n' +
      'Na dúvida, prefira o canal que o usuário já estava usando nesta conversa.',
    ),
  target: z
    .string()
    .optional()
    .nullable()
    .describe(
      'Destino da entrega:\n' +
      '- e-mail válido quando deliveryType="email" (ex: "user@empresa.com").\n' +
      '- número/chatId quando deliveryType="whatsapp" (ex: "5562999990000").\n' +
      '- "self" → o próprio usuário desta conversa, SOMENTE no WhatsApp e SOMENTE se a conversa tiver um número (canais sem WhatsApp rejeitam "self").\n' +
      '- vazio para deliveryType="internal".',
    ),
  preset: z
    .object({
      kind: z.enum(['in', 'hourly', 'daily', 'weekly', 'monthly', 'once']),
      minutes: z.number().int().min(1).optional(),
      everyHours: z.number().int().min(1).max(23).optional(),
      hour: z.number().int().min(0).max(23).optional(),
      minute: z.number().int().min(0).max(59).optional(),
      weekday: z.number().int().min(0).max(6).optional(),
      day: z.number().int().min(1).max(28).optional(),
      date: z.string().optional(),
    })
    .strict()
    .optional()
    .describe(
      'Quando executar. Formatos por kind:\n' +
      '- in (RELATIVO — "daqui a X"): { kind: "in", minutes: N }. Use para "daqui 5 min" (5), "em 2 horas" (120). NÃO precisa saber a hora atual.\n' +
      '- once (data ABSOLUTA futura): { kind: "once", date: "YYYY-MM-DD", hour: 0-23, minute: 0-59 }.\n' +
      '- hourly: { kind: "hourly", everyHours: 1-23, minute: 0-59 }.\n' +
      '- daily: { kind: "daily", hour: 0-23, minute: 0-59 }.\n' +
      '- weekly: { kind: "weekly", weekday: 0-6 (0=dom), hour, minute }.\n' +
      '- monthly: { kind: "monthly", day: 1-28, hour, minute }.\n' +
      'REGRA: "daqui a X / em X min/horas" → SEMPRE "in". "amanhã/dia X às H" → "once". (Aceita também o alias `when` em texto, ex: "daqui 5 minutos".)',
    ),
  // Alias de compatibilidade: modelos às vezes mandam o tempo como string
  // ("in 1 hour", "daqui 5 minutos") em vez do objeto `preset`. Convertido no handler.
  when: z
    .string()
    .max(100)
    .optional()
    .describe('Alias em texto de `preset` para tempo relativo (ex: "daqui 5 minutos", "em 2 horas"). Prefira `preset`.'),
  // Alias adicional: modelos às vezes mandam `schedule` como string de tempo.
  schedule: z
    .string()
    .max(100)
    .optional()
    .describe('Alias de `when` (compatibilidade). Prefira `preset`.'),
}

/**
 * Converte uma expressão relativa em texto ("daqui 5 minutos", "in 2 hours",
 * "em 30 min") no preset { kind: "in", minutes }. Retorna null se não reconhecer
 * — o handler então pede um preset estruturado em vez de adivinhar.
 */
function parseRelativeWhen(text) {
  if (typeof text !== 'string') return null
  const t = text.toLowerCase()
  // Só interpreta tempo RELATIVO. Se houver marcador de horário absoluto ou
  // recorrência (amanhã/dia/às/data/dia-da-semana), devolve null — esses casos
  // exigem `preset` estruturado (once/daily/...), não devem virar "in".
  if (/amanh|hoje|\bdia\b|\bàs\b|\bas\b|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|\d{4}-\d{2}|\d{1,2}\/\d{1,2}|\d{1,2}:\d{2}/.test(t)) {
    return null
  }
  const m = t.match(/(\d+)\s*(min|minuto|minutos|minute|minutes|h|hora|horas|hour|hours)\b/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return null
  const isHour = /^h|hora|hour/.test(m[2])
  const minutes = isHour ? n * 60 : n
  return { kind: 'in', minutes }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function handler(raw) {
  return runTool('createScheduledTask', async () => {
    // ── Normalização (liberal no que aceita) ──────────────────────────────
    const aiId = raw.aiId
    const userId = raw.userId
    const title = raw.title
    const deliveryType = typeof raw.deliveryType === 'string' ? raw.deliveryType.toLowerCase() : raw.deliveryType
    const target = (raw.target ?? '').toString().trim() || null

    // instruction: aceita o alias `message`.
    const instruction = (raw.instruction ?? raw.message ?? '').toString().trim()

    // preset: o zod garante objeto válido ou undefined. Se ausente, tenta
    // reconstruir de um alias em texto (`when`/`schedule`, ex: "daqui 5 min").
    let preset = raw.preset
    if (!preset) {
      preset = parseRelativeWhen(raw.when ?? raw.schedule) || undefined
    }

    // ── Validação acionável (erros que a IA consegue corrigir sozinha) ────
    if (instruction.length < 3) {
      return fail(
        'INVALID_PARAMETERS',
        'Faltou `instruction`: escreva a MENSAGEM final que o destinatário vai receber (ex: "Diga: Não esqueça da reunião."), não uma confirmação de agendamento.',
        { toolName: 'createScheduledTask', retryable: false },
      )
    }
    if (!preset) {
      return fail(
        'INVALID_PARAMETERS',
        'Faltou `preset`: defina quando executar. Para "daqui a X" use { kind: "in", minutes: N }; para data fixa use { kind: "once", date, hour, minute }.',
        { toolName: 'createScheduledTask', retryable: false },
      )
    }
    if (deliveryType === 'email' && (!target || !EMAIL_RE.test(target))) {
      return fail(
        'INVALID_PARAMETERS',
        'deliveryType "email" exige `target` com um e-mail válido (ex: "user@empresa.com"). Peça o e-mail ao usuário se não tiver.',
        { toolName: 'createScheduledTask', retryable: false },
      )
    }
    if (deliveryType === 'whatsapp' && !target) {
      return fail(
        'INVALID_PARAMETERS',
        'deliveryType "whatsapp" exige `target` (número, ex: "5562999990000", ou "self" se a conversa for no WhatsApp). Sem WhatsApp na conversa, use "email" com o endereço do usuário.',
        { toolName: 'createScheduledTask', retryable: false },
      )
    }

    logger.info('createScheduledTask_attempting', {
      title,
      deliveryType,
      preset_kind: preset?.kind,
      self_target: target === 'self',
      normalized_from_alias: !raw.instruction && !!instruction,
    })

    try {
      const response = await auroraClient.post('/mcp/schedules/create', {
        aiId,
        userId,
        title,
        instruction,
        deliveryType,
        target: deliveryType === 'internal' ? null : target,
        preset,
      })

      if (!response.data?.success) {
        return fail(
          'SCHEDULE_CREATE_FAILED',
          response.data?.message || 'Falha ao criar agendamento',
          { toolName: 'createScheduledTask', retryable: false },
        )
      }

      const schedule = response.data.schedule
      const nextRunTime = new Date(schedule.nextRunAt).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
      })

      logger.info('createScheduledTask_success', {
        scheduleId: schedule.id,
        title: schedule.title,
        nextRunAt: schedule.nextRunAt,
      })

      return ok({
        scheduleId: schedule.id,
        title: schedule.title,
        nextRunAt: schedule.nextRunAt,
        nextRunAtFormatted: nextRunTime,
        schedule: schedule.schedule,
        scheduleConfig: schedule.scheduleConfig,
        message: `Agendamento criado! Próxima execução: ${nextRunTime}`,
      })
    } catch (error) {
      const message = error?.response?.data?.message || error?.message || String(error)
      logger.error('createScheduledTask_error', {
        error: message,
        status: error?.response?.status,
      })

      if (error?.response?.status === 400) {
        return fail('INVALID_PARAMETERS', message, { toolName: 'createScheduledTask', retryable: false })
      }
      if (error?.response?.status === 404) {
        return fail('AI_NOT_FOUND', message, { toolName: 'createScheduledTask', retryable: false })
      }
      if (error?.response?.status === 500) {
        return fail(
          'SERVER_ERROR',
          'Erro ao criar agendamento. Tente novamente em alguns segundos.',
          { toolName: 'createScheduledTask', retryable: true, details: { err: message } },
        )
      }

      return fail(
        'UNKNOWN_ERROR',
        message || 'Erro desconhecido ao criar agendamento',
        { toolName: 'createScheduledTask', retryable: true },
      )
    }
  })
}

export const createScheduledTask = { name: 'createScheduledTask', description, inputSchema, handler }
