import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';
import { classifyLocalToolRisk } from '../src/tools/local-tool-risk';
import { CatsLogMemoryUnavailableError } from '../src/utils/catslog-memory-provider';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';
import type { ToolExecutionContext } from '../src/types/tool';

const DOC = 'akd-' + 'a'.repeat(24);
const ENTRY = 'ake-' + 'b'.repeat(24);
const REV = 'akr-' + 'c'.repeat(64);

/** Minimal fake backend recording calls and replaying scripted results. */
function fakeBackend(overrides: Partial<CatsLogMemoryBackend> = {}): CatsLogMemoryBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isAvailable: () => true,
    isKnowledgeRecallAvailable: () => true,
    searchKnowledge: async (query: any) => {
      calls.push(`search:${JSON.stringify(query)}`);
      return {
        hits: [{
          document_id: DOC, day: '2026-10-07', entry_id: ENTRY,
          title: 'T', status: 'active', revision: REV,
        }],
        next_cursor: 'opaque-cursor-✓',
        exhausted: false,
      };
    },
    readKnowledge: async (query: any) => {
      calls.push(`read:${JSON.stringify(query)}`);
      if (query.format === 'okf') return { format: 'okf' as const, body: '# OKF' };
      return {
        format: 'json' as const,
        page: {
          document_id: DOC, revision: REV, day: '2026-10-07',
          generated_at: '2026-10-07T22:14:09Z', generated_by: 'w',
          entries: [], next_cursor: 'entries-cursor-2', exhausted: false,
        },
      };
    },
    expandKnowledge: async (query: any) => {
      calls.push(`expand:${JSON.stringify(query)}`);
      return { edges: [], exhausted: true };
    },
    querySessions: async (query: any) => {
      calls.push(`history:${JSON.stringify(query)}`);
      return { records: [{ ref: 'stream#1' }], next_cursor: 'hist-cursor' };
    },
    ...overrides,
  } as any;
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    surface: 'cli',
    permissionProfile: 'default',
    conversationHistory: [],
    ...overrides,
  } as ToolExecutionContext;
}

describe('catslog_knowledge_recall tool', () => {
  test('grp_7445: phrase miss and explicit alternatives recover distinct, attributed entries', async () => {
    const calls: string[] = [];
    const tool = new CatsLogKnowledgeRecallTool(fakeBackend({ searchKnowledge: async q => {
      calls.push(q.query ?? JSON.stringify(q.any_of));
      assert.equal(q.date_from, '2026-11-01');
      return { exhausted: true, hits: q.any_of ? [{ matched_terms: q.any_of.filter(t => ['未完成','待办','下一步'].includes(t)), document_id: DOC, entry_id: ENTRY, day: '2026-11-15', revision: REV, title: 'fixture', status: 'draft' }] : [] };
    } }));
    for (const query of ['未完成 待办 待跟进 TODO', '未完成 待续 下一步 跟进']) {
      for (const args of [{ query }, { any_of: query.split(' ') }]) {
        calls.length = 0;
        const result = await tool.execute({ action: 'search', date_from: '2026-11-01', ...args }, context());
        const page = JSON.parse(String(result.content));
        assert.equal(page.hits.length, 1);
        assert.equal(page.hits[0].matched_terms.length, 2);
        assert.equal(page.recall_attribution.sources.length, 1);
        assert.equal(page.exhausted, true);
        assert.ok(calls.length <= 5);
      }
    }
  });

  test('alternative search preserves its server cursor and accepts continuation', async () => {
    const tool = new CatsLogKnowledgeRecallTool(fakeBackend());
    const result = await tool.execute({action:'search', any_of:['a','b'], limit:1}, context());
    const page = JSON.parse(String(result.content));
    assert.equal(page.exhausted,false);
    assert.equal(page.next_cursor,'opaque-cursor-✓');
    assert.equal((await tool.execute({action:'search',any_of:['a','b'],cursor:page.next_cursor},context())).ok,true);
  });

  test('search passes cursors byte-exact and reports pagination faithfully', async () => {
    const backend = fakeBackend();
    const tool = new CatsLogKnowledgeRecallTool(backend);
    const result = await tool.execute({
      action: 'search', query: 'q', cursor: 'opaque-cursor-✓', limit: 5,
    }, context());
    assert.equal(result.ok, true);
    const parsed = JSON.parse(String(result.content));
    assert.equal(parsed.next_cursor, 'opaque-cursor-✓');
    assert.equal(parsed.exhausted, false);
    assert.match(parsed.note, /next_cursor/);
    const sent = JSON.parse(backend.calls[0].slice('search:'.length));
    assert.equal(sent.cursor, 'opaque-cursor-✓');
  });

  test('read json pages honestly; read okf returns the raw markdown body', async () => {
    const backend = fakeBackend();
    const tool = new CatsLogKnowledgeRecallTool(backend);
    const jsonResult = await tool.execute({ action: 'read', document_id: DOC, revision: REV, entry_id: ENTRY }, context());
    const parsed = JSON.parse(String(jsonResult.content));
    assert.equal(parsed.next_cursor, 'entries-cursor-2');
    assert.equal(parsed.exhausted, false);
    const okfResult = await tool.execute({ action: 'read', document_id: DOC, revision: REV, format: 'okf' }, context());
    const okf = JSON.parse(String(okfResult.content));
    assert.equal(okf.format, 'okf');
    assert.equal(okf.okf, '# OKF');
  });

  test('unavailable backend surfaces a typed error — never a fake-empty page', async () => {
    const tool = new CatsLogKnowledgeRecallTool({} as CatsLogMemoryBackend);
    const result = await tool.execute({ action: 'search', query: 'q' }, context());
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'CATSLOG_MEMORY_UNAVAILABLE');
    const tool2 = new CatsLogKnowledgeRecallTool(fakeBackend({
      searchKnowledge: undefined,
      isKnowledgeRecallAvailable: () => false,
    }) as any);
    const result2 = await tool2.execute({ action: 'search', query: 'q' }, context());
    assert.equal(result2.ok, false);
    assert.equal(result2.errorCode, 'CATSLOG_MEMORY_UNAVAILABLE');
  });

  test('auth and http errors map to typed codes; unavailable errors pass through', async () => {
    const authBackend = fakeBackend({
      searchKnowledge: async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); },
    });
    const auth = await new CatsLogKnowledgeRecallTool(authBackend).execute({ action: 'search', query: 'q' }, context());
    assert.equal(auth.errorCode, 'CATSLOG_AUTH_REQUIRED');
    assert.equal(auth.retryable, false);

    const notFound = await new CatsLogKnowledgeRecallTool(fakeBackend({
      readKnowledge: async () => { throw Object.assign(new Error('read failed: not_found'), { status: 404 }); },
    })).execute({ action: 'read', document_id: DOC, revision: REV }, context());
    assert.equal(notFound.errorCode, 'CATSLOG_HTTP_404');

    const unavailable = await new CatsLogKnowledgeRecallTool(fakeBackend({
      readKnowledge: async () => { throw new CatsLogMemoryUnavailableError('capability paused'); },
    })).execute({ action: 'read', document_id: DOC, revision: REV }, context());
    assert.equal(unavailable.errorCode, 'CATSLOG_MEMORY_UNAVAILABLE');

    const retryable = await new CatsLogKnowledgeRecallTool(fakeBackend({
      searchKnowledge: async () => { throw Object.assign(new Error('knowledge_unavailable'), { status: 503 }); },
    })).execute({ action: 'search', query: 'q' }, context());
    assert.equal(retryable.errorCode, 'CATSLOG_HTTP_503');
    assert.equal(retryable.retryable, true);
  });

  test('invalid action is a structured error and abort signal flows to the backend', async () => {
    const backend = fakeBackend();
    let observed: AbortSignal | undefined;
    const signalBackend = fakeBackend({
      searchKnowledge: async (_query: any, signal?: AbortSignal) => {
        observed = signal;
        return { hits: [], exhausted: true };
      },
    });
    const controller = new AbortController();
    await new CatsLogKnowledgeRecallTool(signalBackend).execute(
      { action: 'search', query: 'q' }, context({ abortSignal: controller.signal }),
    );
    assert.equal(observed, controller.signal);
    const bad = await new CatsLogKnowledgeRecallTool(backend).execute({ action: 'nope' }, context());
    assert.equal(bad.ok, false);
    assert.equal(bad.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('tool results never contain the capability token', async () => {
    const backend = fakeBackend({
      searchKnowledge: async () => { throw Object.assign(new Error('upstream exploded'), { status: 500 }); },
    });
    const result = await new CatsLogKnowledgeRecallTool(backend).execute({ action: 'search', query: 'q' }, context());
    assert.equal(result.ok, false);
    assert.ok(!String(result.content ?? '').includes('skill-token'));
    assert.ok(!String(result.message).includes('skill-token'));
  });

  test('legacy backend without recall discovery keeps document methods compatible and ignores the Branch switch', async () => {
    const backend = fakeBackend({ isKnowledgeRecallAvailable: undefined, isAvailable: () => false });
    const tool = new CatsLogKnowledgeRecallTool(backend);
    for (const args of [
      { action: 'search', query: 'q' },
      { action: 'read', document_id: DOC, revision: REV },
    ]) assert.equal((await tool.execute(args, context())).ok, true);
    assert.equal(backend.calls.length, 2);
  });

  test('nonexhausted knowledge pages without cursor remain explicit incomplete responses', async () => {
    const tool = new CatsLogKnowledgeRecallTool(fakeBackend({
      searchKnowledge: async () => ({ hits: [], exhausted: false }),
      readKnowledge: async () => ({ format: 'json', page: { document_id: DOC, revision: REV, day: '2026-10-07', generated_at: '', generated_by: 'w', entries: [], exhausted: false } }),
    }));
    for (const args of [
      { action: 'search', query: 'q' },
      { action: 'read', document_id: DOC, revision: REV },
    ]) {
      const page = JSON.parse(String((await tool.execute(args, context())).content));
      assert.equal(page.exhausted, false);
      assert.equal(page.incomplete, true);
      assert.equal(page.next_cursor, undefined);
    }
  });

  test('risk classification: read-only, no confirmation, outside strict prompts', async () => {
    const decision = classifyLocalToolRisk('catslog_knowledge_recall', {}, context());
    assert.equal(decision.risk, 'low');
    assert.equal(decision.requiresConfirmation, false);
  });
});
