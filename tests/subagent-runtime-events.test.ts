import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatSubAgentEventLine, SubAgentEventStore } from '../src/core/sub-agent-events';
import { ConversationRunner } from '../src/core/conversation-runner';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { SubAgentSession } from '../src/core/sub-agent-session';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import { SpawnSubagentTool } from '../src/tools/spawn-subagent-tool';

describe('subagent runtime events', () => {
  test('event store keeps bounded per-parent event streams with per-agent sequence numbers', () => {
    const store = new SubAgentEventStore({ maxEventsPerParent: 2, retentionMs: Number.MAX_SAFE_INTEGER });

    store.append({
      parentSessionKey: 'parent-a',
      subAgentId: 'sub-a',
      subAgentName: '子agent1',
      type: 'agent_spawned',
      summary: 'spawned',
      timestamp: 1000,
    });
    store.append({
      parentSessionKey: 'parent-a',
      subAgentId: 'sub-a',
      subAgentName: '子agent1',
      type: 'agent_progress',
      summary: 'progress 1',
      timestamp: 1001,
    });
    store.append({
      parentSessionKey: 'parent-a',
      subAgentId: 'sub-b',
      type: 'agent_progress',
      summary: 'progress 2',
      timestamp: 1002,
    });

    const events = store.listByParent('parent-a');
    assert.equal(events.length, 2);
    assert.equal(events[0].summary, 'progress 1');
    assert.equal(events[0].seq, 2);
    assert.equal(events[1].summary, 'progress 2');
    assert.equal(events[1].seq, 1);
    assert.match(formatSubAgentEventLine(events[0]), /子agent1/);
  });

  test('event store can expand capacity based on active subagent count', () => {
    const store = new SubAgentEventStore({
      maxEventsPerParent: 2,
      maxEventsPerAgent: 2,
      retentionMs: Number.MAX_SAFE_INTEGER,
    });

    for (let i = 0; i < 6; i += 1) {
      store.append({
        parentSessionKey: 'parent-dynamic',
        subAgentId: `sub-${i % 3}`,
        type: 'agent_progress',
        summary: `event ${i}`,
        timestamp: 1000 + i,
      });
    }

    const events = store.listByParent('parent-dynamic');
    assert.equal(events.length, 6);
    assert.equal(events[0].summary, 'event 0');
    assert.equal(events[5].summary, 'event 5');
  });

  test('manager formats runtime observation from recent subagent events', () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:manager`;

    manager.recordEvent(parentSessionKey, 'sub-test', 'agent_spawned', '派遣 explorer 扫描登录链路');
    manager.recordEvent(parentSessionKey, 'sub-test', 'agent_progress', '已定位 /api/cats/status');

    const observation = manager.buildObservationForParent(parentSessionKey, 5);
    assert.match(observation, /sub-test/);
    assert.match(observation, /派遣 explorer/);
    assert.match(observation, /已定位/);
  });

  test('turn context injects compact subagent status before the latest user message', async () => {
    const originalGetInstance = SubAgentManager.getInstance;
    const parentSessionKey = `test-parent:${Date.now()}:turn`;
    (SubAgentManager as any).getInstance = () => ({
      listByParent: () => [{
        id: 'sub-running',
        displayName: '子agent1',
        agentType: 'explorer',
        skillName: 'explorer',
        toolScope: 'read_only',
        taskDescription: 'dashboard 账号链路审查',
        status: 'running',
        createdAt: Date.now(),
        progressLog: ['完成 dashboard 账号链路审查'],
        outputFiles: [],
        allowedTools: ['read_file', 'grep'],
      }],
      buildObservationForParent: () => '子agent1/sub-running #1 agent_tool_end: read_file 完成',
    });
    const builder = new TurnContextBuilder();
    try {
      const result = await builder.build({
        sessionKey: parentSessionKey,
        durableMessages: [
          { role: 'system', content: 'base system' },
          { role: 'user', content: '用户新问题' },
        ],
        runtimeFeedback: [],
        skillRuntime: {
          reloadSkills: async () => undefined,
          buildSkillsListMessage: () => null,
        } as any,
      });

      const eventIndex = result.messages.findIndex(message => (
        typeof message.content === 'string'
        && message.content.startsWith('[transient_subagent_status]')
      ));
      const userIndex = result.messages.findIndex(message => message.role === 'user' && message.content === '用户新问题');

      assert.ok(eventIndex >= 0, 'subagent status observation should be injected');
      assert.equal(result.messages[eventIndex].__injected, true);
      assert.ok(eventIndex < userIndex, 'subagent observation should appear before latest user message');
      assert.match(String(result.messages[eventIndex].content), /完成 dashboard 账号链路审查/);
      assert.doesNotMatch(
        String(result.messages[eventIndex].content),
        /agent_tool_end|最近 runtime 事件|read_file 完成/,
        'automatic current-turn observation should not include noisy runtime event details',
      );

      const durable = builder.removeTransientMessages(result.messages);
      assert.equal(durable.some(message => (
        typeof message.content === 'string'
        && message.content.includes('完成 dashboard 账号链路审查')
      )), false);
    } finally {
      (SubAgentManager as any).getInstance = originalGetInstance;
    }
  });

  test('turn context does not inject subagent status for sessions without subagents', async () => {
    const builder = new TurnContextBuilder();
    const result = await builder.build({
      sessionKey: `test-parent:${Date.now()}:empty`,
      durableMessages: [
        { role: 'system', content: 'base system' },
        { role: 'user', content: '普通问题' },
      ],
      runtimeFeedback: [],
      skillRuntime: {
        reloadSkills: async () => undefined,
        buildSkillsListMessage: () => null,
      } as any,
    });

    assert.equal(result.messages.some(message => (
      message.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith('[transient_subagent_status]')
    )), false);
  });

  test('turn context does not repeat completed subagent status after result handoff', async () => {
    const originalGetInstance = SubAgentManager.getInstance;
    (SubAgentManager as any).getInstance = () => ({
      listByParent: () => [{
        id: 'sub-completed',
        displayName: '子agent1',
        agentType: 'explorer',
        skillName: 'explorer',
        toolScope: 'read_only',
        taskDescription: '完成项',
        status: 'completed',
        createdAt: Date.now(),
        progressLog: ['已完成'],
        resultSummary: '完成摘要',
        outputFiles: [],
        allowedTools: ['read_file'],
      }],
      buildObservationForParent: () => '子agent1/sub-completed #2 agent_completed: 已完成',
    });
    const builder = new TurnContextBuilder();
    try {
      const result = await builder.build({
        sessionKey: `test-parent:${Date.now()}:completed-only`,
        durableMessages: [
          { role: 'system', content: 'base system' },
          { role: 'user', content: '普通问题' },
        ],
        runtimeFeedback: [],
        skillRuntime: {
          reloadSkills: async () => undefined,
          buildSkillsListMessage: () => null,
        } as any,
      });

      assert.equal(result.messages.some(message => (
        message.role === 'system'
        && typeof message.content === 'string'
        && message.content.startsWith('[transient_subagent_status]')
      )), false);
    } finally {
      (SubAgentManager as any).getInstance = originalGetInstance;
    }
  });

  test('subagent tool-end events summarize tool result instead of tool use id', async () => {
    const originalRun = ConversationRunner.prototype.run;
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-subagent-tool-end-'));
    const events: Array<{ type: string; summary: string }> = [];

    (ConversationRunner.prototype as any).run = async function runMock(messages: any[], callbacks: any) {
      callbacks?.onToolEnd?.('read_file', 'call_function_fake_id', '真实工具结果：找到 src/core/sub-agent-session.ts');
      return {
        response: 'done',
        finalResponseVisible: true,
        messages,
        newMessages: [],
      };
    };

    try {
      const session = new SubAgentSession('sub-tool-end', {} as any, { getSkill: () => undefined } as any, {
        agentType: 'explorer',
        taskDescription: 'check tool end',
        userMessage: 'check tool end',
        workingDirectory,
        emitEvent: (type, summary) => {
          events.push({ type, summary });
        },
      });

      await session.run();

      const toolEndEvent = events.find(event => event.type === 'agent_tool_end');
      assert.ok(toolEndEvent, 'expected an agent_tool_end event');
      assert.match(toolEndEvent.summary, /真实工具结果/);
      assert.doesNotMatch(toolEndEvent.summary, /call_function_fake_id/);

      await session.close();
    } finally {
      ConversationRunner.prototype.run = originalRun;
      fs.rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('subagent result summary falls back to recent progress when final response is empty', async () => {
    const originalRun = ConversationRunner.prototype.run;
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-subagent-empty-result-'));

    (ConversationRunner.prototype as any).run = async function runMock(messages: any[], callbacks: any) {
      callbacks?.onToolEnd?.('grep', 'call_function_fake_id', '找到 dashboard/index.html 中的 renderCatsWorkingBlocks');
      return {
        response: '',
        finalResponseVisible: false,
        messages,
        newMessages: [],
      };
    };

    try {
      const session = new SubAgentSession('sub-empty-result', {} as any, { getSkill: () => undefined } as any, {
        agentType: 'explorer',
        taskDescription: 'check empty result fallback',
        userMessage: 'check empty result fallback',
        workingDirectory,
      });

      await session.run();

      const summary = session.getInfo().resultSummary || '';
      assert.match(summary, /未形成最终摘要/);
      assert.match(summary, /最近进度/);
      assert.notEqual(summary, '（无结果）');
    } finally {
      ConversationRunner.prototype.run = originalRun;
      fs.rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('subagent result summary ignores assistant preamble attached to tool calls', async () => {
    const originalRun = ConversationRunner.prototype.run;
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-subagent-tool-preamble-'));

    (ConversationRunner.prototype as any).run = async function runMock(messages: any[], callbacks: any) {
      messages.push({
        role: 'assistant',
        content: '我来读取这些核心文件，分析完整消息链路。',
        tool_calls: [{
          id: 'call_function_fake_id',
          type: 'function',
          function: { name: 'grep', arguments: '{}' },
        }],
      });
      callbacks?.onToolEnd?.('grep', 'call_function_fake_id', '找到 server/wshandler.go');
      return {
        response: '',
        finalResponseVisible: false,
        messages,
        newMessages: [],
      };
    };

    try {
      const session = new SubAgentSession('sub-tool-preamble', {} as any, { getSkill: () => undefined } as any, {
        agentType: 'explorer',
        taskDescription: 'check tool preamble fallback',
        userMessage: 'check tool preamble fallback',
        workingDirectory,
      });

      await session.run();

      const summary = session.getInfo().resultSummary || '';
      assert.match(summary, /未形成最终摘要/);
      assert.doesNotMatch(summary, /我来读取这些核心文件/);
    } finally {
      ConversationRunner.prototype.run = originalRun;
      fs.rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('ask_parent puts a subagent into waiting state and resume continues it', async () => {
    const originalRun = ConversationRunner.prototype.run;
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-subagent-ask-parent-'));
    const notifications: Array<{ id: string; task: string; question: string }> = [];
    const events: Array<{ type: string; summary: string }> = [];
    let session: SubAgentSession;

    (ConversationRunner.prototype as any).run = async function runMock(messages: any[]) {
      const requestParentInput = (this as any).toolExecutionContext?.requestParentInput;
      assert.equal(typeof requestParentInput, 'function');
      const answer = await requestParentInput('需要确认 CatsCompany 源码路径');
      return {
        response: `收到主 agent 回复：${answer}`,
        finalResponseVisible: true,
        messages,
        newMessages: [],
      };
    };

    try {
      session = new SubAgentSession('sub-ask-parent', {} as any, { getSkill: () => undefined } as any, {
        agentType: 'explorer',
        taskDescription: 'ask parent',
        userMessage: 'ask parent',
        workingDirectory,
        notifyParent: async (id, task, question) => {
          notifications.push({ id, task, question });
        },
        emitEvent: (type, summary) => {
          events.push({ type, summary });
        },
      });

      const runPromise = session.run();
      await waitFor(() => session.getInfo().status === 'waiting_for_input' && notifications.length === 1);

      assert.equal(notifications[0].id, 'sub-ask-parent');
      assert.match(notifications[0].question, /CatsCompany 源码路径/);
      assert.equal(session.getInfo().pendingQuestion, '需要确认 CatsCompany 源码路径');
      assert.ok(session.getInfo().pendingQuestionSince);
      assert.equal(events.some(event => event.type === 'agent_waiting'), true);
      assert.equal(session.resume('E:\\work\\cats\\cats-company'), true);

      await runPromise;

      assert.equal(session.getInfo().status, 'completed');
      assert.match(session.getInfo().resultSummary || '', /E:\\work\\cats\\cats-company/);
    } finally {
      ConversationRunner.prototype.run = originalRun;
      fs.rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('spawn_subagent reuses runtime services and does not load skills for built-in agents', async () => {
    const originalGetInstance = SubAgentManager.getInstance;
    let loadSkillsCalled = false;
    let capturedAiService: unknown;
    let capturedSkillManager: unknown;

    (SubAgentManager as any).getInstance = () => ({
      spawn(
        _parentSessionKey: string,
        request: any,
        _workingDirectory: string,
        aiService: unknown,
        skillManager: unknown,
      ) {
        capturedAiService = aiService;
        capturedSkillManager = skillManager;
        assert.deepEqual(request.allowedTools, ['read_file', 'grep']);
        assert.equal(request.subAgentPrompt, '只输出文件路径和结论');
        assert.equal(request.maxTurns, 9);
        return {
          id: 'sub-runtime-services',
          agentType: request.agentType,
          skillName: request.agentType,
          toolScope: 'read_only',
          allowedTools: request.allowedTools,
          taskDescription: request.taskDescription,
          status: 'running',
          createdAt: Date.now(),
          progressLog: [],
          outputFiles: [],
        };
      },
    });

    const runtimeServices = {
      aiService: { marker: 'shared-ai' },
      skillManager: {
        marker: 'shared-skills',
        async loadSkills() {
          loadSkillsCalled = true;
        },
      },
    };

    try {
      const result = await new SpawnSubagentTool().execute({
        agent_type: 'explorer',
        allowed_tools: ['read_file', 'grep'],
        max_turns: 9,
        subagent_prompt: '只输出文件路径和结论',
        task: '扫描登录链路',
        context: '只读查看登录链路',
      }, {
        workingDirectory: process.cwd(),
        conversationHistory: [],
        sessionId: 'cc_user:test',
        runtimeServices: runtimeServices as any,
      });

      assert.equal(result.ok, true);
      assert.equal(loadSkillsCalled, false);
      assert.equal(capturedAiService, runtimeServices.aiService);
      assert.equal(capturedSkillManager, runtimeServices.skillManager);
    } finally {
      (SubAgentManager as any).getInstance = originalGetInstance;
    }
  });

  test('CatsCo device-scoped spawn_subagent defaults to ask_parent only', async () => {
    const originalGetInstance = SubAgentManager.getInstance;
    let capturedAllowedTools: unknown;

    (SubAgentManager as any).getInstance = () => ({
      spawn(
        _parentSessionKey: string,
        request: any,
      ) {
        capturedAllowedTools = request.allowedTools;
        return {
          id: 'sub-catsco-isolated',
          agentType: request.agentType,
          skillName: request.agentType,
          toolScope: 'read_only',
          allowedTools: request.allowedTools,
          taskDescription: request.taskDescription,
          status: 'running',
          createdAt: Date.now(),
          progressLog: [],
          outputFiles: [],
        };
      },
    });

    try {
      const result = await new SpawnSubagentTool().execute({
        agent_type: 'explorer',
        task: '审查当前问题',
        context: '只看主会话提供的信息，不操作本机文件',
      }, {
        workingDirectory: process.cwd(),
        conversationHistory: [],
        sessionId: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
        surface: 'catscompany',
        executionScope: {
          source: 'catscompany',
          sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
          topicId: 'p2p_7_43',
          topicType: 'p2p',
          actorUserId: 'usr7',
          agentId: 'usr43',
          agentBodyId: 'body-main',
          identityTrust: 'server_canonical',
          isTrusted: true,
        },
        localDeviceGrant: {
          kind: 'catscompany_body',
          source: 'catscompany',
          bodyId: 'body-main',
          createdAt: Date.now(),
        },
        runtimeServices: {
          aiService: {} as any,
          skillManager: {} as any,
        },
      });

      assert.equal(result.ok, true);
      assert.deepEqual(capturedAllowedTools, ['ask_parent']);
    } finally {
      (SubAgentManager as any).getInstance = originalGetInstance;
    }
  });

  test('CatsCo device-scoped spawn_subagent rejects local file tool delegation', async () => {
    const result = await new SpawnSubagentTool().execute({
      agent_type: 'explorer',
      allowed_tools: ['read_file', 'ask_parent'],
      task: '读取本机文件',
      context: '请读取用户设备文件',
    }, {
      workingDirectory: process.cwd(),
      conversationHistory: [],
      sessionId: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
      surface: 'catscompany',
      executionScope: {
        source: 'catscompany',
        sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
        topicId: 'p2p_7_43',
        topicType: 'p2p',
        actorUserId: 'usr7',
        agentId: 'usr43',
        agentBodyId: 'body-main',
        identityTrust: 'server_canonical',
        isTrusted: true,
      },
      localDeviceGrant: {
        kind: 'catscompany_body',
        source: 'catscompany',
        bodyId: 'body-main',
        createdAt: Date.now(),
      },
      runtimeServices: {
        aiService: {} as any,
        skillManager: {} as any,
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /不会传递给子智能体/);
      assert.match(result.message, /read_file/);
    }
  });

  test('spawn_subagent rejects unsafe tools before creating a subagent', async () => {
    const result = await new SpawnSubagentTool().execute({
      agent_type: 'worker',
      allowed_tools: ['read_file', 'send_text'],
      task: '尝试越权',
      context: '不应该派遣',
    }, {
      workingDirectory: process.cwd(),
      conversationHistory: [],
      sessionId: 'cc_user:test',
      runtimeServices: {
        aiService: {} as any,
        skillManager: {} as any,
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /send_text/);
    }
  });

  test('explicit allowed tools cannot exceed the selected tool scope', () => {
    const readOnlySession = new SubAgentSession(
      'sub-scope-readonly',
      {} as any,
      { getSkill: () => undefined } as any,
      {
        agentType: 'explorer',
        toolScope: 'read_only',
        allowedTools: ['read_file', 'write_file', 'execute_shell'],
        taskDescription: 'scope check',
        userMessage: 'scope check',
        workingDirectory: process.cwd(),
      },
    );

    assert.deepStrictEqual(readOnlySession.allowedTools, ['read_file']);

    const testerSession = new SubAgentSession(
      'sub-scope-tester',
      {} as any,
      { getSkill: () => undefined } as any,
      {
        agentType: 'tester',
        toolScope: 'test_only',
        allowedTools: ['grep', 'write_file', 'execute_shell'],
        taskDescription: 'scope check',
        userMessage: 'scope check',
        workingDirectory: process.cwd(),
      },
    );

    assert.deepStrictEqual(testerSession.allowedTools, ['grep', 'execute_shell']);
  });

  test('manager closes finished sessions immediately while keeping lightweight status', async () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:finalize`;
    const injectedMessages: string[] = [];
    const closedIds: string[] = [];
    const eventLogs: Array<{ event: any; info?: any }> = [];
    const platformEvents: Array<{ event: any; info?: any }> = [];

    manager.registerPlatformCallbacks(parentSessionKey, {
      injectMessage: async (text: string) => {
        injectedMessages.push(text);
      },
      onSubAgentEvent: (event: any, info?: any) => {
        platformEvents.push({ event, info });
      },
    });
    manager.registerEventLogger(parentSessionKey, (event, info) => {
      eventLogs.push({ event, info });
    });

    const originalRun = SubAgentSession.prototype.run;
    const originalClose = SubAgentSession.prototype.close;
    (SubAgentSession.prototype as any).run = async function runMock() {
      this.status = 'completed';
      this.completedAt = Date.now();
      this.resultSummary = 'done';
    };
    (SubAgentSession.prototype as any).close = async function closeMock() {
      closedIds.push(this.id);
    };

    try {
      const spawned = await manager.spawn(
        parentSessionKey,
        {
          agentType: 'explorer',
          taskDescription: 'scan',
          userMessage: 'scan context',
        },
        process.cwd(),
        {} as any,
        { getSkill: () => undefined } as any,
      );
      assert.ok(!('error' in spawned));
      assert.match(spawned.displayName || '', /^子agent\d+$/);

      await waitFor(() => closedIds.includes(spawned.id));
      const info = manager.getInfoForParent(parentSessionKey, spawned.id);
      assert.equal(info?.status, 'completed');
      assert.equal(info?.resultSummary, 'done');
      assert.equal(manager.stopForParent(parentSessionKey, spawned.id), 'not_running');

      await waitFor(() => injectedMessages.length > 0);
      assert.match(injectedMessages[0], /已完成/);
      assert.match(injectedMessages[0], /子agent\d+/);
      assert.equal(eventLogs[0].event.subAgentName, spawned.displayName);
      assert.equal(eventLogs[0].info.displayName, spawned.displayName);
      assert.equal(platformEvents[0].event.type, 'agent_spawned');
      assert.equal(platformEvents[0].info.displayName, spawned.displayName);
    } finally {
      SubAgentSession.prototype.run = originalRun;
      SubAgentSession.prototype.close = originalClose;
      manager.unregisterEventLogger(parentSessionKey);
      manager.unregisterPlatformCallbacks(parentSessionKey);
    }
  });

  test('manager unrefs completed subagent retention timer', async () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:retention-unref`;
    let unrefCalled = false;
    let closed = false;

    manager.registerPlatformCallbacks(parentSessionKey, {
      injectMessage: async () => undefined,
    });

    const originalRun = SubAgentSession.prototype.run;
    const originalClose = SubAgentSession.prototype.close;
    const originalSetTimeout = globalThis.setTimeout;
    (SubAgentSession.prototype as any).run = async function runMock() {
      this.status = 'completed';
      this.completedAt = Date.now();
      this.resultSummary = 'done';
    };
    (SubAgentSession.prototype as any).close = async function closeMock() {
      closed = true;
    };
    (globalThis as any).setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 30 * 60 * 1000) {
        return {
          unref() {
            unrefCalled = true;
            return this;
          },
        };
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;

    try {
      const spawned = await manager.spawn(
        parentSessionKey,
        {
          agentType: 'explorer',
          taskDescription: 'retention unref',
          userMessage: 'retention unref',
        },
        process.cwd(),
        {} as any,
        { getSkill: () => undefined } as any,
      );

      assert.ok(!('error' in spawned));
      await waitFor(() => closed);
      await waitFor(() => unrefCalled);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      SubAgentSession.prototype.run = originalRun;
      SubAgentSession.prototype.close = originalClose;
      manager.unregisterPlatformCallbacks(parentSessionKey);
    }
  });

  test('manager injects compact subagent completion summaries into the parent session', async () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:compact-completion`;
    const injectedMessages: string[] = [];
    const longSummary = '这是很长的子 agent 审查结果。'.repeat(400);

    manager.registerPlatformCallbacks(parentSessionKey, {
      injectMessage: async (text: string) => {
        injectedMessages.push(text);
      },
    });

    const originalRun = SubAgentSession.prototype.run;
    const originalClose = SubAgentSession.prototype.close;
    (SubAgentSession.prototype as any).run = async function runMock() {
      this.status = 'completed';
      this.completedAt = Date.now();
      this.resultSummary = longSummary;
    };
    (SubAgentSession.prototype as any).close = async function closeMock() {};

    try {
      const spawned = await manager.spawn(
        parentSessionKey,
        {
          agentType: 'explorer',
          taskDescription: 'compact result',
          userMessage: 'compact result',
        },
        process.cwd(),
        {} as any,
        { getSkill: () => undefined } as any,
      );
      assert.ok(!('error' in spawned));

      await waitFor(() => injectedMessages.length > 0);
      assert.match(injectedMessages[0], /结果摘要/);
      assert.match(injectedMessages[0], /已压缩/);
      assert.ok(injectedMessages[0].length < longSummary.length / 2);
      assert.match(injectedMessages[0], /check_subagent/);
    } finally {
      SubAgentSession.prototype.run = originalRun;
      SubAgentSession.prototype.close = originalClose;
      manager.unregisterPlatformCallbacks(parentSessionKey);
    }
  });

  test('manager unregisters platform callbacks so expired sessions cannot leak callbacks', async () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:unregister-platform`;

    manager.registerPlatformCallbacks(parentSessionKey, {
      injectMessage: async () => undefined,
    });
    manager.unregisterPlatformCallbacks(parentSessionKey);

    const spawned = await manager.spawn(
      parentSessionKey,
      {
        agentType: 'explorer',
        taskDescription: 'should not spawn',
        userMessage: 'should not spawn',
      },
      process.cwd(),
      {} as any,
      { getSkill: () => undefined } as any,
    );

    assert.ok('error' in spawned);
    assert.match(spawned.error, /平台回调未注册/);
  });

  test('manager retries final parent notification before giving up', async () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:notify-retry`;
    let attempts = 0;
    const closedIds: string[] = [];

    manager.registerPlatformCallbacks(parentSessionKey, {
      injectMessage: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('temporary inject failure');
        }
      },
    });

    const originalRun = SubAgentSession.prototype.run;
    const originalClose = SubAgentSession.prototype.close;
    (SubAgentSession.prototype as any).run = async function runMock() {
      this.status = 'completed';
      this.completedAt = Date.now();
      this.resultSummary = 'done after retry';
    };
    (SubAgentSession.prototype as any).close = async function closeMock() {
      closedIds.push(this.id);
    };

    try {
      const spawned = await manager.spawn(
        parentSessionKey,
        {
          agentType: 'explorer',
          taskDescription: 'notify retry',
          userMessage: 'notify retry',
        },
        process.cwd(),
        {} as any,
        { getSkill: () => undefined } as any,
      );

      assert.ok(!('error' in spawned));
      await waitFor(() => closedIds.includes(spawned.id));
      await waitFor(() => attempts === 3, 400);
    } finally {
      SubAgentSession.prototype.run = originalRun;
      SubAgentSession.prototype.close = originalClose;
      manager.unregisterPlatformCallbacks(parentSessionKey);
    }
  });

  test('manager waits for platform spawn event before returning from spawn', async () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:spawn-order`;
    let spawnEventDelivered = false;

    manager.registerPlatformCallbacks(parentSessionKey, {
      injectMessage: async () => undefined,
      onSubAgentEvent: async (event) => {
        if (event.type !== 'agent_spawned') return;
        await new Promise(resolve => setTimeout(resolve, 10));
        spawnEventDelivered = true;
      },
    });

    const originalRun = SubAgentSession.prototype.run;
    (SubAgentSession.prototype as any).run = async function runMock() {
      this.status = 'stopped';
      this.completedAt = Date.now();
    };

    try {
      const spawned = await manager.spawn(
        parentSessionKey,
        {
          agentType: 'explorer',
          taskDescription: 'ordered spawn',
          userMessage: 'ordered spawn',
        },
        process.cwd(),
        {} as any,
        { getSkill: () => undefined } as any,
      );

      assert.ok(!('error' in spawned));
      assert.equal(spawnEventDelivered, true);
    } finally {
      SubAgentSession.prototype.run = originalRun;
      manager.unregisterPlatformCallbacks(parentSessionKey);
    }
  });

  test('manager resolves display names when stopping active subagents', () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:stop-all`;
    let stopped = 0;
    const fakeSession = {
      status: 'running',
      stop() {
        stopped += 1;
        this.status = 'stopped';
      },
      getInfo() {
        return {
          id: 'sub-stop-all',
          agentType: 'worker',
          skillName: 'worker',
          toolScope: 'workspace_write',
          allowedTools: ['read_file'],
          taskDescription: 'long task',
          status: this.status,
          createdAt: Date.now(),
          progressLog: [],
          outputFiles: [],
        };
      },
    };

    (manager as any).subAgents.set('sub-stop-all', fakeSession);
    (manager as any).parentMap.set('sub-stop-all', parentSessionKey);
    (manager as any).displayNameByAgent.set('sub-stop-all', '子agent1');

    try {
      assert.equal(manager.hasActiveForParent(parentSessionKey), true);
      assert.equal(manager.stopForParent(parentSessionKey, '子agent1'), 'stopped');
      assert.equal(stopped, 1);
      assert.equal(manager.hasActiveForParent(parentSessionKey), false);
    } finally {
      (manager as any).subAgents.delete('sub-stop-all');
      (manager as any).parentMap.delete('sub-stop-all');
      (manager as any).displayNameByAgent.delete('sub-stop-all');
    }
  });

  test('manager resolves unique short subagent id prefixes', () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:short-id`;
    const subAgentId = 'sub-de0f25a1-291d-425c-9e34-c3ca17b8a9c3';
    let resumedAnswer = '';
    const fakeSession = {
      status: 'waiting_for_input',
      resume(answer: string) {
        resumedAnswer = answer;
        this.status = 'running';
        return true;
      },
      getInfo() {
        return {
          id: subAgentId,
          agentType: 'explorer',
          skillName: 'explorer',
          toolScope: 'read_only',
          allowedTools: ['read_file', 'ask_parent'],
          taskDescription: 'github search',
          status: this.status,
          createdAt: Date.now(),
          progressLog: [],
          pendingQuestion: this.status === 'waiting_for_input' ? 'need github data' : undefined,
          pendingQuestionSince: Date.now(),
          outputFiles: [],
        };
      },
    };

    (manager as any).subAgents.set(subAgentId, fakeSession);
    (manager as any).parentMap.set(subAgentId, parentSessionKey);
    (manager as any).displayNameByAgent.set(subAgentId, '子agent1');

    try {
      assert.equal(manager.getInfoForParent(parentSessionKey, 'sub-de0f25a1')?.id, subAgentId);
      assert.equal(manager.resumeForParent(parentSessionKey, 'sub-de0f25a1', 'search results'), 'resumed');
      assert.equal(resumedAnswer, 'search results');
      assert.equal(fakeSession.status, 'running');
    } finally {
      (manager as any).subAgents.delete(subAgentId);
      (manager as any).parentMap.delete(subAgentId);
      (manager as any).displayNameByAgent.delete(subAgentId);
    }
  });

  test('manager does not resolve ambiguous short subagent id prefixes', () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:ambiguous-short-id`;
    const ids = [
      'sub-abcdef01-1111-425c-9e34-c3ca17b8a9c3',
      'sub-abcdef01-2222-425c-9e34-c3ca17b8a9c3',
    ];
    const makeSession = (id: string) => ({
      status: 'running',
      getInfo() {
        return {
          id,
          agentType: 'explorer',
          skillName: 'explorer',
          toolScope: 'read_only',
          allowedTools: ['read_file'],
          taskDescription: 'ambiguous',
          status: this.status,
          createdAt: Date.now(),
          progressLog: [],
          outputFiles: [],
        };
      },
    });

    for (const id of ids) {
      (manager as any).subAgents.set(id, makeSession(id));
      (manager as any).parentMap.set(id, parentSessionKey);
    }

    try {
      assert.equal(manager.getInfoForParent(parentSessionKey, 'sub-abcdef01'), undefined);
      assert.equal(manager.stopForParent(parentSessionKey, 'sub-abcdef01'), 'not_found');
    } finally {
      for (const id of ids) {
        (manager as any).subAgents.delete(id);
        (manager as any).parentMap.delete(id);
      }
    }
  });

  test('manager stops all active subagents for a parent episode', () => {
    const manager = SubAgentManager.getInstance();
    const parentSessionKey = `test-parent:${Date.now()}:stop-all`;
    let stopped = 0;
    const fakeSession = {
      status: 'running',
      stop() {
        stopped += 1;
        this.status = 'stopped';
      },
      getInfo() {
        return {
          id: 'sub-stop-all-episode',
          agentType: 'worker',
          skillName: 'worker',
          toolScope: 'workspace_write',
          allowedTools: ['read_file'],
          taskDescription: 'long task',
          status: this.status,
          createdAt: Date.now(),
          progressLog: [],
          outputFiles: [],
        };
      },
    };

    (manager as any).subAgents.set('sub-stop-all-episode', fakeSession);
    (manager as any).parentMap.set('sub-stop-all-episode', parentSessionKey);

    try {
      assert.equal(manager.hasActiveForParent(parentSessionKey), true);
      const result = manager.stopAllForParent(parentSessionKey, '测试停止 episode');
      assert.equal(result.stopped, 1);
      assert.equal(stopped, 1);
      assert.equal(manager.hasActiveForParent(parentSessionKey), false);
    } finally {
      (manager as any).subAgents.delete('sub-stop-all-episode');
      (manager as any).parentMap.delete('sub-stop-all-episode');
    }
  });

  test('subagent stop aborts in-flight tool execution signal', () => {
    const session = new SubAgentSession('sub-abort', {} as any, {} as any, {
      agentType: 'worker',
      taskDescription: 'abort',
      userMessage: 'abort',
      workingDirectory: process.cwd(),
    });
    const controller = new AbortController();
    (session as any).abortController = controller;

    session.stop();

    assert.equal(controller.signal.aborted, true);
    assert.equal(session.status, 'stopped');
  });

  test('subagent runner uses maxTurns only when the main agent specifies it', async () => {
    const observedMaxTurns: Array<number | undefined> = [];
    const originalRun = ConversationRunner.prototype.run;
    (ConversationRunner.prototype as any).run = async function runMock() {
      observedMaxTurns.push((this as any).maxTurns);
      return {
        response: 'done',
        finalResponseVisible: true,
        messages: [],
        newMessages: [],
      };
    };

    try {
      const bounded = new SubAgentSession('sub-max-bounded', {} as any, {} as any, {
        agentType: 'explorer',
        taskDescription: 'bounded',
        userMessage: 'bounded',
        workingDirectory: process.cwd(),
        maxTurns: 7,
      });
      await bounded.run();

      const unbounded = new SubAgentSession('sub-max-unbounded', {} as any, {} as any, {
        agentType: 'explorer',
        taskDescription: 'unbounded',
        userMessage: 'unbounded',
        workingDirectory: process.cwd(),
      });
      await unbounded.run();

      assert.deepEqual(observedMaxTurns, [7, undefined]);
    } finally {
      ConversationRunner.prototype.run = originalRun;
    }
  });

  test('subagent close cleans temporary scratch files while preserving output files', async () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-subagent-cleanup-'));
    try {
      const subAgentId = 'sub-cleanup';
      const tempDir = path.join(workingDirectory, 'tmp', 'subagents', subAgentId);
      const junkFile = path.join(tempDir, 'junk.txt');
      const outputFile = path.join(tempDir, 'keep.txt');
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(junkFile, 'delete me');
      fs.writeFileSync(outputFile, 'keep me');

      const session = new SubAgentSession(subAgentId, {} as any, {} as any, {
        agentType: 'worker',
        taskDescription: 'cleanup',
        userMessage: 'cleanup',
        workingDirectory,
      });
      (session as any).outputFiles = [path.join('tmp', 'subagents', subAgentId, 'keep.txt')];

      await session.close();

      assert.equal(fs.existsSync(junkFile), false);
      assert.equal(fs.existsSync(outputFile), true);
    } finally {
      fs.rmSync(workingDirectory, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean, maxAttempts = 40): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met in time');
}
