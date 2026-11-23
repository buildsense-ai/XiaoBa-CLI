import type { Tool, ToolDefinition } from '../types/tool';
import { isWikiEpisodeRef, mondayWikiId, WikiMemoryHttpError, type MondayWikiMemory } from '../utils/monday-wiki-memory';

class WikiArgumentError extends Error {}

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
        const retryable = (error instanceof WikiMemoryHttpError && (error.status === 404 || error.status === 503))
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
  let searches = 0;
  let reads = 0;
  let readAttempts = 0;
  let sourceReads = 0;
  let sourceAttempts = 0;
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
      description: '按关键词搜索本 Bot 的历史 Wiki。任一词命中即可入选。前 10 条带片段，再返回最多 20 个标题和 Wiki ID。可换词再搜。',
      parameters: { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' } } }, required: ['keywords'] },
    }, async ({ keywords }, signal) => {
      if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 16) {
        throw new WikiArgumentError('keywords 需要包含 1 至 16 个关键词。');
      }
      const invalid = keywords.findIndex((word: unknown) =>
        typeof word !== 'string' || !word.trim() || word.includes('\0') || [...word].length > 256);
      if (invalid !== -1) throw new WikiArgumentError(`keywords[${invalid}] 需要非空文本，最多 256 个字符，且不能含空字符。`);
      if (searches >= 2) throw new Error('搜索次数已用完。使用现有结果或结束检索。');
      searches++;
      const result = await memory.search(keywords, signal);
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
      if (reads >= 3 || readAttempts >= 4) throw new Error('正文读取次数已用完。请结束检索。');
      readAttempts++;
      const result = await memory.read(id, signal);
      if (!result || typeof result !== 'object' || !('wiki_id' in result) || result.wiki_id !== id ||
          !('markdown' in result) || typeof result.markdown !== 'string' ||
          !('source_refs' in result) || !Array.isArray(result.source_refs) ||
          !result.source_refs.every(isWikiEpisodeRef)) throw new Error(`Memory 返回的 Wiki ${id} 正文或原文引用不完整。`);
      reads++;
      tracker.onRead(id, result.source_refs);
      return { ...result, content_trust };
    }, ({ wiki_id }) => {
      const id = wikiId(wiki_id);
      return `当前 Bot 无法读取 Wiki ${id}（HTTP 404）。` + wikiIdHint(id, tracker.knownWikiIds());
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
      const id = wikiId(wiki_id);
      if (!isWikiEpisodeRef(ref)) throw new WikiArgumentError(`Wiki ${id} 的 ref 必须使用 wiki_read 返回的完整 Episode 引用。`);
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
        throw new WikiArgumentError(`Wiki ${id} 的 offset 必须是非负整数。请使用上一页的 next_offset。`);
      }
      const refs = tracker.sourceRefs(id);
      if (!refs) throw new WikiArgumentError(`本轮还没打开 Wiki ${id}。请先调用 wiki_read。` + wikiIdHint(id, tracker.knownWikiIds()));
      if (!refs.includes(ref)) {
        const available = refs.length ? `可用的引用：${refs.join('、')}。` : '这篇 Wiki 未返回 Episode 引用。';
        throw new WikiArgumentError(`引用 ${ref} 不属于 Wiki ${id}。${available}`);
      }
      if (sourceReads >= 1 || sourceAttempts >= 2) throw new Error('原文核验次数已用完。请结束检索。');
      sourceAttempts++;
      const result = await memory.source(id, ref, offset, signal);
      if (!result || typeof result !== 'object' || !('ref' in result) || result.ref !== ref ||
          !('events' in result) || !Array.isArray(result.events)) throw new Error(`Memory 返回的原文页和 Wiki ${id} 的引用 ${ref} 不匹配。`);
      const events = result.events.slice(0, 10).map((event: unknown, index) => {
        if (!event || typeof event !== 'object') throw new Error(`Memory 返回的原文 ${ref} 中，events[${index}] 格式有误。`);
        const text = 'text' in event && typeof event.text === 'string' ? event.text : '';
        return {
          ...('ref' in event && typeof event.ref === 'string' && { ref: event.ref }),
          ...('kind' in event && typeof event.kind === 'string' && { kind: event.kind }),
          text: text.slice(0, 1200),
          ...(text.length > 1200 && { truncated: true }),
        };
      });
      sourceReads++;
      if (events.some(event => event.text.trim())) tracker.onReadSource(id, ref);
      return { ref, events, next_offset: 'next_offset' in result ? result.next_offset : null, content_trust };
    }, ({ wiki_id, ref }) => `当前 Bot 无法读取 Wiki ${wikiId(wiki_id)} 的原文 ${isWikiEpisodeRef(ref) ? ref : ''}（HTTP 404）。请重新读取 Wiki 确认原文引用。`),
  ];
}
