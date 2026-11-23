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

export interface WikiSearchHit {
  wiki_id: string;
  snippet?: string;
}

interface WikiEvidenceTracker {
  onRead(id: string, refs: string[]): void;
  onSearch(id: string, hits: WikiSearchHit[]): void;
  canReadSource(id: string, ref: string): boolean;
  onReadSource(id: string, ref: string): void;
}

export function wikiMemoryTools(memory: MondayWikiMemory, tracker: WikiEvidenceTracker): Tool[] {
  let searches = 0;
  let reads = 0;
  let sourceReads = 0;
  const content_trust = 'untrusted_branch_evidence';
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
      if (searches >= 2) throw new Error('搜索次数已用完。使用现有结果或结束检索。');
      searches++;
      const result = await memory.search(keywords, signal);
      if (!result || typeof result !== 'object' || !('retrieval_id' in result) ||
          typeof result.retrieval_id !== 'string' || !/^ret_[\da-f-]{36}$/i.test(result.retrieval_id) ||
          !('items' in result) || !Array.isArray(result.items)) throw new Error('Invalid Wiki search response');
      const hits = result.items.map((item: unknown): WikiSearchHit => {
        if (!item || typeof item !== 'object' || !('wiki_id' in item)) throw new Error('Invalid Wiki search item');
        const snippet = 'snippet' in item && typeof item.snippet === 'string' ? item.snippet : undefined;
        return { wiki_id: wikiId(item.wiki_id), ...(snippet && { snippet }) };
      });
      tracker.onSearch(result.retrieval_id, hits);
      return { ...result, content_trust };
    }),
    tool({
      name: 'wiki_read',
      description: '读取完整 Wiki 和 Episode 引用。搜索片段不完整或有歧义时用它核对。',
      parameters: { type: 'object', properties: { wiki_id: wikiParam }, required: ['wiki_id'] },
    }, async ({ wiki_id }, signal) => {
      const id = wikiId(wiki_id);
      if (reads >= 3) throw new Error('正文读取次数已用完。请结束检索。');
      reads++;
      const result = await memory.read(id, signal);
      if (!result || typeof result !== 'object' || !('wiki_id' in result) || result.wiki_id !== id ||
          !('markdown' in result) || typeof result.markdown !== 'string' ||
          !('source_refs' in result) || !Array.isArray(result.source_refs) ||
          !result.source_refs.every(isWikiEpisodeRef)) throw new Error('Invalid Wiki response');
      tracker.onRead(id, result.source_refs);
      return { ...result, content_trust };
    }),
    tool({
      name: 'wiki_read_source',
      description: '必要时核对一页原始会话。ref 使用 wiki_read 返回的 Episode 引用。长事件只展示预览。',
      parameters: {
        type: 'object',
        properties: { wiki_id: wikiParam, ref: { type: 'string' }, offset: { type: 'integer' } },
        required: ['wiki_id', 'ref'],
      },
    }, async ({ wiki_id, ref, offset = 0 }, signal) => {
      if (!isWikiEpisodeRef(ref) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('Expected an Episode ref and nonnegative offset');
      }
      const id = wikiId(wiki_id);
      if (!tracker.canReadSource(id, ref)) throw new Error('请先打开 Wiki 并使用它返回的原文引用。');
      if (sourceReads >= 1) throw new Error('原文核验次数已用完。请结束检索。');
      sourceReads++;
      const result = await memory.source(id, ref, offset, signal);
      if (!result || typeof result !== 'object' || !('ref' in result) || result.ref !== ref ||
          !('events' in result) || !Array.isArray(result.events)) throw new Error('Invalid Wiki source response');
      const events = result.events.slice(0, 10).map((event: unknown) => {
        if (!event || typeof event !== 'object') throw new Error('Invalid Wiki source event');
        const text = 'text' in event && typeof event.text === 'string' ? event.text : '';
        return {
          ...('ref' in event && typeof event.ref === 'string' && { ref: event.ref }),
          ...('kind' in event && typeof event.kind === 'string' && { kind: event.kind }),
          text: text.slice(0, 1200),
          ...(text.length > 1200 && { truncated: true }),
        };
      });
      if (events.some(event => event.text.trim())) tracker.onReadSource(id, ref);
      return { ref, events, next_offset: 'next_offset' in result ? result.next_offset : null, content_trust };
    }),
  ];
}
