import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolManager } from '../src/tools/tool-manager';
import {
  McpClientManager,
  mcpToolName,
  mapCallResultContent,
} from '../src/mcp/mcp-client-manager';
import {
  McpPersistentClient,
  type McpCallToolResult,
  type McpConnection,
  type McpConnectionHooks,
  type McpRemoteToolInfo,
} from '../src/mcp/mcp-persistent-client';
import {
  adaptMcpNotification,
  mcpEventId,
} from '../src/mcp/mcp-notification-adapter';
import {
  expandEnvVars,
  parseServersTable,
  loadMcpConfig,
  McpConfigError,
  type McpServerConfig,
} from '../src/mcp/mcp-config';
import type { McpForwardedEvent, McpNotificationLike } from '../src/mcp/mcp-notification-adapter';
import type { ContentBlock } from '../src/types/index';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick();
  }
  assert.ok(predicate(), 'waitFor 超时');
}

// ---------------- 内存连接实现 ----------------

class FakeConnection implements McpConnection {
  tools: McpRemoteToolInfo[] = [];
  callToolResult: McpCallToolResult = { content: [{ type: 'text', text: 'ok' }] };
  callToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  subscribed: string[] = [];
  unsubscribed: string[] = [];
  resources: Array<{ uri: string; name?: string }> = [];
  prompts: Array<{ name: string; description?: string }> = [];
  promptResult: unknown = { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] };
  closed = false;
  ready?: Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  hooks: McpConnectionHooks;

  constructor(hooks: McpConnectionHooks, ready?: Promise<void>) {
    this.hooks = hooks;
    this.ready = ready;
  }

  emit(method: string, params?: unknown): void {
    this.hooks.onNotification?.({ method, params });
  }

  drop(): void {
    this.onclose?.();
  }

  async listTools() {
    return { tools: this.tools };
  }
  async callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallToolResult> {
    this.callToolCalls.push({ name: params.name, args: params.arguments ?? {} });
    return this.callToolResult;
  }
  async listResources() {
    return { resources: this.resources };
  }
  async readResource(params: { uri: string }) {
    return { contents: [{ uri: params.uri, text: 'resource-text', mimeType: 'text/plain' }] };
  }
  async subscribeResource(params: { uri: string }) {
    this.subscribed.push(params.uri);
    return {};
  }
  async unsubscribeResource(params: { uri: string }) {
    this.unsubscribed.push(params.uri);
    return {};
  }
  async listPrompts() {
    return { prompts: this.prompts };
  }
  async getPrompt() {
    return this.promptResult;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const stdioCfg: McpServerConfig = { transport: 'stdio', command: 'fake-server' };
const httpCfg: McpServerConfig = { transport: 'streamable-http', url: 'https://mcp.example.com/mcp', bearerToken: 'tok' };

interface ClientHarness {
  client: McpPersistentClient;
  connections: FakeConnection[];
  notifications: McpNotificationLike[];
  states: Array<{ state: string; attempt: number }>;
  failNextConnects: number;
  latest(): FakeConnection;
}

function createClientHarness(
  serverId = 'srv',
  config: McpServerConfig = stdioCfg,
  overrides: Partial<ConstructorParameters<typeof McpPersistentClient>[0]> = {},
): ClientHarness {
  const harness: ClientHarness = {
    connections: [],
    notifications: [],
    states: [],
    failNextConnects: 0,
    client: undefined as unknown as McpPersistentClient,
    latest() {
      const last = harness.connections[harness.connections.length - 1];
      assert.ok(last, '尚未创建连接');
      return last;
    },
  };
  harness.client = new McpPersistentClient({
    serverId,
    config,
    createConnection: (_cfg, hooks) => {
      let ready: Promise<void> | undefined;
      if (harness.failNextConnects > 0) {
        harness.failNextConnects -= 1;
        ready = Promise.reject(new Error('connect failed'));
      }
      const conn = new FakeConnection(hooks, ready);
      harness.connections.push(conn);
      return conn;
    },
    onNotification: n => harness.notifications.push(n),
    onStateChange: (state, info) => harness.states.push({ state, attempt: info.attempt }),
    reconnect: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5, factor: 2, jitter: 0 },
    sleep: async () => {},
    ...overrides,
  });
  return harness;
}

function toolInfo(name: string, description?: string): McpRemoteToolInfo {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'query' } },
      required: ['q'],
    },
  };
}

// ---------------- 配置 ----------------

describe('mcp-config', () => {
  test('展开 ${VAR} 与 ${VAR:-fallback}', () => {
    const env = { TOKEN: 'abc' } as NodeJS.ProcessEnv;
    assert.equal(expandEnvVars('x-${TOKEN}-y', env), 'x-abc-y');
    assert.equal(expandEnvVars('${MISSING:-dflt}', env), 'dflt');
    assert.throws(() => expandEnvVars('${MISSING}', env), McpConfigError);
  });

  test('校验 stdio 与 streamable-http，transport 可推断', () => {
    const servers = parseServersTable({
      mcpServers: {
        fs: { transport: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], env: { A: '1' }, cwd: '/tmp' },
        web: { url: 'https://mcp.example.com/mcp', bearerToken: 'tok', timeoutMs: 5000 },
      },
    });
    assert.equal(servers.fs.transport, 'stdio');
    assert.equal(servers.web.transport, 'streamable-http');
    assert.equal((servers.web as any).url, 'https://mcp.example.com/mcp');
  });

  test('非法配置聚合报错', () => {
    assert.throws(
      () => parseServersTable({ servers: { bad: { transport: 'stdio' }, 'bad id!': { transport: 'stdio', command: 'x' } } }),
      McpConfigError,
    );
  });

  test('loadMcpConfig 读文件并展开 env，XIAOBA_MCP_SERVERS 可补充', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-'));
    const file = path.join(dir, 'servers.json');
    fs.writeFileSync(file, JSON.stringify({
      mcpServers: {
        fs: { transport: 'stdio', command: 'srv', env: { KEY: '${MY_KEY}' } },
      },
    }));
    const env = {
      MY_KEY: 'secret',
      XIAOBA_MCP_SERVERS: JSON.stringify({ mcpServers: { remote: { url: 'https://x.example/mcp' } } }),
    } as NodeJS.ProcessEnv;
    const cfg = loadMcpConfig({ path: file, env });
    assert.deepEqual(Object.keys(cfg.servers).sort(), ['fs', 'remote']);
    assert.equal((cfg.servers.fs as any).env.KEY, 'secret');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('文件不存在且不强制时返回空表', () => {
    const cfg = loadMcpConfig({ path: '/nonexistent/mcp.json', env: {} as NodeJS.ProcessEnv });
    assert.deepEqual(cfg.servers, {});
  });
});

// ---------------- 通知适配 ----------------

describe('mcp-notification-adapter', () => {
  test('标准通知映射 type/priority 与路由字段', () => {
    const event = adaptMcpNotification('srv', {
      method: 'notifications/resources/updated',
      params: { uri: 'file:///a.txt', _meta: { sessionKey: 's1', topic: 't1' } },
    });
    assert.equal(event.source, 'mcp');
    assert.equal(event.type, 'resources/updated');
    assert.equal(event.method, 'notifications/resources/updated');
    assert.equal(event.artifactId, 'file:///a.txt');
    assert.equal(event.sessionKey, 's1');
    assert.equal(event.topic, 't1');
    assert.equal(event.priority, 'normal');
    assert.ok(event.eventId.startsWith('mcp:srv:'));
  });

  test('显式 event_id 优先，同一通知幂等', () => {
    const n1 = { method: 'notifications/x', params: { event_id: 'e-1' } };
    const n2 = { method: 'notifications/x', params: { event_id: 'e-1' } };
    assert.equal(mcpEventId('srv', n1.method, n1.params), 'mcp:srv:e-1');
    assert.equal(adaptMcpNotification('srv', n1).eventId, adaptMcpNotification('srv', n2).eventId);
  });

  test('相同 payload 生成稳定指纹，不同 server 指纹不同', () => {
    const params = { b: 1, a: 'x' };
    const id1 = mcpEventId('srv', 'notifications/progress', params);
    const id2 = mcpEventId('srv', 'notifications/progress', { a: 'x', b: 1 });
    const id3 = mcpEventId('other', 'notifications/progress', params);
    assert.equal(id1, id2);
    assert.notEqual(id1, id3);
  });

  test('未识别的扩展通知走兜底（为 events/* 预留）', () => {
    const event = adaptMcpNotification('srv', {
      method: 'notifications/experimental/custom',
      params: { artifactId: 'art-9', foo: 'bar' },
    });
    assert.equal(event.type, 'experimental/custom');
    assert.equal(event.artifactId, 'art-9');
    assert.equal(event.priority, 'normal');
    assert.deepEqual(event.payload, { artifactId: 'art-9', foo: 'bar' });
  });

  test('error 类方法升为 critical', () => {
    const event = adaptMcpNotification('srv', { method: 'notifications/task/error' });
    assert.equal(event.priority, 'critical');
  });
});

// ---------------- 长连接客户端 ----------------

describe('mcp-persistent-client', () => {
  test('connect 幂等并维持长连接', async () => {
    const h = createClientHarness();
    await h.client.connect();
    await h.client.connect();
    assert.equal(h.connections.length, 1);
    assert.equal(h.client.getState(), 'connected');
  });

  test('断连后按退避自动重连，恢复订阅，事件链完整', async () => {
    const h = createClientHarness();
    await h.client.connect();
    const first = h.latest();
    await h.client.subscribeResource('res://one');
    assert.deepEqual(first.subscribed, ['res://one']);

    first.drop();
    await waitFor(() => h.client.getState() === 'connected' && h.connections.length === 2);
    const second = h.latest();
    // 重连成功后自动恢复订阅
    assert.deepEqual(second.subscribed, ['res://one']);
    // 状态链包含 reconnecting
    assert.ok(h.states.some(s => s.state === 'reconnecting'));
  });

  test('首次连接失败按重试预算重连，最终成功', async () => {
    const h = createClientHarness();
    h.failNextConnects = 2;
    await h.client.connect();
    assert.equal(h.client.getState(), 'connected');
    assert.equal(h.connections.length, 3);
  });

  test('重试耗尽抛错并落 failed，之后仍可手动 connect', async () => {
    const h = createClientHarness();
    h.failNextConnects = 3;
    await assert.rejects(h.client.connect(), /连接失败/);
    assert.equal(h.client.getState(), 'failed');
    // 恢复后可再次连接
    await h.client.connect();
    assert.equal(h.client.getState(), 'connected');
  });

  test('通知经 hooks 上抛（含未识别方法的兜底语义在适配层）', async () => {
    const h = createClientHarness();
    await h.client.connect();
    h.latest().emit('notifications/tools/list_changed', {});
    h.latest().emit('notifications/experimental/event', { a: 1 });
    assert.equal(h.notifications.length, 2);
    assert.equal(h.notifications[1].method, 'notifications/experimental/event');
  });

  test('close 后不再重连', async () => {
    const h = createClientHarness();
    await h.client.connect();
    const conn = h.latest();
    await h.client.close();
    conn.drop(); // 过期连接的 onclose 不应再触发重连
    await tick(); await tick();
    assert.equal(h.client.getState(), 'closed');
    assert.equal(h.connections.length, 1);
    assert.ok(conn.closed);
  });
});

// ---------------- 工具结果映射 ----------------

describe('mapCallResultContent', () => {
  test('纯文本退化为字符串拼接', () => {
    const out = mapCallResultContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
    assert.equal(out, 'a\nb');
  });

  test('image/audio/resource/structuredContent 多模态保留', () => {
    const blocks = mapCallResultContent(
      [
        { type: 'text', text: 'desc' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'audio', data: 'AA==', mimeType: 'audio/mp3' },
        { type: 'resource', resource: { uri: 'file:///x', text: 'inner', mimeType: 'text/plain' } },
      ],
      { structured: true },
    ) as ContentBlock[];
    assert.ok(Array.isArray(blocks));
    assert.equal(blocks[0].type, 'text');
    const image = blocks[1];
    assert.equal(image.type, 'image');
    if (image.type === 'image') {
      assert.equal(image.source.media_type, 'image/png');
      assert.equal(image.source.data, 'aGk=');
    }
    assert.ok(JSON.stringify(blocks[2]).includes('audio'));
    assert.ok(JSON.stringify(blocks[3]).includes('resource'));
    assert.ok(JSON.stringify(blocks[4]).includes('structuredContent'));
  });
});

// ---------------- 管理器 ----------------

describe('mcp-client-manager', () => {
  function createManagerHarness(opts: {
    servers?: Record<string, McpServerConfig>;
    onEvent?: (e: McpForwardedEvent) => void;
  } = {}) {
    const manager = new ToolManager(process.cwd(), {}, { enabledToolNames: [] });
    const connections = new Map<string, FakeConnection[]>();
    const events: McpForwardedEvent[] = [];
    const mcpManager = new McpClientManager({
      toolManager: manager,
      servers: opts.servers,
      createConnection: (config, hooks) => {
        const conn = new FakeConnection(hooks);
        const key = config.transport === 'stdio' ? `stdio:${config.command}` : `http:${config.url}`;
        const list = connections.get(key) ?? [];
        list.push(conn);
        connections.set(key, list);
        return conn;
      },
      onEvent: opts.onEvent ?? (e => events.push(e)),
      reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5, jitter: 0 },
      sleep: async () => {},
    });
    const connOf = (key: string) => {
      const list = connections.get(key);
      assert.ok(list && list.length > 0, `尚无连接 ${key}`);
      return list[list.length - 1];
    };
    return { manager, mcpManager, connections, events, connOf };
  }

  test('多 server 管理：连接、工具按 mcp_<id>_<name> 注册', async () => {
    const { manager, mcpManager, connOf } = createManagerHarness({
      servers: { fs: stdioCfg, remote: httpCfg },
    });
    mcpManager.start();
    await mcpManager.waitForInitialConnect();

    connOf('stdio:fake-server').tools = [toolInfo('read_file')];
    connOf('http:https://mcp.example.com/mcp').tools = [toolInfo('search'), toolInfo('odd.name v2')];

    const r1 = await mcpManager.refreshServerTools('fs');
    const r2 = await mcpManager.refreshServerTools('remote');
    assert.deepEqual(r1.registered, ['mcp_fs_read_file']);
    assert.deepEqual(r2.registered.sort(), ['mcp_remote_odd_name_v2', 'mcp_remote_search']);
    assert.ok(manager.getTool('mcp_fs_read_file'));
    assert.ok(manager.getTool('mcp_remote_search'));
    assert.equal(mcpToolName('s', 'a.b/c d'), 'mcp_s_a_b_c_d');
  });

  test('tools/list_changed 触发增量 diff 刷新 + 事件转发', async () => {
    const { manager, mcpManager, connOf, events } = createManagerHarness({ servers: { fs: stdioCfg } });
    mcpManager.start();
    await mcpManager.waitForInitialConnect();
    const conn = connOf('stdio:fake-server');
    conn.tools = [toolInfo('a')];
    await mcpManager.refreshServerTools('fs');
    assert.ok(manager.getTool('mcp_fs_a'));

    // 服务端新增 b、下线 a
    conn.tools = [toolInfo('b')];
    conn.emit('notifications/tools/list_changed', {});
    await waitFor(() => manager.getTool('mcp_fs_b') !== undefined);
    assert.equal(manager.getTool('mcp_fs_a'), undefined);
    const evt = events.find(e => e.method === 'notifications/tools/list_changed');
    assert.ok(evt);
    assert.equal(evt!.serverId, 'fs');
    assert.equal(evt!.priority, 'high');
  });

  test('定义不变时不重复注册（幂等 diff）', async () => {
    const { mcpManager, connOf } = createManagerHarness({ servers: { fs: stdioCfg } });
    mcpManager.start();
    await mcpManager.waitForInitialConnect();
    connOf('stdio:fake-server').tools = [toolInfo('a')];
    const first = await mcpManager.refreshServerTools('fs');
    const second = await mcpManager.refreshServerTools('fs');
    assert.equal(first.registered.length, 1);
    assert.equal(second.registered.length, 0);
  });

  test('远端工具调用映射参数与结果', async () => {
    const { manager, mcpManager, connOf } = createManagerHarness({ servers: { fs: stdioCfg } });
    mcpManager.start();
    await mcpManager.waitForInitialConnect();
    const conn = connOf('stdio:fake-server');
    conn.tools = [toolInfo('search')];
    conn.callToolResult = {
      content: [
        { type: 'text', text: 'found' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      ],
    };
    await mcpManager.refreshServerTools('fs');
    const result = await manager.executeTool({
      id: 'call-1',
      type: 'function',
      function: { name: 'mcp_fs_search', arguments: JSON.stringify({ q: 'hello' }) },
    });
    assert.ok(result.ok);
    assert.deepEqual(conn.callToolCalls, [{ name: 'search', args: { q: 'hello' } }]);
    assert.ok(Array.isArray(result.content));
  });

  test('远端 isError → ok:false', async () => {
    const { manager, mcpManager, connOf } = createManagerHarness({ servers: { fs: stdioCfg } });
    mcpManager.start();
    await mcpManager.waitForInitialConnect();
    const conn = connOf('stdio:fake-server');
    conn.tools = [toolInfo('boom')];
    conn.callToolResult = { isError: true, content: [{ type: 'text', text: 'kaboom' }] };
    await mcpManager.refreshServerTools('fs');
    const result = await manager.executeTool({
      id: 'call-2',
      type: 'function',
      function: { name: 'mcp_fs_boom', arguments: '{}' },
    });
    assert.equal(result.ok, false);
    assert.ok(String(result.content).includes('kaboom'));
  });

  test('断线重连：工具面保留，重连后重新刷新', async () => {
    const { manager, mcpManager, connections } = createManagerHarness({ servers: { fs: stdioCfg } });
    mcpManager.start();
    await mcpManager.waitForInitialConnect();
    const first = connections.get('stdio:fake-server')![0];
    first.tools = [toolInfo('a')];
    await mcpManager.refreshServerTools('fs');
    assert.ok(manager.getTool('mcp_fs_a'));

    first.drop();
    await waitFor(() => (connections.get('stdio:fake-server')?.length ?? 0) === 2);
    const second = connections.get('stdio:fake-server')![1];
    // 重连后的自动刷新可能在 tools 就绪前已跑过一轮 —— 显式发 list_changed 触发确定性刷新。
    second.tools = [toolInfo('b')];
    second.emit('notifications/tools/list_changed', {});
    await waitFor(() => manager.getTool('mcp_fs_b') !== undefined);
    assert.equal(manager.getTool('mcp_fs_a'), undefined);
  });

  test('resources/subscribe 与 prompts 透传到长连接', async () => {
    const { mcpManager, connOf } = createManagerHarness({ servers: { fs: stdioCfg } });
    mcpManager.start();
    await mcpManager.waitForInitialConnect();
    const client = mcpManager.getClient('fs')!;
    await client.subscribeResource('res://x');
    assert.deepEqual(connOf('stdio:fake-server').subscribed, ['res://x']);
    const prompt = await client.getPrompt('greet', { name: 'n' });
    assert.ok(prompt);
    const resource = await client.readResource('res://x');
    assert.equal(resource.contents[0].text, 'resource-text');
    await client.unsubscribeResource('res://x');
    assert.deepEqual(connOf('stdio:fake-server').unsubscribed, ['res://x']);
  });

  test('removeServer 注销工具并关闭连接；closeAll 清空', async () => {
    const { manager, mcpManager, connOf } = createManagerHarness({
      servers: { fs: stdioCfg, remote: httpCfg },
    });
    mcpManager.start();
    await mcpManager.waitForInitialConnect();
    connOf('stdio:fake-server').tools = [toolInfo('a')];
    await mcpManager.refreshServerTools('fs');
    assert.ok(manager.getTool('mcp_fs_a'));

    await mcpManager.removeServer('fs');
    assert.equal(manager.getTool('mcp_fs_a'), undefined);
    assert.ok(connOf('stdio:fake-server').closed);
    assert.deepEqual(mcpManager.serverIds(), ['remote']);

    await mcpManager.closeAll();
    assert.deepEqual(mcpManager.serverIds(), []);
  });

  test('status() 汇总各 server 状态', async () => {
    const { mcpManager } = createManagerHarness({ servers: { fs: stdioCfg, remote: httpCfg } });
    mcpManager.start();
    await mcpManager.waitForInitialConnect();
    const status = mcpManager.status();
    assert.equal(status.length, 2);
    const fsStatus = status.find(s => s.serverId === 'fs')!;
    assert.equal(fsStatus.state, 'connected');
    assert.equal(fsStatus.transport, 'stdio');
  });
});
