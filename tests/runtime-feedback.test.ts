import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import {
  fingerprintRuntimeFeedback,
  formatRuntimeFeedback,
  RUNTIME_FEEDBACK_PREFIX,
} from '../src/core/runtime-feedback';

const require = createRequire(import.meta.url);

describe('runtime feedback', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-feedback-'));
    process.chdir(testRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('formats compact agent-visible feedback and stable fingerprints', () => {
    const formatted = formatRuntimeFeedback(' feishu.file_download ', ' failed\n\n to download ', {
      actionHint: ' ask user to retry ',
    });

    assert.equal(formatted.startsWith(RUNTIME_FEEDBACK_PREFIX), true);
    assert.match(formatted, /feishu\.file_download/);
    assert.match(formatted, /错误: failed to download/);
    assert.match(formatted, /处理建议: ask user to retry/);
    assert.equal(
      fingerprintRuntimeFeedback('SRC', 'same\nmessage'),
      fingerprintRuntimeFeedback(' src ', 'same message'),
    );
  });

  test('AgentSession injects runtime feedback as a one-turn user message and records it in turn log', async () => {
    const { AgentSession } = loadAgentSessionModules();
    let capturedMessages: any[] = [];

    const session = new AgentSession('user:runtime-feedback-demo', buildMockServices({
      aiService: {
        async chatStream(messages: any[]) {
          capturedMessages = messages.map(message => ({ ...message }));
          return {
            content: '已处理',
            toolCalls: [],
            usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
          };
        },
      },
    }), 'feishu');
    session.setSystemPromptProvider(() => 'system prompt');

    assert.equal(session.injectRuntimeFeedback(
      'feishu.file_download',
      '文件下载失败: report.pdf',
      { actionHint: '请让用户重试上传。' },
    ), true);
    assert.equal(session.injectRuntimeFeedback(
      'feishu.file_download',
      '文件下载失败: report.pdf',
      { actionHint: '请让用户重试上传。' },
    ), false);
    assert.equal((session as any).messages.some((message: any) => message.__runtimeFeedback), false);
    assert.equal((session as any).runtimeFeedbackInbox.getPendingCount(), 1);

    const result = await session.handleMessage('请继续处理');

    assert.equal(result.text, '已处理');
    const feedbackIndex = capturedMessages.findIndex(message =>
      typeof message.content === 'string' && message.content.startsWith(RUNTIME_FEEDBACK_PREFIX)
    );
    const userIndex = capturedMessages.findIndex(message => message.content === '请继续处理');
    assert.ok(feedbackIndex >= 0, 'runtime feedback should be sent to the model');
    assert.ok(feedbackIndex < userIndex, 'runtime feedback should appear before the actual user request');
    assert.equal(capturedMessages[feedbackIndex].role, 'user');

    const retainedMessages = (session as any).messages as any[];
    assert.equal(retainedMessages.some(message => message.__runtimeFeedback), false);
    assert.equal(retainedMessages.some(message =>
      typeof message.content === 'string' && message.content.startsWith(RUNTIME_FEEDBACK_PREFIX)
    ), false);

    const logPath = (session as any).sessionTurnLogger.getLogFilePath();
    const entries = fs.readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));

    const turnEntries = entries.filter(entry => entry.entry_type === 'turn');
    assert.equal(turnEntries.length, 1);
    assert.equal(turnEntries[0].user.text, '请继续处理');
    assert.equal(turnEntries[0].user.runtime_feedback.length, 1);
    assert.match(turnEntries[0].user.runtime_feedback[0], /feishu\.file_download/);
  });

  test('AgentSession injects session identity next to the latest user request as transient user context', async () => {
    const { AgentSession } = loadAgentSessionModules();
    let capturedMessages: any[] = [];

    const session = new AgentSession('cc_user:usr7', buildMockServices({
      aiService: {
        async chatStream(messages: any[]) {
          capturedMessages = messages.map(message => ({ ...message }));
          return {
            content: '已处理',
            toolCalls: [],
            usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 },
          };
        },
      },
    }), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');

    await session.handleMessage('帮我看一下这个 PR 的测试失败。', {
      sessionIdentity: {
        schemaVersion: 1,
        sessionId: 'cc_user:usr7',
        legacySessionKey: 'cc_user:usr7',
        sessionType: 'catscompany',
        channel: 'catsco',
        actor: { actorUserId: 'usr7', actorDisplayName: 'Alice', externalUserId: 'usr7' },
        agent: { agentId: 'bot42', agentDisplayName: 'Dev Agent', bodyId: 'body-mac-if-known' },
        topic: { topicId: 'p2p_usr7_bot42', topicType: 'p2p', channelSeq: 91 },
      },
    });

    const identityIndex = capturedMessages.findIndex(message =>
      typeof message.content === 'string' && message.content.startsWith('[transient_session_identity]')
    );
    const userIndex = capturedMessages.findIndex(message => message.content === '帮我看一下这个 PR 的测试失败。');
    assert.ok(identityIndex >= 0, 'session identity should be sent to the model');
    assert.ok(identityIndex < userIndex, 'session identity should appear before the actual user request');
    assert.equal(capturedMessages[identityIndex].role, 'user');
    assert.match(capturedMessages[identityIndex].content, /actor: Alice \/ usr7/);
    assert.match(capturedMessages[identityIndex].content, /agent: Dev Agent \/ bot42 \/ body=body-mac-if-known/);

    const retainedMessages = (session as any).messages as any[];
    assert.equal(retainedMessages.some(message =>
      typeof message.content === 'string' && message.content.startsWith('[transient_session_identity]')
    ), false);

    const logPath = (session as any).sessionTurnLogger.getLogFilePath();
    const turnEntry = fs.readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .find(entry => entry.entry_type === 'turn');
    assert.equal(turnEntry.identity.actor.actorUserId, 'usr7');
    assert.equal(turnEntry.identity.topic.channelSeq, 91);
  });

  test('AgentSession records runtime observations without treating them as runtime feedback', async () => {
    const { AgentSession } = loadAgentSessionModules();
    let capturedMessages: any[] = [];

    const session = new AgentSession('user:runtime-observation-demo', buildMockServices({
      aiService: {
        async chatStream(messages: any[]) {
          capturedMessages = messages.map(message => ({ ...message }));
          return {
            content: '已整合子任务结果',
            toolCalls: [],
            usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
          };
        },
      },
    }), 'catscompany');
    session.setSystemPromptProvider(() => 'system prompt');

    const result = await session.handleRuntimeObservation('[子智能体完成]\n结果：ok', {
      source: 'subagent_result',
    });

    assert.equal(result.text, '已整合子任务结果');
    const capturedRuntimeMessage = capturedMessages.find(message => message.content === '[子智能体完成]\n结果：ok');
    assert.equal(capturedRuntimeMessage?.role, 'user');

    const retainedMessages = (session as any).messages as any[];
    const runtimeMessage = retainedMessages.find(message => message.content === '[子智能体完成]\n结果：ok');
    assert.equal(runtimeMessage?.__runtimeObservation, true);
    assert.equal(runtimeMessage?.runtimeObservationSource, 'subagent_result');
    assert.equal(retainedMessages.some(message => message.__runtimeFeedback), false);

    const logPath = (session as any).sessionTurnLogger.getLogFilePath();
    const entries = fs.readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));

    const turnEntries = entries.filter(entry => entry.entry_type === 'turn');
    assert.equal(turnEntries.length, 1);
    assert.equal(turnEntries[0].user.text, '[子智能体完成]\n结果：ok');
    assert.equal(turnEntries[0].user.runtime_observation_source, 'subagent_result');
    assert.equal(turnEntries[0].user.runtime_feedback, undefined);
  });

  test('HandleMessageOptions runtime feedback does not mutate session state while busy', async () => {
    const { AgentSession, BUSY_MESSAGE } = loadAgentSessionModules();
    const session = new AgentSession('user:busy-feedback-demo', buildMockServices(), 'feishu');

    (session as any).busy = true;
    const result = await session.handleMessage('blocked turn', {
      runtimeFeedback: [{
        source: 'feishu.file_download',
        message: '文件下载失败: busy.pdf',
      }],
    });

    assert.equal(result.text, BUSY_MESSAGE);
    assert.equal((session as any).messages.length, 0);
    assert.equal((session as any).runtimeFeedbackInbox.getPendingCount(), 0);
  });

  test('direct runtime feedback injection while busy waits for the next real turn', async () => {
    const { AgentSession } = loadAgentSessionModules();
    let capturedMessages: any[] = [];
    const session = new AgentSession('user:busy-pending-feedback-demo', buildMockServices({
      aiService: {
        async chatStream(messages: any[]) {
          capturedMessages = messages.map(message => ({ ...message }));
          return {
            content: 'next turn handled',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      },
    }), 'feishu');
    session.setSystemPromptProvider(() => 'system prompt');

    (session as any).busy = true;
    assert.equal(session.injectRuntimeFeedback('runtime', 'busy-time error'), true);
    assert.equal((session as any).messages.length, 0);
    assert.equal((session as any).runtimeFeedbackInbox.getPendingCount(), 1);

    (session as any).busy = false;
    await session.handleMessage('next turn');

    assert.equal(capturedMessages.some(message =>
      typeof message.content === 'string' && message.content.includes('busy-time error')
    ), true);
    assert.equal((session as any).runtimeFeedbackInbox.getPendingCount(), 0);
  });

  test('runtime feedback is not summarized by runner compaction', async () => {
    const { AgentSession } = loadAgentSessionModules();
    let aiCalls = 0;
    const session = new AgentSession('user:runtime-feedback-compaction-demo', buildMockServices({
      aiService: {
        async chatStream(messages: any[]) {
          aiCalls++;
          assert.equal(
            messages.some(message =>
              typeof message.content === 'string'
              && message.content.includes('Please summarize the following')
            ),
            false,
            'runtime feedback should not trigger runner-level compaction summary calls',
          );
          return {
            content: 'handled without compaction',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      },
    }), 'feishu');
    session.setSystemPromptProvider(() => 'system prompt');

    session.injectRuntimeFeedback('runtime', 'x'.repeat(300_000), { maxLength: 300_000 });
    await session.handleMessage('short user request');

    assert.equal(aiCalls, 1);
  });
});

function loadAgentSessionModules(): any {
  delete require.cache[require.resolve('../src/core/agent-session')];
  delete require.cache[require.resolve('../src/utils/session-turn-logger')];
  return require('../src/core/agent-session');
}

function buildMockServices(overrides: any = {}): any {
  return {
    aiService: overrides.aiService ?? {},
    toolManager: overrides.toolManager ?? {
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
