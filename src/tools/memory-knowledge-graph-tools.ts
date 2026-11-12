import type { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';

/** Branch-local adapters keep discovery separate from complete graph disclosure. */
export class MemoryKnowledgeSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_knowledge_search',
    description: '按一个具体 literal 关键词搜索本 Agent 的日记图候选（非语义搜索）。只返回精确版本元数据，不能作正文引用；用 memory_knowledge_graph 读取必要条件和修正。',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  };
  constructor(private readonly search: (query: unknown, signal?: AbortSignal) => Promise<Record<string, unknown>>) {}
  async execute(args: any, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    return { ok: true, content: JSON.stringify(await this.search(args?.query, context?.abortSignal)) };
  }
}

export class MemoryKnowledgeGraphTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_knowledge_graph',
    description: '按本 run 搜索所得精确 ref 读取完整日记 Memory Graph。所有必要条件及补充/修正整体交付；超预算返回 reference_only，不能引用单条动作或元数据。读取与远端投影共享整轮预算。',
    parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  };
  constructor(private readonly read: (ref: string, signal?: AbortSignal) => Promise<Record<string, unknown>>) {}
  async execute(args: any, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    return { ok: true, content: JSON.stringify(await this.read(String(args?.ref ?? ''), context?.abortSignal)) };
  }
}
