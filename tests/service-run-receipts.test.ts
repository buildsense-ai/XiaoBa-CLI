import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  ServiceRunReceiptRouter,
  buildServiceRunReceiptPrompt,
} from '../src/catscompany/service-run-receipts';

describe('ServiceRunReceiptRouter', () => {
  test('登记后消费：带出会话路由信息，且只消费一次', () => {
    const router = new ServiceRunReceiptRouter();
    router.track({
      runId: 'run_1',
      serviceSessionId: 'sess_1',
      toolName: 'catsco_codex',
      conversationSessionKey: 'catscompany:p2p:usr441:1619',
      conversationTopic: 'p2p_441_1619',
      actorUserId: 'usr441',
    });

    const consumed = router.consume({ receipt_id: 'rcp_1', run_id: 'run_1', status: 'completed' });
    assert.ok(consumed);
    assert.equal(consumed!.run.toolName, 'catsco_codex');
    assert.equal(consumed!.run.conversationSessionKey, 'catscompany:p2p:usr441:1619');
    assert.equal(consumed!.run.conversationTopic, 'p2p_441_1619');
    assert.equal(consumed!.run.actorUserId, 'usr441');

    // 同 run 再来一条回执（不同 receipt_id）：run 已消费 → 忽略
    assert.equal(router.consume({ receipt_id: 'rcp_2', run_id: 'run_1', status: 'completed' }), null);
  });

  test('重复 receipt_id（平台至少一次投递）只生效一次', () => {
    const router = new ServiceRunReceiptRouter();
    router.track({ runId: 'run_a' });
    router.track({ runId: 'run_b' });

    const first = router.consume({ receipt_id: 'dup', run_id: 'run_a', status: 'completed' });
    assert.ok(first);
    // 同 receipt_id 重投（哪怕换了 run）→ 视为重复
    assert.equal(router.consume({ receipt_id: 'dup', run_id: 'run_b', status: 'completed' }), null);
    // run_b 仍可被正常回执消费
    assert.ok(router.consume({ receipt_id: 'b1', run_id: 'run_b', status: 'completed' }));
  });

  test('未登记的 run 忽略', () => {
    const router = new ServiceRunReceiptRouter();
    assert.equal(router.consume({ receipt_id: 'x', run_id: 'run_unknown' }), null);
    assert.equal(router.consume(null), null);
    assert.equal(router.consume({ receipt_id: 'y' } as any), null);
  });

  test('登记项按 TTL 过期，不无限增长', () => {
    let now = 1_000_000;
    const router = new ServiceRunReceiptRouter(60_000, 4096, () => now);
    router.track({ runId: 'run_old', conversationSessionKey: 'k' });
    now += 61_000;
    assert.equal(router.consume({ receipt_id: 'r1', run_id: 'run_old', status: 'completed' }), null);
    assert.equal(router.pendingCount, 0);
  });

  test('同 run 重复登记只保留最新一条；超出上限淘汰最旧', () => {
    const router = new ServiceRunReceiptRouter(60_000, 2, () => 1_000);
    router.track({ runId: 'run_1', toolName: 'a' });
    router.track({ runId: 'run_1', toolName: 'b' });
    assert.equal(router.pendingCount, 1);
    const consumed = router.consume({ receipt_id: 'r1', run_id: 'run_1' });
    assert.equal(consumed!.run.toolName, 'b');

    router.track({ runId: 'run_2' });
    router.track({ runId: 'run_3' });
    router.track({ runId: 'run_4' });
    assert.equal(router.pendingCount, 2);
    assert.equal(router.consume({ receipt_id: 'r2', run_id: 'run_2' }), null);
    assert.ok(router.consume({ receipt_id: 'r3', run_id: 'run_4' }));
  });
});

describe('buildServiceRunReceiptPrompt', () => {
  const baseRun = {
    runId: 'run_1',
    serviceSessionId: 'sess_1',
    toolName: 'catsco_codex',
    conversationSessionKey: 'k',
    conversationTopic: 'p2p_1_2',
    actorUserId: 'usr1',
    trackedAt: 0,
  };

  test('completed：标注后台完成并要求继续推进', () => {
    const text = buildServiceRunReceiptPrompt({
      receipt: { receipt_id: 'r', run_id: 'run_1', status: 'completed' },
      run: baseRun,
    });
    assert.match(text, /后台任务回执/);
    assert.match(text, /catsco_codex/);
    assert.match(text, /run_1/);
    assert.match(text, /completed/);
    assert.match(text, /继续推进/);
  });

  test('awaiting_input：转述问题', () => {
    const text = buildServiceRunReceiptPrompt({
      receipt: { status: 'awaiting_input', question: '要哪个月的数据？' },
      run: baseRun,
    });
    assert.match(text, /需要用户补充信息/);
    assert.match(text, /要哪个月的数据/);
  });

  test('failed：告知原因并给建议', () => {
    const text = buildServiceRunReceiptPrompt({
      receipt: { status: 'failed', error: 'endpoint 超时' },
      run: baseRun,
    });
    assert.match(text, /失败/);
    assert.match(text, /endpoint 超时/);
    assert.match(text, /重试/);
  });

  test('未知状态：说明进展，不崩', () => {
    const text = buildServiceRunReceiptPrompt({ receipt: { status: 'weird' }, run: baseRun });
    assert.match(text, /weird/);
  });
});
