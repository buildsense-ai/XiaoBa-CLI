import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { MessageSender } from '../src/catscompany/message-sender';

/**
 * 平台派活时的回复归属。
 *
 * 平台的 topic 是固定的 `p2p_调用方_bot`，同一账号并发调同一个 bot 时所有 run
 * 共用一条消息流。平台按 `reply_to == 那条 prompt 的 id` 认领结果，所以每一段
 * 回复（长回复会被切段）都要指回它。
 *
 * 没有它，平台只能按「水位线之后 bot 说的都算」认领 —— 两个并发的 run 会各自
 * 拿到两份结果拼起来的东西。
 */
describe('CatsCompany MessageSender reply correlation', () => {
  function makeSender(sent: any[]) {
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');
    return sender;
  }

  test('reply 把 reply_to 带上（平台据此认领结果）', async () => {
    const sent: any[] = [];
    await makeSender(sent).reply('p2p_38_982', '查好了', { replyTo: 12345 });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].reply_to, 12345);
  });

  test('长回复切段后每段都带同一个 reply_to', async () => {
    const sent: any[] = [];
    await makeSender(sent).reply('p2p_38_982', 'x'.repeat(9000), { replyTo: 777 });

    assert.ok(sent.length > 1, '应该被切成多段');
    for (const payload of sent) {
      assert.equal(payload.reply_to, 777);
    }
  });

  test('不带 replyTo 时不出现这个字段（真人聊天不该变成引用回复）', async () => {
    const sent: any[] = [];
    await makeSender(sent).reply('p2p_38_982', '在的');

    assert.equal(sent.length, 1);
    assert.equal('reply_to' in sent[0], false);
  });

  test('非法 replyTo 一律不发', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const sent: any[] = [];
      await makeSender(sent).reply('p2p_38_982', '在的', { replyTo: bad as number });
      assert.equal('reply_to' in sent[0], false, `replyTo=${bad} 不该被发出去`);
    }
  });

  /**
   * 「回合结束」标记。
   *
   * 平台拿它判断这一轮真的说完了，不再靠「静默多久算说完」去猜 —— bot 干活是
   * 「先说要做啥 → 真去做 → 再报结果」，中间那步实测能超过 14 秒。靠静默窗口猜
   * 就会把「收到，我先让工具出方案…」这种前言当成最终答案交出去，而调用方从
   * 结果上看不出被截断。
   */
  test('turnDone 只挂在最后一段（中间段挂上等于提前宣布结束）', async () => {
    const sent: any[] = [];
    await makeSender(sent).reply('p2p_38_982', 'x'.repeat(9000), {
      replyTo: 777,
      turnDone: 'sess_abc',
    });

    assert.ok(sent.length > 1, '应该被切成多段');
    for (const [index, payload] of sent.entries()) {
      const isLast = index === sent.length - 1;
      if (isLast) {
        assert.equal(payload.metadata?.catsco_turn_done, 'sess_abc', '最后一段必须带标记');
      } else {
        assert.equal(
          payload.metadata?.catsco_turn_done,
          undefined,
          `第 ${index + 1} 段不该带标记`
        );
      }
      // 标记不能顶掉 reply_to：平台两条信息都要用。
      assert.equal(payload.reply_to, 777);
    }
  });

  test('单段回复时标记就在这一段上', async () => {
    const sent: any[] = [];
    await makeSender(sent).reply('p2p_38_982', '查好了', { replyTo: 12345, turnDone: 'sess_x' });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].metadata?.catsco_turn_done, 'sess_x');
  });

  test('不带 turnDone 时不出现标记（真人聊天无需平台收尾）', async () => {
    const sent: any[] = [];
    await makeSender(sent).reply('p2p_38_982', '在的', { replyTo: 12345 });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].metadata?.catsco_turn_done, undefined);
  });

  test('空白 turnDone 不产生标记', async () => {
    for (const blank of ['', '   ']) {
      const sent: any[] = [];
      await makeSender(sent).reply('p2p_38_982', '在的', { replyTo: 1, turnDone: blank });
      assert.equal(sent[0].metadata?.catsco_turn_done, undefined, `turnDone="${blank}" 不该发`);
    }
  });
});
