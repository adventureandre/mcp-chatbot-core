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
// Tool: transferToAgent — DESABILITADA
// ========================================
// Substituida pelo sistema de UiActions + handoff (Fase 6 do ExpertCustom):
// agora a transferencia eh feita via UiAction `transfer_to_human_agent`
// que muda o status da conversa pra AWAITING_HUMAN. O nome confundia a IA
// (transferToAgent vs transfer_to_human_agent). Comentada pra evitar
// conflito. Se precisar reativar no futuro, descomenta o bloco abaixo.
//
// server.tool(
//   "transferToAgent",
//   "Envia o contato do atendente humano para o usuario via WhatsApp, para que o usuario possa iniciar conversa com o atendente.",
//   {
//     userId: z.string().describe("ChatId do usuario que quer falar com atendente (ex: 5562999540017@c.us)"),
//   },
//   async ({ userId }) => {
//     try {
//       const agentNumber = process.env.AGENT_PHONE_NUMBER || "556299540017";
//       const userChatId = userId.includes("@") ? userId : `${userId}@c.us`;
//
//       const headers = {
//         "Content-Type": "application/json",
//         ...(WAHA_API_KEY ? { "X-API-Key": WAHA_API_KEY } : {}),
//       };
//
//       // Envia contato do atendente para o usuario
//       await axios.post(`${WAHA_BASE_URL}/api/sendContactVcard`, {
//         chatId: userChatId,
//         contacts: [
//           {
//             fullName: "Atendente",
//             phoneNumber: `+${agentNumber}`,
//             whatsappId: agentNumber,
//             vcard: null,
//           },
//         ],
//         session: WAHA_SESSION,
//       }, { headers, timeout: 10000 });
//
//       return jsonTxt({
//         success: true,
//         message: "Contato do atendente enviado para o usuario",
//       });
//     } catch (error) {
//       return jsonTxt({ success: false, error: error.message });
//     }
//   }
// );

// ========================================
// Start
// ========================================

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP ChatBot Core rodando via STDIO...");
