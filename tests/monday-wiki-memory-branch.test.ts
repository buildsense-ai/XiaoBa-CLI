import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { mondayWikiMemory } from '../src/utils/monday-wiki-memory';
import type { AIService } from '../src/utils/ai-service';

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
      return Response.json({ retrieval_id, items: [{ wiki_id, title: 'Layout reflow' }], has_more: false });
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
    async chat(messages: unknown[], definitions: Array<{ name: string; parameters: unknown }>) {
      assert.equal(JSON.stringify(messages).includes('fixture-key'), false);
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

test('allows a verified search quote after an invented quote or a title-only citation is rejected', async () => {
  const wiki_id = 'mem_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const titleOnlyId = 'mem_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
  const retrieval_id = 'ret_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const laterRetrieval = 'ret_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
  const quote = 'Keep the selected node during reflow.';
  const summary = 'Preserve the selected node.';
  const candidate = { wiki_id, contribution: summary };
  const actions = [
    { name: 'wiki_search', args: { keywords: ['reflow'] } },
    { name: 'wiki_search', args: { keywords: ['layout'] } },
    { name: 'finish_wiki_search', args: { summary, evidence: [{ ...candidate, quote: 'Clear the selected node.' }] } },
    { name: 'finish_wiki_search', args: { summary, evidence: [{ ...candidate, wiki_id: titleOnlyId, quote }] } },
    { name: 'finish_wiki_search', args: { summary, evidence: [{ ...candidate, quote }] } },
  ];
  let step = 0;
  const ai = {
    isToolCallingSupported: () => true,
    async chat() {
      const action = actions[step++];
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
