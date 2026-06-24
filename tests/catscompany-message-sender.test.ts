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
  test('splits short enumerated replies into separate messages', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');

    await sender.reply('p2p_1_2', '1）测试 126/0 全绿。\n2）无产物溯源会让承诺看起来像已完成。');

    assert.equal(sent.length, 2);
    assert.equal(sent[0].content, '1）测试 126/0 全绿。');
    assert.equal(sent[1].content, '2）无产物溯源会让承诺看起来像已完成。');
  });

  test('splits inline ordered replies when the model keeps items on one line', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');

    await sender.reply('p2p_1_2', '第一，测试已经全绿。第二，后续风险是承诺没有产物溯源。');

    assert.equal(sent.length, 2);
    assert.equal(sent[0].content, '第一，测试已经全绿。');
    assert.equal(sent[1].content, '第二，后续风险是承诺没有产物溯源。');
  });

  test('splits long natural language paragraphs by sentence boundaries', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');

    const sentence = '这是一段没有空行的中文说明，用来模拟模型把背景、结论、风险和下一步全部挤在同一个自然段里。';
    await sender.reply('p2p_1_2', sentence.repeat(12));

    assert.ok(sent.length > 1);
    assert.ok(sent.every(item => String(item.content).startsWith('　　')));
    assert.ok(sent.every(item => String(item.content).length <= 560));
    assert.equal(
      sent.map(item => String(item.content).replace(/^　　/, '')).join(''),
      sentence.repeat(12),
    );
  });

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

    assert.equal(sent.length, 4);
    assert.ok(sent.every(item => item.type === 'text'));
    assert.ok(sent.every(item => String(item.content).length <= 1200));
    assert.match(String(sent[0].content), /^　　创建内容/);
    assert.match(String(sent[sent.length - 1].content), /^　　下一步建议/);
    assert.equal(
      sent.map(item => String(item.content).replace(/^　　/, '')).join('\n\n'),
      text,
    );
  });

  test('does not indent list or code-like reply blocks', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');

    const text = [
      '这是普通说明段落，长度故意写长一点，用来触发长回复分段。它应该被补上段首两个全角空格，避免网页里大段文字贴边显示。这里继续补充一些内容，模拟真实任务完成后解释背景、结果、限制和下一步，让总长度稳定超过自动分段阈值。',
      '- 第一项：列表不应该被补段首空格，否则 Markdown 列表会变形。\n- 第二项：继续保持列表结构。',
      '```js\nconsole.log("code block should stay as-is");\n```',
      '最后一个普通段落也应该补上段首缩进，确保自然段和特殊块的格式能区分开来。这里再补一段说明，确保测试不会因为样例太短而绕过长回复格式化路径。',
    ].join('\n\n');

    await sender.reply('p2p_1_2', text);

    assert.equal(sent.length, 4);
    assert.match(String(sent[0].content), /^　　这是普通说明段落/);
    assert.match(String(sent[1].content), /^- 第一项/);
    assert.match(String(sent[2].content), /^```js/);
    assert.match(String(sent[3].content), /^　　最后一个普通段落/);
  });

  test('preserves copyable JSON replies without natural-language indentation or splitting', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');

    const json = JSON.stringify({
      status: 'ok',
      items: Array.from({ length: 30 }, (_value, index) => ({
        id: index + 1,
        title: `测试项 ${index + 1}`,
        result: 'passed',
      })),
    }, null, 2);

    await sender.reply('p2p_1_2', json);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, json);
    assert.doesNotMatch(String(sent[0].content), /^　　/);
    assert.deepEqual(JSON.parse(sent[0].content), JSON.parse(json));
  });

  test('preserves SQL replies as copyable text', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');

    const sql = 'SELECT user_id, SUM(cost_cny) AS total_cost FROM relay_usage WHERE created_at >= CURRENT_DATE GROUP BY user_id ORDER BY total_cost DESC;';

    await sender.reply('p2p_1_2', sql);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, sql);
    assert.doesNotMatch(String(sent[0].content), /^　　/);
  });
});
