import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../types';
import { ToolDefinition } from '../types/tool';
import { estimateMessageTokens, estimateToolsTokens } from '../core/token-estimator';

const DEBUG_DIR = path.resolve('logs/context-debug');

export interface ContextDebugEntry {
  request_id: string;
  timestamp: string;
  session_key: string;
  query: string;
  context_modules: Record<string, { tokens: number; content?: string; [k: string]: any }>;
  total_estimated_tokens: number;
  turns: TurnLog[];
  final: {
    sent_messages: string[];
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tool_calls: number;
  };
}

export interface TurnLog {
  turn: number;
  prompt_tokens: number;
  completion_tokens: number;
  tool_calls: { name: string; arguments: string }[];
  assistant_text: string;
}

export class ContextDebugLogger {
  private entry: ContextDebugEntry;
  readonly enabled: boolean;

  constructor(requestId: string, sessionKey: string, query: string) {
    this.enabled = process.env.CONTEXT_DEBUG === 'true';
    this.entry = {
      request_id: requestId,
      timestamp: new Date().toISOString(),
      session_key: sessionKey,
      query,
      context_modules: {},
      total_estimated_tokens: 0,
      turns: [],
      final: { sent_messages: [], total_prompt_tokens: 0, total_completion_tokens: 0, total_tool_calls: 0 },
    };
  }

  recordContextModules(messages: Message[], tools: ToolDefinition[], recallMeta?: { factsCount?: number } | null): void {
    if (!this.enabled) return;

    const modules: ContextDebugEntry['context_modules'] = {};
    const systemParts: string[] = [];
    const historyMsgs: { role: string; snippet: string }[] = [];
    let currentQuery = '';

    for (const msg of messages) {
      const c = typeof msg.content === 'string' ? msg.content :
        Array.isArray(msg.content) ? msg.content.map(b => b.type === 'text' ? b.text : '[图片]').join('') : '';
      const t = estimateMessageTokens(msg);

      if (msg.role === 'system') {
        if (c.startsWith('[surface:')) modules.surface_rule = { tokens: t, content: c };
        else if (c.startsWith('[session_context]')) modules.session_context = { tokens: t, content: c };
        else if (c.includes('[long_term_memory]')) modules.recall = { tokens: t, content: c, facts_count: recallMeta?.factsCount ?? 0 };
        else if (c.includes('[transient_subagent_status]')) modules.subagent_status = { tokens: t, content: c };
        else if (c.includes('__type__') && c.includes('skill_activation')) modules.skill_prompt = { tokens: t, content: c };
        else { systemParts.push(c); modules.system_prompt = { tokens: (modules.system_prompt?.tokens ?? 0) + t, content: systemParts.join('\n---\n') }; }
      } else if (msg.role === 'user') {
        currentQuery = c;
        historyMsgs.push({ role: 'user', snippet: c.slice(0, 300) });
      } else {
        historyMsgs.push({ role: msg.role, snippet: (c || '').slice(0, 200) });
      }
    }

    // 最后一条 user 是当前 query，从 history 中移除
    if (historyMsgs.length > 0 && historyMsgs[historyMsgs.length - 1].role === 'user') {
      historyMsgs.pop();
    }

    modules.current_query = { tokens: estimateMessageTokens({ role: 'user', content: currentQuery }), content: currentQuery };

    // history: 只记录摘要，不存完整内容
    const nonSystem = messages.filter(m => m.role !== 'system');
    // 排除最后一条 user（当前 query），剩余为历史
    const historyOriginals = nonSystem.slice(0, -1);
    const historyTokens = historyOriginals.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    modules.history = { tokens: historyTokens, message_count: historyMsgs.length, messages: historyMsgs as any };

    const toolTokens = estimateToolsTokens(tools);
    modules.tool_definitions = { tokens: toolTokens, tool_count: tools.length, tool_names: tools.map(t => t.name) };

    this.entry.context_modules = modules;
    this.entry.total_estimated_tokens = Object.values(modules).reduce((s, m) => s + (m.tokens || 0), 0);
  }

  recordTurn(turn: number, promptTokens: number, completionTokens: number, toolCalls: { name: string; arguments: string }[], assistantText: string): void {
    if (!this.enabled) return;
    this.entry.turns.push({ turn, prompt_tokens: promptTokens, completion_tokens: completionTokens, tool_calls: toolCalls, assistant_text: assistantText.slice(0, 500) });
  }

  recordFinal(sentMessages: string[], totalPrompt: number, totalCompletion: number, totalTools: number): void {
    if (!this.enabled) return;
    this.entry.final = { sent_messages: sentMessages, total_prompt_tokens: totalPrompt, total_completion_tokens: totalCompletion, total_tool_calls: totalTools };
  }

  flush(): void {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const filePath = path.join(DEBUG_DIR, `${this.entry.request_id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(this.entry, null, 2));
    } catch { /* debug log 写入失败不影响主流程 */ }
  }

  // ─── SDK 边界记录（静态方法，供 provider 层直接调用） ───

  private static sdkDumpCounter = 0;

  /**
   * 记录 SDK 调用边界的原始数据
   * @param stage 'before' | 'after'
   * @param requestId 关联的 request_id（用于和主日志对应）
   * @param data 原始数据（params 或 response）
   */
  static dumpSdkBoundary(stage: 'before' | 'after', requestId: string | undefined, data: object): void {
    if (process.env.CONTEXT_DEBUG !== 'true') return;
    try {
      ContextDebugLogger.sdkDumpCounter++;
      const now = new Date();
      const ts = `${now.getHours().toString().padStart(2, '0')}-${now.getMinutes().toString().padStart(2, '0')}-${now.getSeconds().toString().padStart(2, '0')}`;
      const seq = ContextDebugLogger.sdkDumpCounter.toString().padStart(4, '0');
      const fileName = `${ts}_${seq}_sdk_${stage}${requestId ? `_${requestId.slice(0, 8)}` : ''}.json`;
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DEBUG_DIR, fileName),
        JSON.stringify({
          timestamp: now.toISOString(),
          stage,
          request_id: requestId,
          data
        }, null, 2)
      );
    } catch { /* SDK dump 写入失败不影响主流程 */ }
  }
}
