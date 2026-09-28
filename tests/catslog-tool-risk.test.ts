import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyLocalToolRisk } from '../src/tools/local-tool-risk';
import type { ToolExecutionContext } from '../src/types/tool';

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
  test('device-bound read tools stay low risk without confirmation', () => {
    for (const toolName of [
      'catslog_skill_memory',
      'catslog_skill_catalog',
      'catslog_skill_graph',
      'catslog_session_query',
      'catslog_session_recall',
    ]) {
      const decision = classifyLocalToolRisk(toolName, {}, context());
      assert.equal(decision.requiresConfirmation, false, toolName);
      assert.equal(decision.risk, 'low', toolName);
    }
  });

  test('remote writes get their own external-write classification', () => {
    for (const toolName of ['catslog_skill_outcome', 'catslog_memory_note']) {
      const decision = classifyLocalToolRisk(toolName, {}, context());
      // Consent is the explicit CATSLOG_*_ENABLED switch (the provider
      // re-checks it per call), so no interactive confirmation — but the
      // medium risk level must distinguish external writes from local reads.
      assert.equal(decision.requiresConfirmation, false, toolName);
      assert.equal(decision.risk, 'medium', toolName);
      assert.match(decision.reason, /CATSLOG/);
    }
  });

  test('classification is environment-independent; exposure gating stays in the provider', () => {
    // Even with the write switches unset, the classifier only describes the
    // tool that is already exposed; the provider decides availability.
    delete process.env.CATSLOG_MEMORY_WRITE_ENABLED;
    delete process.env.CATSLOG_SKILL_OUTCOMES_ENABLED;
    const decision = classifyLocalToolRisk('catslog_memory_note', {}, context());
    assert.equal(decision.requiresConfirmation, false);
    assert.equal(decision.risk, 'medium');
  });
});
