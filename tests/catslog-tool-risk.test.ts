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
  test('the fused branch fan-out stays low risk without confirmation', () => {
    for (const toolName of [
      'catslog_branch',
      'finish_memory_search',
      'memory_search',
      'memory_read_turn',
      'memory_neighbors',
    ]) {
      const decision = classifyLocalToolRisk(toolName, {}, context());
      assert.equal(decision.requiresConfirmation, false, toolName);
      assert.equal(decision.risk, 'low', toolName);
    }
  });

  test('removed per-source CatsLog tools fall back to the default confirmation gate', () => {
    // The thin v1 branch never exposes these names; if something re-registers
    // them without re-classifying, they must not silently ride the low-risk
    // read list or the old external-write carve-out.
    for (const toolName of [
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
