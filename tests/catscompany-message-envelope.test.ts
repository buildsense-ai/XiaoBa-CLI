import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsClient } from '../src/catscompany/client';
import {
  createCatsCoMessageEnvelope,
  createExecutionScope,
} from '../src/catscompany/message-envelope';

describe('CatsCompany MessageEnvelope and ExecutionScope', () => {
  test('keeps two p2p users scoped separately when they message the same agent', () => {
    const alice = createCatsCoMessageEnvelope({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      seq: 21,
      text: 'alice task',
      botUid: 'usr43',
      metadata: {
        catsco_identity: {
          actor: { user_id: 'usr7', display_name: 'Alice' },
          agent: { agent_id: 'usr43', body_id: 'body-mac' },
          topic: { topic_id: 'p2p_7_43', type: 'p2p', channel_seq: 21 },
          permissions: { source: 'server_canonical_message' },
        },
      },
    });
    const bob = createCatsCoMessageEnvelope({
      topic: 'p2p_8_43',
      senderId: 'usr8',
      seq: 22,
      text: 'bob task',
      botUid: 'usr43',
      metadata: {
        catsco_identity: {
          actor: { user_id: 'usr8', display_name: 'Bob' },
          agent: { agent_id: 'usr43', body_id: 'body-mac' },
          topic: { topic_id: 'p2p_8_43', type: 'p2p', channel_seq: 22 },
          permissions: { source: 'server_canonical_message' },
        },
      },
    });

    assert.equal(alice.sessionKey, 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43');
    assert.equal(alice.legacySessionKey, 'cc_user:usr7');
    assert.equal(bob.sessionKey, 'session:v2:catscompany:p2p:p2p_8_43:agent:usr43');
    assert.equal(bob.legacySessionKey, 'cc_user:usr8');
    assert.equal(alice.identityTrust, 'server_canonical');
    assert.equal(bob.identityTrust, 'server_canonical');
    assert.equal(createExecutionScope(alice).actorUserId, 'usr7');
    assert.equal(createExecutionScope(bob).actorUserId, 'usr8');
  });

  test('creates a trusted group scope with recipient agent body identity', () => {
    const envelope = createCatsCoMessageEnvelope({
      topic: 'grp_80',
      isGroup: true,
      senderId: 'usr7',
      seq: 31,
      text: '@usr43 请看一下',
      metadata: {
        catsco_identity: {
          actor: { user_id: 'usr7', username: 'alice' },
          agent: { agent_id: 'usr43', body_id: 'body-review' },
          topic: { topic_id: 'grp_80', type: 'group', channel_seq: 31 },
          permissions: { source: 'server_canonical_message' },
        },
      },
    });
    const scope = createExecutionScope(envelope);

    assert.equal(envelope.sessionKey, 'session:v2:catscompany:group:grp_80%3Aactor%3Ausr7:agent:usr43');
    assert.equal(envelope.legacySessionKey, 'cc_group:grp_80:actor:usr7');
    assert.equal(scope.topicType, 'group');
    assert.equal(scope.actorUserId, 'usr7');
    assert.equal(scope.agentId, 'usr43');
    assert.equal(scope.agentBodyId, 'body-review');
    assert.equal(scope.isTrusted, true);
  });

  test('normalizes numeric CatsCo ids to the canonical usr-prefixed form', () => {
    const envelope = createCatsCoMessageEnvelope({
      topic: 'p2p_7_43',
      senderId: '7',
      seq: 36,
      text: 'mobile follow-up',
      botUid: '43',
      metadata: {
        catsco_identity: {
          actor: { user_id: '7', display_name: 'Alice' },
          agent: { agent_id: '43', body_id: 'body-mobile' },
          topic: { topic_id: 'p2p_7_43', type: 'p2p', channel_seq: 36 },
          permissions: { source: 'server_canonical_message' },
        },
      },
    });
    const scope = createExecutionScope(envelope);

    assert.equal(envelope.actorUserId, 'usr7');
    assert.equal(envelope.agentId, 'usr43');
    assert.equal(envelope.sessionKey, 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43');
    assert.equal(envelope.legacySessionKey, 'cc_user:usr7');
    assert.equal(scope.actorUserId, 'usr7');
    assert.equal(scope.agentId, 'usr43');
    assert.equal(scope.agentBodyId, 'body-mobile');
    assert.equal(scope.isTrusted, true);
  });

  test('does not trust spoofed catsco_identity when it conflicts with sender', () => {
    const envelope = createCatsCoMessageEnvelope({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      seq: 40,
      text: 'hello',
      metadata: {
        catsco_identity: {
          actor: { user_id: 'usr999' },
          agent: { agent_id: 'usr43', body_id: 'wrong-body' },
          topic: { topic_id: 'p2p_7_43', type: 'p2p', channel_seq: 40 },
          permissions: { source: 'server_canonical_message' },
        },
      },
    });
    const scope = createExecutionScope(envelope);

    assert.equal(envelope.identityTrust, 'untrusted');
    assert.equal(scope.isTrusted, false);
    assert.equal(scope.actorUserId, 'usr7');
    assert.equal(scope.agentBodyId, undefined);
    assert.ok(envelope.warnings?.some(warning => warning.includes('actor.user_id')));
  });

  test('marks missing canonical identity as legacy context instead of trusted', () => {
    const envelope = createCatsCoMessageEnvelope({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      seq: 41,
      text: 'legacy hello',
      botUid: 'usr43',
      metadata: { client_msg_id: 'catsco-legacy-1' },
    });
    const scope = createExecutionScope(envelope);

    assert.equal(envelope.identityTrust, 'legacy_context');
    assert.equal(envelope.messageId, 'catsco-legacy-1');
    assert.equal(scope.isTrusted, false);
    assert.equal(scope.actorUserId, 'usr7');
    assert.equal(scope.agentId, 'usr43');
    assert.equal(scope.agentBodyId, undefined);
  });

  test('client forwards inbound metadata into MessageContext', async () => {
    const client = new CatsClient({
      serverUrl: 'ws://127.0.0.1:1',
      apiKey: 'cc-test',
      bodyId: 'body-test',
    });

    const messagePromise = new Promise<any>(resolve => {
      client.once('message', resolve);
    });

    (client as any).handleMessage({
      data: {
        topic: 'p2p_7_43',
        from: 'usr7',
        seq: 51,
        content: 'hello',
        type: 'text',
        metadata: {
          catsco_identity: {
            actor: { user_id: 'usr7' },
            agent: { agent_id: 'usr43', body_id: 'body-test' },
            topic: { topic_id: 'p2p_7_43', type: 'p2p', channel_seq: 51 },
            permissions: { source: 'server_canonical_message' },
          },
        },
      },
    });

    const ctx = await messagePromise;
    assert.equal(ctx.topic, 'p2p_7_43');
    assert.equal(ctx.senderId, 'usr7');
    assert.deepEqual((ctx.metadata as any).catsco_identity.agent, {
      agent_id: 'usr43',
      body_id: 'body-test',
    });
  });
});
