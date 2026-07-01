import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function removeTreeWithRetry(target: string): Promise<void> {
  const retryableCodes = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (!retryableCodes.has(error?.code) || attempt === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

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
    delete process.env.XIAOBA_PROMPT_MODE;
  });

  afterEach(async () => {
    try {
      require('../src/utils/logger').Logger.closeLogFile();
    } catch {}
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      await removeTreeWithRetry(testRoot);
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
    assert.match(prompt, /当前目录会在每次模型请求中作为临时上下文消息提供/);
    assert.doesNotMatch(prompt, /~\/Documents\/xiaoba/);
    assert.doesNotMatch(prompt, /必须多次调用 send_text/);
    assert.doesNotMatch(prompt, /150字以上/);
    assert.doesNotMatch(prompt, /500字以上/);
    assert.doesNotMatch(prompt, /send_file 工具写成文件发送/);
    assert.match(prompt, /已生成、已发送、见附件、可预览、可下载/);
    assert.match(prompt, /send_text` 只能发送普通文本/);
    assert.match(prompt, /微信、飞书等轻量聊天通道优先短消息和普通文件/);
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
        'resolve_common_directory',
        'resume_subagent',
        'send_file',
        'send_text',
        'share_skillhub_skill',
        'skill',
        'spawn_subagent',
        'stop_subagent',
        'update_plan',
        'write_file',
      ],
    );
  });

  test('session system prompt provider does not inject Feishu surface prompt text', async () => {
    const { AgentSession } = loadAgentSessionModules();

    const privateSession = new AgentSession('user:feishu-test', buildMockServices());
    setSessionSystemPrompt(privateSession, 'user:feishu-test', 'feishu');
    await privateSession.init();

    const groupSession = new AgentSession('group:feishu-test', buildMockServices());
    setSessionSystemPrompt(groupSession, 'group:feishu-test', 'feishu');
    await groupSession.init();

    assert.equal(getSystemMessages(privateSession).some(content => content.includes('[surface:')), false);
    assert.equal(getSystemMessages(groupSession).some(content => content.includes('[surface:')), false);
  });

  test('session system prompt provider does not inject CatsCo surface prompt text', async () => {
    const { AgentSession } = loadAgentSessionModules();

    const session = new AgentSession('cc_user:demo', buildMockServices());
    setSessionSystemPrompt(session, 'cc_user:demo', 'catscompany');
    await session.init();

    const groupSession = new AgentSession('cc_group:demo', buildMockServices());
    setSessionSystemPrompt(groupSession, 'cc_group:demo', 'catscompany');
    await groupSession.init();

    assert.equal(getSystemMessages(session).some(content => content.includes('[surface:')), false);
    assert.equal(getSystemMessages(groupSession).some(content => content.includes('[surface:')), false);
  });

  test('session system prompt provider does not inject Weixin surface prompt text', async () => {
    const { AgentSession } = loadAgentSessionModules();

    const session = new AgentSession('user:weixin-demo', buildMockServices(), 'weixin');
    setSessionSystemPrompt(session, 'user:weixin-demo', 'weixin');
    await session.init();
    const systemMessages = getSystemMessages(session);

    assert.equal(systemMessages.some(content => content.includes('[surface:feishu')), false);
    assert.equal(systemMessages.some(content => content.includes('[surface:weixin]')), false);
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
