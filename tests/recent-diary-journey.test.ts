import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChatResponse, Message, ToolDefinition } from '../src/types';

// Check the first model request for hidden prefetch, then follow the on-demand
// metadata page to its pinned body through the actual Go/Postgres API.
test('recent Diary is read on demand in the same turn, followed by an ordinary reply', {
  skip: !process.env.RECENT_DIARY_TEST_ORIGIN,
}, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-diary-journey-'));
  process.env.XIAOBA_USER_DATA_DIR = work;
  try {
    const [{ AgentTurnController }, { TurnContextBuilder }, { AIService }, { CatscoLogAgentClient }, { CatsLogKnowledgeRecallTool }] = await Promise.all([
      import('../src/core/agent-turn-controller'), import('../src/core/turn-context-builder'),
      import('../src/utils/ai-service'), import('../src/utils/catsco-log-agent-client'),
      import('../src/tools/catslog-knowledge-recall-tool'),
    ]);
    const client = new CatscoLogAgentClient(process.env.RECENT_DIARY_TEST_ORIGIN!);
    const token = process.env.RECENT_DIARY_TEST_TOKEN!;
    const queries: unknown[] = [];
    let reads = 0;
    const backend = {
      searchKnowledge: async (query: any, signal?: AbortSignal) => {
        queries.push(query);
        return client.searchKnowledge({ ...query, token, signal });
      },
      readKnowledge: async (query: any, signal?: AbortSignal) => {
        reads++;
        assert.ok(query.revision && query.entry_id);
        return client.readKnowledge({ ...query, token, signal });
      },
    };
    const native = new CatsLogKnowledgeRecallTool(backend);
    const requests: Message[][] = [];
    const usage = { promptTokens: 10, completionTokens: 3, totalTokens: 13 };
    function call(id: string, args: object): ChatResponse {
      return { content: null, toolCalls: [{ id, type: 'function', function: { name: native.definition.name, arguments: JSON.stringify(args) } }], usage };
    }
    class ScriptedModel extends AIService {
      override isToolCallingSupported() { return true; }
      override async chatStream(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
        requests.push(structuredClone(messages));
        assert.ok(!messages.some(m => typeof m.content === 'string' && m.content.startsWith('[recent_diary_candidates]\n')));
        if (requests.length === 1) {
          assert.equal(queries.length, 0, 'no lookup occurs before the model calls the tool');
          assert.ok(tools?.some(t => t.name === native.definition.name));
          return call('list-diary', { action: 'recent', limit: 1 });
        }
        if (requests.length === 2) {
          assert.equal(queries.length, 1);
          const message = messages.find(m => m.role === 'tool' && m.tool_call_id === 'list-diary');
          assert.equal(typeof message?.content, 'string');
          const page = JSON.parse(message!.content as string);
          assert.equal(page.hits.length, 1);
          assert.equal(page.exhausted, false);
          assert.ok(page.next_cursor);
          const hit = page.hits[0];
          assert.match(hit.title, /配音/);
          return call('read-diary', { action: 'read', document_id: hit.document_id, revision: hit.revision, entry_id: hit.entry_id });
        }
        if (requests.length === 3) {
          const read = messages.find(m => m.role === 'tool' && m.tool_call_id === 'read-diary');
          assert.equal(typeof read?.content, 'string');
          const result = JSON.parse(read!.content as string);
          assert.match(result.entries[0].text, /现有记录无法确认修复/);
          return { content: `60 秒片的配音是否修复仍待核实。${result.entries[0].ref}`, toolCalls: [], usage };
        }
        assert.equal(queries.length, 1, 'ordinary follow-up did not start another lookup');
        return { content: '收到。', toolCalls: [], usage };
      }
    }
    const ai = new ScriptedModel({ provider: 'openai', apiUrl: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: 'fake' });
    const controller = new AgentTurnController({
      sessionKey: 'recent-diary-journey', sessionType: 'cli', workspaceRoot: work,
      getCurrentDirectory: () => work, updateCurrentDirectory: () => undefined,
      services: {
        aiService: ai, catslogMemory: backend, skillManager: {} as any,
        toolManager: {
          getToolDefinitions: () => [native.definition],
          executeTool: async (call: any, _messages: any, context: any) => {
            const result = await native.execute(JSON.parse(call.function.arguments), context);
            return { role: 'tool', tool_call_id: call.id, name: native.definition.name, ...result };
          },
        } as any,
      },
      skillRuntime: { reloadSkills: async () => undefined, buildSkillsListMessage: () => null } as any,
      planRuntime: undefined as any, turnContextBuilder: new TurnContextBuilder(),
      turnLogRecorder: { recordTurn: () => undefined, startRun: () => undefined, recordEvent: () => undefined } as any,
    });
    const first = await controller.run({ input: '现在思考下我们最近有啥没完成的活', messages: [], runtimeFeedback: [], shouldContinue: () => true });
    assert.match(first.text, /配音是否修复仍待核实。catslog:knowledge:/);
    assert.equal(reads, 1);
    assert.equal(first.visibleToUser, true);
    const follow = await controller.run({ input: '谢谢', messages: first.messages, runtimeFeedback: [], shouldContinue: () => true });
    assert.equal(follow.text, '收到。');
    const lookupCount = queries.length;
    const combined = await native.execute({ action: 'search', any_of: ['配音', '故障'] }, {});
    assert.equal(combined.ok, true);
    const rankedDays = JSON.parse(combined.content!).hits.map((hit: { day: string }) => hit.day);
    assert.deepEqual(rankedDays, ['2026-11-16', '2026-10-08', '2026-10-12']);
    const search = async (args: object) => {
      const result = await native.execute({ action: 'search', ...args }, {});
      assert.equal(result.ok, true);
      return JSON.parse(result.content!);
    };
    const terms = { any_of: ['渲染', '字幕'] };
    const single = await search({ ...terms, limit: 1 });
    const full = await search({ ...terms, limit: 10 });
    assert.equal(single.hits[0].title, '渲染字幕失败');
    assert.equal(single.hits[0].ref, full.hits[0].ref);
    assert.deepEqual(single.hits[0].matched_terms, terms.any_of);
    const next = await search({ ...terms, limit: 1, cursor: single.next_cursor });
    assert.equal(next.hits[0].ref, full.hits[1].ref);
    const phrase = { query: terms.any_of.join(' '), limit: 1 };
    const fallback = await search(phrase);
    assert.equal(fallback.hits[0].ref, single.hits[0].ref);
    const resumed = await search({ ...phrase, cursor: fallback.next_cursor });
    assert.equal(resumed.hits[0].ref, next.hits[0].ref);
    // No link or known correction date: start from the next event day and read the newer result.
    const from = new Date(single.hits[0].day + 'T00:00:00Z');
    from.setUTCDate(from.getUTCDate() + 1);
    const newer = await search({ ...terms, date_from: from.toISOString().slice(0, 10) });
    const correction = newer.hits.find((hit: { title: string }) => hit.title === '交付验收');
    assert.ok(correction);
    const checked = await native.execute({ action: 'read', document_id: correction.document_id, entry_id: correction.entry_id, revision: correction.revision }, {});
    assert.match(JSON.parse(checked.content!).entries[0].text, /已修复，验收通过/);
    if (process.env.RECENT_DIARY_CLIENT_REPORT) {
      fs.writeFileSync(process.env.RECENT_DIARY_CLIENT_REPORT, JSON.stringify({ answer: first.text, model_requests: requests.length, lookups: lookupCount, pinned_reads: reads, follow_up: follow.text, prefetch: false, keyword_ranked_days: rankedDays, corrected_status_ref: correction.ref, first_at_both_limits: single.hits[0].ref }, null, 2) + '\n', { mode: 0o600 });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
