import type { Tool, ToolDefinition } from '../types/tool';
import { isWikiEpisodeRef, mondayWikiId, WikiMemoryHttpError, type MondayWikiMemory } from '../utils/monday-wiki-memory';

class WikiArgumentError extends Error {}
const SOURCE_PAGE_TEXT_CHARS = 12_000;
export const WIKI_SEARCH_KEYWORD_LIMIT = 16;

function searchKeywords(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length) {
    throw new WikiArgumentError('keywords 至少需要一个关键词。');
  }
  const distinct = new Set<string>();
  for (const [index, word] of input.entries()) {
    if (typeof word !== 'string' || !word.trim() || word.includes('\0')) {
      throw new WikiArgumentError(`keywords[${index}] 需要非空文本，且不能含空字符。`);
    }
    distinct.add(word.trim().replace(/[A-Z]/g, char => char.toLowerCase()));
  }
  if (distinct.size > WIKI_SEARCH_KEYWORD_LIMIT) {
    throw new WikiArgumentError(`每次最多 ${WIKI_SEARCH_KEYWORD_LIMIT} 个不同关键词。请按不同查找方向拆成多次搜索。`);
  }
  return [...distinct];
}

function readOffset(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WikiArgumentError(`${field} 必须是非负整数。请使用上次返回的续读位置。`);
  }
  return value;
}

function editDistance(input: string, target: string): number {
  let previous = Array.from({ length: target.length + 1 }, (_, i) => i);
  for (let i = 1; i <= input.length; i++) {
    const row = [i];
    for (let j = 1; j <= target.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(input[i - 1] !== target[j - 1]));
    }
    previous = row;
  }
  return previous[target.length];
}

export function wikiIdHint(input: string, knownIds: Iterable<string>): string {
  if (!/^(?:mem_)?[a-z0-9-]{32,42}$/i.test(input.trim())) return '';
  const normalized = input.trim().toLowerCase().replace(/^mem_/, '');
  const candidates = [...new Set(knownIds)]
    .filter(id => id !== input)
    .map(id => ({ id, distance: editDistance(normalized, id.toLowerCase().slice(4)) }));
  const closest = Math.min(2, ...candidates.map(candidate => candidate.distance));
  const matches = candidates.filter(candidate => candidate.distance === closest).slice(0, 3);
  return matches.length === 0 ? '' : ` 请核对是否要使用本轮已找到的 ${matches.map(match => match.id).join('、')}。`;
}

function describeWikiFailure(error: unknown, missing?: () => string): string {
  if (error instanceof WikiMemoryHttpError) {
    if (error.status === 404 && missing) return missing();
    if (error.status === 401 || error.status === 403) return `Bot 凭据未通过 Memory 验证（HTTP ${error.status}）。`;
    if (error.status === 503) return 'Memory 暂时不可用（HTTP 503）。';
    if (error.status === 504) return 'Memory 查询超时（HTTP 504）。搜索时可减少关键词，按方向分别查找。';
  }
  if (error instanceof Error && error.name === 'TimeoutError') return '请求 Memory 超时。';
  if (error instanceof Error && error.name === 'AbortError') return '请求已取消。';
  if (error instanceof TypeError) return '连接 Memory 失败。';
  return error instanceof Error ? error.message : '读取 Memory 失败。';
}

function tool(definition: ToolDefinition, call: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  describeMissing?: (args: Record<string, unknown>) => string): Tool {
  return {
    definition,
    async execute(input: unknown, context) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: `${definition.name} 需要一个 JSON 对象。`, retryable: true };
      }
      const args = { ...input };
      try {
        const result = await call(args, context?.abortSignal);
        return { ok: true, content: JSON.stringify(result) };
      } catch (error) {
        if (error instanceof WikiArgumentError) {
          return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: error.message, retryable: true };
        }
        const message = describeWikiFailure(error, describeMissing && (() => describeMissing(args)));
        const retryable = (error instanceof WikiMemoryHttpError && [404, 503, 504].includes(error.status))
          || (error instanceof Error && error.name === 'TimeoutError');
        return { ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: `${definition.name}：${message}`, retryable };
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
  knownWikiIds(): Iterable<string>;
  sourceRefs(id: string): string[] | undefined;
  onReadSource(id: string, ref: string): void;
}

export function wikiMemoryTools(memory: MondayWikiMemory, tracker: WikiEvidenceTracker): Tool[] {
  const content_trust = 'untrusted_branch_evidence';
  const wikiParam = { type: 'string', description: 'Wiki ID from search or a Wiki reference' };
  const wikiId = (value: unknown) => {
    if (typeof value !== 'string') throw new WikiArgumentError('wiki_id 必须是字符串。');
    if (!mondayWikiId.test(value)) {
      throw new WikiArgumentError('wiki_id 格式有误。请使用完整的 mem_ 加 UUID。' + wikiIdHint(value, tracker.knownWikiIds()));
    }
    return value;
  };
  return [
    tool({
      name: 'wiki_search',
      description: `按原文子串搜索本 Bot 的 Wiki，任一词命中即入选。每次最多 ${WIKI_SEARCH_KEYWORD_LIMIT} 个不同关键词，建议每个查找方向单独查询。返回前 30 篇及其命中词，前 10 篇附片段。`,
      parameters: {
        type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' } } },
        required: ['keywords'],
      },
    }, async ({ keywords }, signal) => {
      const result = await memory.search(searchKeywords(keywords), signal);
      if (!result || typeof result !== 'object' || !('retrieval_id' in result) ||
          typeof result.retrieval_id !== 'string' || !/^ret_[\da-f-]{36}$/i.test(result.retrieval_id) ||
          !('items' in result) || !Array.isArray(result.items)) throw new Error('Memory 的搜索响应缺少有效的 retrieval_id 或 items。');
      const hits = result.items.map((item: unknown, index): WikiSearchHit => {
        if (!item || typeof item !== 'object' || !('wiki_id' in item) ||
          typeof item.wiki_id !== 'string' || !mondayWikiId.test(item.wiki_id)) {
          throw new Error(`Memory 的搜索结果 items[${index}] 缺少有效的 Wiki ID。`);
        }
        const snippet = 'snippet' in item && typeof item.snippet === 'string' ? item.snippet : undefined;
        return { wiki_id: item.wiki_id, ...(snippet && { snippet }) };
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
      const result = await memory.read(id, signal);
      if (!result || typeof result !== 'object' || !('wiki_id' in result) || result.wiki_id !== id ||
          !('markdown' in result) || typeof result.markdown !== 'string' ||
          !('source_refs' in result) || !Array.isArray(result.source_refs) ||
          !result.source_refs.every(isWikiEpisodeRef)) throw new Error(`Memory 返回的 Wiki ${id} 正文或原文引用不完整。`);
      tracker.onRead(id, result.source_refs);
      return { ...result, content_trust };
    }, ({ wiki_id }) => {
      const id = wikiId(wiki_id);
      return `当前 Bot 无法读取 Wiki ${id}（HTTP 404）。` + wikiIdHint(id, tracker.knownWikiIds());
    }),
    tool({
      name: 'wiki_read_source',
      description: '按页读取原始会话。ref 使用 wiki_read 返回的 Episode 引用。用 next_offset 和 next_text_offset 继续读取，直到 next_offset 为 null。',
      parameters: {
        type: 'object',
        properties: { wiki_id: wikiParam, ref: { type: 'string' }, offset: { type: 'integer' }, text_offset: { type: 'integer' } },
        required: ['wiki_id', 'ref'],
      },
    }, async ({ wiki_id, ref, offset = 0, text_offset = 0 }, signal) => {
      const id = wikiId(wiki_id);
      if (!isWikiEpisodeRef(ref)) throw new WikiArgumentError(`Wiki ${id} 的 ref 必须使用 wiki_read 返回的完整 Episode 引用。`);
      const eventOffset = readOffset(offset, 'offset');
      const textOffset = readOffset(text_offset, 'text_offset');
      const refs = tracker.sourceRefs(id);
      if (!refs) throw new WikiArgumentError(`本轮还没打开 Wiki ${id}。请先调用 wiki_read。` + wikiIdHint(id, tracker.knownWikiIds()));
      if (!refs.includes(ref)) {
        const available = refs.length ? `可用的引用：${refs.join('、')}。` : '这篇 Wiki 未返回 Episode 引用。';
        throw new WikiArgumentError(`引用 ${ref} 不属于 Wiki ${id}。${available}`);
      }
      const result = await memory.source(id, ref, eventOffset, signal);
      if (!result || typeof result !== 'object' || !('ref' in result) || result.ref !== ref ||
          !('events' in result) || !Array.isArray(result.events)) throw new Error(`Memory 返回的原文页和 Wiki ${id} 的引用 ${ref} 不匹配。`);
      const events: Array<{ ref?: string; kind?: string; text: string }> = [];
      let remaining = SOURCE_PAGE_TEXT_CHARS;
      let nextOffset = 'next_offset' in result && typeof result.next_offset === 'number' ? result.next_offset : null;
      let nextTextOffset = 0;
      for (const [index, event] of result.events.entries()) {
        if (!event || typeof event !== 'object' || typeof event.text !== 'string') {
          throw new Error(`Memory 返回的原文 ${ref} 中，events[${index}] 缺少有效文本。`);
        }
        const start = index === 0 ? textOffset : 0;
        if (start > event.text.length) throw new WikiArgumentError(`原文 ${ref} 的 text_offset 超出事件长度。`);
        let end = Math.min(event.text.length, start + remaining);
        // Keep a surrogate pair together when returning only part of an event.
        const last = event.text.charCodeAt(end - 1);
        if (end > start && end < event.text.length && last >= 0xd800 && last <= 0xdbff) end--;
        if (end > start || end === event.text.length) events.push({
          ...('ref' in event && typeof event.ref === 'string' && { ref: event.ref }),
          ...('kind' in event && typeof event.kind === 'string' && { kind: event.kind }),
          text: event.text.slice(start, end),
        });
        remaining -= end - start;
        if (end < event.text.length) {
          nextOffset = eventOffset + index;
          nextTextOffset = end;
          break;
        }
      }
      if (events.some(event => event.text.trim())) tracker.onReadSource(id, ref);
      return { ref, events, next_offset: nextOffset, next_text_offset: nextTextOffset, content_trust };
    }, ({ wiki_id, ref }) => `当前 Bot 无法读取 Wiki ${wikiId(wiki_id)} 的原文 ${isWikiEpisodeRef(ref) ? ref : ''}（HTTP 404）。请重新读取 Wiki 确认原文引用。`),
  ];
}
