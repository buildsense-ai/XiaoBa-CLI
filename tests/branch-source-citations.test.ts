import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { AgentTurnController } from '../src/core/agent-turn-controller';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { collectBranchCitationUsage, collectBranchRefLanes, deriveBranchRefLane, matchBranchCitations } from '../src/core/branch-citation-reporter';
import { Logger } from '../src/utils/logger';
import { SessionTurnLogger } from '../src/utils/session-turn-logger';
import type { Message } from '../src/types';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';

const DOC = `akd-${'a'.repeat(24)}`;
const ENTRY = `ake-${'b'.repeat(24)}`;
const REV = `akr-${'c'.repeat(64)}`;
const RAW = { kind: 'session_query' as const, id: 'turn-1', session_id: 's-1', stream_id: 'st-1', byte_offset: 12, revision: 'd'.repeat(64) };
const SOURCE = `catslog:source:${'e'.repeat(64)}`;
const POOL = `ref_${'f'.repeat(64)}`;
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const call = (id: string, name: string, args: any) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

test('typed source refs tag and count in their own lane, including fallback/carryover, never old remote reporting', () => {
  assert.equal(deriveBranchRefLane(SOURCE), 'source');
  assert.equal(deriveBranchRefLane('catslog:source:bad'), 'other');
  assert.deepEqual(collectBranchRefLanes([SOURCE, SOURCE, POOL], new Set([POOL])), [
    { ref: SOURCE, lane: 'source' }, { ref: POOL, lane: 'remote_pool' },
  ]);
  const observation: any = { source: 'memory', summary: 'Source summary', status: 'completed', relevance: 'medium',
    timing: 'late_previous_turn', metadata: { refs: [SOURCE, POOL], citation: { requestId: 'request-1', refs: [SOURCE, POOL] } } };
  const counts = collectBranchCitationUsage([observation], SOURCE);
  assert.equal(counts?.carryover, true);
  assert.equal(counts?.injectedByLane.source, 1);
  assert.equal(counts?.citedByLane.source, 1);
  assert.equal(counts?.citedByLane.remote_pool, 0);
  assert.deepEqual(matchBranchCitations([observation], SOURCE), { reports: [], knowledgeRefs: [], sourceRefs: [SOURCE] });
  assert.deepEqual(matchBranchCitations([observation], `${SOURCE} ${POOL}`).reports, [{ requestId: 'request-1', refs: [POOL] }]);
});

test('source citation ref collection uses the source injection bound, not the old 32-document KB bound', () => {
  const refs = Array.from({ length: 40 }, (_, index) => `catslog:source:${index.toString(16).padStart(64, '0')}`);
  const observation: any = { source: 'memory', summary: 'Source summary', status: 'completed', relevance: 'medium', metadata: { refs } };
  const corpus = refs.join('\n');
  assert.equal(collectBranchCitationUsage([observation], corpus)?.citedByLane.source, 40);
  assert.deepEqual(matchBranchCitations([observation], corpus).sourceRefs, refs);
});

async function actualSourceBranch(root: string, forged = false) {
  const queue = new InMemorySyntheticObservationQueue();
  let sourceReads = 0;
  let presentedRef = '';
  let pass = 0;
  const backend: CatsLogMemoryBackend = {
    isAvailable: () => true,
    isKnowledgeRecallAvailable: () => true,
    searchKnowledge: async () => ({ hits: [{ document_id: DOC, entry_id: ENTRY, day: '2026-10-08', title: 'Deployment guard', status: 'active', revision: REV }], exhausted: true }),
    readKnowledge: async () => ({ format: 'json', page: { document_id: DOC, revision: REV, day: '2026-10-08', generated_at: '2026-10-08T00:00:00Z', generated_by: 'test',
      entries: [{ id: ENTRY, title: 'Deployment guard', text: 'Relevant historical constraint', status: 'active', source_anchors: [RAW] }], exhausted: true } }),
    expandKnowledge: async () => ({ edges: [], exhausted: true }),
    readKnowledgeSource: async () => { sourceReads++; return {
      source: { anchor: RAW, status: 'read', role: 'organic', speaker: 'user_assistant', occurred_at: '2026-10-08T00:00:00Z',
        text: 'user: do not deploy\nassistant: wait for explicit approval', content_hash: `sha256:${'1'.repeat(64)}`,
        coverage: 'complete', truncated: false, redacted: true, missing: false, revoked: false },
      before: [], after: [], before_exhausted: true, after_exhausted: true, context_truncated: false, served_at: '2026-10-08T12:00:00Z',
    }; },
  };
  const ai: any = { isToolCallingSupported: () => true, chat: async (messages: Message[]) => {
    pass++;
    if (pass === 1) return { content: null, toolCalls: [call('assess', 'assess_memory_need', { action: 'recall', query_text: 'deploy guard', keywords: ['deploy'] })], usage };
    const message = [...messages].reverse().find(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('evidence_pack'));
    assert.ok(message);
    const pack = JSON.parse(String(message.content));
    const rows = pack.evidence_pack.daily_knowledge.source_reads;
    assert.equal(rows.length, 1, 'real reader result survives refine presentation');
    assert.equal(rows[0].source.disclosure, 'text');
    assert.match(rows[0].source.text, /do not deploy/);
    presentedRef = rows[0].source.ref;
    assert.equal(deriveBranchRefLane(presentedRef), 'source');
    return { content: null, toolCalls: [call('finish', 'finish_memory_search', { summary: 'Prior source says wait for explicit deployment approval.',
      refs: [forged ? SOURCE : presentedRef], inject: true, delivery: 'context' })], usage };
  } };
  await startMemorySidecarBranch({ sessionKey: 'branch-source-test', input: 'What is the deployment guard?', recentMessages: [],
    workingDirectory: root, aiService: ai, queue, catslogMemory: backend, logEnabled: false }).done;
  assert.equal(sourceReads, 1);
  return { queue, presentedRef };
}

test('presented source -> real Branch finish guard -> parent injection -> assistant corpus citation -> local persisted event', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'branch-source-attribution-'));
  const logger = new SessionTurnLogger('cli', `branch-source-test-${randomUUID()}`);
  try {
    const { queue, presentedRef } = await actualSourceBranch(root);
    assert.equal(queue.size(), 1);
    let modelPass = 0;
    const received: Message[][] = [];
    let remoteReports = 0;
    const ai: any = { chatStream: async (messages: Message[]) => {
      modelPass++; received.push(messages);
      if (modelPass === 1) {
        assert.ok(messages.some(message => message.role === 'tool' && String(message.content).includes(presentedRef)), 'source ref is really injected');
        return { content: null, toolCalls: [call('parent-action', 'noop', { evidence: presentedRef })], usage };
      }
      return { content: 'I will wait for explicit approval.', toolCalls: [], usage };
    } };
    const controller = new AgentTurnController({ sessionKey: 'branch-source-test', sessionType: 'cli',
      services: { aiService: ai, catslogMemory: { reportBranchCitations: async () => { remoteReports++; } },
        toolManager: { getToolDefinitions: () => [{ name: 'noop', description: 'test action', parameters: { type: 'object', properties: {} } }],
          executeTool: async (tool: any) => ({ role: 'tool', name: 'noop', tool_call_id: tool.id, content: 'done', ok: true }) },
        skillManager: {} } as any,
      skillRuntime: { reloadSkills: async () => {}, buildSkillsListMessage: () => null } as any,
      planRuntime: undefined as any, turnContextBuilder: new TurnContextBuilder(), turnLogRecorder: { recordTurn: () => {} } as any,
      workspaceRoot: root, getCurrentDirectory: () => root, updateCurrentDirectory: () => {},
    });
    (controller as any).startMemorySidecarIfEnabled = () => ({ queue, originTurn: 1, done: true,
      handle: { cancel: () => {}, done: Promise.resolve() } });
    await Logger.withSessionContext('branch-source-test', logger, () => controller.run({ input: 'Recall deployment guard', messages: [], runtimeFeedback: [], shouldContinue: () => true }));
    const records = readFileSync(logger.getLogFilePath(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const events = records.filter(record => record.event?.type === 'branch_source_usage');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].event.payload.injected_refs, [presentedRef]);
    assert.deepEqual(events[0].event.payload.cited_refs, [presentedRef]);
    assert.deepEqual(events[0].event.payload.retained_refs, [], 'interim tool arguments are distinct from final explicit retention');
    assert.equal(events[0].event.payload.delivery_semantics, 'branch_summary_with_refs_not_source_body');
    assert.equal(events[0].event.payload.server_feedback, 'not_connected');
    const lane = records.find(record => record.event?.type === 'branch_citation_usage').event.payload;
    assert.equal(lane.injectedByLane.source, 1);
    assert.equal(lane.citedByLane.source, 1);
    assert.equal(lane.retainedByLane.source, 0);
    assert.equal(remoteReports, 0);
    assert.equal(records.filter(record => record.event?.type === 'native_recall_source_usage').length, 0, 'Branch reader did not run native tool');
    assert.doesNotMatch(JSON.stringify(events[0].event.payload), /principal|session_id|stream_id|user: do not deploy/);
  } finally { rmSync(logger.getLogFilePath(), { force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('a source ref absent from refine presentation fails finish guard and never gets injected or counted', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'branch-source-forged-'));
  try {
    const { queue } = await actualSourceBranch(root, true);
    assert.equal(queue.size(), 0);
    assert.equal(collectBranchCitationUsage(queue.drain(), SOURCE), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
