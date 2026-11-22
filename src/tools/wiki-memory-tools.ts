import type { Tool, ToolDefinition } from '../types/tool';
import { isWikiEpisodeRef, mondayWikiId, type MondayWikiMemory } from '../utils/monday-wiki-memory';

function tool(definition: ToolDefinition, call: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>): Tool {
  return {
    definition,
    async execute(input: unknown, context) {
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a JSON object');
        const result = await call({ ...input }, context?.abortSignal);
        return { ok: true, content: JSON.stringify(result) };
      } catch (error) {
        return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: error instanceof Error ? error.message : 'Wiki memory unavailable', retryable: false };
      }
    },
  };
}

export function wikiMemoryTools(memory: MondayWikiMemory, onRead: (id: string) => void, onSearch: (id: string, wikiIds: string[]) => void): Tool[] {
  const wikiParam = { type: 'string', description: 'Wiki ID from search or a Wiki reference' };
  const wikiId = (value: unknown) => {
    if (typeof value !== 'string' || !mondayWikiId.test(value)) throw new Error('Expected a Wiki ID');
    return value;
  };
  return [
    tool({
      name: 'wiki_search',
      description: '按关键词搜索本 Bot 的历史 Wiki。任一词命中即可入选。前 10 条带片段，再返回最多 20 个标题和 Wiki ID。可换词再搜。',
      parameters: { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' } } }, required: ['keywords'] },
    }, async ({ keywords }, signal) => {
      if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 16 ||
          !keywords.every((word: unknown): word is string => typeof word === 'string' && !!word.trim() && [...word].length <= 256)) {
        throw new Error('Expected 1–16 literal keywords');
      }
      const result = await memory.search(keywords, signal);
      if (!result || typeof result !== 'object' || !('retrieval_id' in result) ||
          typeof result.retrieval_id !== 'string' || !/^ret_[\da-f-]{36}$/i.test(result.retrieval_id) ||
          !('items' in result) || !Array.isArray(result.items)) throw new Error('Invalid Wiki search response');
      const wikiIds = result.items.map((item: unknown) => {
        if (!item || typeof item !== 'object' || !('wiki_id' in item)) throw new Error('Invalid Wiki search item');
        return wikiId(item.wiki_id);
      });
      onSearch(result.retrieval_id, wikiIds);
      return result;
    }),
    tool({
      name: 'wiki_read',
      description: '读取一篇 Wiki 的完整 Markdown 和原始 Episode 引用。引用它作为结论依据前先读取正文。',
      parameters: { type: 'object', properties: { wiki_id: wikiParam }, required: ['wiki_id'] },
    }, async ({ wiki_id }, signal) => {
      const id = wikiId(wiki_id);
      const result = await memory.read(id, signal);
      if (!result || typeof result !== 'object' || !('wiki_id' in result) || result.wiki_id !== id ||
          !('markdown' in result) || typeof result.markdown !== 'string') throw new Error('Invalid Wiki response');
      onRead(id);
      return result;
    }),
    tool({
      name: 'wiki_read_source',
      description: '核对一篇 Wiki 对应的原始会话片段。ref 使用 wiki_read 返回的 Episode 引用。有 next_offset 时可继续读取。',
      parameters: {
        type: 'object',
        properties: { wiki_id: wikiParam, ref: { type: 'string' }, offset: { type: 'integer' } },
        required: ['wiki_id', 'ref'],
      },
    }, ({ wiki_id, ref, offset = 0 }, signal) => {
      if (!isWikiEpisodeRef(ref) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('Expected an Episode ref and nonnegative offset');
      }
      return memory.source(wikiId(wiki_id), ref, offset, signal);
    }),
  ];
}
