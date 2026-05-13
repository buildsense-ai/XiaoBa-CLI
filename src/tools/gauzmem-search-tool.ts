import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { GauzMemClient } from '../utils/gauzmem-client';

export class GauzMemSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'gauzmem_search',
    description: '搜索 GauzMem 长期记忆 sidecar，返回本轮临时 memory bundle。服务不可用时不要重试阻塞主任务。',
    transcriptMode: 'transient',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要从 GauzMem 中检索的记忆问题或关键词。',
        },
        max_evidence: {
          type: 'number',
          description: '最多返回多少条 evidence，默认 12。',
          default: 12,
        },
        max_graph_hops: {
          type: 'number',
          description: '从命中 evidence 继续披露几跳 graph，默认 1。',
          default: 1,
        },
      },
      required: ['query'],
    },
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const query = String(args.query || '').trim();
    if (!query) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'query 不能为空',
        retryable: false,
      };
    }

    const client = new GauzMemClient();
    if (!client.enabled) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: 'GauzMem is disabled. Set GAUZMEM_ENABLED=true to use gauzmem_search.',
        retryable: false,
      };
    }

    const result = await client.toolSearch({
      query,
      sessionId: context.sessionId || 'unknown',
      sessionType: context.surface,
      maxEvidence: typeof args.max_evidence === 'number' ? args.max_evidence : 12,
      maxGraphHops: typeof args.max_graph_hops === 'number' ? args.max_graph_hops : 1,
    });
    if (result?.runId && context.gauzMemRunIds && !context.gauzMemRunIds.includes(result.runId)) {
      context.gauzMemRunIds.push(result.runId);
    }
    if (result?.runId && context.gauzMemRuns) {
      context.gauzMemRuns.push({
        runId: result.runId,
        query,
        toolCallId: context.toolCallId,
        evidenceIds: result.memoryBundle?.evidenceIds || [],
        edgeIds: result.memoryBundle?.edgeIds || [],
        stats: result.stats || {},
      });
    }

    const bundle = result?.memoryBundle?.text || result?.promptBundle;
    if (!bundle?.trim()) {
      return { ok: true, content: '[gauzmem_recall]\n(no memory found)\n[/gauzmem_recall]' };
    }
    return { ok: true, content: `runId: ${result?.runId}\n${bundle}` };
  }
}
