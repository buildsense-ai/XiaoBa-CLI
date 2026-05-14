import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('runtime characterization', () => {
  const originalEnv = { ...process.env };
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-characterization-'));
    process.chdir(testRoot);
    process.env.CURRENT_AGENT_DISPLAY_NAME = 'RuntimeTestAgent';
    process.env.CURRENT_PLATFORM = 'characterization';
    delete process.env.BOT_BRIDGE_NAME;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('PromptManager appends runtime identity and workspace defaults', async () => {
    delete require.cache[require.resolve('../src/utils/prompt-manager')];
    const { PromptManager } = require('../src/utils/prompt-manager');

    const prompt = await PromptManager.buildSystemPrompt();
    const today = new Date().toISOString().slice(0, 10);

    assert.match(prompt, /你是用户的私人助理，认真、可靠、能持续协作/);
    assert.match(prompt, /你在这个平台上的名字是：RuntimeTestAgent/);
    assert.doesNotMatch(prompt, /你是小八/);
    assert.match(prompt, /当前平台：characterization/);
    assert.match(prompt, new RegExp(`当前日期：${today}`));
    assert.match(prompt, /你的默认工作目录是：`~\/catsco-workspace\/RuntimeTestAgent`/);
    assert.doesNotMatch(prompt, /运行时计划/);
    assert.doesNotMatch(prompt, /update_plan/);
    assert.doesNotMatch(prompt, /决策日志/);
    assert.doesNotMatch(prompt, /record_decision/);
    assert.doesNotMatch(prompt, /后台子 agent 调度/);
    assert.doesNotMatch(prompt, /spawn_subagent/);
    assert.doesNotMatch(prompt, /压缩 observation/);
    assert.doesNotMatch(prompt, /子 agent 通信与回流/);
    assert.doesNotMatch(prompt, /ask_parent/);
    assert.doesNotMatch(prompt, /resume_subagent/);
    assert.doesNotMatch(prompt, /~\/Documents\/xiaoba/);
    assert.doesNotMatch(prompt, /必须多次调用 send_text/);
    assert.doesNotMatch(prompt, /150字以上/);
    assert.doesNotMatch(prompt, /500字以上/);
    assert.doesNotMatch(prompt, /send_file 工具写成文件发送/);
  });

  test('ToolManager registers the current default tool set', () => {
    const { ToolManager } = require('../src/tools/tool-manager');
    const manager = new ToolManager('/tmp/xiaoba-runtime-characterization');

    assert.deepStrictEqual(
      manager.getToolDefinitions().map((definition: any) => definition.name).sort(),
      [
        'check_subagent',
        'edit_file',
        'execute_shell',
        'glob',
        'grep',
        'read_file',
        'record_decision',
        'resume_subagent',
        'send_file',
        'send_text',
        'skill',
        'spawn_subagent',
        'stop_subagent',
        'update_plan',
        'write_file',
      ],
    );
  });

  test('session system prompt provider injects Feishu surface context for user and group sessions', async () => {
    const { AgentSession } = loadAgentSessionModules();

    const privateSession = new AgentSession('user:feishu-test', buildMockServices());
    setSessionSystemPrompt(privateSession, 'user:feishu-test', 'feishu');
    await privateSession.init();
    const privateSurface = getSystemMessages(privateSession)
      .find(content => content.includes('[surface:feishu:private]'));

    assert.ok(privateSurface);
    assert.match(privateSurface, /当前是飞书私聊会话/);
    assert.match(privateSurface, /每次文本输出都会立即自动发送给用户/);

    const groupSession = new AgentSession('group:feishu-test', buildMockServices());
    setSessionSystemPrompt(groupSession, 'group:feishu-test', 'feishu');
    await groupSession.init();
    const groupSurface = getSystemMessages(groupSession)
      .find(content => content.includes('[surface:feishu:group]'));

    assert.ok(groupSurface);
    assert.match(groupSurface, /当前是飞书群聊会话/);
  });

  test('session system prompt provider injects CatsCo surface context for cc sessions', async () => {
    const { AgentSession } = loadAgentSessionModules();

    const session = new AgentSession('cc_user:demo', buildMockServices());
    setSessionSystemPrompt(session, 'cc_user:demo', 'catscompany');
    await session.init();
    const surface = getSystemMessages(session)
      .find(content => content.includes('[surface:catscompany]'));

    assert.ok(surface);
    assert.match(surface, /当前是 CatsCo 聊天会话/);
    assert.match(surface, /每次文本输出都会立即自动发送给用户/);

    const groupSession = new AgentSession('cc_group:demo', buildMockServices());
    setSessionSystemPrompt(groupSession, 'cc_group:demo', 'catscompany');
    await groupSession.init();

    assert.equal(
      getSystemMessages(groupSession).some(content => content.includes('[surface:catscompany]')),
      true,
    );
  });

  test('session system prompt provider uses sessionType to inject Weixin surface context for user-prefixed sessions', async () => {
    const { AgentSession } = loadAgentSessionModules();

    const session = new AgentSession('user:weixin-demo', buildMockServices(), 'weixin');
    setSessionSystemPrompt(session, 'user:weixin-demo', 'weixin');
    await session.init();
    const systemMessages = getSystemMessages(session);

    assert.equal(systemMessages.some(content => content.includes('[surface:feishu')), false);
    const surface = systemMessages.find(content => content.includes('[surface:weixin]'));
    assert.ok(surface);
    assert.match(surface, /当前是微信聊天会话/);
  });

  test('session system prompt provider does not inject chat surface context for plain cli sessions', async () => {
    const { AgentSession } = loadAgentSessionModules();

    const session = new AgentSession('cli-session', buildMockServices());
    setSessionSystemPrompt(session, 'cli-session', 'cli');
    await session.init();

    assert.equal(
      getSystemMessages(session).some(content => content.includes('[surface:')),
      false,
    );
  });

  test('AgentSession does not infer surface system prompt without an injected provider', async () => {
    const { AgentSession } = loadAgentSessionModules();

    const session = new AgentSession('user:direct-session', buildMockServices(), 'feishu');
    await session.init();

    assert.equal(
      getSystemMessages(session).some(content => content.includes('[surface:')),
      false,
    );
  });

  test('AgentSession clear discards pending restored history before initialization', async () => {
    const { AgentSession } = loadAgentSessionModules();

    const session = new AgentSession('user:clear-restore-demo', buildMockServices(), 'feishu');
    (session as any).pendingRestore = [
      { role: 'user', content: 'stale restored message' },
    ];

    session.reset();
    await session.init();

    assert.equal(
      (session as any).messages.some((message: any) => message.content === 'stale restored message'),
      false,
    );
  });

  test('AgentSession passes resolved surface into tool execution context', async () => {
    const { AgentSession } = loadAgentSessionModules();
    let capturedSurface: string | undefined;
    let callCount = 0;

    const session = new AgentSession('cc_group:demo', buildMockServices({
      aiService: {
        async chatStream() {
          callCount++;
          if (callCount === 1) {
            return {
              content: null,
              toolCalls: [{
                id: 'tool-1',
                type: 'function',
                function: {
                  name: 'capture_context',
                  arguments: '{}',
                },
              }],
            };
          }

          return {
            content: 'done',
            toolCalls: [],
          };
        },
      },
      toolManager: {
        getToolDefinitions() {
          return [{
            name: 'capture_context',
            description: 'Capture tool context',
            parameters: {
              type: 'object',
              properties: {},
            },
          }];
        },
        async executeTool(toolCall: any, _messages: any[], context: any) {
          capturedSurface = context.surface;
          return {
            tool_call_id: toolCall.id,
            role: 'tool',
            name: toolCall.function.name,
            content: 'captured',
            ok: true,
          };
        },
      },
    }));

    const result = await session.handleMessage('run tool');

    assert.equal(result.text, 'done');
    assert.equal(capturedSurface, 'catscompany');
  });

  test('AgentSession requestInterrupt aborts the active tool context', async () => {
    const { AgentSession } = loadAgentSessionModules();
    let capturedSignal: AbortSignal | undefined;
    let releaseExecuteStart: (() => void) | undefined;
    const executeStarted = new Promise<void>(resolve => {
      releaseExecuteStart = resolve;
    });

    const session = new AgentSession('cc_user:abort-demo', buildMockServices({
      aiService: {
        async chatStream() {
          return {
            content: null,
            toolCalls: [{
              id: 'tool-abort',
              type: 'function',
              function: {
                name: 'capture_abort',
                arguments: '{}',
              },
            }],
          };
        },
      },
      toolManager: {
        getToolDefinitions() {
          return [{
            name: 'capture_abort',
            description: 'Capture abort signal',
            parameters: {
              type: 'object',
              properties: {},
            },
          }];
        },
        async executeTool(toolCall: any, _messages: any[], context: any) {
          capturedSignal = context.abortSignal;
          releaseExecuteStart?.();
          await waitForSignalAbort(context.abortSignal, 1000);
          return {
            tool_call_id: toolCall.id,
            role: 'tool',
            name: toolCall.function.name,
            content: 'aborted',
            ok: true,
          };
        },
      },
    }));

    const run = session.handleMessage('run abortable tool');
    await executeStarted;
    session.requestInterrupt();
    await run;

    assert.equal(capturedSignal?.aborted, true);
  });

  test('AgentSession requestInterrupt aborts in-flight AI inference', async () => {
    const { AgentSession } = loadAgentSessionModules();
    let capturedSignal: AbortSignal | undefined;
    let releaseInferenceStart: (() => void) | undefined;
    const inferenceStarted = new Promise<void>(resolve => {
      releaseInferenceStart = resolve;
    });

    const session = new AgentSession('cc_user:ai-abort-demo', buildMockServices({
      aiService: {
        async chatStream(_messages: any[], _tools: any[], _callbacks: any, options: { signal?: AbortSignal }) {
          capturedSignal = options.signal;
          releaseInferenceStart?.();
          await waitForSignalAbort(options.signal, 1000);
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      },
      toolManager: {
        getToolDefinitions() {
          return [];
        },
      },
    }));

    const run = session.handleMessage('run abortable inference');
    await inferenceStarted;
    session.requestInterrupt();
    const result = await run;

    assert.equal(capturedSignal?.aborted, true);
    assert.equal(result.visibleToUser, false);
    assert.equal(result.text, '');
  });
});

function loadAgentSessionModules(): any {
  delete require.cache[require.resolve('../src/core/agent-session')];
  delete require.cache[require.resolve('../src/utils/prompt-manager')];
  delete require.cache[require.resolve('../src/utils/session-turn-logger')];
  return require('../src/core/agent-session');
}

function buildMockServices(overrides: any = {}): any {
  return {
    aiService: overrides.aiService ?? {},
    toolManager: overrides.toolManager ?? {
      setContextDefaults() {},
      getToolDefinitions() { return []; },
      executeTool() { throw new Error('not expected'); },
    },
    skillManager: {
      getSkill() { return undefined; },
      getUserInvocableSkills() { return []; },
      getAutoInvocableSkills() { return []; },
      findAutoInvocableSkillByText() { return undefined; },
      loadSkills: async () => {},
    },
  };
}

function getSystemMessages(session: any): string[] {
  return session.messages
    .filter((message: any) => message.role === 'system' && typeof message.content === 'string')
    .map((message: any) => message.content);
}

function setSessionSystemPrompt(session: any, sessionKey: string, sessionType?: string): void {
  const { composeSessionSystemPromptProvider } = require('../src/core/session-system-prompt');
  session.setSystemPromptProvider(composeSessionSystemPromptProvider(
    () => 'base system prompt',
    { sessionKey, sessionType },
  ));
}

function waitForSignalAbort(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  if (!signal) return Promise.reject(new Error('missing AbortSignal'));
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('AbortSignal was not aborted'));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
