import { z } from 'zod'
import { auroraClient } from '../lib/aurora.js'
import { logger } from '../lib/logger.js'
import { ok, fail, runTool } from '../lib/response.js'

const description =
  'Cria um agendamento (tarefa recorrente automática) que a IA executa em horários regulares. ' +
  '\n\n' +
  'USE quando o usuario pedir pra agendar uma tarefa recorrente, como:\n' +
  ' - "Me envie um email todo dia às 9h com o resumo"\n' +
  ' - "Envie uma mensagem no WhatsApp toda segunda às 14h"\n' +
  ' - "Execute essa verificação todo primeiro dia do mês"\n' +
  '\n' +
  'A IA descreve o que fazer em `instruction`, escolhe quando com `preset`, e ' +
  'para onde entregar com `deliveryType` + `target`.\n' +
  '\n' +
  'TIPOS DE RECORRÊNCIA (preset):\n' +
  ' - hourly: { kind: "hourly", everyHours: N (1-23), minute: M (0-59) }\n' +
  ' - daily: { kind: "daily", hour: H (0-23), minute: M (0-59) }\n' +
  ' - weekly: { kind: "weekly", weekday: D (0=domingo..6=sábado), hour: H, minute: M }\n' +
  ' - monthly: { kind: "monthly", day: D (1-28), hour: H, minute: M }\n' +
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
      'Onde entregar o resultado: ' +
      '"internal" (efeito=tools+histórico), ' +
      '"email" (requer target com email), ' +
      '"whatsapp" (requer target com número)',
    ),
  target: z
    .string()
    .optional()
    .nullable()
    .describe(
      'Destino da entrega (obrigatório se deliveryType não é "internal"): ' +
      'email válido para "email", número WhatsApp para "whatsapp". ' +
      'Ex: "user@company.com" ou "5562999540017"',
    ),
  preset: z
    .object({
      kind: z.enum(['hourly', 'daily', 'weekly', 'monthly']),
      everyHours: z.number().int().min(1).max(23).optional(),
      hour: z.number().int().min(0).max(23).optional(),
      minute: z.number().int().min(0).max(59),
      weekday: z.number().int().min(0).max(6).optional(),
      day: z.number().int().min(1).max(28).optional(),
    })
    .strict()
    .describe(
      'Preset de recorrência. Estrutura varia por kind:\n' +
      '- hourly: { kind, everyHours (1-23), minute }\n' +
      '- daily: { kind, hour (0-23), minute }\n' +
      '- weekly: { kind, weekday (0-6), hour, minute }\n' +
      '- monthly: { kind, day (1-28), hour, minute }',
    ),
}

async function handler({ aiId, title, instruction, deliveryType, target, preset }) {
  return runTool('createScheduledTask', async () => {
    try {
      logger.info('createScheduledTask_attempting', {
        title,
        deliveryType,
        preset_kind: preset?.kind,
      })

      const response = await auroraClient.post('/mcp/schedules/create', {
        aiId, // injetado pelo Aurora (ToolExecutor) — IA chamadora
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
