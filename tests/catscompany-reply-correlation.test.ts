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
});
