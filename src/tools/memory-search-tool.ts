import { Tool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { GauzMemService } from '../utils/gauzmem-service';
import { Logger } from '../utils/logger';

/**
 * Memory Search 工具 - 主动搜索 GauzMem 长期记忆
 *
 * 让 AI 可以主动查询历史记忆。
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
          description: '返回的最大种子数（1-50，默认 15）',
        },
      },
      required: ['query'],
    },
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<string> {
    const { query, top_k = 15 } = args;

    const normalizedQuery = (query || '').trim();
    if (!normalizedQuery) {
      return '错误: query 不能为空';
    }

    const gauzMem = GauzMemService.getInstance();

    if (!gauzMem.isAvailable()) {
      return '记忆服务当前不可用（未配置或暂时不可达）';
    }

    const topK = Math.max(1, Math.min(Number(top_k) || 15, 50));

    Logger.info(`[MemorySearch] 查询: ${normalizedQuery} (top_k=${topK})`);

    try {
      const result = await gauzMem.recallWithMetadata(normalizedQuery, {
        maxSeeds: topK,
      });

      if (!result || !result.recall || result.factsCount === 0) {
        return `未找到与「${normalizedQuery}」相关的记忆`;
      }

      // 格式化输出
      const lines: string[] = [
        `查询: ${normalizedQuery}`,
        `找到 ${result.factsCount} 条相关记忆，${result.subgraphCount} 个关联子图：`,
        '',
        result.recall,
      ];

      // 添加元信息
      if (result.latencyMs !== null) {
        lines.push(`\n(搜索耗时: ${result.latencyMs.toFixed(1)}ms)`);
      }

      return lines.join('\n');
    } catch (err: any) {
      Logger.warning(`[MemorySearch] 查询失败: ${err.message}`);
      return `记忆搜索失败: ${err.message}`;
    }
  }
}
