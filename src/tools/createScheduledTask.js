import { z } from 'zod'
import { auroraClient } from '../lib/aurora.js'
import { logger } from '../lib/logger.js'
import { ok, fail, runTool } from '../lib/response.js'

const description =
  'Cria um agendamento que a IA executa automaticamente — uma vez só (once) ou em horários regulares (recorrente). ' +
  '\n\n' +
  'USE quando o usuario pedir pra agendar algo, como:\n' +
  ' - "Me lembre amanhã às 9h de ligar pro cliente" → once (uma vez)\n' +
  ' - "Rode esse follow-up na sexta às 14h" → once (uma vez)\n' +
  ' - "Me envie um email todo dia às 9h com o resumo" → daily (recorrente)\n' +
  ' - "Envie uma mensagem no WhatsApp toda segunda às 14h" → weekly\n' +
  ' - "Execute essa verificação todo primeiro dia do mês" → monthly\n' +
  '\n' +
  'A IA descreve o que fazer em `instruction`, escolhe quando com `preset`, e ' +
  'para onde entregar com `deliveryType` + `target`.\n' +
  '\n' +
  'TIPOS DE QUANDO (preset):\n' +
  ' - once (UMA VEZ): { kind: "once", date: "YYYY-MM-DD" (futura), hour: H (0-23), minute: M (0-59) } — executa 1x e para\n' +
  ' - hourly: { kind: "hourly", everyHours: N (1-23), minute: M (0-59) }\n' +
  ' - daily: { kind: "daily", hour: H (0-23), minute: M (0-59) }\n' +
  ' - weekly: { kind: "weekly", weekday: D (0=domingo..6=sábado), hour: H, minute: M }\n' +
  ' - monthly: { kind: "monthly", day: D (1-28), hour: H, minute: M }\n' +
  '\n' +
  'REGRA: para pedidos pontuais ("amanhã", "dia X", "na sexta") use SEMPRE once. ' +
  'A data do once precisa ser FUTURA.\n' +
  '\n' +
  'TIPOS DE ENTREGA:\n' +
  ' - "internal": Executa a instrução (efeito = tools + histórico), não entrega externamente\n' +
  ' - "email": Envia o resultado por email (requer `target`)\n' +
  ' - "whatsapp": Envia o resultado via WhatsApp (requer `target` = número/chatId)\n' +
  '\n' +
  'EXEMPLO DE USO:\n' +
  'user: "Quero um resumo das tarefas todo dia às 9h no meu email"\n' +
  'ia: [chama createScheduledTask com]\n' +
  '  title: "Resumo diário de tarefas"\n' +
  '  instruction: "Liste todas as tarefas pendentes do usuario de forma resumida"\n' +
  '  deliveryType: "email"\n' +
  '  target: "user@example.com"\n' +
  '  preset: { kind: "daily", hour: 9, minute: 0 }\n' +
  'ia: "Pronto! Vou enviar um resumo para seu email todo dia às 9h da manhã."'

const inputSchema = {
  // Preenchido AUTOMATICAMENTE pelo Aurora (ToolExecutor injeta a IA chamadora).
  // A IA não fornece — impede criar agendamento atribuído a outra IA.
  aiId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'ID da IA dona do agendamento. Preenchido AUTOMATICAMENTE pelo sistema — ' +
      'a IA NÃO precisa fornecer.',
    ),
  // Preenchido AUTOMATICAMENTE pelo Aurora (ToolExecutor injeta o usuário atual).
  // A IA não fornece — é o identificador de quem está conversando agora; usado
  // pra resolver target "self" (lembrar o próprio usuário) sem a IA saber o número.
  userId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Identificador do usuário da conversa atual. Preenchido AUTOMATICAMENTE pelo ' +
      'sistema — a IA NÃO precisa fornecer.',
    ),
  title: z
    .string()
    .min(3)
    .max(200)
    .describe(
      'Título descritivo da tarefa (ex: "Resumo diário", "Verificação de estoque"). ' +
      'Será exibido no painel de agendamentos.',
    ),
  instruction: z
    .string()
    .min(10)
    .max(5000)
    .describe(
      'Instruções claras do que a IA deve fazer. Será executada como turno normal da IA. ' +
      'Ex: "Gere um relatório das vendas de hoje e envie"',
    ),
  deliveryType: z
    .enum(['internal', 'email', 'whatsapp'])
    .describe(
      'Onde entregar o resultado:\n' +
      '- "whatsapp": envia no WhatsApp. Para LEMBRAR O PRÓPRIO USUÁRIO da conversa ' +
      '(ex: "me lembre...", "me avise..."), use target "self" — o sistema entrega ' +
      'pra ele automaticamente, você NÃO precisa saber o número.\n' +
      '- "email": envia por email (requer target com o email).\n' +
      '- "internal": só executa (tools+histórico), NÃO notifica ninguém. ' +
      'NÃO use internal para lembretes/avisos ao usuário — ele não receberia nada.',
    ),
  target: z
    .string()
    .optional()
    .nullable()
    .describe(
      'Destino da entrega:\n' +
      '- "self" → o PRÓPRIO usuário desta conversa (use para "me lembre/me avise" no WhatsApp).\n' +
      '- email válido para deliveryType "email" (ex: "user@company.com").\n' +
      '- número/chatId para mandar pra OUTRA pessoa no WhatsApp (ex: "5562999540017").\n' +
      'Para "internal" não se aplica (deixe vazio).',
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
    .describe(
      'Preset de quando executar. Estrutura varia por kind:\n' +
      '- in (DAQUI A X — tempo RELATIVO): { kind: "in", minutes: N } — executa 1x daqui a N minutos. ' +
      'USE ISSO para "daqui 2 minutos", "em 30 min", "daqui 2 horas" (=120). Você NÃO precisa saber a hora atual — o sistema calcula.\n' +
      '- once (data ABSOLUTA): { kind, date "YYYY-MM-DD" (futura), hour (0-23), minute } — executa 1x na data exata\n' +
      '- hourly: { kind, everyHours (1-23), minute }\n' +
      '- daily: { kind, hour (0-23), minute }\n' +
      '- weekly: { kind, weekday (0-6), hour, minute }\n' +
      '- monthly: { kind, day (1-28), hour, minute }\n' +
      'REGRA: "daqui a X" / "em X min/horas" → SEMPRE "in" (nunca tente adivinhar a hora atual). ' +
      '"amanhã/dia X às H" → "once". Repetições → daily/weekly/monthly.',
    ),
}

async function handler({ aiId, userId, title, instruction, deliveryType, target, preset }) {
  return runTool('createScheduledTask', async () => {
    try {
      logger.info('createScheduledTask_attempting', {
        title,
        deliveryType,
        preset_kind: preset?.kind,
        self_target: target === 'self',
      })

      const response = await auroraClient.post('/mcp/schedules/create', {
        aiId, // injetado pelo Aurora (ToolExecutor) — IA chamadora
        userId, // injetado pelo Aurora — usado pra resolver target "self"
        title,
        instruction,
        deliveryType,
        target: target || null,
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
        return fail(
          'INVALID_PARAMETERS',
          message,
          { toolName: 'createScheduledTask', retryable: false },
        )
      }
      if (error?.response?.status === 404) {
        return fail(
          'AI_NOT_FOUND',
          message,
          { toolName: 'createScheduledTask', retryable: false },
        )
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
