import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsSendError } from '../src/catscompany/client';
import { MessageSender } from '../src/catscompany/message-sender';

describe('CatsCompany MessageSender retry behavior', () => {
  test('falls back to HTTP after retryable ack timeout with the same client_msg_id', async () => {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: any) => {
      requests.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({ seq_id: 123 }),
      } as any;
    }) as any;

    try {
      const sender = new MessageSender({
        sendStructuredMessage: async () => {
          throw new CatsSendError('timeout', 'ack timeout', undefined, {
            clientMsgID: 'catsco-test-1',
            retryableWithHttp: true,
          });
        },
      } as any, 'https://app.example.test', 'cc_test');

      await sender.sendText('p2p_1_2', 'hello');

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0].client_msg_id, 'catsco-test-1');
      assert.strictEqual(requests[0].metadata.client_msg_id, 'catsco-test-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not HTTP retry ack timeout without server dedupe support', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('should not fetch');
    }) as any;

    try {
      const sender = new MessageSender({
        sendStructuredMessage: async () => {
          throw new CatsSendError('timeout', 'ack timeout');
        },
      } as any, 'https://app.example.test', 'cc_test');

      await assert.rejects(() => sender.sendText('p2p_1_2', 'hello'), /ack timeout/);
      assert.strictEqual(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('still HTTP retries transport errors before a WebSocket write', async () => {
    const requests: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: any) => {
      requests.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({ seq_id: 456 }),
      } as any;
    }) as any;

    try {
      const sender = new MessageSender({
        sendStructuredMessage: async () => {
          throw new CatsSendError('transport', 'socket not open');
        },
      } as any, 'https://app.example.test', 'cc_test');

      await sender.sendText('p2p_1_2', 'hello');

      assert.strictEqual(requests.length, 1);
      assert.match(requests[0].client_msg_id, /^catsco-/);
      assert.strictEqual(requests[0].metadata.client_msg_id, requests[0].client_msg_id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('CatsCompany MessageSender reply segmentation', () => {
  test('splits long structured replies into multiple readable text messages', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');

    const text = [
      '创建内容：E:\\work\\xiaoba\\XiaoBa-CLI\\.dev-user-data\\tmp\\agent-code-sandbox\\run-20260624-092054 下三个文件：analyzeReply.js、test.analyzeReply.js、README.md。这里故意补一段较长说明，用来模拟模型完成任务后把文件、路径、测试数量、修复轨迹都挤进同一条聊天消息里的情况。',
      '测试结果：passed: 30 / failed: 0，退出码 0。修复轨迹：首轮 7 失败，原因是中文 repeat 字符数估错，加上期望按错的算法逻辑写；之后逐轮修改测试与文案，最终全绿。这里继续补充一些自然语言，保证段落足够长，触发按段落拆分，而不是仅靠 4000 字硬切。',
      '发现的一个 prompt 风格问题：算法把 260 字单段视作未 huge 但已开始扣分，会出现 260 字以下不用扣分、261 到 300 字反而被双重扣的尴尬断点。这个段落也故意写长一点，模拟真实回复里问题解释太长、用户看起来很累的情况。',
      '下一步建议：把 huge 阈值和 charCount 分档合并为一条曲线，避免双重扣分；给 analyzeReply 加 token 估算；把报告腔短语暴露成参数，方便不同聊天通道按需开关。',
    ].join('\n\n');

    await sender.reply('p2p_1_2', text);

    assert.ok(sent.length >= 2, `expected multiple messages, got ${sent.length}`);
    assert.ok(sent.every(item => item.type === 'text'));
    assert.ok(sent.every(item => String(item.content).length <= 1200));
    assert.match(String(sent[0].content), /创建内容/);
    assert.match(String(sent[sent.length - 1].content), /下一步建议/);
    assert.equal(sent.map(item => String(item.content)).join('\n\n'), text);
  });
});
