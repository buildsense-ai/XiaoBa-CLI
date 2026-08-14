import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LOOP_ACTION_PACKET_SCHEMA,
  LoopEvidenceSender,
  buildLoopEvidenceEvent,
  canonicalLoopEvidenceJson,
  resolveLoopEvidenceBotBinding,
  type LoopActionPacket,
} from '../src/catscompany/loop-evidence';

const BOT_UID = '559';
const EXECUTION_TOPIC = 'grp_101';
const EVIDENCE_TOPIC = 'grp_102';

function packet(overrides: Partial<LoopActionPacket> = {}): LoopActionPacket {
  const base: LoopActionPacket = {
    schema: LOOP_ACTION_PACKET_SCHEMA,
    kind: 'preflight_attempt',
    actionId: 'action-1',
    actionKey: 'preflight_attempt:attempt-1:1',
    action: {
      state: 'ready',
      workItemRevision: 7,
      targetPrincipal: 'catsco-user:559',
      targetTopicId: EXECUTION_TOPIC,
    },
    workItemId: 'work-1',
    workItemRevision: 7,
    targetPrincipal: 'catsco-user:559',
    targetTopicId: EXECUTION_TOPIC,
    workerTopicId: EXECUTION_TOPIC,
    evidenceTopicId: EVIDENCE_TOPIC,
    attemptId: 'attempt-1',
    ownerUid: '602',
    generation: 1,
    runtimePrincipal: 'catsco-user:559',
    workerSessionId: 'session:v2:catscompany:group:grp_101:agent:559',
    workBundle: {
      contractDigest: 'a'.repeat(64),
      instructions: 'Make the requested change and report the result.',
      deliverables: ['github-pr'],
    },
  };
  return { ...base, ...overrides, action: { ...base.action, ...(overrides.action || {}) } };
}

function fakeClient(uid = BOT_UID) {
  const sent: any[] = [];
  return {
    client: {
      uid,
      sendStructuredMessage: async (message: any) => {
        sent.push(message);
        return 42;
      },
    },
    sent,
  };
}

describe('CatsCo Loop evidence sender', () => {
  test('sends canonical worker_ready evidence only to the evidence topic with idempotency-bound client_msg_id', async () => {
    const { client, sent } = fakeClient();
    const sender = new LoopEvidenceSender({ client, botUid: BOT_UID });
    const result = await sender.workerReady(packet(), EXECUTION_TOPIC);

    assert.equal(result.seqId, 42);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].topic_id, EVIDENCE_TOPIC);
    assert.notEqual(sent[0].topic_id, EXECUTION_TOPIC);
    assert.equal(sent[0].client_msg_id, result.event.idempotencyKey);
    assert.equal(sent[0].metadata.client_msg_id, result.event.idempotencyKey);
    assert.equal(sent[0].content, canonicalLoopEvidenceJson(result.event));
    assert.deepEqual(JSON.parse(sent[0].content), {
      entityRef: 'attempt:attempt-1',
      eventId: result.event.eventId,
      idempotencyKey: result.event.idempotencyKey,
      payload: {
        attemptId: 'attempt-1',
        expectedRevision: 7,
        generation: 1,
        runtimePrincipal: 'catsco-user:559',
        signature: 'catsco-message-attested',
        workItemId: 'work-1',
        workerSessionId: 'session:v2:catscompany:group:grp_101:agent:559',
      },
      source: 'catsco-user:559',
      type: 'worker_ready',
    });
  });

  test('builds deterministic runtime_started evidence from the session-bound action packet', () => {
    const first = buildLoopEvidenceEvent({ ...packet(), kind: 'execute_attempt', actionKey: 'execute_attempt:attempt-1:1' }, EXECUTION_TOPIC, BOT_UID, 'runtime_started');
    const second = buildLoopEvidenceEvent({ ...packet(), kind: 'execute_attempt', actionKey: 'execute_attempt:attempt-1:1' }, EXECUTION_TOPIC, BOT_UID, 'runtime_started');
    assert.deepEqual(first, second);
    assert.equal(first.type, 'runtime_started');
    assert.equal(first.payload.workerSessionId, 'session:v2:catscompany:group:grp_101:agent:559');
  });

  test('rejects mismatched actionable packet bindings before sending', async () => {
    const invalidPackets: Array<[string, LoopActionPacket, 'worker_ready' | 'runtime_started', string]> = [
      ['wrong target principal', packet({ targetPrincipal: 'catsco-user:560' }), 'worker_ready', /target principal/],
      ['wrong action principal', packet({ action: { ...packet().action, targetPrincipal: 'catsco-user:560' } }), 'worker_ready', /target principal/],
      ['wrong runtime principal', packet({ runtimePrincipal: 'catsco-user:560' }), 'worker_ready', /runtime principal/],
      ['wrong received topic', packet(), 'worker_ready', /execution topic/],
      ['missing evidence topic', packet({ evidenceTopicId: '' }), 'worker_ready', /evidenceTopicId/],
      ['evidence equals execution topic', packet({ evidenceTopicId: EXECUTION_TOPIC }), 'worker_ready', /evidence topic/],
      ['missing session', packet({ workerSessionId: '' }), 'worker_ready', /workerSessionId/],
      ['missing owner', packet({ ownerUid: '' }), 'worker_ready', /ownerUid/],
      ['numeric owner', packet({ ownerUid: 602 as any }), 'worker_ready', /ownerUid/],
      ['object owner', packet({ ownerUid: { value: '602' } as any }), 'worker_ready', /ownerUid/],
      ['wrong session topic', packet({ workerSessionId: 'session:v2:catscompany:group:grp_999:agent:559' }), 'worker_ready', /workerSessionId/],
      ['wrong session bot', packet({ workerSessionId: 'session:v2:catscompany:group:grp_101:agent:560' }), 'worker_ready', /workerSessionId/],
      ['malformed session', packet({ workerSessionId: 'cc_group:grp_101' }), 'worker_ready', /workerSessionId/],
      ['stale action', packet({ action: { ...packet().action, state: 'satisfied' as 'ready' } }), 'worker_ready', /stale/],
      ['mismatched revision', packet({ action: { ...packet().action, workItemRevision: 8 } }), 'worker_ready', /revision/],
      ['ready sent from execute action', { ...packet(), kind: 'execute_attempt', actionKey: 'execute_attempt:attempt-1:1' }, 'worker_ready', /does not match/],
      ['started sent from preflight action', packet(), 'runtime_started', /does not match/],
    ];

    for (const [_name, invalid, eventType, expected] of invalidPackets) {
      const { client, sent } = fakeClient();
      const sender = new LoopEvidenceSender({ client, botUid: BOT_UID });
      const receivedTopic = _name === 'wrong received topic' ? 'grp_999' : EXECUTION_TOPIC;
      await assert.rejects(() => sender.send(invalid, receivedTopic, eventType), expected);
      assert.equal(sent.length, 0);
    }
  });

  test('refuses to send when the connected client is not the configured Bot UID', async () => {
    const { client, sent } = fakeClient('560');
    const sender = new LoopEvidenceSender({ client, botUid: BOT_UID });
    await assert.rejects(() => sender.workerReady(packet(), EXECUTION_TOPIC), /UID does not match/);
    assert.equal(sent.length, 0);
  });

  test('resolves Bot-only binding from local config without returning account credentials', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-loop-evidence-'));
    try {
      fs.mkdirSync(path.join(root, '.xiaoba'), { recursive: true });
      fs.writeFileSync(path.join(root, '.xiaoba', 'catsco.json'), JSON.stringify({
        version: 1,
        account: { uid: 'human-uid', token: 'human-secret-token' },
        currentBot: { uid: BOT_UID, apiKey: 'bot-secret-key', boundByUserUid: 'human-uid', bindingSource: 'test' },
        device: { deviceId: 'device-1', bodyId: 'body-1', installationId: 'install-1' },
      }));
      const binding = resolveLoopEvidenceBotBinding(root);
      assert.deepEqual(Object.keys(binding).sort(), ['apiKey', 'bodyId', 'botUid', 'httpBaseUrl', 'installationId', 'serverUrl']);
      assert.equal(binding.botUid, BOT_UID);
      assert.equal(binding.apiKey, 'bot-secret-key');
      assert.equal(JSON.stringify(binding).includes('human-secret-token'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
