import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { ToolManager } from '../src/tools/tool-manager';
import {
  CatsCoMcpToolBridge,
  type McpBridgeCallResult,
  type McpBridgeClient,
  type McpBridgeEndpoint,
  type McpBridgeToolInfo,
} from '../src/mcp/mcp-tool-bridge';
import type { ToolExecutionContext } from '../src/types/tool';

class FakeClient implements McpBridgeClient {
  closed = false;
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly endpoints: McpBridgeEndpoint[] = [];

  constructor(
    private readonly listToolsFn: () => McpBridgeToolInfo[] | Promise<McpBridgeToolInfo[]>,
    private readonly callToolFn: (name: string, args: Record<string, unknown>) => McpBridgeCallResult,
  ) {}

  async listTools(): Promise<McpBridgeToolInfo[]> {
    return this.listToolsFn();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpBridgeCallResult> {
    this.calls.push({ name, args });
    return this.callToolFn(name, args);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function toolInfo(name: string, description?: string): McpBridgeToolInfo {
  return {
    name,
    description: description ?? `${name} 的描述`,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'object', description: '输入' },
        session_id: { type: 'string', description: '续聊会话 id' },
      },
      required: ['input'],
    },
  };
}

interface HarnessOptions {
  listTools?: () => McpBridgeToolInfo[] | Promise<McpBridgeToolInfo[]>;
  callTool?: (name: string, args: Record<string, unknown>) => McpBridgeCallResult;
  resolveEndpoint?: () => McpBridgeEndpoint | null;
  refreshIntervalMs?: number;
  runPollTimeoutMs?: number;
  runPollIntervalMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const manager = new ToolManager(process.cwd(), {}, { enabledToolNames: [] });
  const clients: FakeClient[] = [];
  const bridge = new CatsCoMcpToolBridge({
    toolManager: manager,
    createClient: endpoint => {
      const client = new FakeClient(
        options.listTools ?? (() => []),
        options.callTool ?? (() => ({ isError: false, contentText: '' })),
      );
      client.endpoints.push(endpoint);
      clients.push(client);
      return client;
    },
    resolveEndpoint: options.resolveEndpoint ?? (() => ({ url: 'https://app.catsco.cc/api/mcp', token: 'test-token' })),
    refreshIntervalMs: options.refreshIntervalMs ?? 0,
    runPollTimeoutMs: options.runPollTimeoutMs ?? 0,
    runPollIntervalMs: options.runPollIntervalMs ?? 1,
    sleep: async () => {},
  });
  return { bridge, manager, clients };
}

const context = {} as ToolExecutionContext;

describe('CatsCo MCP 工具桥', () => {
  test('refresh 只注册 catsco_ 前缀工具，并按下线 diff 注销', async () => {
    const state = { tools: [toolInfo('catsco_hello'), toolInfo('catsco_run_status'), toolInfo('github_search')] };
    const { bridge, manager } = createHarness({ listTools: () => state.tools });

    const first = await bridge.refresh();
    assert.ok(first);
    assert.deepStrictEqual(first.registered.sort(), ['catsco_hello', 'catsco_run_status']);
    assert.equal(manager.getTool('catsco_hello') !== undefined, true);
    assert.equal(manager.getTool('github_search'), undefined);

    const second = await bridge.refresh();
    assert.deepStrictEqual(second, { registered: [], unregistered: [] });

    state.tools = [toolInfo('catsco_world'), toolInfo('catsco_run_status')];
    const third = await bridge.refresh();
    assert.deepStrictEqual(third, { registered: ['catsco_world'], unregistered: ['catsco_hello'] });
    assert.equal(manager.getTool('catsco_hello'), undefined);
    assert.equal(manager.getTool('catsco_world') !== undefined, true);
  });

  test('completed：output.text 作为工具结果，附产物文件', async () => {
    const executedArgs: Array<Record<string, unknown>> = [];
    const { bridge, manager, clients } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      callTool: (_name, args) => {
        executedArgs.push(args);
        return {
          isError: false,
          contentText: 'run=r1 session=s1 status=completed',
          structured: {
            contract_version: 'catsco.service-run-result.v1',
            status: 'completed',
            run_id: 'r1',
            session_id: 's1',
            output: { text: '你好，我是 hello agent' },
            files: ['https://app.catsco.cc/f/1'],
          },
        };
      },
    });
    await bridge.refresh();

    const tool = manager.getTool('catsco_hello');
    assert.ok(tool);
    const result = await tool.execute({ input: { text: 'hi' }, session_id: 's0' }, context);
    assert.equal(result.ok, true);
    const content = (result as { content: string }).content;
    assert.match(content, /你好，我是 hello agent/);
    assert.match(content, /https:\/\/app\.catsco\.cc\/f\/1/);
    // 续聊凭据：completed 也给出 session_id、区分后续追问与新任务。
    assert.match(content, /续聊凭据 session_id=s1/);
    assert.match(content, /同一任务的后续追问请携带此 id 再次调用「catsco_hello」/);
    assert.match(content, /新任务请勿携带/);
    assert.match(content, /不要在回复中提及本行/);
    assert.deepStrictEqual(executedArgs, [{ input: { text: 'hi' }, session_id: 's0' }]);
    // 执行客户端（refresh 之后创建的那一个）必须被 close，释放平台会话。
    assert.equal(clients[clients.length - 1].closed, true);
    assert.equal(clients[0].closed, true);
  });

  test('completed 无 session_id：不输出续聊凭据行', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      callTool: () => ({
        isError: false,
        contentText: 'run=r0 status=completed',
        structured: { status: 'completed', run_id: 'r0', output: { text: '纯文本结果' } },
      }),
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(result.ok, true);
    const content = (result as { content: string }).content;
    assert.match(content, /纯文本结果/);
    assert.doesNotMatch(content, /续聊凭据/);
  });

  test('awaiting_input：返问文本 + session_id 续聊指引', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      callTool: () => ({
        isError: false,
        contentText: 'run=r2 session=s2 status=awaiting_input question=请补充邮箱',
        structured: {
          status: 'awaiting_input',
          run_id: 'r2',
          session_id: 's2',
          output: { question: '请补充邮箱' },
        },
      }),
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(result.ok, true);
    const content = (result as { content: string }).content;
    assert.match(content, /请补充邮箱/);
    assert.match(content, /s2/);
    assert.match(content, /catsco_hello/);
  });

  test('running 句柄：自动轮询 catsco_run_status 至终态', async () => {
    const callLog: string[] = [];
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello'), toolInfo('catsco_run_status')],
      callTool: (name, args) => {
        callLog.push(name);
        if (name === 'catsco_hello') {
          return {
            isError: false,
            contentText: 'run=r3 session=s3 status=running',
            structured: { status: 'running', run_id: 'r3', session_id: 's3' },
          };
        }
        assert.deepStrictEqual(args, { run_id: 'r3' });
        return {
          isError: false,
          contentText: 'run=r3 session=s3 status=completed',
          structured: { status: 'completed', run_id: 'r3', session_id: 's3', output: { text: '最终答复' } },
        };
      },
      runPollTimeoutMs: 500,
      runPollIntervalMs: 1,
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(result.ok, true);
    assert.match((result as { content: string }).content, /最终答复/);
    assert.deepStrictEqual(callLog, ['catsco_hello', 'catsco_run_status']);
  });

  test('running 超时：登记待补 run，带对话路由（onRunPending）', async () => {
    const pending: Array<Record<string, unknown>> = [];
    const manager = new ToolManager(process.cwd(), {}, { enabledToolNames: [] });
    const bridge = new CatsCoMcpToolBridge({
      toolManager: manager,
      createClient: () =>
        new FakeClient(
          () => [toolInfo('catsco_hello')],
          () => ({
            isError: false,
            contentText: 'run=r7 session=s7 status=running',
            structured: { status: 'running', run_id: 'r7', session_id: 's7' },
          }),
        ),
      resolveEndpoint: () => ({ url: 'https://app.catsco.cc/api/mcp', token: 't' }),
      refreshIntervalMs: 0,
      runPollTimeoutMs: 1,
      runPollIntervalMs: 1,
      sleep: async () => {},
      onRunPending: info => pending.push(info),
    });
    await bridge.refresh();

    const routedContext = {
      sessionId: 'catscompany:p2p_7_43',
      channel: { chatId: 'p2p_7_43', reply: async () => {} },
    } as unknown as ToolExecutionContext;
    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, routedContext);
    assert.equal(result.ok, true);
    // 轮询超时仍 running：登记一条待补（含本地会话路由 + 平台 session）。
    assert.equal(pending.length, 1);
    assert.deepStrictEqual(pending[0], {
      runId: 'r7',
      serviceSessionId: 's7',
      toolName: 'catsco_hello',
      conversationSessionKey: 'catscompany:p2p_7_43',
      conversationTopic: 'p2p_7_43',
    });
  });

  test('completed 不触发 onRunPending（只有仍在运行才登记）', async () => {
    const pending: Array<Record<string, unknown>> = [];
    const manager = new ToolManager(process.cwd(), {}, { enabledToolNames: [] });
    const bridge = new CatsCoMcpToolBridge({
      toolManager: manager,
      createClient: () =>
        new FakeClient(
          () => [toolInfo('catsco_hello')],
          () => ({
            isError: false,
            contentText: 'run=r8 session=s8 status=completed',
            structured: { status: 'completed', run_id: 'r8', session_id: 's8', output: { text: '好' } },
          }),
        ),
      resolveEndpoint: () => ({ url: 'https://app.catsco.cc/api/mcp', token: 't' }),
      refreshIntervalMs: 0,
      runPollTimeoutMs: 0,
      onRunPending: info => pending.push(info),
    });
    await bridge.refresh();

    await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(pending.length, 0);
  });

  test('catsco_run_status 自身不做轮询（避免自旋）', async () => {
    const callLog: string[] = [];
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_run_status')],
      callTool: name => {
        callLog.push(name);
        return {
          isError: false,
          contentText: 'run=r9 session=s9 status=running',
          structured: { status: 'running', run_id: 'r9', session_id: 's9' },
        };
      },
      runPollTimeoutMs: 500,
      runPollIntervalMs: 1,
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_run_status')!.execute({ run_id: 'r9' }, context);
    assert.equal(result.ok, true);
    assert.match((result as { content: string }).content, /仍在运行/);
    assert.deepStrictEqual(callLog, ['catsco_run_status']);
  });

  test('isError 结果映射为 ok:false 并附可读信息', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      callTool: () => ({ isError: true, contentText: 'subscription_required' }),
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(result.ok, false);
    const failure = result as { errorCode: string; message: string };
    assert.equal(failure.errorCode, 'subscription_required');
    assert.match(failure.message, /未添加该 Agent 工具/);
  });

  test('isError「码: 中文说明」（session_busy）：errorCode 取裸码，message 走策展文案', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      callTool: () => ({
        isError: true,
        contentText: 'session_busy: 同会话已有进行中的 run（可先查询 catsco_run_status）',
      }),
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(result.ok, false);
    const failure = result as { errorCode: string; message: string };
    assert.equal(failure.errorCode, 'session_busy');
    assert.match(failure.message, /已有进行中的运行/);
    assert.doesNotMatch(failure.message, /^远端工具返回错误/);
  });

  test('isError「码: 中文说明」（agent_not_subscribed）：映射为可操作的重新添加指引', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      callTool: () => ({
        isError: true,
        contentText: 'agent_not_subscribed: 该应用已从你的清单中移除（可在应用目录重新添加后再调用）',
      }),
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(result.ok, false);
    const failure = result as { errorCode: string; message: string };
    assert.equal(failure.errorCode, 'agent_not_subscribed');
    assert.match(failure.message, /重新添加/);
  });

  test('isError 未知码带说明：errorCode 取裸码，message 保留码与说明', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      callTool: () => ({ isError: true, contentText: 'some_new_code: 请稍后再试' }),
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(result.ok, false);
    const failure = result as { errorCode: string; message: string };
    assert.equal(failure.errorCode, 'some_new_code');
    assert.match(failure.message, /some_new_code/);
    assert.match(failure.message, /请稍后再试/);
  });

  test('协议级 unknown tool（-32602，工具被撤订阅/下线）：映射为可操作的重新添加指引，而非"无法连接"', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      callTool: () => {
        const error = Object.assign(new Error('MCP error -32602: unknown tool "catsco_hello"'), { code: -32602 });
        throw error;
      },
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(result.ok, false);
    const failure = result as { errorCode: string; message: string };
    assert.equal(failure.errorCode, 'catsco_mcp_tool_unlisted');
    assert.match(failure.message, /订阅清单/);
    assert.match(failure.message, /重新添加/);
    assert.doesNotMatch(failure.message, /无法连接/);
  });

  test('协议级 unknown tool（仅 message 无 code）：同样映射为重新添加指引', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      callTool: () => {
        throw new Error('MCP error -32602: unknown tool "catsco_hello"');
      },
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(result.ok, false);
    const failure = result as { errorCode: string; message: string };
    assert.equal(failure.errorCode, 'catsco_mcp_tool_unlisted');
  });

  test('failed 状态映射为 ok:false，携带 error 明细', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      callTool: () => ({
        isError: false,
        contentText: 'run=r4 session=s4 status=failed error=boom',
        structured: { status: 'failed', run_id: 'r4', session_id: 's4', error: 'boom' },
      }),
    });
    await bridge.refresh();

    const result = await manager.getTool('catsco_hello')!.execute({ input: {} }, context);
    assert.equal(result.ok, false);
    const failure = result as { errorCode: string; message: string };
    assert.equal(failure.errorCode, 'catsco_run_failed');
    assert.equal(failure.message, 'boom');
  });

  test('未登录（端点为 null）：刷新跳过、执行给出明确错误', async () => {
    const { bridge, clients } = createHarness({
      resolveEndpoint: () => null,
      listTools: () => [toolInfo('catsco_hello')],
    });
    assert.equal(await bridge.refresh(), null);
    assert.equal(clients.length, 0);
    assert.deepStrictEqual(bridge.getBridgedToolNames(), []);

    const result = await bridge.executeRemoteTool('catsco_hello', {});
    assert.equal(result.ok, false);
    assert.equal((result as { errorCode: string }).errorCode, 'catsco_mcp_not_configured');
  });

  test('刷新失败静默（后台不抛错），恢复后照常注册', async () => {
    let failing = true;
    const { bridge, manager } = createHarness({
      listTools: () => {
        if (failing) throw new Error('offline');
        return [toolInfo('catsco_hello')];
      },
    });
    bridge.refreshInBackground();
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.deepStrictEqual(bridge.getBridgedToolNames(), []);

    failing = false;
    const recovered = await bridge.refresh();
    assert.deepStrictEqual(recovered, { registered: ['catsco_hello'], unregistered: [] });
    assert.equal(manager.getTool('catsco_hello') !== undefined, true);
  });

  test('工具定义：描述补充用法指引，parameters 映射远端 inputSchema', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
    });
    await bridge.refresh();

    const definition = manager.getTool('catsco_hello')!.definition;
    assert.match(definition.description, /用法：input 传发给该 Agent 的输入/);
    // 委托偏向（dogfood A/B 实验入）：匹配领域时优先调用、不本地另做。
    assert.match(definition.description, /应优先调用本工具完成并以返回结果为准/);
    assert.match(definition.description, /不要用本地通用能力另做一份同类成品/);
    assert.match(definition.description, /同一任务的后续追问（含 awaiting_input 的补充、completed 之后的追问）/);
    assert.match(definition.description, /新任务不要携带 session_id/);
    assert.deepStrictEqual(definition.parameters, {
      type: 'object',
      properties: {
        input: { type: 'object', description: '输入' },
        session_id: { type: 'string', description: '续聊会话 id' },
      },
      required: ['input'],
    });
  });

  test('未登录不消耗刷新间隔：登录后立即刷新可完成同步', async () => {
    let endpoint: McpBridgeEndpoint | null = null;
    let listCalls = 0;
    const { bridge, manager } = createHarness({
      resolveEndpoint: () => endpoint,
      listTools: () => {
        listCalls += 1;
        return [toolInfo('catsco_hello')];
      },
      refreshIntervalMs: 60_000,
    });

    assert.equal(await bridge.refresh(), null);
    assert.equal(listCalls, 0);
    assert.equal(manager.getTool('catsco_hello'), undefined);

    // 同一节流窗口内登录：必须立即同步（不能因为未登录时的那次空转被节流）
    endpoint = { url: 'https://app.catsco.cc/api/mcp', token: 'fresh-token' };
    const synced = await bridge.refresh();
    assert.deepStrictEqual(synced?.registered, ['catsco_hello']);
    assert.equal(listCalls, 1);
    assert.equal(manager.getTool('catsco_hello') !== undefined, true);
  });

  test('并发 refresh 单飞：只发一次 listTools，返回同一结果', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let listCalls = 0;
    const { bridge } = createHarness({
      listTools: async () => {
        listCalls += 1;
        await gate;
        return [toolInfo('catsco_hello')];
      },
      refreshIntervalMs: 0,
    });

    const first = bridge.refresh();
    const second = bridge.refresh();
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(listCalls, 1);
    assert.strictEqual(a, b);
    assert.deepStrictEqual(a?.registered, ['catsco_hello']);
  });

  test('ensureReady：未登录时立即返回，不阻塞首轮', async () => {
    const { bridge } = createHarness({ resolveEndpoint: () => null });
    const started = Date.now();
    await bridge.ensureReady(3000);
    assert.ok(Date.now() - started < 500, '未登录时 ensureReady 应立即返回');
  });

  test('远端定义变化：同名工具按新描述/参数替换注册', async () => {
    const state = { description: '第一版描述' };
    const { bridge, manager } = createHarness({
      listTools: () => [{ ...toolInfo('catsco_hello'), description: state.description }],
    });

    await bridge.refresh();
    assert.match(String(manager.getTool('catsco_hello')?.definition.description), /第一版描述/);

    state.description = '第二版描述';
    const changed = await bridge.refresh();
    assert.deepStrictEqual(changed?.registered, ['catsco_hello']);
    assert.deepStrictEqual(changed?.unregistered, []);
    assert.match(String(manager.getTool('catsco_hello')?.definition.description), /第二版描述/);
  });

  test('run 轮询关闭（timeout<=0）：running 立即返回句柄，不查 run_status', async () => {
    let statusCalls = 0;
    const { bridge } = createHarness({
      listTools: () => [toolInfo('catsco_hello'), toolInfo('catsco_run_status')],
      callTool: name => {
        if (name === 'catsco_run_status') {
          statusCalls += 1;
          return { isError: false, contentText: '', structured: { status: 'completed', run_id: 'r1' } };
        }
        return {
          isError: false,
          contentText: '',
          structured: { status: 'running', run_id: 'r1', session_id: 's1' },
        };
      },
      runPollTimeoutMs: 0,
    });
    await bridge.refresh();

    const result = await bridge.executeRemoteTool('catsco_hello', { input: {} });
    assert.equal(result.ok, true);
    assert.match(String(result.content), /仍在运行/);
    assert.equal(statusCalls, 0);
  });

  test('端点解析抛错（本地配置损坏）：refresh 返回 null 不抛，执行给明确错误', async () => {
    const { bridge } = createHarness({
      resolveEndpoint: () => {
        throw new Error('catsco.json 损坏');
      },
    });

    assert.equal(await bridge.refresh(), null);
    await bridge.ensureReady(500);
    const result = await bridge.executeRemoteTool('catsco_hello', { input: {} });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'catsco_mcp_not_configured');
  });

  test('刷新间隔守卫：未到间隔直接跳过（不发网络请求）', async () => {    const { bridge, clients } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      refreshIntervalMs: 60_000,
    });
    const first = await bridge.refresh();
    assert.ok(first);
    assert.equal(await bridge.refresh(), null);
    assert.equal(clients.length, 1);
  });

  test('run_status 描述注明 run_id 用法', async () => {
    const { bridge, manager } = createHarness({
      listTools: () => [toolInfo('catsco_run_status')],
    });
    await bridge.refresh();
    const definition = manager.getTool('catsco_run_status')!.definition;
    assert.match(definition.description, /run_id 传 catsco_<slug> 返回的 run_id/);
  });

  test('ensureReady：等待在途刷新完成后再返回（首轮工具可见）', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { bridge, manager } = createHarness({
      listTools: () => gate.then(() => [toolInfo('catsco_hello')]),
    });

    bridge.refreshInBackground(); // 模拟 prewarm 在途
    let settled = false;
    const ready = bridge.ensureReady(2000).then(() => { settled = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false, 'ensureReady 不应在刷新完成前返回');

    release();
    await ready;
    assert.equal(settled, true);
    assert.deepStrictEqual(bridge.getBridgedToolNames(), ['catsco_hello']);
    assert.equal(manager.getTool('catsco_hello') !== undefined, true);
  });

  test('ensureReady：已同步完成后立即返回且不发新请求', async () => {
    const { bridge, clients } = createHarness({
      listTools: () => [toolInfo('catsco_hello')],
      refreshIntervalMs: 60_000,
    });
    await bridge.refresh();
    const started = Date.now();
    await bridge.ensureReady(2000);
    assert.ok(Date.now() - started < 500, 'ensureReady 应立即返回');
    assert.equal(clients.length, 1, '不应发起新的网络请求');
  });

  test('ensureReady：刷新超时则放弃等待，不阻塞首轮', async () => {
    const { bridge } = createHarness({
      // 200ms 后才失败：ensureReady(30) 应早于它返回。
      listTools: () => new Promise<McpBridgeToolInfo[]>((_resolve, reject) => {
        setTimeout(() => reject(new Error('slow network')), 200);
      }),
    });
    const started = Date.now();
    await bridge.ensureReady(30);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 150, `ensureReady 应在上限内返回（实测 ${elapsed}ms）`);
    await new Promise<void>(resolve => setTimeout(resolve, 250));
    assert.deepStrictEqual(bridge.getBridgedToolNames(), []);
    // bootstrap 已结算：后续调用不再挂等
    const second = Date.now();
    await bridge.ensureReady(2000);
    assert.ok(Date.now() - second < 100);
  });
});
