import { createCatsCoLocalConfigService } from '../catscompany/local-config';

export const mondayWikiId = /^mem_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const episodeId = /^ep_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export class WikiMemoryHttpError extends Error {
  constructor(readonly status: number) {
    super(`Memory 返回 HTTP ${status}`);
  }
}

export function mondayWikiMemory(runtimeRoot: string, request = fetch) {
  const { apiKey } = createCatsCoLocalConfigService({ runtimeRoot }).getAuthState();
  if (!apiKey) return undefined;
  const headers = { authorization: 'ApiKey ' + apiKey };

  async function query(path: string, body: object | undefined, signal?: AbortSignal): Promise<unknown> {
    const deadline = AbortSignal.timeout(15_000);
    const response = await request('https://memory.catsco.cn:18443/v1/bot-memory' + path, {
      headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WikiMemoryHttpError(response.status);
    }
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Memory 返回的内容不是有效 JSON。');
      throw error;
    }
  }

  return {
    search: (keywords: string[], signal?: AbortSignal, offset = 0) =>
      query('/search', { keywords, ...(offset > 0 && { offset }) }, signal),
    read: (id: string, signal?: AbortSignal) => query('/wikis/' + id, undefined, signal),
    source: (id: string, ref: string, offset: number, signal?: AbortSignal) =>
      query('/wikis/' + id + '/source', { ref, offset, limit: 10 }, signal),
  };
}

export type MondayWikiMemory = NonNullable<ReturnType<typeof mondayWikiMemory>>;

export function isWikiEpisodeRef(value: unknown): value is string {
  return typeof value === 'string' && episodeId.test(value);
}
