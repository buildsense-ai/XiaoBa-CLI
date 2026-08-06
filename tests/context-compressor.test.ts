import { describe, test, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { ContextCompressor, contentToString, messagesToConversationText, parseCompactSummary, buildCompactSystemPrompt, truncateForSummary } from '../src/core/context-compressor';
import { estimateTokens } from '../src/core/token-estimator';
import type { Message } from '../src/types';
import type { AIService } from '../src/utils/ai-service';

// ─── 测试辅助 ─────────────────────────────────────────────

function user(content: string): Message {
  return { role: 'user', content };
}

function assistant(content: string, toolCalls?: Message['tool_calls']): Message {
  return { role: 'assistant', content, tool_calls: toolCalls };
}

function tool(name: string, content: string, toolCallId: string): Message {
  return { role: 'tool', name, content, tool_call_id: toolCallId };
}

function system(content: string): Message {
  return { role: 'system', content };
}

function mockAIService(summaryText: string): AIService {
  return {
    chat: async () => ({
      content: `<summary>\n${summaryText}\n</summary>`,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    }),
    chatStream: async (_messages: Message[], _tools?: any, callbacks?: any) => {
      const content = `<summary>\n${summaryText}\n</summary>`;
      callbacks?.onText?.(content);
      return {
        content,
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    },
  } as unknown as AIService;
}

function mockAIServiceWithCapture(summaryText: string): { service: AIService; requests: Message[][] } {
  const requests: Message[][] = [];
  const service = {
    chat: async () => ({
      content: `<summary>\n${summaryText}\n</summary>`,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    }),
    chatStream: async (_messages: Message[], _tools?: any, callbacks?: any) => {
      requests.push(_messages.map(message => ({ ...message })));
      const content = `<summary>\n${summaryText}\n</summary>`;
      callbacks?.onText?.(content);
      return {
        content,
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    },
  } as unknown as AIService;
  return { service, requests };
}

// ─── contentToString ─────────────────────────────────────

describe('contentToString', () => {
  test('string content', () => {
    const result = contentToString('hello');
    assert.equal(result, 'hello');
  });

  test('null returns empty string', () => {
    const result = contentToString(null);
    assert.equal(result, '');
  });

  test('ContentBlock[] with text', () => {
    const result = contentToString([{ type: 'text', text: 'hi' }]);
    assert.equal(result, 'hi');
  });

  test('ContentBlock[] with image returns [图片]', () => {
    const result = contentToString([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } } as any]);
    assert.equal(result, '[图片]');
  });

  test('ContentBlock[] mixed', () => {
    const result = contentToString([{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } } as any]);
    assert.equal(result, 'hello[图片]');
  });
});

// ─── messagesToConversationText ───────────────────────────

describe('messagesToConversationText', () => {
  test('单条 user 消息', () => {
    const msgs = [user('你好')];
    const result = messagesToConversationText(msgs);
    assert.equal(result, '[用户] 你好');
  });

  test('单条 assistant 消息', () => {
    const msgs = [assistant('今天天气不错')];
    const result = messagesToConversationText(msgs);
    assert.equal(result, '[AI] 今天天气不错');
  });

  test('工具调用链格式化正确', () => {
    const msgs = [
      user('帮我读这个文件'),
      assistant('好的', [
        { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"a.txt"}' } },
      ]),
      tool('read_file', '文件内容是 hello world', 'tc1'),
      assistant('文件内容是 hello world'),
    ];
    const result = messagesToConversationText(msgs);
    assert.ok(result.includes('[用户]'), '应包含用户消息');
    assert.ok(result.includes('[AI]'), '应包含AI消息');
    assert.ok(result.includes('[工具 read_file]'), '应包含工具消息');
  });

  test('摘要输入中过长的工具输出被截断', () => {
    const longContent = '中'.repeat(1000);
    const msgs = [tool('bash', longContent, 'tc1')];
    const result = truncateForSummary(msgs);
    assert.ok(result.includes('...[共 1000 字符]'), '应包含截断标记');
    assert.ok(!result.includes('中'.repeat(900)), '截断后不应包含900个字符');
  });

  test('摘要输入中单条超大消息按 token 预算截断', () => {
    const result = truncateForSummary([user('中'.repeat(1000))], 20);

    assert.ok(estimateTokens(result) <= 20, `summary should fit budget, got ${estimateTokens(result)}`);
    assert.ok(!result.includes('中'.repeat(100)), '不应保留固定 500 字符的大段内容');
  });
});

// ─── parseCompactSummary ─────────────────────────────────

describe('parseCompactSummary', () => {
  test('正常提取 summary 内容', () => {
    const raw = '<analysis>分析</analysis>\n\n<summary>\n这是摘要\n</summary>';
    const result = parseCompactSummary(raw);
    assert.equal(result, '这是摘要');
  });

  test('没有 analysis 标签', () => {
    const raw = '<summary>\n纯摘要\n</summary>';
    const result = parseCompactSummary(raw);
    assert.equal(result, '纯摘要');
  });

  test('没有标签时返回原文', () => {
    const raw = '没有标签';
    const result = parseCompactSummary(raw);
    assert.equal(result, '没有标签');
  });

  test('多行摘要', () => {
    const raw = '<summary>\n第一行\n第二行\n</summary>';
    const result = parseCompactSummary(raw);
    assert.equal(result, '第一行\n第二行');
  });
});

// ─── buildCompactSystemPrompt ─────────────────────────────

describe('buildCompactSystemPrompt', () => {
  test('生成包含禁止工具调用的说明', () => {
    const prompt = buildCompactSystemPrompt();
    assert.ok(prompt.includes('不要调用任何工具'), '应包含禁止工具调用');
  });

  test('生成包含摘要范围要求', () => {
    const prompt = buildCompactSystemPrompt();
    assert.ok(prompt.includes('摘要必须覆盖'), '应包含摘要范围标题');
    assert.ok(prompt.includes('用户明确提出的请求'), '应包含用户意图要求');
    assert.ok(prompt.includes('尚未完成的待办'), '应包含待办要求');
  });

  test('customInstructions 追加到 prompt', () => {
    const prompt = buildCompactSystemPrompt('聚焦代码变更');
    assert.ok(prompt.includes('补充要求'), '应包含追加标记');
    assert.ok(prompt.includes('聚焦代码变更'), '应包含自定义指令');
  });

  test('空白 customInstructions 不追加', () => {
    const prompt = buildCompactSystemPrompt('   ');
    assert.ok(!prompt.includes('补充要求'));
  });
});

// ─── ContextCompressor.compact ───────────────────────────

describe('ContextCompressor.compact', () => {
  let aiService: AIService;

  beforeEach(() => {
    aiService = mockAIService('1. 用户要求读文件\n2. 已完成');
  });

  test('全量压缩：session 被摘要，system 保留', async () => {
    const compressor = new ContextCompressor(aiService, { preserveRecentEpisodes: 0 });
    const messages: Message[] = [
      system('你是小八'),
      system('[session_context] adapter context'),
      user('你好'),
      assistant('hi'),
      user('帮我读 a.txt'),
      assistant('ok', [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{}' } }]),
      tool('read_file', 'hello', 'tc1'),
      assistant('文件内容是 hello'),
    ];

    const result = await compressor.compact(messages);

    // system 消息：base + session context + boundary = 3
    const systemMsgs = result.filter(m => m.role === 'system');
    assert.equal(systemMsgs.length, 3);

    // boundary 是 system 消息
    const boundaryMsg = result.find(m => m.role === 'system' && (m.content as string).includes('[compact_boundary]'));
    assert.ok(boundaryMsg !== undefined, '应有 boundary 消息');

    // session 被替换为一条摘要 user 消息
    const userMsgs = result.filter(m => m.role === 'user');
    assert.equal(userMsgs.length, 1, '应有 1 条 user 消息（summary）');
    assert.ok((userMsgs[0].content as string).includes('AI 摘要'), '摘要内容应包含标记');

    // 原来的 session 消息（assistant/tool）不应存在于结果中
    const roles = result.map(m => m.role);
    assert.ok(!roles.includes('assistant'), 'assistant 不应在结果中');
    assert.ok(!roles.includes('tool'), 'tool 不应在结果中');
  });

  test('全量压缩：结果中无任何 tool_call_id 引用', async () => {
    const compressor = new ContextCompressor(aiService, { preserveRecentEpisodes: 0 });
    const messages: Message[] = [
      user('读文件'),
      assistant('ok', [{ id: 'tc1', type: 'function', function: { name: 'read', arguments: '{}' } }]),
      tool('read', 'file content', 'tc1'),
    ];

    const result = await compressor.compact(messages);

    for (const msg of result) {
      assert.equal(msg.tool_call_id, undefined, `消息不应有 tool_call_id`);
    }
    for (const msg of result) {
      if (msg.role === 'assistant') {
        assert.equal((msg as any).tool_calls, undefined, 'assistant 不应有 tool_calls');
      }
    }
  });

  test('空 session 时返回原消息', async () => {
    const compressor = new ContextCompressor(aiService, { preserveRecentEpisodes: 0 });
    const messages: Message[] = [system('base')];
    const result = await compressor.compact(messages);
    assert.deepEqual(result, messages);
  });

  test('AI 摘要失败时抛出异常', async () => {
    const failingService = {
      chatStream: async () => { throw new Error('API error'); },
    } as unknown as AIService;
    const compressor = new ContextCompressor(failingService);
    const messages: Message[] = [system('base'), user('hello'), assistant('hi')];

    await assert.rejects(
      async () => compressor.compact(messages),
      /API error/
    );
  });

  test('压缩结果：system + boundary + summary', async () => {
    const compressor = new ContextCompressor(aiService, { preserveRecentEpisodes: 0 });
    const messages: Message[] = [system('你是小八'), user('hello'), assistant('hi')];
    const result = await compressor.compact(messages);

    const roles = result.map(m => m.role);
    const systemCount = roles.filter(r => r === 'system').length;
    const userCount = roles.filter(r => r === 'user').length;
    const assistantCount = roles.filter(r => r === 'assistant').length;
    const toolCount = roles.filter(r => r === 'tool').length;

    assert.equal(systemCount, 2, '应有 2 条 system (base + boundary)');
    assert.equal(userCount, 1, '应有 1 条 user (summary)');
    assert.equal(assistantCount, 0, '应无 assistant');
    assert.equal(toolCount, 0, '应无 tool');
  });

  test('boundary 记录原始消息数和 token', async () => {
    const compressor = new ContextCompressor(aiService, { preserveRecentEpisodes: 0 });
    const messages: Message[] = [
      system('base'),
      user('msg1'),
      assistant('ai1'),
      user('msg2'),
      assistant('ai2', [{ id: 'tc1', type: 'function', function: { name: 'x', arguments: '{}' } }]),
      tool('x', 'r1', 'tc1'),
    ];

    const result = await compressor.compact(messages);
    const boundary = result.find(m => m.role === 'system' && (m.content as string).includes('[compact_boundary]'));
    assert.ok(boundary !== undefined);
    assert.ok((boundary!.content as string).includes('messages summarized'));
    assert.ok((boundary!.content as string).includes('Pre-compact tokens:'));
  });

  test('preserves a short marked recent episode verbatim and excludes it from summary input', async () => {
    const capture = mockAIServiceWithCapture('summary-body');
    const compressor = new ContextCompressor(capture.service, { preserveRecentEpisodes: 1 });
    const messages: Message[] = [
      system('base'),
      user('old request'),
      assistant('old answer'),
      { role: 'user', content: 'recent root', __episodeId: 'episode:recent', __episodeInputKind: 'root' },
      {
        role: 'assistant',
        content: 'calling tool',
        tool_calls: [{
          id: 'call_recent',
          type: 'function',
          function: { name: 'read_notes', arguments: '{"path":"notes.md"}' },
        }],
        __episodeId: 'episode:recent',
      },
      { role: 'tool', name: 'read_notes', tool_call_id: 'call_recent', content: 'tool full result', __episodeId: 'episode:recent' },
      { role: 'assistant', content: 'recent final', __episodeId: 'episode:recent' },
    ];

    const result = await compressor.compact(messages);
    const summaryRequestText = String(capture.requests[0][1].content);

    assert.match(summaryRequestText, /old request/);
    assert.doesNotMatch(summaryRequestText, /recent root/);
    assert.doesNotMatch(summaryRequestText, /tool full result/);
    assert.doesNotMatch(summaryRequestText, /recent final/);

    const preserved = result.filter(message => message.__episodeId === 'episode:recent');
    assert.equal(preserved.length, 4);
    assert.deepEqual(preserved.map(message => message.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(preserved[0].content, 'recent root');
    assert.equal(preserved[0].__episodeInputKind, 'root');
    assert.equal(preserved[1].tool_calls?.[0].function.name, 'read_notes');
    assert.equal(preserved[2].content, 'tool full result');
    assert.equal(preserved[3].content, 'recent final');
  });

  test('preserves the two latest short marked episodes when both fit the budget', async () => {
    const capture = mockAIServiceWithCapture('summary-body');
    const compressor = new ContextCompressor(capture.service, { preserveRecentEpisodes: 2 });
    const messages: Message[] = [
      system('base'),
      user('old request'),
      assistant('old answer'),
      { role: 'user', content: 'episode one root', __episodeId: 'episode:one', __episodeInputKind: 'root' },
      { role: 'assistant', content: 'episode one final', __episodeId: 'episode:one' },
      { role: 'user', content: 'episode two root', __episodeId: 'episode:two', __episodeInputKind: 'root' },
      { role: 'assistant', content: 'episode two final', __episodeId: 'episode:two' },
    ];

    const result = await compressor.compact(messages);
    const preservedOne = result.filter(message => message.__episodeId === 'episode:one');
    const preservedTwo = result.filter(message => message.__episodeId === 'episode:two');

    assert.equal(preservedOne.length, 2);
    assert.equal(preservedTwo.length, 2);
    assert.deepEqual(preservedOne.map(message => message.content), ['episode one root', 'episode one final']);
    assert.deepEqual(preservedTwo.map(message => message.content), ['episode two root', 'episode two final']);
    assert.doesNotMatch(String(capture.requests[0][1].content), /episode one root|episode two root/);
  });

  test('turns an oversized marked episode into a text capsule instead of partial tool messages', async () => {
    const capture = mockAIServiceWithCapture('summary-body');
    const compressor = new ContextCompressor(capture.service, {
      maxContextTokens: 1000,
      preserveRecentEpisodes: 1,
      preserveRecentEpisodeTokenBudget: 50,
      recentEpisodeCapsuleMaxChars: 3000,
    });
    const longRoot = `root request ${'x'.repeat(4000)}`;
    const messages: Message[] = [
      system('base'),
      user('old request'),
      assistant('old answer'),
      { role: 'user', content: longRoot, __episodeId: 'episode:big', __episodeInputKind: 'root' },
      {
        role: 'assistant',
        content: 'calling search',
        tool_calls: [{
          id: 'call_big',
          type: 'function',
          function: { name: 'search_notes', arguments: '{"query":"birthday dinner"}' },
        }],
        __episodeId: 'episode:big',
      },
      { role: 'tool', name: 'search_notes', tool_call_id: 'call_big', content: `search result ${'y'.repeat(2000)}`, __episodeId: 'episode:big' },
      { role: 'user', content: 'pending correction', __episodeId: 'episode:big', __episodeInputKind: 'pending' },
      { role: 'assistant', content: 'final answer with constraints', __episodeId: 'episode:big' },
    ];

    const result = await compressor.compact(messages);
    const capsule = result.find(message =>
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.startsWith('[recent_episode_context]')
    );

    assert.ok(capsule, 'capsule should be present');
    const capsuleText = String(capsule!.content);
    assert.match(capsuleText, /USER_ROOT/);
    assert.match(capsuleText, /USER_PENDING/);
    assert.match(capsuleText, /ASSISTANT_FINAL/);
    assert.match(capsuleText, /TOOLS/);
    assert.match(capsuleText, /search_notes/);
    assert.match(capsuleText, /birthday dinner/);
    assert.match(capsuleText, /final answer with constraints/);
    assert.equal(result.some(message => message.role === 'tool'), false);
    assert.equal(result.some(message => message.role === 'assistant'), false);
    assert.match(String(capture.requests[0][1].content), /\[recent_episode_context\]/);
  });

  test('needsCompaction 正确判断', async () => {
    const compressor = new ContextCompressor(aiService, { maxContextTokens: 1000, compactionThreshold: 0.7 });
    const light: Message[] = [system('a'), user('b')];
    // 中文按 1.5 chars/token，1500字 ≈ 1000 tokens，确保超过 700 阈值
    const heavy: Message[] = [system('a'), user('中'.repeat(1500))];

    const lightResult = compressor.needsCompaction(light);
    const heavyResult = compressor.needsCompaction(heavy);
    assert.equal(lightResult, false);
    assert.equal(heavyResult, true);
  });

  test('needsCompaction 在历史工具结果数量过多时触发', async () => {
    const compressor = new ContextCompressor(aiService, {
      maxContextTokens: 1_000_000,
      compactionThreshold: 0.7,
      toolResultCompactionCountThreshold: 3,
      toolResultCompactionTokenThreshold: 1_000_000,
    });
    const messages: Message[] = [
      system('base'),
      user('之前的任务'),
      tool('execute_shell', 'ok', 'tc1'),
      tool('read_file', 'ok', 'tc2'),
      tool('grep', 'ok', 'tc3'),
    ];

    assert.equal(compressor.needsCompaction(messages), true);
  });

  test('needsCompaction 在历史工具结果体积过大时触发', async () => {
    const compressor = new ContextCompressor(aiService, {
      maxContextTokens: 1_000_000,
      compactionThreshold: 0.7,
      toolResultCompactionCountThreshold: 1000,
      toolResultCompactionTokenThreshold: 100,
    });
    const messages: Message[] = [
      system('base'),
      user('之前的任务'),
      tool('read_file', '中'.repeat(300), 'tc1'),
    ];

    const usage = compressor.getUsageInfo(messages);
    assert.equal(compressor.needsCompaction(messages), true);
    assert.equal(usage.toolResultCount, 1);
    assert.ok(usage.toolResultTokens >= 100);
  });

  test('getUsageInfo 返回正确结构', async () => {
    const compressor = new ContextCompressor(aiService, { maxContextTokens: 1000 });
    const info = compressor.getUsageInfo([system('a'), user('b')]);
    assert.equal(info.maxTokens, 1000);
    assert.equal(typeof info.usedTokens, 'number');
    assert.equal(typeof info.usagePercent, 'number');
    assert.equal(typeof info.toolResultCount, 'number');
    assert.equal(typeof info.toolResultTokens, 'number');
    assert.equal(typeof info.toolResultChars, 'number');
  });
});

// ─── 全流程 ─────────────────────────────────────────────

describe('全流程：压缩 → push current_input → 推理', () => {
  test('模拟 handleMessage：压缩后追加当前输入，结构正确', async () => {
    const historyMessages: Message[] = [
      system('你是小八'),
      user('第一个问题'),
      assistant('回答一'),
      user('第二个问题'),
      assistant('回答二'),
      user('第三个问题'),
      assistant('回答三'),
    ];

    const aiService = mockAIService('用户问了三个问题，已全部回答。第三个问题是关于XXX。');
    const compressor = new ContextCompressor(aiService, { preserveRecentEpisodes: 0 });

    // Step 1: 压缩
    const afterCompact = await compressor.compact(historyMessages);

    // Step 2: push 当前输入
    afterCompact.push(user('请继续回答第四个问题'));

    // 验证结构
    const roles = afterCompact.map(m => m.role);
    assert.equal(roles.filter(r => r === 'system').length, 2, '2 条 system');
    assert.equal(roles.filter(r => r === 'user').length, 2, '2 条 user (summary + current)');
    assert.equal(roles.filter(r => r === 'assistant').length, 0, '无 assistant');
    assert.equal(roles.filter(r => r === 'tool').length, 0, '无 tool');

    // 最后一条是 current_input
    const lastMsg = afterCompact[afterCompact.length - 1];
    assert.ok((lastMsg.content as string).includes('第四个问题'));

    // 无任何 tool_call_id 或 tool_calls 残留
    for (const msg of afterCompact) {
      assert.equal(msg.tool_call_id, undefined);
      if (msg.role === 'assistant') {
        assert.equal((msg as any).tool_calls, undefined);
      }
    }
  });
});
