import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LoopRuntimeBridge } from '../src/catscompany/loop-runtime-bridge';
import { LOOP_ACTION_PACKET_SCHEMA, type LoopActionPacket } from '../src/catscompany/loop-evidence';

const topic = 'grp_101';
const session = 'session:v2:catscompany:group:grp_101:agent:559';

function packet(kind: LoopActionPacket['kind']): LoopActionPacket {
  return {
    schema: LOOP_ACTION_PACKET_SCHEMA,
    kind,
    actionId: `${kind}-1`,
    actionKey: `${kind}:attempt-1:1`,
    action: { state: 'ready', workItemRevision: 7, targetPrincipal: 'catsco-user:559', targetTopicId: topic },
    workItemId: 'work-1',
    workItemRevision: 7,
    targetPrincipal: 'catsco-user:559',
    targetTopicId: topic,
    workerTopicId: topic,
    evidenceTopicId: 'grp_102',
    attemptId: 'attempt-1',
    generation: 1,
    runtimePrincipal: 'catsco-user:559',
    workerSessionId: session,
    workBundle: { contractDigest: 'a'.repeat(64), instructions: 'do work', deliverables: ['github-pr'] },
  };
}

describe('CatsCo Loop runtime bridge', () => {
  test('ignores ordinary messages', async () => {
    const bridge = new LoopRuntimeBridge({
      botUid: '559',
      controllerUid: '602',
      evidenceSender: {} as any,
      prepareSession: () => { throw new Error('must not prepare'); },
      execute: async () => { throw new Error('must not execute'); },
    });
    assert.deepEqual(await bridge.handle('hello', topic, '602'), { handled: false });
  });

  test('preflight prepares the exact session and emits readiness', async () => {
    const calls: string[] = [];
    const bridge = new LoopRuntimeBridge({
      botUid: '559',
      controllerUid: '602',
      evidenceSender: { workerReady: async () => { calls.push('worker_ready'); } } as any,
      prepareSession: (id) => { calls.push(`session:${id}`); },
      execute: async () => { calls.push('execute'); },
    });
    const result = await bridge.handle(JSON.stringify(packet('preflight_attempt')), topic, '602');
    assert.deepEqual(result, { handled: true, kind: 'preflight_attempt' });
    assert.deepEqual(calls, [`session:${session}`, 'worker_ready']);
  });

  test('execute emits runtime_started before invoking the worker', async () => {
    const calls: string[] = [];
    const bridge = new LoopRuntimeBridge({
      botUid: '559',
      controllerUid: '602',
      evidenceSender: { runtimeStarted: async () => { calls.push('runtime_started'); } } as any,
      prepareSession: (id) => { calls.push(`session:${id}`); },
      execute: async (value) => { calls.push(`execute:${value.workBundle.instructions}`); },
    });
    await bridge.handle(JSON.stringify(packet('execute_attempt')), topic, '602');
    assert.deepEqual(calls, [`session:${session}`, 'runtime_started', 'execute:do work']);
  });

  test('deduplicates concurrent delivery of one Action', async () => {
    let executions = 0;
    const bridge = new LoopRuntimeBridge({
      botUid: '559',
      controllerUid: '602',
      evidenceSender: { workerReady: async () => undefined } as any,
      prepareSession: async () => undefined,
      execute: async () => { executions += 1; },
    });
    const text = JSON.stringify(packet('preflight_attempt'));
    await Promise.all([bridge.handle(text, topic, '602'), bridge.handle(text, topic, '602')]);
    assert.equal(executions, 0);
  });

  test('accepts normalized Controller UID and rejects an unauthorized sender', async () => {
    const bridge = new LoopRuntimeBridge({
      botUid: '559',
      controllerUid: '602',
      evidenceSender: { workerReady: async () => undefined } as any,
      prepareSession: async () => undefined,
      execute: async () => undefined,
    });
    await bridge.handle(JSON.stringify(packet('preflight_attempt')), topic, 'usr602');
    await assert.rejects(() => bridge.handle(JSON.stringify({ ...packet('execute_attempt'), actionId: 'action-2' }), topic, '603'), /Controller UID/);
  });

  test('rejects non-group topics and non-positive revisions', async () => {
    const bridge = new LoopRuntimeBridge({ botUid: '559', controllerUid: '602', evidenceSender: {} as any, prepareSession: () => undefined, execute: async () => undefined });
    await assert.rejects(() => bridge.handle(JSON.stringify({ ...packet('preflight_attempt'), targetTopicId: 'p2p_559_602', workerTopicId: 'p2p_559_602', action: { ...packet('preflight_attempt').action, targetTopicId: 'p2p_559_602' }, workerSessionId: 'session:v2:catscompany:group:p2p_559_602:agent:559' }), 'p2p_559_602', '602'), /group topic/);
    await assert.rejects(() => bridge.handle(JSON.stringify({ ...packet('preflight_attempt'), workItemRevision: 0, action: { ...packet('preflight_attempt').action, workItemRevision: 0 } }), topic, '602'), /positive integer/);
  });

  test('rejects a packet whose session is bound to another topic', async () => {
    const invalid = { ...packet('preflight_attempt'), workerSessionId: 'session:v2:catscompany:group:grp_999:agent:559' };
    const bridge = new LoopRuntimeBridge({ botUid: '559', controllerUid: '602', evidenceSender: {} as any, prepareSession: () => undefined, execute: async () => undefined });
    await assert.rejects(() => bridge.handle(JSON.stringify(invalid), topic, '602'), /workerSessionId/);
  });
});
