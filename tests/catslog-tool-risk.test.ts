import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyLocalToolRisk } from '../src/tools/local-tool-risk';
import type { ToolExecutionContext } from '../types/tool';

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: 'test-session',
    surface: 'agent',
    permissionProfile: 'strict',
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    ...overrides,
  } as ToolExecutionContext;
}

describe('CatsLog tool risk classification', () => {
  test('the memory pipeline tools stay low risk without confirmation', () => {
    for (const toolName of [
      'assess_memory_need',
      'finish_memory_search',
    ]) {
      const decision = classifyLocalToolRisk(toolName, {}, context());
      assert.equal(decision.requiresConfirmation, false, toolName);
      assert.equal(decision.risk, 'low', toolName);
    }
  });

  test('v1.2 loop tools and removed per-source CatsLog tools fall back to the default confirmation gate', () => {
    // The v1.3 pipeline no longer exposes these names; if something re-registers
    // them without re-classifying, they must not silently ride the low-risk
    // read list or the old external-write carve-out.
    for (const toolName of [
      'memory_search',
      'memory_read_turn',
      'memory_neighbors',
      'catslog_branch',
      'catslog_skill_memory',
      'catslog_skill_catalog',
      'catslog_skill_graph',
      'catslog_session_query',
      'catslog_session_recall',
      'catslog_skill_outcome',
      'catslog_memory_note',
    ]) {
      const decision = classifyLocalToolRisk(toolName, {}, context());
      assert.equal(decision.requiresConfirmation, true, toolName);
      assert.equal(decision.risk, 'medium', toolName);
    }
  });
});
