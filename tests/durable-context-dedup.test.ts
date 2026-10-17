/**
 * 回填去重：认出「远端这条就是我发的」。
 *
 * 主键是 `source:id`。本机发出的消息落盘时还没有 id（saveContext 在 reply 之前
 * 就执行完了），所以发送成功后把服务端返回的 seq 记进运行态，回填时按 id 认领。
 *
 * 这里刻意不做正文比对——正文在三种真实形态下都对不上：长回复按 4000 字拆段
 * 发送、发送前会剥掉 `[已发送信息]` 前缀、服务端还会在 agent 副本上改写
 * （`@usr<id>` 换名字、附件追加地址）。反过来，正文比对还会误伤：同一句短确认
 * 发两次时，后一条的远端副本会被前一条的本地文本挡掉。
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  collectSentRemoteIds,
  isDuplicateDurableContextEntry,
  type DurableContextDedupState,
} from '../src/core/durable-context-dedup';

const SOURCE = 'catscompany.agent_context';

function state(overrides: Partial<DurableContextDedupState> = {}): DurableContextDedupState {
  return {
    knownRemoteIds: new Set<string>(),
    watermarks: {},
    sentRemoteIds: new Set<string>(),
    ...overrides,
  };
}

describe('回填去重（按发出的 seq 认领）', () => {
  test('本机发出过的 seq 不再回填', () => {
    const dedup = state({
      sentRemoteIds: collectSentRemoteIds(SOURCE, [1444586]),
    });

    assert.equal(
      isDuplicateDurableContextEntry({ content: 'Hi Lin!', source: SOURCE, id: 1444586 }, dedup),
      true,
      '记过 seq 的远端副本应被跳过',
    );
  });

  test('没记过的 seq 照常回填', () => {
    // 本机没有这条——例如发出后进程就挂了。恢复语义不能变。
    const dedup = state();

    assert.equal(
      isDuplicateDurableContextEntry({ content: '上一轮的回复', source: SOURCE, id: 11 }, dedup),
      false,
    );
  });

  test('长回复拆段：每一段各自的 seq 都能被认领', () => {
    // reply 按 MAX_MSG_LENGTH=4000 拆段，每段一个 seq。本地存全文，
    // 回填回来的是单段——按内容比对必然失配，按 seq 则每段都对得上。
    const dedup = state({
      sentRemoteIds: collectSentRemoteIds(SOURCE, [900, 901, 902]),
    });

    for (const id of [900, 901, 902]) {
      assert.equal(
        isDuplicateDurableContextEntry({ content: '某一段', source: SOURCE, id }, dedup),
        true,
        `第 ${id} 段应被认领`,
      );
    }
  });

  test('前缀被剥离、正文被服务端改写都不影响认领', () => {
    // 本地存的是未剥前缀的文本，回填的是剥过的；服务端还会把 @usr<id>
    // 换成名字。正文怎么变都无所谓——认的是 id。
    const dedup = state({
      sentRemoteIds: collectSentRemoteIds(SOURCE, [700]),
    });

    assert.equal(
      isDuplicateDurableContextEntry(
        { content: '发给 Peer Agent 了（本地存的是 @usr43）', source: SOURCE, id: 700 },
        dedup,
      ),
      true,
    );
  });

  test('同一句短确认发两次，后一条不会被前一条挡掉', () => {
    // 内容比对会在这里误伤：本地有「收到」，就挡掉了 id=99 那条。
    // 按 seq 认领则只挡真正发过的那次。
    const dedup = state({
      sentRemoteIds: collectSentRemoteIds(SOURCE, [98]),
    });

    assert.equal(
      isDuplicateDurableContextEntry({ content: '收到', source: SOURCE, id: 99 }, dedup),
      false,
      '没记过 seq 的同文消息不该被误挡',
    );
  });

  test('已见过的远端 id 仍然按原规则去重', () => {
    const dedup = state({ knownRemoteIds: new Set([`${SOURCE}:100`]) });

    assert.equal(
      isDuplicateDurableContextEntry({ content: '之前的消息', source: SOURCE, id: 100 }, dedup),
      true,
    );
  });

  test('低于高水位的远端 id 仍然被挡住', () => {
    const dedup = state({ watermarks: { [SOURCE]: 500 } });

    assert.equal(
      isDuplicateDurableContextEntry({ content: '更早的消息', source: SOURCE, id: 400 }, dedup),
      true,
    );
    assert.equal(
      isDuplicateDurableContextEntry({ content: '更新的消息', source: SOURCE, id: 600 }, dedup),
      false,
    );
  });

  test('同一批里重复出现的条目只保留一条', () => {
    const dedup = state();
    const entry = { content: '同一条', source: SOURCE, id: 700 };

    assert.equal(isDuplicateDurableContextEntry(entry, dedup), false, '第一次保留');
    assert.equal(isDuplicateDurableContextEntry({ ...entry }, dedup), true, '第二次跳过');
  });

  test('没有 id 的纯文本条目照常放行', () => {
    const dedup = state();
    assert.equal(isDuplicateDurableContextEntry({ content: '一段上下文' }, dedup), false);
  });
});

describe('发出的 seq 收集', () => {
  test('按 source 组装成 source:id 键', () => {
    const keys = collectSentRemoteIds(SOURCE, [1, 2]);
    assert.deepEqual([...keys].sort(), [`${SOURCE}:1`, `${SOURCE}:2`]);
  });

  test('剔除非法值', () => {
    const keys = collectSentRemoteIds(SOURCE, [0, -1, Number.NaN, 5] as number[]);
    assert.deepEqual([...keys], [`${SOURCE}:5`]);
  });

  test('source 为空或没有记录时返回空集合', () => {
    assert.equal(collectSentRemoteIds('', [1]).size, 0);
    assert.equal(collectSentRemoteIds(SOURCE, undefined).size, 0);
    assert.equal(collectSentRemoteIds(SOURCE, []).size, 0);
  });
});
