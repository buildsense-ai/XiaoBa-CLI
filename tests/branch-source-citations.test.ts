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

const DOC = `akd-${'a'.repeat(24)}`, ENTRY = `ake-${'b'.repeat(24)}`, REV = `akr-${'c'.repeat(64)}`;
const SOURCE = `catslog:source:${'e'.repeat(64)}`, POOL = `ref_${'f'.repeat(64)}`;
const KNOWLEDGE = `catslog:knowledge:${DOC}:${REV}:${ENTRY}`;
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
  assert.equal(counts?.injectedByLane.source, 1); assert.equal(counts?.citedByLane.source, 1);
  assert.equal(counts?.citedByLane.remote_pool, 0);
  assert.deepEqual(matchBranchCitations([observation], SOURCE), { reports: [], knowledgeRefs: [], sourceRefs: [SOURCE] });
  assert.deepEqual(matchBranchCitations([observation], `${SOURCE} ${POOL}`).reports, [{ requestId: 'request-1', refs: [POOL] }]);
});

test('source citation ref collection uses the source injection bound, not the old 32-document KB bound', () => {
  const refs = Array.from({ length: 40 }, (_, index) => `catslog:source:${index.toString(16).padStart(64, '0')}`);
  const observation: any = { source: 'memory', summary: 'Source summary', status: 'completed', relevance: 'medium', metadata: { refs } };
  assert.equal(collectBranchCitationUsage([observation], refs.join('\n'))?.citedByLane.source, 40);
  assert.deepEqual(matchBranchCitations([observation], refs.join('\n')).sourceRefs, refs);
});

// Follow main's current explicit tool loop, rather than the retired assess/refine runner.
async function actualGraphBranch(root: string, forged = false) {
  const queue = new InMemorySyntheticObservationQueue();
  let pass = 0, graphReads = 0;
  const anchor = { kind: 'knowledge_entry' as const, document_id: DOC, id: ENTRY, revision: REV };
  const backend: CatsLogMemoryBackend = {
    isAvailable: () => true, isKnowledgeRecallAvailable: () => true,
    searchKnowledge: async () => ({ hits: [{ document_id: DOC, entry_id: ENTRY, day: '2026-10-08', title: 'Deployment guard', status: 'draft', revision: REV }], exhausted: true }),
    readKnowledgeGraph: async () => {
      graphReads++;
      return { contract: 'memory-graph/1', seeds: [anchor], closure_complete: true, edges: [], nodes: [{
        anchor, day: '2026-10-08', head_revision: REV, current_status: 'draft',
        entry: { id: ENTRY, title: 'Deployment guard', text: 'Do not deploy without explicit approval.', status: 'draft' },
      }] };
    },
  };
  const ai: any = { isToolCallingSupported: () => true, chat: async (messages: Message[]) => {
    pass++;
    if (pass === 1) return { content: null, toolCalls: [call('search', 'memory_knowledge_search', { query: 'deploy' })], usage };
    if (pass === 2) return { content: null, toolCalls: [call('graph', 'memory_knowledge_graph', { ref: KNOWLEDGE })], usage };
    if (pass === 3) {
      const tool = messages.filter(message => message.role === 'tool').at(-1)!;
      assert.match(String(tool.content), /Do not deploy/);
    }
    return { content: null, toolCalls: [call(`finish-${pass}`, 'finish_memory_search', {
      summary: 'Prior evidence says wait for explicit deployment approval.', evidence: [forged ? SOURCE : KNOWLEDGE], inject: true,
    })], usage };
  } };
  await startMemorySidecarBranch({ sessionKey: 'branch-graph-test', input: 'What is the deployment guard?', recentMessages: [],
    workingDirectory: root, aiService: ai, queue, catslogMemory: backend, logEnabled: false }).done;
  assert.equal(graphReads, 1);
  return queue;
}

test('current Branch graph -> parent injection -> assistant corpus citation -> separate knowledge lane event', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'branch-graph-attribution-'));
  const logger = new SessionTurnLogger('cli', `branch-graph-test-${randomUUID()}`);
  try {
    const queue = await actualGraphBranch(root);
    assert.equal(queue.size(), 1);
    let modelPass = 0, remoteReports = 0;
    const ai: any = { chatStream: async (messages: Message[]) => {
      modelPass++;
      if (modelPass === 1) {
        assert.ok(messages.some(message => message.role === 'tool' && String(message.content).includes('memory_graphs')
          && String(message.content).includes('Do not deploy')), 'complete graph is in actual parent input');
        return { content: null, toolCalls: [call('parent-action', 'noop', { evidence: KNOWLEDGE })], usage };
      }
      return { content: 'I will wait for explicit approval.', toolCalls: [], usage };
    } };
    const controller = new AgentTurnController({ sessionKey: 'branch-graph-test', sessionType: 'cli',
      services: { aiService: ai, catslogMemory: { reportBranchCitations: async () => { remoteReports++; } },
        toolManager: { getToolDefinitions: () => [{ name: 'noop', description: 'test action', parameters: { type: 'object', properties: {} } }],
          executeTool: async (tool: any) => ({ role: 'tool', name: 'noop', tool_call_id: tool.id, content: 'done', ok: true }) }, skillManager: {} } as any,
      skillRuntime: { reloadSkills: async () => {}, buildSkillsListMessage: () => null } as any,
      planRuntime: undefined as any, turnContextBuilder: new TurnContextBuilder(), turnLogRecorder: { recordTurn: () => {} } as any,
      workspaceRoot: root, getCurrentDirectory: () => root, updateCurrentDirectory: () => {},
    });
    (controller as any).startMemorySidecarIfEnabled = () => ({ queue, originTurn: 1, done: true, handle: { cancel: () => {}, done: Promise.resolve() } });
    await Logger.withSessionContext('branch-graph-test', logger, () => controller.run({ input: 'Recall deployment guard', messages: [], runtimeFeedback: [], shouldContinue: () => true }));
    const records = readFileSync(logger.getLogFilePath(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const event = records.find(record => record.event?.type === 'branch_knowledge_citations').event.payload;
    assert.deepEqual(event.refs, [KNOWLEDGE]); assert.deepEqual(event.retained_refs, []);
    const lane = records.find(record => record.event?.type === 'branch_citation_usage').event.payload;
    assert.equal(lane.injectedByLane.knowledge, 1); assert.equal(lane.citedByLane.knowledge, 1); assert.equal(lane.retainedByLane.knowledge, 0);
    assert.equal(lane.injectedByLane.source, 0, 'a graph does not disclose original source bodies');
    assert.equal(remoteReports, 0, 'knowledge refs never enter the legacy pool reporter');
    assert.equal(records.filter(record => record.event?.type === 'native_recall_source_usage').length, 0);
  } finally { rmSync(logger.getLogFilePath(), { force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('a source hash outside the current graph cannot finish or be injected and counted', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'branch-graph-forged-'));
  try {
    const queue = await actualGraphBranch(root, true);
    assert.equal(queue.size(), 0); assert.equal(collectBranchCitationUsage(queue.drain(), SOURCE), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
