import { createCatsCoLocalConfigService } from '../catscompany/local-config';

export const mondayWikiId = /^mem_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const episodeId = /^ep_[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function mondayWikiMemory(runtimeRoot: string, request = fetch) {
  const auth = createCatsCoLocalConfigService({ runtimeRoot }).getAuthState();
  const uid = auth.botUid?.replace(/^usr/, '');
  if (!uid || !/^[1-9][0-9]{0,18}$/.test(uid) || !auth.apiKey) return undefined;
  const headers = { authorization: 'ApiKey ' + auth.apiKey, 'x-bot-uid': uid };

  async function query(path: string, body: object | undefined, signal?: AbortSignal): Promise<unknown> {
    const deadline = AbortSignal.timeout(10_000);
    const response = await request('https://memory.catsco.cn:18443/v1/bot-memory' + path, {
      headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Wiki memory request failed (HTTP ' + response.status + ')');
    }
    return response.json();
  }

  return {
    search: (keywords: string[], signal?: AbortSignal) => query('/search', { keywords }, signal),
    read: (id: string, signal?: AbortSignal) => query('/wikis/' + id, undefined, signal),
    source: (id: string, ref: string, offset: number, signal?: AbortSignal) =>
      query('/wikis/' + id + '/source', { ref, offset, limit: 10 }, signal),
  };
}

export type MondayWikiMemory = NonNullable<ReturnType<typeof mondayWikiMemory>>;

export function isWikiEpisodeRef(value: unknown): value is string {
  return typeof value === 'string' && episodeId.test(value);
}
