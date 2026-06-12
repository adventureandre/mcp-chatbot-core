import axios from 'axios'
import http from 'node:http'
import https from 'node:https'
import { config } from '../config.js'

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })

export const auroraClient = axios.create({
  baseURL: config.aurora.baseUrl,
  timeout: config.aurora.timeoutMs,
  httpAgent,
  httpsAgent,
  headers: {
    'Content-Type': 'application/json',
  },
})
