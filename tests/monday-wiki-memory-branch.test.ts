import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { wikiMemoryTools } from '../src/tools/wiki-memory-tools';
import { mondayWikiMemory, WikiMemoryHttpError } from '../src/utils/monday-wiki-memory';
import type { AIService } from '../src/utils/ai-service';
import type { Message } from '../src/types';

test('the dedicated Wiki branch injects only read evidence with verified source and retrieval refs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'monday-wiki-branch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originalUid = process.env.CATSCO_BOT_UID;
  const originalKey = process.env.CATSCO_API_KEY;
  process.env.CATSCO_BOT_UID = 'stale-bot-uid';
  process.env.CATSCO_API_KEY = 'fixture-key';
  t.after(() => {
    if (originalUid === undefined) delete process.env.CATSCO_BOT_UID;
    else process.env.CATSCO_BOT_UID = originalUid;
    if (originalKey === undefined) delete process.env.CATSCO_API_KEY;
    else process.env.CATSCO_API_KEY = originalKey;
  });

  const wiki_id = 'mem_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const ref = 'ep_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const retrieval_id = 'ret_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const requested: string[] = [];
  const provider = mondayWikiMemory(root, async (url, options) => {
    const route = new URL(String(url)).pathname;
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('authorization'), 'ApiKey fixture-key');
    assert.equal(headers.get('x-bot-uid'), null);
    requested.push(route);
    if (route.endsWith('/search')) {
      assert.deepEqual(JSON.parse(String(options?.body)), { keywords: ['anchor', 'reflow'] });
      return Response.json({
        retrieval_id, has_more: false,
        items: [{ wiki_id, title: 'Layout reflow', matched_keywords: ['reflow'], matched_keyword_count: 1 }],
      });
    }
    if (route.endsWith('/source')) {
      assert.deepEqual(JSON.parse(String(options?.body)), { ref, offset: 0, limit: 10 });
      return Response.json({ ref, events: [{ text: 'Reflow must keep the selected node.' }], next_offset: null });
    }
    return Response.json({ wiki_id, markdown: '# Layout reflow', source_refs: [ref] });
  });
  assert.ok(provider);
  const actions = [
    { name: 'wiki_search', args: { keywords: ['anchor', 'reflow'] } },
    { name: 'finish_wiki_search', args: { summary: 'Premature.', evidence: [{ wiki_id, contribution: 'Not yet read.' }] } },
    { name: 'wiki_read', args: { wiki_id } },
    { name: 'wiki_read_source', args: { wiki_id, ref } },
    { name: 'finish_wiki_search', args: { summary: 'Keep the selected node during reflow.', evidence: [{ wiki_id, contribution: 'Reflow preserves the selected node.' }] } },
  ];
  const queue = new InMemorySyntheticObservationQueue();
  let step = 0;
  const ai = {
    isToolCallingSupported: () => true,
    async chat(messages: Message[], definitions: Array<{ name: string; parameters: unknown }>) {
      assert.equal(JSON.stringify(messages).includes('fixture-key'), false);
      if (step === 1) {
        const searchResult = JSON.parse(String(messages.filter(message => message.role === 'tool').at(-1)?.content));
        assert.deepEqual(searchResult.items[0].matched_keywords, ['reflow']);
        assert.equal(searchResult.items[0].matched_keyword_count, 1);
      }
      if (step === 2) {
        const rejection = String(messages.filter(message => message.role === 'tool').at(-1)?.content);
        assert.ok(rejection.includes(`evidence[0]（${wiki_id}）`));
        assert.match(rejection, /只看到了标题.*wiki_read/);
      }
      const action = actions[step++];
      assert.ok(action);
      assert.ok(definitions.find(definition => definition.name === action.name));
      assert.deepEqual(definitions.map(definition => definition.name).sort(), ['finish_wiki_search', 'wiki_read', 'wiki_read_source', 'wiki_search']);
      assert.doesNotMatch(JSON.stringify(definitions.find(definition => definition.name === action.name)?.parameters), /bot_uid|authorization/);
      return {
        content: null,
        toolCalls: [{ id: 'call-' + step, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) } }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
  await startMemorySidecarBranch({
    sessionKey: 'wiki-branch', input: 'Keep the selected node', recentMessages: [], workingDirectory: root,
    aiService: ai as unknown as AIService, queue, kind: 'wiki', wikiMemory: provider, logEnabled: false,
  }).done;
  assert.deepEqual(requested, ['/v1/bot-memory/search', '/v1/bot-memory/wikis/' + wiki_id, '/v1/bot-memory/wikis/' + wiki_id + '/source']);
  const [observation] = queue.drain();
  assert.ok(observation?.formattedContent);
  assert.deepEqual(JSON.parse(observation.formattedContent).wiki_refs, [{
    wiki_id, retrieval_id, source_refs: [ref], checked_source_refs: [ref], contribution: 'Reflow preserves the selected node.',
    evidence_level: 'wiki_body',
  }]);
});

test('reports each invalid citation and accepts a corrected finish after stray text', async () => {
  const wiki_id = 'mem_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const mistypedId = 'mem_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef';
  const titleOnlyId = 'mem_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
  const retrieval_id = 'ret_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const laterRetrieval = 'ret_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
  const quote = 'Keep the selected node during reflow.';
  const summary = 'Preserve the selected node.';
  const candidate = { wiki_id, contribution: summary };
  const actions = [
    { name: 'wiki_search', args: { keywords: ['reflow'] } },
    { name: 'wiki_search', args: { keywords: ['layout'] } },
    { name: 'finish_wiki_search', args: { summary, evidence: [
      { ...candidate, quote: 'Clear the selected node.' },
      { ...candidate, wiki_id: titleOnlyId, quote },
      { ...candidate, wiki_id: mistypedId, quote },
    ] } },
    null,
    { name: 'finish_wiki_search', args: { summary, evidence: [{ ...candidate, quote }] } },
  ];
  let step = 0;
  const ai = {
    isToolCallingSupported: () => true,
    async chat(messages: Message[]) {
      if (step === 3) {
        const rejection = String(messages.filter(message => message.role === 'tool').at(-1)?.content);
        assert.ok(rejection.includes(`evidence[0]（${wiki_id}） 的 quote 与该 Wiki 的命中片段不一致`));
        assert.ok(rejection.includes(`evidence[1]（${titleOnlyId}） 只看到了标题`));
        assert.ok(rejection.includes(`evidence[2]（${mistypedId}） 本轮没有搜到或打开过`));
        assert.ok(rejection.includes(`请核对是否要使用本轮已找到的 ${wiki_id}`));
      }
      if (step === 4) assert.match(String(messages.at(-1)?.content), /请立即用 finish_wiki_search/);
      const action = actions[step++];
      if (action === null) return { content: summary };
      assert.ok(action);
      return { content: null, toolCalls: [{
        id: 'call-' + step, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) },
      }] };
    },
  };
  const queue = new InMemorySyntheticObservationQueue();
  await startMemorySidecarBranch({
    sessionKey: 'wiki-snippet', input: 'Which node stays selected?', recentMessages: [],
    workingDirectory: tmpdir(), aiService: ai as unknown as AIService, queue, kind: 'wiki', logEnabled: false,
    wikiMemory: {
      search: async keywords => keywords.includes('reflow')
        ? { retrieval_id, items: [{ wiki_id, title: 'Layout reflow', snippet: quote }] }
        : { retrieval_id: laterRetrieval, items: [{ wiki_id, title: 'Layout reflow' }, { wiki_id: titleOnlyId, title: quote }] },
      read: async () => assert.fail('The snippet supports this fact without opening the Wiki'),
      source: async () => assert.fail('No original source lookup was requested'),
    },
  }).done;
  assert.equal(step, actions.length);
  const [observation] = queue.drain();
  assert.ok(observation?.formattedContent);
  assert.deepEqual(JSON.parse(observation.formattedContent).wiki_refs, [{
    ...candidate, retrieval_id, evidence_level: 'search_snippet', quote,
  }]);
});

test('points read failures to the known Wiki or Episode and distinguishes credential errors', async () => {
  const wikiId = 'mem_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const mistypedId = 'mem_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef';
  const unrelatedId = 'mem_ffffffff-ffff-ffff-ffff-ffffffffffff';
  const sourceRef = 'ep_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const wrongRef = 'ep_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef';
  const [search, read, source] = wikiMemoryTools({
    search: async () => { throw new WikiMemoryHttpError(401); },
    read: async () => { throw new WikiMemoryHttpError(404); },
    source: async () => assert.fail('Bad source arguments must be rejected before HTTP'),
  }, {
    knownWikiIds: () => [wikiId, unrelatedId],
    sourceRefs: id => id === wikiId ? [sourceRef] : undefined,
    onSearch() {},
    onRead() {},
    onReadSource() {},
  });
  const context = { workingDirectory: tmpdir(), conversationHistory: [] };
  const typo = await read.execute({ wiki_id: mistypedId }, context);
  assert.equal(typo.ok, false);
  if (typo.ok) return;
  assert.ok(typo.message.includes(mistypedId));
  assert.ok(typo.message.includes(wikiId));
  assert.ok(!typo.message.includes(unrelatedId));

  const episode = await source.execute({ wiki_id: wikiId, ref: wrongRef }, context);
  assert.equal(episode.ok, false);
  if (episode.ok) return;
  assert.ok(episode.message.includes(wrongRef));
  assert.ok(episode.message.includes(sourceRef));

  const badKeyword = await search.execute({ keywords: ['layout', ''] }, context);
  assert.equal(badKeyword.ok, false);
  if (badKeyword.ok) return;
  assert.match(badKeyword.message, /keywords\[1\]/);

  const credential = await search.execute({ keywords: ['layout'] }, context);
  assert.equal(credential.ok, false);
  if (credential.ok) return;
  assert.match(credential.message, /Bot 凭据.*HTTP 401/);
});

test('keeps searching and reading after the former quotas and can finish a long source event', async () => {
  const wikiId = 'mem_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const mistypedId = 'mem_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef';
  const ref = 'ep_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const retrieval_id = 'ret_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const longText = 'a'.repeat(11_999) + '😊' + 'b'.repeat(1_000);
  let sourceRequests = 0;
  const requestedSearches: string[][] = [];
  const [search, read, source] = wikiMemoryTools({
    search: async keywords => {
      requestedSearches.push(keywords);
      return { retrieval_id, items: [{ wiki_id: wikiId }], has_more: false };
    },
    read: async id => {
      if (id !== wikiId) throw new WikiMemoryHttpError(404);
      return { wiki_id: id, markdown: '# Evidence', source_refs: [ref] };
    },
    source: async (_id, _ref, offset) => {
      if (++sourceRequests === 1) throw new WikiMemoryHttpError(503);
      return offset === 0 ? { ref, events: [{ text: longText }], next_offset: 1 }
        : { ref, events: [{ text: 'Final event' }], next_offset: null };
    },
  }, {
    knownWikiIds: () => [wikiId], sourceRefs: () => [ref],
    onSearch() {}, onRead() {}, onReadSource() {},
  });
  const context = { workingDirectory: tmpdir(), conversationHistory: [] };
  const keywords = Array.from({ length: 15 }, (_, i) => `keyword-${i}`);
  const overLimit = await search.execute({ keywords: [...keywords, 'one', 'two'] }, context);
  assert.equal(overLimit.ok, false);
  if (!overLimit.ok) assert.match(overLimit.message, /16 个不同关键词/);
  assert.equal(requestedSearches.length, 0);
  for (let i = 0; i < 3; i++) {
    assert.ok((await search.execute({ keywords: [' KEYWORD-0 ', ...keywords, `refine-${i}`] }, context)).ok);
  }
  assert.deepEqual(requestedSearches.map(words => words.at(-1)), ['refine-0', 'refine-1', 'refine-2']);
  assert.ok(requestedSearches.every(words => words.length === 16));
  for (let n = 0; n < 3; n++) assert.equal((await read.execute({ wiki_id: wikiId }, context)).ok, true);
  assert.equal((await read.execute({ wiki_id: mistypedId }, context)).ok, false);
  assert.equal((await read.execute({ wiki_id: wikiId }, context)).ok, true);
  assert.equal((await source.execute({ wiki_id: wikiId, ref }, context)).ok, false);
  const text: string[] = [];
  let offset: number | null = 0;
  let text_offset = 0;
  for (let page = 0; page < 3; page++) {
    const result = await source.execute({ wiki_id: wikiId, ref, offset, text_offset }, context);
    assert.ok(result.ok);
    const parsed = JSON.parse(result.content);
    text.push(parsed.events[0].text);
    offset = parsed.next_offset;
    text_offset = parsed.next_text_offset;
  }
  assert.equal(text[0].length, 11_999);
  assert.equal(text.slice(0, 2).join(''), longText);
  assert.equal(text[2], 'Final event');
  assert.equal(offset, null);
});

test('allows retrieval after turn 50 and three final submissions to correct an error', async () => {
  const wiki_id = 'mem_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const retrieval_id = 'ret_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const quote = 'Keep the selected node.';
  const queue = new InMemorySyntheticObservationQueue();
  let turn = 0;
  let searchRequests = 0;
  const ai = {
    isToolCallingSupported: () => true,
    async chat(messages: Message[], definitions: Array<{ name: string }>) {
      turn++;
      const name = turn <= 52 ? 'wiki_search' : 'finish_wiki_search';
      assert.ok(definitions.some(definition => definition.name === name));
      const errors = messages.filter(message => message.role === 'tool');
      if (turn > 53) assert.match(String(errors.at(-1)?.content), new RegExp(`还可以修正并重新提交 ${57 - turn} 次`));

      const args = turn <= 52 ? JSON.stringify({ keywords: [turn === 52 ? 'selected node' : ''] })
        : turn === 53 ? '{' // Malformed JSON counts as a finalization failure too.
        : turn === 54 ? JSON.stringify({ summary: quote })
        : JSON.stringify({ summary: quote, evidence: [{ wiki_id, contribution: quote, quote: turn === 55 ? 'wrong quote' : quote }] });
      return { content: null, toolCalls: [{ id: `call-${turn}`, type: 'function', function: { name, arguments: args } }] };
    },
  };
  await startMemorySidecarBranch({
    sessionKey: 'wiki-finish-at-budget', input: 'Which node stays selected?', recentMessages: [],
    workingDirectory: tmpdir(), aiService: ai as unknown as AIService, queue, kind: 'wiki', logEnabled: false,
    wikiMemory: {
      search: async () => {
        searchRequests++;
        return { retrieval_id, items: [{ wiki_id, title: 'Node selection', snippet: quote }] };
      },
      read: async () => assert.fail('Unexpected Wiki read'),
      source: async () => assert.fail('Unexpected source read'),
    },
  }).done;
  assert.equal(searchRequests, 1);
  assert.equal(turn, 56);
  assert.deepEqual(queue.drain().map(observation => observation.summary), [quote]);
});

test('stops after the fourth invalid finish call and injects no partial evidence', async () => {
  const queue = new InMemorySyntheticObservationQueue();
  let attempts = 0;
  const ai = {
    isToolCallingSupported: () => true,
    async chat() {
      attempts++;
      return { content: null, toolCalls: [{ id: `finish-${attempts}`, type: 'function', function: {
        name: 'finish_wiki_search', arguments: JSON.stringify({ summary: 'Unsupported', evidence: [{}] }),
      } }] };
    },
  };
  await startMemorySidecarBranch({
    sessionKey: 'wiki-invalid-finish', input: 'Find memory', recentMessages: [], workingDirectory: tmpdir(),
    aiService: ai as unknown as AIService, queue, kind: 'wiki', logEnabled: false,
    wikiMemory: {
      search: async () => assert.fail('Unexpected search'),
      read: async () => assert.fail('Unexpected Wiki read'),
      source: async () => assert.fail('Unexpected source read'),
    },
  }).done;
  assert.equal(attempts, 4);
  assert.deepEqual(queue.drain(), []);
});
