import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { queryTurnLogs, TurnLogEntry } from '../utils/turn-log-store';

/**
 * RecallLog 工具 - 回忆之前的操作记录
 *
 * 让 agent 按需查询历史工具调用过程，而不是被动地把所有历史塞入上下文。
 */
export class RecallLogTool implements Tool {
    definition: ToolDefinition = {
        name: 'recall_log',
        description: `回忆之前的操作记录。当你需要查看历史操作细节时使用。

使用场景：
- 用户提到之前做过的事情（如"刚才那个论文"、"上次分析的结果"）
- 你需要查看之前某轮对话中使用了哪些工具、产出了哪些文件
- 用户要求你基于之前的操作继续工作

注意：
- 默认返回最近 5 轮的操作摘要
- 可用 query 按关键词筛选（匹配任务描述、工具名、文件名等）
- 返回的是摘要信息，不是完整的工具输出`,
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '搜索关键词，匹配任务描述、工具名、文件路径等。留空返回全部最近记录。',
                },
                turns_back: {
                    type: 'number',
                    description: '回溯几轮对话记录（默认 5，最大 20）',
                    default: 5,
                },
            },
            required: [],
        },
    };

    async execute(args: any, context: ToolExecutionContext): Promise<string> {
        const { query, turns_back = 5 } = args;
        const sessionId = context.sessionId;

        if (!sessionId) {
            return '无法获取当前会话 ID，recall_log 仅在会话中可用。';
        }

        const turnsBack = Math.min(Math.max(1, turns_back), 20);
        const entries = queryTurnLogs(sessionId, turnsBack, query || undefined);

        if (entries.length === 0) {
            if (query) {
                return `未找到与"${query}"相关的操作记录。最近 ${turnsBack} 轮内没有匹配的历史。`;
            }
            return '暂无历史操作记录。';
        }

        return this.formatEntries(entries);
    }

    private formatEntries(entries: TurnLogEntry[]): string {
        const parts: string[] = [];

        for (const entry of entries) {
            const lines: string[] = [];
            lines.push(`[第 ${entry.turnIndex} 轮 | ${this.formatTime(entry.timestamp)}]`);
            lines.push(`用户: ${entry.userMessage}`);

            if (entry.toolCalls.length > 0) {
                // 按工具名分组计数
                const toolGroups = new Map<string, number>();
                for (const tc of entry.toolCalls) {
                    toolGroups.set(tc.name, (toolGroups.get(tc.name) || 0) + 1);
                }
                const toolSummary = Array.from(toolGroups.entries())
                    .map(([name, count]) => count > 1 ? `${name}×${count}` : name)
                    .join(', ');
                lines.push(`工具调用: ${toolSummary}（共 ${entry.toolCalls.length} 次）`);

                // 展示每个工具调用的简要信息（最多展示 8 个）
                const shown = entry.toolCalls.slice(0, 8);
                for (const tc of shown) {
                    lines.push(`  - ${tc.name}(${tc.argsSummary}) → ${tc.resultSummary}`);
                }
                if (entry.toolCalls.length > 8) {
                    lines.push(`  ...还有 ${entry.toolCalls.length - 8} 次调用`);
                }
            }

            if (entry.outputFiles.length > 0) {
                lines.push(`产出文件: ${entry.outputFiles.join(', ')}`);
            }

            lines.push(`回复: ${entry.assistantReply}`);
            parts.push(lines.join('\n'));
        }

        return parts.join('\n\n');
    }

    private formatTime(isoTime: string): string {
        try {
            const d = new Date(isoTime);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } catch {
            return isoTime;
        }
    }
}
