import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudBotModelAckRetry } from '../src/bot-definition/ack-retry';
import { CloudBotModelRuntimeReloadController } from '../src/bot-definition/runtime-reload';
import { isTransientCloudError } from '../src/bot-definition/transient-error';

test('a lost success ACK is retried without restarting the model', async () => {
  let sends = 0;
  let applies = 0;
  const selection = { modelId: 'm', revision: 7 };
  const ack = new CloudBotModelAckRetry({ isActive: () => true, send: async () => {
    if (++sends === 1) throw new Error('lost ACK');
  } });
  const controller = new CloudBotModelRuntimeReloadController({
    pullSelection: async () => { ack.observe(selection); await ack.retry(); return selection; },
    isIdle: () => true,
    applySelection: async () => { applies++; ack.schedule(selection, ''); await ack.retry(); return 'applied'; },
  });
  await controller.pollOnce(); await controller.pollOnce(); await controller.pollOnce();
  assert.equal(applies, 1); assert.equal(sends, 2);
});

test('a newer revision or disabled cloud management drops an obsolete ACK', async () => {
  const ack = new CloudBotModelAckRetry({ isActive: () => true, send: async () => assert.fail('stale ACK') });
  ack.schedule({ modelId: 'old', revision: 7 }, '');
  ack.observe({ modelId: 'new', revision: 8 }); await ack.retry();
  ack.schedule({ modelId: 'new', revision: 8 }, '');
  ack.observe(undefined); await ack.retry();
});

test('a late ACK cannot clear a newer pending ACK or reschedule after shutdown', async () => {
  let active = true;
  let finish!: () => void;
  const revisions: number[] = [];
  const ack = new CloudBotModelAckRetry({ isActive: () => active, send: async selection => {
    revisions.push(selection.revision);
    if (selection.revision === 7) await new Promise<void>(resolve => { finish = resolve; });
  } });
  ack.schedule({ modelId: 'm', revision: 7 }, '');
  const pending = ack.retry();
  ack.schedule({ modelId: 'm', revision: 8 }, '');
  finish(); await pending; await ack.retry();
  active = false;
  ack.schedule({ modelId: 'm', revision: 9 }, ''); await ack.retry();
  assert.deepEqual(revisions, [7, 8]);
});

test('transient cloud classification uses structured transport status and preserves auth failures', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isTransientCloudError({ status }), true);
  for (const status of [400, 401, 403, 409, 422]) assert.equal(isTransientCloudError({ status, message: 'timeout 503' }), false);
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.equal(isTransientCloudError(new Error('wrapped', { cause: { code } })), true);
  }
  assert.equal(isTransientCloudError(new DOMException('deadline', 'TimeoutError')), true);
  assert.equal(isTransientCloudError(new DOMException('aborted', 'AbortError')), true);
  assert.equal(isTransientCloudError(new Error('unsupported model')), false);
});
