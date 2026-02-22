import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { GauzMemService } from '../utils/gauzmem-service';
import { Logger } from '../utils/logger';

/**
 * Memory Search 工具 - 主动搜索 GauzMem 长期记忆
 *
 * 使用 ActiveSearchService（结构化 JSON），而非 passive recall（自然语言片段）。
 */
export class MemorySearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_search',
    description:
      '主动搜索长期记忆。可以搜索历史对话、用户偏好、历史决策等。' +
      '当用户问"之前讨论了什么"、"我们之前聊过 xxx 吗"等需要回忆历史时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询语句，描述你想回忆的内容',
        },
        top_k: {
          type: 'number',
          description: '返回的最大结果数（1-50，默认 5）',
        },
        graph_hops: {
          type: 'number',
          description: '图扩展跳数（0-3，默认 0 不扩展）。需要深挖关联时设为 1-2',
        },
        temporal_expand: {
          type: 'number',
          description: '前后扩展轮数（0-10，默认 0）。需要看上下文对话时设为 1-3',
        },
      },
      required: ['query'],
    },
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const { query, top_k = 5, graph_hops = 0, temporal_expand = 0 } = args;

    const normalizedQuery = (query || '').trim();
    if (!normalizedQuery) {
      return '错误: query 不能为空';
    }

    const gauzMem = GauzMemService.getInstance();

    if (!gauzMem.isAvailable()) {
      return '记忆服务当前不可用（未配置或暂时不可达）';
    }

    const topK = Math.max(1, Math.min(Number(top_k) || 5, 50));

    Logger.info(`[MemorySearch] 查询: ${normalizedQuery} (top_k=${topK}, graph_hops=${graph_hops}, temporal=${temporal_expand})`);

    try {
      const result = await gauzMem.activeSearch(normalizedQuery, {
        topK,
        graphHops: Number(graph_hops) || 0,
        temporalExpand: Number(temporal_expand) || 0,
      });

      if (!result || result.totalResults === 0) {
        return `未找到与「${normalizedQuery}」相关的记忆`;
      }

      const lines: string[] = [
        `找到 ${result.totalResults} 条相关记忆：`,
        '',
      ];

      for (const item of result.results) {
        lines.push(`- [fact#${item.fact_id}] ${item.content}`);

        if (item.source_chunk?.text) {
          lines.push(`  原文: ${item.source_chunk.text.slice(0, 200)}`);
        }

        if (item.related_facts?.length) {
          for (const rf of item.related_facts) {
            lines.push(`  → [${rf.relation_type}] ${rf.content}`);
          }
        }

        if (item.expanded_context?.length) {
          lines.push(`  上下文:`);
          for (const ctx of item.expanded_context) {
            lines.push(`    [${ctx.speaker} T${ctx.turn}] ${ctx.text.slice(0, 150)}`);
          }
        }
      }

      if (result.searchTimeMs !== null) {
        lines.push(`\n(搜索耗时: ${result.searchTimeMs.toFixed(1)}ms)`);
      }

      return lines.join('\n');
    } catch (err: any) {
      Logger.warning(`[MemorySearch] 查询失败: ${err.message}`);
      return `记忆搜索失败: ${err.message}`;
    }
  }
}
