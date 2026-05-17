import axios from 'axios'
import http from 'node:http'
import https from 'node:https'
import { config } from '../config.js'

/**
 * Client HTTP dedicado pro WAHA com:
 *  - keep-alive habilitado (reutiliza conexoes TCP entre tool calls)
 *  - timeout configuravel via env
 *  - X-API-Key injetada automaticamente se a env estiver setada
 */

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })

export const wahaClient = axios.create({
  baseURL: config.waha.baseUrl,
  timeout: config.waha.timeoutMs,
  httpAgent,
  httpsAgent,
  headers: {
    'Content-Type': 'application/json',
    ...(config.waha.apiKey ? { 'X-API-Key': config.waha.apiKey } : {}),
  },
})

/**
 * Normaliza um numero/identificador pra chatId do WAHA.
 *  - Se ja tem `@`, devolve como veio (5562...@c.us ou ...@g.us pra grupo)
 *  - Caso contrario, assume chat 1:1 e adiciona @c.us
 */
export function toChatId(target) {
  return target.includes('@') ? target : `${target}@c.us`
}
