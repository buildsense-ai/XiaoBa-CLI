import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsSendError } from '../src/catscompany/client';
import { MessageSender } from '../src/catscompany/message-sender';

describe('CatsCompany MessageSender retry behavior', () => {
  test('sends task status as a dedicated transient protocol message', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return 0;
      },
    } as any, 'https://app.example.test', 'cc_test');

    await sender.sendTaskStatus('p2p_1_2', {
      run_id: 'run-1',
      artifact_task_ref: `atr_${'a'.repeat(43)}`,
      state: 'running',
      summary: '正在处理请求',
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'task_status');
    assert.deepEqual(sent[0].content, {
      run_id: 'run-1',
      artifact_task_ref: `atr_${'a'.repeat(43)}`,
      state: 'running',
      summary: '正在处理请求',
    });
  });

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

  test('uses the client HTTP base (domain failover aware) when no explicit base URL is given', async () => {
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      requests.push(String(url));
      return {
        ok: true,
        json: async () => ({ seq_id: 789 }),
      } as any;
    }) as any;

    try {
      const sender = new MessageSender({
        sendStructuredMessage: async () => {
          throw new CatsSendError('transport', 'socket not open');
        },
        getHttpBaseUrl: () => 'https://app.catsco.cn',
      } as any, undefined, 'cc_test');

      await sender.sendText('p2p_1_2', 'hello');

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0], 'https://app.catsco.cn/api/messages/send');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('CatsCompany MessageSender reply length handling', () => {
  test('keeps formatted replies in one message below the platform limit', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');

    const text = [
      '结论：保留模型原始的段落和列表格式。',
      '- 第一项：不要拆成单独消息。\n- 第二项：不要额外添加段首缩进。',
      '```js\nconsole.log("keep formatting");\n```',
    ].join('\n\n');

    await sender.reply('p2p_1_2', text);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'text');
    assert.equal(sent[0].content, text);
  });

  test('splits only when a reply exceeds the platform message limit', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');

    const first = 'a'.repeat(3900);
    const second = 'b'.repeat(300);
    const text = `${first}\n${second}`;

    await sender.reply('p2p_1_2', text);

    assert.equal(sent.length, 2);
    assert.equal(sent[0].content, first);
    assert.equal(sent[1].content, second);
    assert.equal(sent.map(item => item.content).join('\n'), text);
  });

  test('does not send anything for empty or whitespace-only replies', async () => {
    for (const text of ['', '   ', '\n', '\t \n']) {
      const sent: any[] = [];
      const sender = new MessageSender({
        sendStructuredMessage: async (payload: any) => {
          sent.push(payload);
          return sent.length;
        },
      } as any, 'https://app.example.test', 'cc_test');

      await sender.reply('p2p_1_2', text);

      assert.equal(sent.length, 0, `expected no messages for input ${JSON.stringify(text)}`);
    }
  });
});

describe('CatsCompany MessageSender sent-seq bookkeeping', () => {
  test('reports every segment seq after a successful reply', async () => {
    const recorded: Array<{ topic: string; seqs: number[] }> = [];
    let next = 700;
    const sender = new MessageSender({
      sendStructuredMessage: async () => next++,
    } as any, 'https://app.example.test', 'cc_test');
    sender.onTextSent = (topic, seqs) => recorded.push({ topic, seqs });

    const first = 'a'.repeat(3900);
    const second = 'b'.repeat(300);
    await sender.reply('grp_42', `${first}\n${second}`);

    assert.deepEqual(recorded, [{ topic: 'grp_42', seqs: [700, 701] }]);
  });

  test('reports the segments that did go out when a later one fails', async () => {
    // 已经发出去的分段同样会被回填重复插入。异常穿透时若不交出它们的 seq，
    // 前面几段就永远认不回来——调用方的 catch 只看得到错误。
    const recorded: Array<{ topic: string; seqs: number[] }> = [];
    let calls = 0;
    const sender = new MessageSender({
      sendStructuredMessage: async () => {
        calls++;
        if (calls === 2) throw new Error('send failed');
        return 900;
      },
    } as any, 'https://app.example.test', 'cc_test');
    sender.onTextSent = (topic, seqs) => recorded.push({ topic, seqs });

    const first = 'a'.repeat(3900);
    const second = 'b'.repeat(300);
    await assert.rejects(() => sender.reply('grp_42', `${first}\n${second}`));

    assert.deepEqual(recorded, [{ topic: 'grp_42', seqs: [900] }]);
  });

  test('does not report when nothing was sent', async () => {
    const recorded: number[][] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async () => 1,
    } as any, 'https://app.example.test', 'cc_test');
    sender.onTextSent = (_topic, seqs) => recorded.push(seqs);

    await sender.reply('grp_42', '   ');

    assert.deepEqual(recorded, []);
  });

  test('a throwing bookkeeping callback does not break the send', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return 5;
      },
    } as any, 'https://app.example.test', 'cc_test');
    sender.onTextSent = () => {
      throw new Error('bookkeeping blew up');
    };

    const seqs = await sender.reply('grp_42', 'hello');

    assert.deepEqual(seqs, [5]);
    assert.equal(sent.length, 1, '消息本身仍然发出去了');
  });
});
