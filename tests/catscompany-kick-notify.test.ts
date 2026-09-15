import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsClient, CatsSendError } from '../src/catscompany/client';
import { MessageSender } from '../src/catscompany/message-sender';
import { buildCatsCoSessionKey } from '../src/catscompany/message-envelope';

function createClient(): CatsClient {
  const client = new CatsClient({
    serverUrl: 'ws://127.0.0.1:9',
    apiKey: 'cc-test-key',
  });
  client.on('error', () => undefined);
  return client;
}

describe('CatsCompany kick/disband notices', () => {
  test('emits member_kicked with topic and kicked user_id from pres', () => {
    const client = createClient();
    const events: Array<{ topic?: string; userId?: string }> = [];
    client.on('member_kicked', (payload: { topic?: string; userId?: string }) => events.push(payload));

    (client as any).handleMessage({
      pres: { what: 'member_kicked', topic: 'grp_42', user_id: 407, src: 'grp_42' },
    });

    assert.deepEqual(events, [{ topic: 'grp_42', userId: '407' }]);
  });

  test('keeps empty userId when pres carries no user_id', () => {
    const client = createClient();
    const events: Array<{ topic?: string; userId?: string }> = [];
    client.on('member_kicked', (payload: { topic?: string; userId?: string }) => events.push(payload));

    (client as any).handleMessage({
      pres: { what: 'member_kicked', topic: 'grp_7', src: 'grp_7' },
    });

    assert.deepEqual(events, [{ topic: 'grp_7', userId: '' }]);
  });

  test('emits group_disbanded with the topic', () => {
    const client = createClient();
    const events: Array<{ topic?: string }> = [];
    client.on('group_disbanded', (payload: { topic?: string }) => events.push(payload));

    (client as any).handleMessage({
      pres: { what: 'group_disbanded', topic: 'grp_99', src: 'grp_99' },
    });

    assert.deepEqual(events, [{ topic: 'grp_99' }]);
  });

  test('group session keys use the cc_group:<topic> form used by message handling', () => {
    assert.equal(buildCatsCoSessionKey('group', 'grp_42', ''), 'cc_group:grp_42');
  });
});

describe('CatsCompany MessageSender send circuit breaker', () => {
  test('triggers onTopicSendBlocked after 5 consecutive 403 rejections', async () => {
    const sender = new MessageSender({
      sendStructuredMessage: async () => {
        throw new CatsSendError('ack', 'CatsCompany ack 403: not a group member', 403);
      },
    } as any, 'https://app.example.test', 'cc_test');

    const blocked: Array<{ topic: string; code?: number }> = [];
    sender.onTopicSendBlocked = (topic, error) => blocked.push({ topic, code: error.code });

    for (let i = 0; i < 4; i += 1) {
      await assert.rejects(() => sender.sendText('grp_9', `turn-${i}`), /not a group member/);
    }
    assert.deepEqual(blocked, [], 'must not fire before reaching the threshold');

    await assert.rejects(() => sender.sendText('grp_9', 'turn-5'), /not a group member/);
    assert.deepEqual(blocked, [{ topic: 'grp_9', code: 403 }]);
  });

  test('resets the streak after a successful send', async () => {
    let fail = true;
    const sender = new MessageSender({
      sendStructuredMessage: async () => {
        if (fail) throw new CatsSendError('ack', 'CatsCompany ack 403: not a group member', 403);
        return 1;
      },
    } as any, 'https://app.example.test', 'cc_test');

    const blocked: string[] = [];
    sender.onTopicSendBlocked = (topic) => blocked.push(topic);

    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => sender.sendText('grp_9', 'fail'));
    }
    fail = false;
    await sender.sendText('grp_9', 'ok');
    fail = true;
    for (let i = 0; i < 4; i += 1) {
      await assert.rejects(() => sender.sendText('grp_9', 'fail again'));
    }
    assert.deepEqual(blocked, [], 'successful send must reset the failure streak');

    await assert.rejects(() => sender.sendText('grp_9', 'streak 5'));
    assert.deepEqual(blocked, ['grp_9']);
  });

  test('does not count non-permanent failures (429 rate limit) toward the threshold', async () => {
    const sender = new MessageSender({
      sendStructuredMessage: async () => {
        throw new CatsSendError('ack', 'CatsCompany ack 429: rate limited', 429);
      },
    } as any, 'https://app.example.test', 'cc_test');

    const blocked: string[] = [];
    sender.onTopicSendBlocked = (topic) => blocked.push(topic);

    for (let i = 0; i < 8; i += 1) {
      await assert.rejects(() => sender.sendText('grp_9', 'rate limited'), /rate limited/);
    }
    assert.deepEqual(blocked, []);
  });

  test('404 (deleted target) also feeds the circuit breaker', async () => {
    const sender = new MessageSender({
      sendStructuredMessage: async () => {
        throw new CatsSendError('ack', 'CatsCompany ack 404: topic not found', 404);
      },
    } as any, 'https://app.example.test', 'cc_test');

    const blocked: Array<{ code?: number }> = [];
    sender.onTopicSendBlocked = (_topic, error) => blocked.push({ code: error.code });

    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(() => sender.sendText('grp_11', 'gone'), /topic not found/);
    }
    assert.deepEqual(blocked, [{ code: 404 }]);
  });
});
