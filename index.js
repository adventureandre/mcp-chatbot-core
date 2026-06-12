#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { logger } from './src/lib/logger.js'
import { closeRedis } from './src/lib/redis.js'
import { sendMessageToWhatsApp } from './src/tools/sendMessageToWhatsApp.js'
import { createScheduledTask } from './src/tools/createScheduledTask.js'

const server = new McpServer({
  name: 'mcp-chatbot-core',
  version: '1.1.0',
})

const tools = [
  sendMessageToWhatsApp,
  createScheduledTask,
]

for (const tool of tools) {
  server.tool(tool.name, tool.description, tool.inputSchema, tool.handler)
}

const transport = new StdioServerTransport()

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('shutdown_started', { signal })
  try {
    await server.close().catch((err) => logger.warn('server_close_error', { err: err.message }))
    await closeRedis()
  } finally {
    logger.info('shutdown_complete', { signal })
    process.exit(0)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { reason: String(reason) })
})
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { err: err.message, stack: err.stack })
  process.exit(1)
})

await server.connect(transport)
logger.info('mcp_ready', { tools: tools.map((t) => t.name) })
