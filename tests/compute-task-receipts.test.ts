import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  ComputeTaskReceiptRouter,
  buildComputeTaskReceiptPrompt,
} from '../src/catscompany/compute-task-receipts';

describe('ComputeTaskReceiptRouter', () => {
  test('登记后消费回执，带出原对话路由并只消费一次', () => {
    const router = new ComputeTaskReceiptRouter();
    router.track({
      quoteId: 'hpc_quote_1',
      toolName: 'catsco_compute_task_quote',
      conversationSessionKey: 'catscompany:p2p_441_1619',
      conversationTopic: 'p2p_441_1619',
      actorUserId: 'usr441',
    });

    const consumed = router.consume({
      receipt_id: 'ctr_1',
      quote_id: 'hpc_quote_1',
      status: 'completed',
      charged_units: 120,
    });
    assert.ok(consumed);
    assert.equal(consumed!.task.conversationSessionKey, 'catscompany:p2p_441_1619');
    assert.equal(consumed!.task.conversationTopic, 'p2p_441_1619');
    assert.equal(consumed!.task.actorUserId, 'usr441');
    assert.equal(consumed!.receipt.charged_units, 120);

    assert.equal(router.consume({
      receipt_id: 'ctr_1',
      quote_id: 'hpc_quote_1',
      status: 'completed',
    }), null);
    assert.equal(router.pendingCount, 0);
  });

  test('重复 receipt_id 幂等，且不会吞掉其他 quote 的回执', () => {
    const router = new ComputeTaskReceiptRouter();
    router.track({ quoteId: 'hpc_quote_a' });
    router.track({ quoteId: 'hpc_quote_b' });

    assert.ok(router.consume({ receipt_id: 'dup', quote_id: 'hpc_quote_a', status: 'completed' }));
    assert.equal(router.consume({ receipt_id: 'dup', quote_id: 'hpc_quote_b', status: 'completed' }), null);
    assert.ok(router.consume({ receipt_id: 'other', quote_id: 'hpc_quote_b', status: 'failed' }));
  });

  test('未登记 quote、空回执和缺少 quote_id 都被忽略', () => {
    const router = new ComputeTaskReceiptRouter();
    assert.equal(router.consume(null), null);
    assert.equal(router.consume({ receipt_id: 'missing-quote' }), null);
    assert.equal(router.consume({ receipt_id: 'unknown', quote_id: 'hpc_unknown' }), null);
  });

  test('待处理项和已见回执按 TTL 过期，容量超限淘汰最旧项', () => {
    let now = 1_000;
    const router = new ComputeTaskReceiptRouter(100, 2, () => now);
    router.track({ quoteId: 'hpc_old' });
    now += 10;
    router.track({ quoteId: 'hpc_two' });
    router.track({ quoteId: 'hpc_three' });
    assert.equal(router.pendingCount, 2);
    assert.equal(router.consume({ receipt_id: 'old', quote_id: 'hpc_old' }), null);

    assert.ok(router.consume({ receipt_id: 'seen', quote_id: 'hpc_two' }));
    now += 101;
    router.track({ quoteId: 'hpc_fresh' });
    assert.equal(router.pendingCount, 1);
    assert.ok(router.consume({ receipt_id: 'seen', quote_id: 'hpc_fresh' }));
  });
});

describe('buildComputeTaskReceiptPrompt', () => {
  test('完成回执提示词包含状态、计量和结束要求', () => {
    const text = buildComputeTaskReceiptPrompt({
      receipt: {
        receipt_id: 'ctr_1',
        quote_id: 'hpc_quote_1',
        status: 'completed',
        charged_units: 120,
        progress: { slurm_job_id: '16', released: true },
      },
      task: {
        quoteId: 'hpc_quote_1',
        toolName: 'catsco_compute_task_quote',
        trackedAt: 0,
      },
    });
    assert.match(text, /算力后台任务回执/);
    assert.match(text, /hpc_quote_1/);
    assert.match(text, /120/);
    assert.match(text, /最终结果和实际扣费/);
    assert.match(text, /不要重复提交同一算力任务/);
  });

  test('失败回执提示词要求报告失败原因和资源回收状态', () => {
    const text = buildComputeTaskReceiptPrompt({
      receipt: { quote_id: 'hpc_quote_2', status: 'failed', error: 'Slurm job failed' },
      task: { quoteId: 'hpc_quote_2', toolName: 'catsco_compute_task_quote', trackedAt: 0 },
    });
    assert.match(text, /失败原因/);
    assert.match(text, /资源回收状态/);
    assert.match(text, /Slurm job failed/);
  });
});
