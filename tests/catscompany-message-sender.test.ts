import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
    sender.onDurableMessageSent = (topic, seqs) => recorded.push({ topic, seqs });

    const first = 'a'.repeat(3900);
    const second = 'b'.repeat(300);
    await sender.reply('grp_42', `${first}\n${second}`);

    // 每段各自发送、各自记账；调用方拿到的是逐条 seq。
    assert.deepEqual(recorded, [
      { topic: 'grp_42', seqs: [700] },
      { topic: 'grp_42', seqs: [701] },
    ]);
  });

  test('reports the segments that did go out when a later one fails', async () => {
    // 已经发出去的分段同样会被回填重复插入。记账挂在 send() 成功处，所以第 1 段
    // 的 seq 在异常穿透前就已经记下了。
    const recorded: Array<{ topic: string; seqs: number[] }> = [];
    let calls = 0;
    const sender = new MessageSender({
      sendStructuredMessage: async () => {
        calls++;
        if (calls === 2) throw new Error('send failed');
        return 900;
      },
    } as any, 'https://app.example.test', 'cc_test');
    sender.onDurableMessageSent = (topic, seqs) => recorded.push({ topic, seqs });

    const first = 'a'.repeat(3900);
    const second = 'b'.repeat(300);
    await assert.rejects(() => sender.reply('grp_42', `${first}\n${second}`));

    assert.deepEqual(recorded, [{ topic: 'grp_42', seqs: [900] }]);
  });

  test('reports an attachment send, which does not go through reply()', async () => {
    // 附件走 sendFile，不经过 reply。服务端把 image/file 列为持久类型，它们同样
    // 会进回填；只挂 reply 会漏掉这一整条路径。
    const recorded: Array<{ topic: string; seqs: number[] }> = [];
    const sender = new MessageSender({
      uploadFile: async () => ({ url: '/uploads/files/a.txt', name: 'a.txt', size: 3 }),
      sendStructuredMessage: async () => 1234,
    } as any, 'https://app.example.test', 'cc_test');
    sender.onDurableMessageSent = (topic, seqs) => recorded.push({ topic, seqs });

    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cats-sender-')), 'a.txt');
    fs.writeFileSync(filePath, 'abc');
    await sender.sendFile('grp_42', filePath, 'a.txt');

    assert.deepEqual(recorded, [{ topic: 'grp_42', seqs: [1234] }]);
  });

  test('附件也要带 reply_to，否则平台当成过程记录丢掉', async () => {
    // 实测的故障形态：正文带着回合标记先到，平台据此认为「这单已经有明确归属的
    // 答案了」；紧接着到达的 file/image 不带任何归属标记，于是被判成过程记录跳过。
    // bot 明明发了文件，调用方什么都收不到，而且两边都看不出发生过什么。
    const sent: any[] = [];
    const sender = new MessageSender({
      uploadFile: async () => ({ url: '/uploads/images/a.png', name: 'a.png', size: 3 }),
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return 1;
      },
    } as any, 'https://app.example.test', 'cc_test');

    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cats-sender-')), 'a.png');
    fs.writeFileSync(filePath, 'abc');
    await sender.sendFile('p2p_38_982', filePath, 'a.png', { replyTo: 4321 });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'image');
    assert.equal(sent[0].reply_to, 4321);
  });

  test('不带 replyTo 时不出现 reply_to（真人聊天里发文件不该变成引用回复）', async () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      uploadFile: async () => ({ url: '/uploads/files/a.txt', name: 'a.txt', size: 3 }),
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return 1;
      },
    } as any, 'https://app.example.test', 'cc_test');

    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cats-sender-')), 'a.txt');
    fs.writeFileSync(filePath, 'abc');
    await sender.sendFile('grp_42', filePath, 'a.txt');

    assert.equal('reply_to' in sent[0], false);
  });

  test('does not report transient kinds that never reach history', async () => {
    // thinking / tool_use / task_status 不在服务端的持久白名单里，不会进回填，
    // 记它们只会让运行态无谓增长。
    const recorded: number[][] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async () => 1,
    } as any, 'https://app.example.test', 'cc_test');
    sender.onDurableMessageSent = (_topic, seqs) => recorded.push(seqs);

    await sender.sendThinking('grp_42', '思考中');
    await sender.sendToolUse('grp_42', 'call_1', 'glob', { pattern: '*' });
    await sender.sendTaskStatus('grp_42', {
      run_id: 'run-1',
      state: 'running',
      summary: '处理中',
    });

    assert.deepEqual(recorded, []);
  });

  test('does not report when nothing was sent', async () => {
    const recorded: number[][] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async () => 1,
    } as any, 'https://app.example.test', 'cc_test');
    sender.onDurableMessageSent = (_topic, seqs) => recorded.push(seqs);

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
    sender.onDurableMessageSent = () => {
      throw new Error('bookkeeping blew up');
    };

    const seqs = await sender.reply('grp_42', 'hello');

    assert.deepEqual(seqs, [5]);
    assert.equal(sent.length, 1, '消息本身仍然发出去了');
  });
});

// 生产事故（2026-10-26 查实）：工具桥为了让模型续聊，会在工具结果里塞
// `[续聊凭据 session_id=...]`，并叮嘱「不要在回复中提及本行」。模型经常不听，
// 有 388 条这样的标注被原样发到了用户/群里。出口必须兜底。
describe('CatsCompany MessageSender strips internal annotations', () => {
  const makeSender = () => {
    const sent: any[] = [];
    const sender = new MessageSender({
      sendStructuredMessage: async (payload: any) => {
        sent.push(payload);
        return sent.length;
      },
    } as any, 'https://app.example.test', 'cc_test');
    return { sender, sent };
  };

  test('把续聊凭据从句尾剥掉', async () => {
    const { sender, sent } = makeSender();
    await sender.reply(
      'grp_42',
      '这台电脑现在是 16:18。\n\n[续聊凭据 session_id=sess_abc — 同一任务的后续追问请携带此 id 再次调用「catsco_x」；新任务请勿携带；不要在回复中提及本行]',
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, '这台电脑现在是 16:18。');
    assert.ok(!String(sent[0].content).includes('续聊凭据'));
  });

  test('标注在中间也剥掉，其余内容一字不动', async () => {
    const { stripInternalAnnotations } = await import('../src/catscompany/message-sender');
    const input = '第一段\n[续聊凭据 session_id=s1 — 提示]\n第二段';
    // 连带前导换行一起吃掉，避免留下一个空行。
    assert.equal(stripInternalAnnotations(input), '第一段\n第二段');
  });

  test('不误伤用户自己写的方括号内容', async () => {
    const { stripInternalAnnotations } = await import('../src/catscompany/message-sender');
    const input = '按 [2026] 号文件执行，参考 [附录 A] 。';
    assert.equal(stripInternalAnnotations(input), input);
  });

  test('只有标注时整条不发（避免发出空气泡）', async () => {
    const { sender, sent } = makeSender();
    const seqs = await sender.reply(
      'grp_42',
      '[续聊凭据 session_id=sess_abc — 同一任务的后续追问请携带此 id 再次调用「catsco_x」；新任务请勿携带；不要在回复中提及本行]',
    );
    assert.deepEqual(seqs, []);
    assert.equal(sent.length, 0);
  });
});
