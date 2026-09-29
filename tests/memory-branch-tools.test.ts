import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AssessMemoryNeedTool,
  FinishMemorySearchTool,
  validateAssessArgs,
} from '../src/tools/memory-branch-tools';

describe('memory branch tools', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-memory-tools-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe('assess_memory_need', () => {
    test('declares the pause_turn structured-output contract', () => {
      const tool = new AssessMemoryNeedTool(async () => ({ ok: true }));
      assert.equal(tool.definition.controlMode, 'pause_turn');
      assert.equal(tool.definition.name, 'assess_memory_need');
      assert.deepEqual(tool.definition.parameters.required, ['action']);
      assert.deepEqual(tool.definition.parameters.properties.action.enum, ['recall', 'skip']);
    });

    test('validates and normalizes a recall decision', () => {
      const validation = validateAssessArgs({
        action: 'recall',
        query_text: 'dashboard filter rollback decision',
        keywords: ['dashboard_unique', 'rollback', 'dashboard_unique', '  ', 42],
        sources: ['skill', 'agent_memory', 'skill'],
      });
      assert.equal(validation.ok, true);
      assert.deepEqual(validation.ok && validation.payload, {
        action: 'recall',
        queryText: 'dashboard filter rollback decision',
        keywords: ['dashboard_unique', 'rollback', '42'],
        sources: ['skill', 'agent_memory'],
      });
    });

    test('maps a skip decision and fills a default reason', () => {
      const explicit = validateAssessArgs({ action: 'skip', reason: '闲聊，无需记忆。' });
      assert.equal(explicit.ok, true);
      assert.deepEqual(explicit.ok && explicit.payload, {
        action: 'skip',
        reason: '闲聊，无需记忆。',
      });

      const implicit = validateAssessArgs({ action: 'skip' });
      assert.equal(implicit.ok, true);
      assert.match(implicit.ok && implicit.payload.reason, /主 agent/);
    });

    test('rejects malformed decisions fail-closed', () => {
      assert.equal(validateAssessArgs({}).ok, false);
      assert.equal(validateAssessArgs({ action: 'explore' }).ok, false);
      assert.equal(validateAssessArgs({ action: 'recall' }).ok, false);
      assert.equal(validateAssessArgs({ action: 'recall', query_text: 'q' }).ok, false);
      assert.equal(validateAssessArgs({ action: 'recall', query_text: 'q', keywords: [] }).ok, false);
      assert.equal(validateAssessArgs({ action: 'recall', query_text: 'q', keywords: ['  '] }).ok, false);
      assert.equal(
        validateAssessArgs({ action: 'recall', query_text: 'q', keywords: ['k'], sources: ['memory'] }).ok,
        false,
      );
      const oversized = validateAssessArgs({
        action: 'recall',
        query_text: 'q'.repeat(9_000),
        keywords: ['k'],
      });
      assert.equal(oversized.ok, false);
    });

    test('execute returns the handler ack and surfaces validation errors', async () => {
      const seen: unknown[] = [];
      const tool = new AssessMemoryNeedTool(async (payload, context) => {
        seen.push(payload);
        assert.equal(context.workingDirectory, testRoot);
        return { ok: true, action: 'skip' };
      });
      const context = { workingDirectory: testRoot, conversationHistory: [] };

      const bad = await tool.execute({ action: 'nope' }, context as any);
      assert.equal(bad.ok, false);
      assert.match(JSON.parse(String(bad.message)).error, /action must be/);
      assert.equal(seen.length, 0);

      const good = await tool.execute({ action: 'skip', reason: '不需要' }, context as any);
      assert.equal(good.ok, true);
      assert.deepEqual(JSON.parse(String(good.content)), { ok: true, action: 'skip' });
      assert.deepEqual(seen, [{ action: 'skip', reason: '不需要' }]);
    });
  });

  test('finish validates canonical refs and has pause control mode', async () => {
    let captured: any = null;
    const tool = new FinishMemorySearchTool(payload => {
      captured = payload;
    });

    assert.equal(tool.definition.controlMode, 'pause_turn');

    const invalid = await tool.execute({
      summary: 'done',
      refs: ['m1'],
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(invalid.ok, false);
    assert.match(JSON.parse(String(invalid.message)).error, /invalid canonical ref/);

    const emptyDefaultInject = await tool.execute({
      summary: 'No useful memory.',
      refs: [],
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(emptyDefaultInject.ok, false);
    assert.match(JSON.parse(String(emptyDefaultInject.message)).error, /unless inject is false/);

    const valid = await tool.execute({
      summary: 'Prior decision found.',
      refs: ['chat/2026-06-16/demo.jsonl#2', 'chat/2026-06-16/demo.jsonl#2'],
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(valid.ok, true);
    assert.deepEqual(captured, {
      summary: 'Prior decision found.',
      refs: ['chat/2026-06-16/demo.jsonl#2'],
      inject: true,
    });
    assert.deepEqual(JSON.parse(String(valid.content)), { ok: true });

    const suppressed = await tool.execute({
      summary: 'No extra memory worth injecting.',
      refs: [],
      inject: false,
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(suppressed.ok, true);
    assert.deepEqual(captured, {
      summary: 'No extra memory worth injecting.',
      refs: [],
      inject: false,
    });

    const audit = await tool.execute({
      summary: 'Retain this evidence for branch audit only.',
      refs: ['chat/2026-06-16/demo.jsonl#2'],
      inject: false,
      delivery: 'audit',
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(audit.ok, true);
    assert.deepEqual(captured, {
      summary: 'Retain this evidence for branch audit only.',
      refs: ['chat/2026-06-16/demo.jsonl#2'],
      inject: false,
      delivery: 'audit',
    });

    const contradictory = await tool.execute({
      summary: 'Found something but asked not to inject.',
      refs: ['chat/2026-06-16/demo.jsonl#2'],
      inject: false,
    }, { workingDirectory: testRoot, conversationHistory: [] });
    assert.equal(contradictory.ok, false);
    assert.match(JSON.parse(String(contradictory.message)).error, /refs must be empty/);
  });

  test('finish accepts generated CatsLog citations but still rejects arbitrary refs', async () => {
    let captured: any;
    const tool = new FinishMemorySearchTool(payload => {
      captured = payload;
    });
    const context = { workingDirectory: testRoot, conversationHistory: [] };

    const valid = await tool.execute({
      summary: 'Remote skill and session evidence are relevant.',
      refs: ['catslog:skill:release-playbook@3', 'stream-release#17'],
    }, context);
    assert.equal(valid.ok, true);
    assert.deepEqual(captured.refs, ['catslog:skill:release-playbook@3', 'stream-release#17']);

    const invalid = await tool.execute({
      summary: 'bad',
      refs: ['https://evil.example.test/#1'],
    }, context);
    assert.equal(invalid.ok, false);
  });
});
