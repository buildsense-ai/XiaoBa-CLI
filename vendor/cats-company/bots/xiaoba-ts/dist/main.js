"use strict";
/**
 * 小八 (Xiaoba) — Cats Company AI Assistant Bot (TypeScript)
 *
 * Connects via the @catscompany/bot-sdk WebSocket SDK and calls an
 * OpenAI-compatible LLM API to generate replies.
 *
 * Environment variables:
 *   BOT_API_KEY   - Bot API key (required)
 *   BOT_WS_URL    - WebSocket URL (default: ws://localhost:6061/v0/channels)
 *   LLM_API_BASE  - LLM endpoint (default: https://api.openai.com/v1)
 *   LLM_API_KEY   - LLM bearer token
 *   LLM_MODEL     - Model name (default: gpt-3.5-turbo)
 *   MAX_HISTORY   - Max conversation turns per topic (default: 20)
 */
Object.defineProperty(exports, "__esModule", { value: true });
const bot_sdk_1 = require("@catscompany/bot-sdk");
// --- Configuration ---
const BOT_API_KEY = process.env.BOT_API_KEY ?? '';
const BOT_WS_URL = process.env.BOT_WS_URL ?? 'ws://localhost:6061/v0/channels';
const LLM_API_BASE = process.env.LLM_API_BASE ?? 'https://api.openai.com/v1';
const LLM_API_KEY = process.env.LLM_API_KEY ?? '';
const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-3.5-turbo';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY ?? '20', 10);
const SYSTEM_PROMPT = `你是 Cats Company 的 AI 助手「小八」。你友好、有帮助、简洁。
用中文回复，除非用户使用其他语言。保持回复简短自然，像朋友聊天一样。`;
const conversations = new Map();
function getHistory(topic) {
    let h = conversations.get(topic);
    if (!h) {
        h = [];
        conversations.set(topic, h);
    }
    return h;
}
function addMessage(topic, role, content) {
    const h = getHistory(topic);
    h.push({ role, content });
    if (h.length > MAX_HISTORY) {
        conversations.set(topic, h.slice(-MAX_HISTORY));
    }
}
// --- LLM call ---
async function callLLM(topic, userMessage) {
    addMessage(topic, 'user', userMessage);
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...getHistory(topic),
    ];
    const headers = { 'Content-Type': 'application/json' };
    if (LLM_API_KEY) {
        headers['Authorization'] = `Bearer ${LLM_API_KEY}`;
    }
    try {
        const res = await fetch(`${LLM_API_BASE}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: LLM_MODEL,
                messages,
                max_tokens: 1024,
            }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`LLM API ${res.status}: ${body}`);
        }
        const data = await res.json();
        const reply = data.choices[0].message.content.trim();
        addMessage(topic, 'assistant', reply);
        return reply;
    }
    catch (err) {
        console.error(`[llm] call failed: ${err.message}`);
        return '抱歉，我暂时无法回复，请稍后再试。';
    }
}
// --- Main ---
function main() {
    if (!BOT_API_KEY) {
        console.error('BOT_API_KEY environment variable is required');
        process.exit(1);
    }
    if (!LLM_API_KEY) {
        console.warn('[warn] LLM_API_KEY not set — LLM calls will likely fail');
    }
    const bot = new bot_sdk_1.CatsBot({
        serverUrl: BOT_WS_URL,
        apiKey: BOT_API_KEY,
    });
    bot.on('ready', (uid) => {
        console.log(`[ready] 小八 online as ${uid}`);
        console.log(`  model: ${LLM_MODEL}`);
        console.log(`  api base: ${LLM_API_BASE}`);
    });
    bot.on('message', async (ctx) => {
        console.log(`[msg] from=${ctx.from} topic=${ctx.topic} text="${ctx.text}"`);
        try {
            ctx.sendTyping();
            const reply = await callLLM(ctx.topic, ctx.text);
            console.log(`[reply] → ${ctx.topic}: ${reply.slice(0, 80)}${reply.length > 80 ? '...' : ''}`);
            await ctx.reply(reply);
        }
        catch (err) {
            console.error(`[error] reply failed: ${err.message}`);
        }
    });
    bot.on('disconnect', (code, reason) => {
        console.log(`[disconnect] code=${code} reason=${reason}`);
    });
    bot.on('reconnecting', (attempt) => {
        console.log(`[reconnecting] attempt #${attempt}`);
    });
    bot.on('error', (err) => {
        console.error(`[error] ${err.message}`);
    });
    console.log(`Starting 小八, server=${BOT_WS_URL}`);
    bot.run().catch((err) => {
        console.error('Fatal:', err);
        process.exit(1);
    });
}
main();
//# sourceMappingURL=main.js.map