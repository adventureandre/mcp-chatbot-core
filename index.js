import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { createClient } from "redis";

const server = new McpServer({
  name: "mcp-chatbot-core",
  version: "1.0.0",
});

// ========================================
// Config
// ========================================

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const WAHA_BASE_URL = process.env.WAHA_BASE_URL || "http://localhost:3000";
const WAHA_SESSION = process.env.WAHA_SESSION || "default";
const WAHA_API_KEY = process.env.WAHA_API_KEY || "";

let redis = null;

async function getRedis() {
  if (!redis) {
    redis = createClient({ url: REDIS_URL });
    redis.on("error", (err) => console.error("Redis error:", err));
    await redis.connect();
  }
  return redis;
}

function txt(text) {
  return { content: [{ type: "text", text }] };
}
function jsonTxt(obj) {
  return txt(JSON.stringify(obj, null, 2));
}

// ========================================
// Tool: smartContextManager
// ========================================

const explicitClearIndicators = [
  "esqueca isso", "esquece isso", "esqueca tudo", "esquece tudo",
  "limpa conversa", "limpe a conversa", "limpar conversa", "limpar historico",
  "zerar conversa", "resetar conversa", "comecar de novo", "comecar do zero",
  "recomecar conversa", "nova conversa",
];

const topicChangeIndicators = [
  "mudando de assunto", "mudar de assunto", "novo assunto",
  "outro assunto", "deixa pra la", "nao importa", "vamos falar de outra coisa",
];

const activeWorkflowIndicators = [
  "oferta", "ofertas", "criar", "criando", "registro", "registrar",
  "confirma", "confirmar", "prosseguir", "continuar", "proximo", "proxima",
  "aguarde", "processando", "analisando",
];

server.tool(
  "smartContextManager",
  "Detecta mudanca de contexto na conversa e limpa a thread quando necessario. Chame quando o usuario pedir para esquecer, limpar conversa ou mudar de assunto.",
  {
    userId: z.string(),
    currentMessage: z.string(),
  },
  async ({ userId, currentMessage }) => {
    try {
      const current = currentMessage.toLowerCase();

      // Verifica workflow ativo
      for (const ind of activeWorkflowIndicators) {
        if (current.includes(ind)) {
          return jsonTxt({
            success: true,
            action: "keep_context",
            message: "Contexto mantido - workflow ativo detectado",
          });
        }
      }

      // Verifica pedido explicito de limpeza
      let shouldClear = false;
      let reason = "Nenhum indicador de mudanca";

      for (const ind of explicitClearIndicators) {
        if (current.includes(ind)) {
          shouldClear = true;
          reason = `Solicitacao explicita: "${ind}"`;
          break;
        }
      }

      if (!shouldClear) {
        for (const ind of topicChangeIndicators) {
          if (current.includes(ind)) {
            shouldClear = true;
            reason = `Mudanca de topico: "${ind}"`;
            break;
          }
        }
      }

      if (!shouldClear) {
        return jsonTxt({
          success: true,
          action: "keep_context",
          message: "Contexto mantido - sem mudanca significativa",
        });
      }

      // Limpa a thread no Redis
      const r = await getRedis();
      const threadKey = `openai:thread:${userId}`;
      await r.del(threadKey);

      return jsonTxt({
        success: true,
        action: "context_cleared",
        reason,
        message: "Contexto limpo - iniciando nova conversa",
      });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: sendMessageToWhatsApp
// ========================================

server.tool(
  "sendMessageToWhatsApp",
  "Envia uma mensagem para um numero do WhatsApp via WAHA",
  {
    phoneNumber: z.string().optional(),
    to: z.string().optional(),
    message: z.string(),
    mentions: z.array(z.string()).optional(),
    context: z.string().optional(),
  },
  async ({ phoneNumber, to, message, mentions, context }) => {
    const target = phoneNumber || to;
    if (!target) {
      return jsonTxt({ success: false, error: "Numero de telefone nao fornecido" });
    }

    try {
      const chatId = target.includes("@") ? target : `${target}@c.us`;

      const payload = {
        chatId,
        text: message,
        session: WAHA_SESSION,
      };
      if (mentions && mentions.length > 0) {
        payload.mentions = mentions.map((m) => m.replace(/[@c.us]/g, ""));
      }

      const headers = {
        "Content-Type": "application/json",
        ...(WAHA_API_KEY ? { "X-API-Key": WAHA_API_KEY } : {}),
      };
      await axios.post(`${WAHA_BASE_URL}/api/sendText`, payload, {
        headers,
        timeout: 10000,
      });

      // Salvar contexto e primeira mensagem na thread Redis
      const r = await getRedis();
      const threadKey = `openai:thread:${chatId}`;
      const threadData = await r.get(threadKey);
      if (threadData) {
        try {
          const thread = JSON.parse(threadData);
          if (context) {
            thread.messages.push({
              role: "assistant",
              content: `[CONTEXTO PRINCIPAL]: ${context}`,
            });
          }
          thread.messages.push({
            role: "assistant",
            content: `[PRIMEIRA MENSAGEM DA AURORA]: ${message}`,
          });
          await r.set(threadKey, JSON.stringify(thread));
          await r.expire(threadKey, 24 * 60 * 60);
        } catch { /* ignore */ }
      }

      return jsonTxt({
        success: true,
        message: "Mensagem enviada com sucesso",
        phoneNumber: target,
      });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: saveTemporaryData
// ========================================

server.tool(
  "saveTemporaryData",
  "Salva dados temporarios como rascunho/bloco de notas durante tarefas complexas. Use para guardar resultados parciais, listas de etapas pendentes, dados coletados de APIs, ou qualquer informacao que precise ser lembrada entre chamadas de ferramentas. Expira em 1h por padrao. Exemplo de uso: salvar lista de ofertas encontradas, resultados de consultas SQL, dados parciais de um fluxo multi-etapa.",
  {
    key: z.string().describe("Chave descritiva. Ex: 'ofertas_pendentes', 'consulta_resultado', 'etapas_restantes'"),
    data: z.any().describe("Qualquer dado: objeto, array, texto, numero"),
    ttl: z.number().optional().default(3600).describe("Tempo de vida em segundos (padrao 3600 = 1h)"),
  },
  async ({ key, data, ttl }) => {
    try {
      const r = await getRedis();
      const redisKey = `temp:${key}`;
      await r.setEx(
        redisKey,
        ttl,
        JSON.stringify({
          data,
          savedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        })
      );
      return jsonTxt({
        success: true,
        message: `Dados salvos em "${key}" por ${Math.round(ttl / 60)} minutos`,
        key: redisKey,
      });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Tool: getTemporaryData
// ========================================

server.tool(
  "getTemporaryData",
  "Recupera dados salvos anteriormente com saveTemporaryData. Use para retomar tarefas em andamento, consultar resultados parciais salvos, ou verificar etapas pendentes de um fluxo multi-etapa.",
  { key: z.string().describe("Mesma chave usada no saveTemporaryData. Ex: 'ofertas_pendentes'") },
  async ({ key }) => {
    try {
      const r = await getRedis();
      const redisKey = `temp:${key}`;
      const raw = await r.get(redisKey);
      if (!raw) {
        return jsonTxt({
          success: false,
          found: false,
          message: `Dados nao encontrados para "${key}". Podem ter expirado.`,
        });
      }
      const parsed = JSON.parse(raw);
      return jsonTxt({
        success: true,
        found: true,
        data: parsed.data,
        savedAt: parsed.savedAt,
        expiresAt: parsed.expiresAt,
      });
    } catch (error) {
      return jsonTxt({ success: false, error: error.message });
    }
  }
);

// ========================================
// Start
// ========================================

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP ChatBot Core rodando via STDIO...");
