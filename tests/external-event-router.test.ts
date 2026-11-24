/**
 * 统一外部事件唤醒总线（ExternalEventRouter）单测。
 * 覆盖：eventId 幂等去重、artifactId → sessionKey/topic 绑定路由、
 * A2UI 立即唤醒、批注防抖合并、负载合并、TTL 过期、退订与自定义策略。
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  ExternalEventRouter,
  defaultExternalEventPrompt,
  mergeEventPayloads,
  type ExternalEventDispatch,
  type ExternalEventEnvelope,
} from '../src/events/external-event-router';

function collect(router: ExternalEventRouter): { dispatches: ExternalEventDispatch[]; unsubscribe: () => void } {
  const dispatches: ExternalEventDispatch[] = [];
  const unsubscribe = router.subscribe(d => { dispatches.push(d); });
  return { dispatches, unsubscribe };
}

/** 等路由的串行派发链排空（防抖 flush 也走同一条链）。 */
async function flush(router: ExternalEventRouter): Promise<void> {
  // emitAndWait 等 dispatchChain；无事件时也安全。
  await (router as any).dispatchChain;
}

function a2ui(overrides: Partial<ExternalEventEnvelope> = {}): ExternalEventEnvelope {
  return {
    source: 'artifact:a2ui',
    type: 'a2ui.action',
    target: { sessionKey: 'sess-1', topic: 'p2p_1_2' },
    actorUserId: 'usr_7',
    payload: { action: 'click', widget: 'ok-btn' },
    priority: 'immediate',
    ...overrides,
  };
}

describe('ExternalEventRouter — 幂等去重', () => {
  test('相同 eventId 在 TTL 内只派发一次', async () => {
    const router = new ExternalEventRouter();
    const { dispatches } = collect(router);
    const event = a2ui({ eventId: 'evt-1' });
    assert.strictEqual(router.emit(event), true);
    assert.strictEqual(router.emit(event), false);
    await flush(router);
    assert.strictEqual(dispatches.length, 1);
  });

  test('不同 eventId 各自派发；无 eventId 不去重', async () => {
    const router = new ExternalEventRouter();
    const { dispatches } = collect(router);
    router.emit(a2ui({ eventId: 'a' }));
    router.emit(a2ui({ eventId: 'b' }));
    router.emit(a2ui());
    router.emit(a2ui());
    await flush(router);
    assert.strictEqual(dispatches.length, 4);
  });

  test('eventId 超过 TTL 后允许再次派发', async () => {
    let now = 1000;
    const router = new ExternalEventRouter({ dedupeTtlMs: 100, now: () => now });
    const { dispatches } = collect(router);
    router.emit(a2ui({ eventId: 'ttl' }));
    await flush(router);
    now += 200;
    router.emit(a2ui({ eventId: 'ttl' }));
    await flush(router);
    assert.strictEqual(dispatches.length, 2);
  });

  test('非法 envelope 直接拒绝', () => {
    const router = new ExternalEventRouter();
    assert.strictEqual(router.emit({} as ExternalEventEnvelope), false);
    assert.strictEqual(router.emit({ source: '', type: 'x' } as ExternalEventEnvelope), false);
    assert.strictEqual(router.emit({ source: 'mcp:s', type: '' } as ExternalEventEnvelope), false);
  });
});

describe('ExternalEventRouter — artifact 路由', () => {
  test('bindArtifact 后 artifactId 事件唤回绑定会话', async () => {
    const router = new ExternalEventRouter();
    const { dispatches } = collect(router);
    router.bindArtifact('art-1', { sessionKey: 'sess-A', topic: 'grp_x' });
    router.emit({
      source: 'artifact:a2ui',
      type: 'a2ui.submit',
      target: { artifactId: 'art-1' },
      priority: 'immediate',
    });
    await flush(router);
    assert.strictEqual(dispatches.length, 1);
    assert.strictEqual(dispatches[0].sessionKey, 'sess-A');
    assert.strictEqual(dispatches[0].topic, 'grp_x');
    assert.strictEqual(dispatches[0].artifactId, 'art-1');
  });

  test('显式 sessionKey 优先于 artifact 绑定', async () => {
    const router = new ExternalEventRouter();
    const { dispatches } = collect(router);
    router.bindArtifact('art-2', { sessionKey: 'sess-old', topic: 't_old' });
    router.emit({
      source: 'artifact:a2ui',
      type: 'a2ui.action',
      target: { artifactId: 'art-2', sessionKey: 'sess-new', topic: 't_new' },
      priority: 'immediate',
    });
    await flush(router);
    assert.strictEqual(dispatches[0].sessionKey, 'sess-new');
    assert.strictEqual(dispatches[0].topic, 't_new');
    assert.strictEqual(dispatches[0].artifactId, 'art-2');
  });

  test('未绑定 artifact 且无 sessionKey → 丢弃但不污染幂等表，绑定后重投可正常派发', async () => {
    const router = new ExternalEventRouter({ aggregationPolicies: {} });
    const { dispatches } = collect(router);
    const first = router.emitWithResult({
      eventId: 'orphan',
      source: 'mcp:srv',
      type: 'mcp.notification.x',
      target: { artifactId: 'art-missing' },
    });
    assert.strictEqual(first.accepted, false);
    assert.strictEqual(first.reason, 'unbound');
    await flush(router);
    assert.strictEqual(dispatches.length, 0);
    // 未绑定时不占用幂等键：绑定后重投同一 eventId 应被接受并派发。
    router.bindArtifact('art-missing', { sessionKey: 'sess-late' });
    const retry = router.emitWithResult({
      eventId: 'orphan',
      source: 'mcp:srv',
      type: 'mcp.notification.x',
      target: { artifactId: 'art-missing' },
    });
    assert.strictEqual(retry.accepted, true);
    assert.strictEqual(retry.reason, 'dispatched');
    await flush(router);
    assert.strictEqual(dispatches.length, 1);
    assert.strictEqual(dispatches[0].sessionKey, 'sess-late');
  });

  test('unbindArtifact 后事件无法再路由', async () => {
    const router = new ExternalEventRouter();
    const { dispatches } = collect(router);
    router.bindArtifact('art-3', { sessionKey: 'sess-3' });
    router.unbindArtifact('art-3');
    assert.strictEqual(router.emit({
      source: 'artifact:a2ui', type: 'a2ui.action', target: { artifactId: 'art-3' },
    }), false);
    await flush(router);
    assert.strictEqual(dispatches.length, 0);
  });

  test('绑定 TTL 过期后不再路由；重复绑定刷新路由', async () => {
    let now = 1000;
    const router = new ExternalEventRouter({ bindingTtlMs: 100, now: () => now });
    const { dispatches } = collect(router);
    router.bindArtifact('art-4', { sessionKey: 'sess-old' });
    now += 50;
    router.bindArtifact('art-4', { sessionKey: 'sess-new' }); // 刷新
    now += 80;
    assert.strictEqual(router.resolveArtifact('art-4')?.sessionKey, 'sess-new');
    now += 30; // 第二次绑定后 >100ms
    assert.strictEqual(router.resolveArtifact('art-4'), undefined);
    router.emit({ source: 'artifact:a2ui', type: 'a2ui.action', target: { artifactId: 'art-4' } });
    await flush(router);
    assert.strictEqual(dispatches.length, 0);
  });
});

describe('ExternalEventRouter — 优先级与防抖聚合', () => {
  test('A2UI immediate 事件绕过聚合立即派发', async () => {
    const router = new ExternalEventRouter({
      aggregationPolicies: { 'artifact:a2ui': { windowMs: 60_000 } },
    });
    const { dispatches } = collect(router);
    router.emit(a2ui({ priority: 'immediate' }));
    await flush(router);
    assert.strictEqual(dispatches.length, 1);
  });

  test('默认策略：连续批注在窗口内合并为一次唤醒', async () => {
    const router = new ExternalEventRouter({
      aggregationPolicies: { 'artifact:annotation': { windowMs: 30 } },
    });
    const { dispatches } = collect(router);
    const base: ExternalEventEnvelope = {
      source: 'artifact:annotation',
      type: 'annotation.created',
      target: { sessionKey: 'sess-ann', topic: 'p2p_1_2' },
      actorUserId: 'usr_9',
    };
    router.emit({ ...base, eventId: 'ann-1', payload: { line: 3, note: '第一段' } });
    router.emit({ ...base, eventId: 'ann-2', payload: { line: 7, note: '第二段' } });
    router.emit({ ...base, eventId: 'ann-3', payload: { line: 9, note: '第三段' } });
    await new Promise(resolve => setTimeout(resolve, 120));
    await flush(router);
    assert.strictEqual(dispatches.length, 1);
    const merged = dispatches[0].event;
    assert.deepStrictEqual(merged.payload, {
      items: [{ line: 3, note: '第一段' }, { line: 7, note: '第二段' }, { line: 9, note: '第三段' }],
    });
    assert.deepStrictEqual(merged.mergedEventIds, ['ann-1', 'ann-2', 'ann-3']);
    // 合并后丢弃原始 eventId（聚合是一次新派发）。
    assert.strictEqual(merged.eventId, undefined);
  });

  test('不同防抖键（不同会话）不互相合并', async () => {
    const router = new ExternalEventRouter({
      aggregationPolicies: { 'artifact:annotation': { windowMs: 30 } },
    });
    const { dispatches } = collect(router);
    router.emit({
      source: 'artifact:annotation', type: 'a', target: { sessionKey: 's1' }, payload: 'x',
    });
    router.emit({
      source: 'artifact:annotation', type: 'a', target: { sessionKey: 's2' }, payload: 'y',
    });
    await new Promise(resolve => setTimeout(resolve, 120));
    await flush(router);
    assert.strictEqual(dispatches.length, 2);
  });

  test('防抖窗口内的新事件重置计时（leading+trailing 语义）', async () => {
    const router = new ExternalEventRouter({
      aggregationPolicies: { 'artifact:annotation': { windowMs: 60 } },
    });
    const { dispatches } = collect(router);
    router.emit({ source: 'artifact:annotation', type: 'a', target: { sessionKey: 's' }, payload: 1 });
    await new Promise(resolve => setTimeout(resolve, 40));
    router.emit({ source: 'artifact:annotation', type: 'a', target: { sessionKey: 's' }, payload: 2 });
    await new Promise(resolve => setTimeout(resolve, 40));
    // 距第二条仅 40ms，仍在窗口内：尚未派发。
    assert.strictEqual(dispatches.length, 0);
    await new Promise(resolve => setTimeout(resolve, 80));
    await flush(router);
    assert.strictEqual(dispatches.length, 1);
  });

  test('自定义 merge 策略生效', async () => {
    const router = new ExternalEventRouter({
      aggregationPolicies: {
        'mcp:srv': {
          windowMs: 30,
          merge: (pending, next) => ({ ...pending, payload: `${pending.payload}+${next.payload}` }),
        },
      },
    });
    const { dispatches } = collect(router);
    router.emit({ source: 'mcp:srv', type: 't', target: { sessionKey: 's' }, payload: 'a' });
    router.emit({ source: 'mcp:srv', type: 't', target: { sessionKey: 's' }, payload: 'b' });
    await new Promise(resolve => setTimeout(resolve, 120));
    await flush(router);
    assert.strictEqual(dispatches.length, 1);
    assert.strictEqual(dispatches[0].event.payload, 'a+b');
  });
});

describe('ExternalEventRouter — 派发与提示文本', () => {
  test('dispatch 携带解析后的路由与默认提示文本', async () => {
    const router = new ExternalEventRouter();
    const { dispatches } = collect(router);
    router.emit({
      source: 'mcp:github', type: 'mcp.notification.issue',
      target: { sessionKey: 'sess-x', topic: 'grp_y' },
      actorUserId: 'usr_42',
      payload: { issue: 7 },
      priority: 'immediate',
    });
    await flush(router);
    assert.strictEqual(dispatches.length, 1);
    assert.strictEqual(dispatches[0].actorUserId, 'usr_42');
    assert.match(dispatches[0].text, /mcp:github/);
    assert.match(dispatches[0].text, /issue/);
  });

  test('buildText 优先于默认渲染（服务回执自定义文案）', async () => {
    const router = new ExternalEventRouter();
    const { dispatches } = collect(router);
    router.emit({
      source: 'catsco:receipt', type: 'service_run_receipt',
      target: { sessionKey: 's' }, priority: 'immediate',
      buildText: () => '（后台任务回执：工具 catsco_x，run r1，状态 completed）',
    });
    await flush(router);
    assert.strictEqual(dispatches[0].text, '（后台任务回执：工具 catsco_x，run r1，状态 completed）');
  });

  test('自定义 buildPrompt 全局生效', async () => {
    const router = new ExternalEventRouter({ buildPrompt: e => `custom:${e.source}:${e.type}` });
    const { dispatches } = collect(router);
    router.emit(a2ui());
    await flush(router);
    assert.strictEqual(dispatches[0].text, 'custom:artifact:a2ui:a2ui.action');
  });

  test('订阅者异常不阻断其它订阅者与后续事件', async () => {
    const router = new ExternalEventRouter();
    const calls: string[] = [];
    router.subscribe(() => { throw new Error('boom'); });
    router.subscribe(d => { calls.push(d.sessionKey); });
    router.emit(a2ui({ target: { sessionKey: 's1' } }));
    router.emit(a2ui({ target: { sessionKey: 's2' } }));
    await flush(router);
    assert.deepStrictEqual(calls, ['s1', 's2']);
    assert.strictEqual(router.stats.dropped, 2); // 两条派发各抛一次
  });

  test('退订后不再收到派发', async () => {
    const router = new ExternalEventRouter();
    const { dispatches, unsubscribe } = collect(router);
    router.emit(a2ui());
    await flush(router);
    unsubscribe();
    router.emit(a2ui());
    await flush(router);
    assert.strictEqual(dispatches.length, 1);
  });

  test('emitAndWait 等待防抖 flush', async () => {
    const router = new ExternalEventRouter({
      aggregationPolicies: { 'artifact:annotation': { windowMs: 30 } },
    });
    const { dispatches } = collect(router);
    router.emit({ source: 'artifact:annotation', type: 'a', target: { sessionKey: 's' }, payload: 1 });
    await router.emitAndWait({ source: 'artifact:annotation', type: 'a', target: { sessionKey: 's' }, payload: 2 });
    await new Promise(resolve => setTimeout(resolve, 120));
    await flush(router);
    assert.strictEqual(dispatches.length, 1);
  });
});

describe('辅助函数', () => {
  test('mergeEventPayloads 首个负载包装为 items', () => {
    const pending: ExternalEventEnvelope = {
      eventId: 'e1', source: 'artifact:annotation', type: 'a',
      target: { sessionKey: 's' }, payload: { n: 1 },
    };
    const merged = mergeEventPayloads(pending, { ...pending, eventId: 'e2', payload: { n: 2 } });
    assert.deepStrictEqual(merged.payload, { items: [{ n: 1 }, { n: 2 }] });
    assert.deepStrictEqual(merged.mergedEventIds, ['e1', 'e2']);
  });

  test('mergeEventPayloads 无 payload 时保持空 items', () => {
    const pending: ExternalEventEnvelope = {
      source: 'artifact:annotation', type: 'a', target: { sessionKey: 's' },
    };
    const merged = mergeEventPayloads(pending, { ...pending });
    assert.deepStrictEqual(merged.payload, { items: [] });
  });

  test('defaultExternalEventPrompt 渲染来源/类型与负载', () => {
    const text = defaultExternalEventPrompt({
      source: 'artifact:a2ui', type: 'a2ui.action',
      target: { sessionKey: 's' }, payload: { action: 'submit' },
    });
    assert.match(text, /artifact:a2ui/);
    assert.match(text, /a2ui\.action/);
    assert.match(text, /submit/);
  });

  test('stats 与 reset 可用', async () => {
    const router = new ExternalEventRouter();
    router.bindArtifact('a', { sessionKey: 's' });
    router.emit(a2ui({ eventId: 'x' }));
    assert.strictEqual(router.stats.bindings, 1);
    router.reset();
    assert.strictEqual(router.stats.bindings, 0);
    assert.strictEqual(router.stats.pendingDebounced, 0);
  });
});
