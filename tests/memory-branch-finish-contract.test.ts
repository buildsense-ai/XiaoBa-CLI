import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FinishMemorySearchTool, MemoryReadTurnTool } from '../src/tools/memory-branch-tools';
import { MemorySearchBranchSession } from '../src/core/memory-search-branch-session';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';

const ref = 'chat/2026-06-16/demo.jsonl#2';

test('finish evidence is a strict array; read tool still uses singular ref', async () => {
  assert.ok(new MemoryReadTurnTool({} as any).definition.parameters.properties.ref);
  for (const invalid of [{ refs: [ref] }, { ref }, { evidence: ref }, { evidence: [42] }]) {
    let captured: any;
    const tool = new FinishMemorySearchTool(value => { captured = value; });
    assert.deepEqual(tool.definition.parameters.required, ['summary', 'evidence', 'inject']);
    const result = await tool.execute({ summary: 'history', inject: true, ...invalid });
    assert.equal(result.ok, false);
    assert.equal(captured, undefined);
    assert.match(JSON.stringify(result), /evidence/);
    const repaired = await tool.execute({ summary: 'history', evidence: [ref], inject: true });
    assert.equal(repaired.ok, true);
    assert.deepEqual(captured.refs, [ref]);
  }
});

test('empty evidence normally finishes without injection, not an error', async () => {
  let captured: any;
  const tool = new FinishMemorySearchTool(value => { captured = value; });
  assert.equal((await tool.execute({ summary: 'Nothing new.', evidence: [], inject: false })).ok, true);
  assert.deepEqual(captured, { summary: 'Nothing new.', refs: [], inject: false });
});

test('autonomous finish retains original summary without a new 400/800 cap', async () => {
  let captured: any;
  const tool = new FinishMemorySearchTool(value => { captured = value; });
  const summary = 'Historical detail. '.repeat(100);
  assert.equal((await tool.execute({ summary, evidence: [ref], inject: true })).ok, true);
  assert.equal(captured.summary, summary.trim());
});

test('restored Memory ignores retired pipeline limits and exposes autonomous tools', async () => {
  const branch = new MemorySearchBranchSession({
    sessionKey: 'restore-contract', input: 'task', recentMessages: [], workingDirectory: process.cwd(),
    aiService: {} as any, queue: new InMemorySyntheticObservationQueue(), logEnabled: false,
    deadlineMs: 45000, maxContextTokens: 16000, maxTurnsPerPass: 4, maxPasses: 2,
  } as any);
  for (const key of ['deadlineMs', 'maxContextTokens', 'maxTurnsPerPass', 'maxPasses']) {
    assert.equal((branch as any).options[key], undefined, key);
  }
  assert.equal((branch as any).options.parallelToolExecution, false);
  assert.deepEqual((branch as any).buildTools().map((t: any) => t.definition.name),
    ['memory_search', 'memory_read_turn', 'memory_neighbors', 'finish_memory_search']);
  const messages = await (branch as any).buildInitialMessages();
  assert.match(messages[0].content, /evidence/);
  assert.doesNotMatch(messages[0].content, /assess_memory_need|session_graph/);
  branch.stop();
});
