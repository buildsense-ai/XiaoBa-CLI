import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeRecallTracker, dailyKnowledgeRef, hashedRecallRef, nativeRecallAttribution, recallTextHash } from '../src/core/native-recall-attribution';
import { collectBranchCitationUsage, deriveBranchRefLane, matchBranchCitations } from '../src/core/branch-citation-reporter';
import { ConversationRunner } from '../src/core/conversation-runner';
import { CatsLogKnowledgeRecallTool } from '../src/tools/catslog-knowledge-recall-tool';
import { ToolManager } from '../src/tools/tool-manager';
import { AgentTurnController } from '../src/core/agent-turn-controller';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { Logger } from '../src/utils/logger';
import { SessionTurnLogger } from '../src/utils/session-turn-logger';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Message } from '../src/types';
import type { ToolResult } from '../src/types/tool';

const DOC = `akd-${'a'.repeat(24)}`;
const REV = `akr-${'b'.repeat(64)}`;
const ENTRY = `ake-${'c'.repeat(24)}`;
const REF = dailyKnowledgeRef(DOC, REV, ENTRY);
const TEXT = 'Respect the negative constraint: do not deploy.';
function result(disclosure: 'text' | 'metadata' = 'text'): ToolResult {
  return { tool_call_id: 'call-1', role: 'tool', name: 'catslog_knowledge_recall', ok: true,
    content: JSON.stringify({ entries: [{ ref: REF, text: disclosure === 'text' ? TEXT : undefined }],
      recall_attribution: nativeRecallAttribution([{ ref: REF, disclosure,
        ...(disclosure === 'text' ? { disclosed_text_hash: recallTextHash(TEXT) } : {}) }]) }) };
}
const assistant = (text: string): Message => ({ role: 'assistant', content: text });

function event(tracker: NativeRecallTracker, messages: Message[] = [], final = '', outcome: 'completed' | 'failed' | 'cancelled' = 'completed'): any {
  return tracker.finish(messages, final, outcome)[0];
}

test('source identity hash is canonical across nested JSON key order and pinned body variants', () => {
  const anchor = { id: 'node-1', kind: 'learning_node', revision: 'a'.repeat(64), session_id: 's-1' };
  const reordered = { session_id: 's-1', revision: 'a'.repeat(64), kind: 'learning_node', id: 'node-1' };
  assert.equal(hashedRecallRef('source', [anchor, null]), hashedRecallRef('source', [reordered, null]));
  assert.notEqual(hashedRecallRef('source', [anchor, 'one']), hashedRecallRef('source', [anchor, 'two']));
  assert.notEqual(hashedRecallRef('source', [anchor, null]), hashedRecallRef('history', [anchor, null]));
});

test('Go raw anchor omitempty zeros and canonical SHA pin preserve the same source ref without changing wire identities', () => {
  const explicit = { kind: 'session_query', id: 'turn-0', stream_id: 'stream-1', session_id: 's-1',
    byte_offset: 0, byte_length: 0, revision: `sha256:${'a'.repeat(64)}` };
  const canonicalGo = { session_id: 's-1', id: 'turn-0', revision: 'a'.repeat(64), stream_id: 'stream-1', kind: 'session_query' };
  assert.equal(hashedRecallRef('source', [explicit, 'body-hash']), hashedRecallRef('source', [canonicalGo, 'body-hash']));
  assert.equal(explicit.revision, `sha256:${'a'.repeat(64)}`, 'normalization must not mutate request DTO');
  assert.equal(hashedRecallRef('source', [{ ...explicit, kind: 'session_result', byte_length: 10 }, null]),
    hashedRecallRef('source', [{ ...canonicalGo, kind: 'session_result', byte_length: 10 }, null]));
  assert.notEqual(hashedRecallRef('source', [explicit, null]), hashedRecallRef('source', [{ ...explicit, byte_offset: 1 }, null]));
  assert.notEqual(hashedRecallRef('source', [{ kind: 'learning_node', id: 'ln-1', byte_offset: 0 }, null]),
    hashedRecallRef('source', [{ kind: 'learning_node', id: 'ln-1' }, null]), 'zero-coordinate equivalence belongs only to raw domains');
  assert.equal(hashedRecallRef('source', [{ kind: 'learning_node', id: 'ln-1', revision: explicit.revision }, null]),
    hashedRecallRef('source', [{ kind: 'learning_node', id: 'ln-1', revision: 'a'.repeat(64) }, null]));
});

test('observed read is neither delivery nor citation; tool-result refs never cite themselves', () => {
  const tracker = new NativeRecallTracker();
  const read = result();
  tracker.observe(read);
  const usage = event(tracker, [read], REF);
  assert.equal(usage.observed.length, 1);
  assert.deepEqual(usage.delivered, []);
  assert.deepEqual(usage.cited, []);
  assert.deepEqual(usage.retained, []);
  assert.equal(usage.server_feedback, 'not_connected');
});

test('interim explicit corpus citation differs from final explicit retention', () => {
  const tracker = new NativeRecallTracker();
  const read = result();
  tracker.observe(read); tracker.deliver([read]);
  const usage = event(tracker, [read, assistant(`Interim cites ${REF}`)], 'done');
  assert.deepEqual(usage.delivered, [{ ref: REF, disclosure: 'text' }]);
  assert.deepEqual(usage.cited, [REF]);
  assert.deepEqual(usage.retained, []);
  assert.equal(usage.retained_semantics, 'final_explicit_ref_match_not_semantic_adoption');
  assert.doesNotMatch(JSON.stringify(usage), /Respect the negative/);
});

test('recall arguments and earlier assistant references do not count as use of a later read', () => {
  const tracker = new NativeRecallTracker();
  const prior = assistant(`Earlier ${REF}`);
  const read = result();
  tracker.observe(read, [prior]); tracker.deliver([read]);
  const retrieval: Message = { role: 'assistant', content: null, tool_calls: [{ id: 'read-2', type: 'function',
    function: { name: 'catslog_knowledge_recall', arguments: JSON.stringify({ ref: REF, action: 'read' }) } }] };
  const usage = event(tracker, [prior, read, retrieval], 'no final citation');
  assert.deepEqual(usage.cited, []);
  assert.deepEqual(usage.retained, []);
});

test('compaction removing original result still permits later citations without counting preceding assistant', () => {
  const tracker = new NativeRecallTracker();
  const prior = assistant(`Before execution ${REF}`);
  const read = result();
  tracker.observe(read, [prior]); tracker.deliver([read]);
  const usage = event(tracker, [prior, assistant('Later has no citation')], 'done');
  assert.deepEqual(usage.cited, []);
  const second = new NativeRecallTracker();
  second.observe(read, [prior]); second.deliver([read]);
  const usage2 = event(second, [prior, assistant(`After compaction cites ${REF}`)], 'done');
  assert.deepEqual(usage2.cited, [REF]);
  assert.deepEqual(usage2.retained, []);
});

test('actual submitted source body, not surviving envelope, determines disclosure', () => {
  const read = result();
  const body = JSON.parse(String(read.content));
  const tracker = new NativeRecallTracker(); tracker.observe(read);
  const clipped = { ...read, content: JSON.stringify({ ...body, entries: [{ ref: REF, text: '' }] }) };
  tracker.deliver([clipped]);
  const usage = event(tracker, [clipped], REF);
  assert.deepEqual(usage.delivered, [{ ref: REF, disclosure: 'metadata' }]);
  assert.deepEqual(usage.retained, [REF]);
  assert.equal(usage.observed[0].disclosure, 'text');
  const onlyEnvelope = new NativeRecallTracker(); onlyEnvelope.observe(read);
  onlyEnvelope.deliver([{ ...read, content: JSON.stringify({ recall_attribution: body.recall_attribution }) }]);
  assert.deepEqual(event(onlyEnvelope, [], REF).delivered, []);
});

test('metadata hits remain metadata; full delivery is not downgraded by later compaction', () => {
  const tracker = new NativeRecallTracker(); const read = result('metadata');
  tracker.observe(read); tracker.deliver([read]);
  assert.deepEqual(event(tracker, [read]).delivered, [{ ref: REF, disclosure: 'metadata' }]);
  const full = result(); const body = JSON.parse(String(full.content));
  const second = new NativeRecallTracker(); second.observe(full); second.deliver([full]);
  second.deliver([{ ...full, content: JSON.stringify({ ...body, entries: [{ ref: REF, text: '' }] }) }]);
  assert.deepEqual(event(second, [full]).delivered, [{ ref: REF, disclosure: 'text' }]);
});

test('failed result and old trace replay/carryover cannot register delivery in another turn', () => {
  const old = result(); const first = new NativeRecallTracker();
  first.observe(old); first.deliver([old]);
  assert.equal(first.finish([old], REF).length, 1);
  assert.deepEqual(first.finish([old], REF), [], 'finish expires all observed refs');
  first.deliver([old]); assert.deepEqual(first.finish([old], REF), [], 'late delivery does not revive expired trace');
  const next = new NativeRecallTracker();
  next.deliver([old]); assert.deepEqual(next.finish([old], REF), [], 'durable tool result from previous turn is not new execution');
  next.observe({ ...old, ok: false, errorCode: 'CATSLOG_HTTP_401' });
  assert.deepEqual(next.finish([old], REF), []);
  const current = result(); next.observe(current); next.deliver([old]);
  assert.deepEqual(event(next, [current], REF).delivered, [], 'same tool id and ref with stale trace still fails');
});

test('untrusted attribution extensions are stripped before local persistence', () => {
  const tracker = new NativeRecallTracker();
  const read = result();
  const body = JSON.parse(String(read.content));
  Object.assign(body.recall_attribution.sources[0], { principal_id: 'private', text: 'private body',
    coverage: 'partial', role: 'organic', redacted: true });
  tracker.observe({ ...read, content: JSON.stringify(body) });
  const usage = event(tracker);
  assert.equal(usage.observed[0].coverage, 'partial');
  assert.equal(usage.observed[0].role, 'organic');
  assert.doesNotMatch(JSON.stringify(usage), /principal_id|private body/);
});

test('failed/cancelled completion emits outcome without final retention and clears state', () => {
  for (const outcome of ['failed', 'cancelled'] as const) {
    const tracker = new NativeRecallTracker(); const read = result();
    tracker.observe(read); tracker.deliver([read]);
    const usage = event(tracker, [read, assistant(REF)], REF, outcome);
    assert.equal(usage.outcome, outcome);
    assert.deepEqual(usage.cited, [REF]);
    assert.deepEqual(usage.retained, []);
    assert.deepEqual(tracker.finish([], REF), []);
  }
});

test('daily exact refs classify as knowledge, match only whole refs, and never enter old remote reports', () => {
  const observation: any = { id: 'daily', source: 'memory', status: 'completed', relevance: 'medium', summary: 's',
    metadata: { refs: [REF], citation: { requestId: 'remote-1', refs: [REF] } } };
  assert.equal(deriveBranchRefLane(REF), 'knowledge');
  assert.equal(deriveBranchRefLane('catslog:knowledge:garbage'), 'other');
  assert.deepEqual(collectBranchCitationUsage([observation], REF)?.citedByLane, { remote_pool: 0, session: 0, knowledge: 1, source: 0 });
  assert.equal(collectBranchCitationUsage([observation], ENTRY)?.citedByLane.knowledge, 0);
  assert.deepEqual(matchBranchCitations([observation], REF), { reports: [], knowledgeRefs: [REF] });
});

function nativeTool(): CatsLogKnowledgeRecallTool {
  return new CatsLogKnowledgeRecallTool({ readKnowledge: async () => ({ format: 'json', page: { document_id: DOC, revision: REV,
    day: '2026-10-08', generated_at: '2026-10-08T00:00:00Z', generated_by: 'test',
    entries: [{ id: ENTRY, title: 'Negative constraint', text: TEXT, status: 'active' }], exhausted: true } }) });
}
const call = { id: 'native-real-1', type: 'function' as const, function: { name: 'catslog_knowledge_recall',
  arguments: JSON.stringify({ action: 'read', document_id: DOC, revision: REV, entry_id: ENTRY }) } };
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

test('real executor and provider submission seams generate observed/delivered sets; stop before submission leaves observed only', async () => {
  for (const stop of [false, true]) {
    const tools = new ToolManager(); tools.registerTool(nativeTool());
    const tracker = new NativeRecallTracker(); let calls = 0; let stopped = false;
    const ai: any = { chat: async (messages: Message[]) => {
      calls++;
      if (calls === 1) return { content: null, toolCalls: [call], usage };
      const body = JSON.parse(String(messages.find(message => message.role === 'tool')?.content));
      assert.equal(body.entries[0].text, TEXT);
      assert.equal(body.entries[0].ref, REF);
      return { content: REF, toolCalls: [], usage };
    } };
    const runner = new ConversationRunner(ai, tools, { stream: false, shouldContinue: () => !stopped,
      toolExecutionContext: { workingDirectory: process.cwd(), workspaceRoot: process.cwd() } });
    const result = await runner.run([{ role: 'user', content: 'recall' }], {
      onToolExecutionResult: (toolResult, messages) => { tracker.observe(toolResult, messages); if (stop) stopped = true; },
      onModelInput: messages => tracker.deliver(messages),
    });
    const summary = event(tracker, result.newMessages, result.response);
    assert.equal(summary.observed.length, 1);
    assert.deepEqual(summary.delivered, stop ? [] : [{ ref: REF, disclosure: 'text' }]);
    assert.deepEqual(summary.retained, stop ? [] : [REF]);
    assert.equal(calls, stop ? 1 : 2);
  }
});

test('controller persists source-specific local JSONL event through existing session logger, without remote feedback or content', async () => {
  const tools = new ToolManager(); tools.registerTool(nativeTool()); let calls = 0;
  const ai: any = { chatStream: async () => {
    calls++;
    return calls === 1 ? { content: null, toolCalls: [call], usage } : { content: `Final ${REF}`, toolCalls: [], usage };
  } };
  const logger = new SessionTurnLogger('cli', `native-attribution-test-${randomUUID()}`);
  const controller = new AgentTurnController({ sessionKey: 'native-test', sessionType: 'cli',
    services: { aiService: ai, toolManager: tools, skillManager: {} as any, memoryBranch: { enabled: false },
      catslogMemory: { reportBranchCitations: async () => { throw new Error('must not report native refs'); } } } as any,
    skillRuntime: { reloadSkills: async () => {}, buildSkillsListMessage: () => null } as any,
    planRuntime: undefined as any, turnContextBuilder: new TurnContextBuilder(), turnLogRecorder: { recordTurn: () => {} } as any,
    workspaceRoot: process.cwd(), getCurrentDirectory: () => process.cwd(), updateCurrentDirectory: () => {},
  });
  try {
    const first = await Logger.withSessionContext('native-test', logger, () => controller.run({ input: 'recall', messages: [], runtimeFeedback: [], shouldContinue: () => true }));
    // The next turn can quote a durable ref but did not execute a new recall.
    await Logger.withSessionContext('native-test', logger, () => controller.run({ input: 'continue', messages: first.messages, runtimeFeedback: [], shouldContinue: () => true }));
    const records = readFileSync(logger.getLogFilePath(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const events = records.filter(record => record.event?.type === 'native_recall_source_usage');
    assert.equal(events.length, 1);
    const payload = events[0].event.payload;
    assert.deepEqual(payload.observed.map((source: any) => source.ref), [REF]);
    assert.deepEqual(payload.delivered, [{ ref: REF, disclosure: 'text' }]);
    assert.deepEqual(payload.cited, [REF]);
    assert.deepEqual(payload.retained, [REF]);
    // No CatsLog capability in this fixture: durable enqueue binds to the
    // captured capability scope, so without it the event stays local-only.
    assert.equal(payload.server_feedback, 'local_only_unbound_or_unavailable');
    assert.doesNotMatch(JSON.stringify(payload), /Respect the negative|token|principal|agent_subject|memory_scope/);
  } finally { rmSync(logger.getLogFilePath(), { force: true }); }
});
