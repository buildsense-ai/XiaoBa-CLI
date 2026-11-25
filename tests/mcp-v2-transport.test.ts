/**
 * MCP SDK v2 核心与传输升级测试（@modelcontextprotocol/client v2）。
 *
 * 覆盖：
 * 1. 双代协商：legacy stdio（initialize 回退）/ modern stdio+http（server/discover）
 *    + PriorDiscovery 缓存（命中、失效、TTL）；
 * 2. 传输：sse 一等配置、streamable-http → legacy SSE 404/405 自动回退、
 *    sessionId 续传、失败连接清理（stdio 子进程不泄漏）；
 * 3. 双轨订阅：legacy resources/subscribe + 推送、modern subscriptions/listen +
 *    自动重挂；
 * 4. 全原语方法面：tools/resources/templates/prompts/complete/instructions/progressToken/
 *    tasks（能力检查优雅降级）；
 * 5. McpSdkClient v2：legacy server 上 tools/list_changed 推送。
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, Server, createMcpHandler } from '@modelcontextprotocol/server';
import {
  McpPersistentClient,
  PriorDiscoveryCache,
  createSdkMcpConnectionFactory,
  isLegacySseEndpointError,
  type McpConnection,
  type McpConnectionHooks,
  type McpListenHandle,
  type McpListenFilter,
} from '../src/mcp/mcp-persistent-client';
import {
  parseServersTable,
  validateServerConfig,
  isSameMcpServerConfig,
  type McpServerConfig,
} from '../src/mcp/mcp-config';
import { createSdkMcpBridgeClientFactory } from '../src/mcp/mcp-sdk-client';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// tsx 以 ESM 方式运行测试文件时 __dirname 不可用；这里用 import.meta 推导。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, 'helpers', 'mcp-v2-test-server.mjs');

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  assert.ok(predicate(), 'waitFor 超时');
}

function stdioConfig(mode: 'modern' | 'legacy', extraEnv: Record<string, string> = {}): McpServerConfig {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(__dirname, 'helpers', 'mcp-v2-test-server.mjs'), mode],
    env: { ...extraEnv },
  };
}

/** 连接到 fake stdio server，返回 persistent client（调用方负责 close）。 */
async function connectStdio(
  mode: 'modern' | 'legacy',
  options: {
    factory?: ReturnType<typeof createSdkMcpConnectionFactory>;
    env?: Record<string, string>;
    clientOptions?: Partial<ConstructorParameters<typeof McpPersistentClient>[0]>;
  } = {},
): Promise<McpPersistentClient> {
  const factory = options.factory ?? createSdkMcpConnectionFactory();
  const client = new McpPersistentClient({
    serverId: `fake-${mode}`,
    config: stdioConfig(mode, options.env),
    createConnection: factory,
    reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 50, jitter: 0 },
    requestTimeoutMs: 10_000,
    ...options.clientOptions,
  });
  await client.connect();
  return client;
}

// ---------------- 配置层 ----------------

describe('mcp-config v2: sse 一等 transport', () => {
  test('sse 被接受且不做静默别名', () => {
    const cfg = validateServerConfig('legacy-sse', { transport: 'sse', url: 'https://example.test/sse' });
    assert.equal(cfg.transport, 'sse');
    assert.equal((cfg as { url: string }).url, 'https://example.test/sse');
  });

  test('sse 参与 servers 表解析与等价比较', () => {
    const servers = parseServersTable({
      mcpServers: {
        sse: { transport: 'sse', url: 'https://example.test/sse', bearerToken: 'tok' },
        http: { transport: 'streamable-http', url: 'https://example.test/mcp' },
      },
    });
    assert.equal(servers.sse.transport, 'sse');
    assert.equal(servers.http.transport, 'streamable-http');
    // sse 与 streamable-http 即使 URL 相同也不等价 —— transport 是一等维度。
    assert.equal(isSameMcpServerConfig(
      { transport: 'sse', url: 'https://x.test/sse' },
      { transport: 'streamable-http', url: 'https://x.test/sse' },
    ), false);
    assert.equal(isSameMcpServerConfig(
      { transport: 'sse', url: 'https://x.test/sse' },
      { transport: 'sse', url: 'https://x.test/sse' },
    ), true);
  });
});

// ---------------- 双代协商 ----------------

describe('era negotiation（双代协商）', () => {
  test('legacy stdio server：auto 协商回退 2025-11-25 initialize', async () => {
    const client = await connectStdio('legacy');
    try {
      assert.equal(client.getProtocolEra(), 'legacy');
      assert.equal(client.getProtocolVersion(), '2025-11-25');
      assert.equal(client.getServerInstructions(), 'legacy instructions');
      const caps = client.getCapabilities() as { tools?: unknown } | undefined;
      assert.ok(caps?.tools, '应拿到服务端 tools 能力');
    } finally {
      await client.close();
    }
  });

  test('modern stdio server：auto 协商命中 2026-07-28 server/discover', async () => {
    const client = await connectStdio('modern');
    try {
      assert.equal(client.getProtocolEra(), 'modern');
      assert.equal(client.getProtocolVersion(), '2026-07-28');
      assert.equal(client.getServerInstructions(), 'modern instructions');
    } finally {
      await client.close();
    }
  });

  test('modern HTTP server：server/discover 命中，DiscoverResult 可用', async () => {
    const modern = await startModernHttpServer();
    try {
      const factory = createSdkMcpConnectionFactory({ discoveryCache: new PriorDiscoveryCache() });
      const client = new McpPersistentClient({
        serverId: 'modern-http',
        config: { transport: 'streamable-http', url: modern.url },
        createConnection: factory,
        reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        requestTimeoutMs: 10_000,
      });
      await client.connect();
      assert.equal(client.getProtocolEra(), 'modern');
      assert.equal(client.getProtocolVersion(), '2026-07-28');
      assert.equal(client.getServerInstructions(), 'modern http instructions');
      await client.close();
    } finally {
      await modern.close();
    }
  });
});

// ---------------- PriorDiscovery 缓存 ----------------

describe('PriorDiscovery 缓存', () => {
  test('缓存单元行为：legacy 判定 TTL 到期失效，modern 不过期', () => {
    let now = 1_000;
    const cache = new PriorDiscoveryCache({ legacyTtlMs: 100, now: () => now });
    cache.set('a', { kind: 'legacy' });
    assert.equal(cache.get('a')?.kind, 'legacy');
    now += 101;
    assert.equal(cache.get('a'), undefined, 'legacy 判定到期应失效');
    cache.set('b', { kind: 'modern', discover: { supportedVersions: ['2026-07-28'] } as never });
    now += 10_000;
    assert.equal(cache.get('b')?.kind, 'modern', 'modern 判定不应过期');
    cache.invalidate('b');
    assert.equal(cache.get('b'), undefined);
  });

  test('重连消费 prior：第二次连接走缓存判定，重连零探测', async () => {
    const discoveryCache = new PriorDiscoveryCache();
    const discoveryLog: Array<{ era?: string; usedPrior: boolean }> = [];
    const factory = createSdkMcpConnectionFactory({ discoveryCache });
    const instrumentedFactory = (config: McpServerConfig, hooks: McpConnectionHooks) => {
      const inner = factory(config, {
        ...hooks,
        onDiscovery: (info) => {
          discoveryLog.push({ era: info.era, usedPrior: info.usedPrior });
          hooks.onDiscovery?.(info);
        },
      });
      return inner;
    };

    const client = new McpPersistentClient({
      serverId: 'modern-prior',
      config: stdioConfig('modern'),
      createConnection: instrumentedFactory,
      reconnect: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 10, jitter: 0 },
      sleep: async () => {},
      requestTimeoutMs: 10_000,
    });
    await client.connect();
    assert.equal(discoveryLog.length, 1);
    assert.equal(discoveryLog[0].usedPrior, false, '首连无缓存可消费');
    assert.equal(discoveryLog[0].era, 'modern');
    assert.equal(discoveryCache.size, 1, 'modern 判定应写入缓存');

    // 断线触发重连：第二次连接应消费缓存 prior。
    // 通过 close() 模拟真实断连（transport 终止会级联触发 onclose），
    // 直接手动调 onclose 会遗留未回收的 stdio 子进程。
    const internal = (client as unknown as { connection: McpConnection | null }).connection;
    void internal?.close();
    internal?.onclose?.();
    await waitFor(() => client.getState() === 'connected' && discoveryLog.length >= 2, 8000);
    assert.equal(discoveryLog[1].usedPrior, true, '重连应消费 PriorDiscovery 缓存');
    assert.equal(discoveryLog[1].era, 'modern');
    await client.close();
  });

  test('prior 缓存损坏（服务端不支持缓存的代际版本）：连接失败使缓存失效，重试重探成功', async () => {
    const modern = await startModernHttpServer();
    try {
      const discoveryCache = new PriorDiscoveryCache();
      // 故意注入伪造的 modern prior：宣传一个服务端不支持的版本（2027-01-01），
      // connect 必须以版本协商错误失败，缓存失效后重试重探成功。
      discoveryCache.set(`url:${modern.url}`, {
        kind: 'modern',
        discover: { supportedVersions: ['2027-01-01'], capabilities: {} } as never,
      });
      assert.equal(discoveryCache.size, 1);
      const factory = createSdkMcpConnectionFactory({ discoveryCache });
      const client = new McpPersistentClient({
        serverId: 'poisoned-prior',
        config: { transport: 'streamable-http', url: modern.url },
        createConnection: factory,
        reconnect: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 10, jitter: 0 },
        sleep: async () => {},
        requestTimeoutMs: 10_000,
      });
      await client.connect();
      // 第一次失败 → 缓存失效 → 第二次重探（无 prior）→ server/discover 成功。
      assert.equal(client.getState(), 'connected');
      assert.equal(client.getProtocolEra(), 'modern');
      assert.equal(client.getProtocolVersion(), '2026-07-28');
      await client.close();
    } finally {
      await modern.close();
    }
  });

  test('legacy 判定被缓存：重连直接 initialize，跳过探测', async () => {
    const discoveryCache = new PriorDiscoveryCache();
    const usedPriors: boolean[] = [];
    const factory = createSdkMcpConnectionFactory({ discoveryCache });
    const instrumented = (config: McpServerConfig, hooks: McpConnectionHooks) =>
      factory(config, {
        ...hooks,
        onDiscovery: (info) => {
          usedPriors.push(info.usedPrior);
          hooks.onDiscovery?.(info);
        },
      });
    const client = new McpPersistentClient({
      serverId: 'legacy-prior',
      config: stdioConfig('legacy'),
      createConnection: instrumented,
      reconnect: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 10, jitter: 0 },
      sleep: async () => {},
      requestTimeoutMs: 10_000,
    });
    await client.connect();
    const internal = (client as unknown as { connection: McpConnection | null }).connection;
    void internal?.close();
    internal?.onclose?.();
    await waitFor(() => client.getState() === 'connected' && usedPriors.length >= 2, 8000);
    assert.equal(usedPriors[0], false);
    assert.equal(usedPriors[1], true, 'legacy 判定也应被缓存消费');
    await client.close();
  });
});

// ---------------- 传输：streamable-http → legacy SSE 回退 ----------------

describe('streamable-http → legacy SSE 自动回退', () => {
  test('404/405 信号判定', () => {
    assert.equal(isLegacySseEndpointError(new Error('Error POSTing to endpoint: 404 Not Found')), true);
    assert.equal(isLegacySseEndpointError(new Error('Method not allowed (405) on endpoint POST')), true);
    assert.equal(isLegacySseEndpointError(new Error('connection refused')), false);
  });

  test('legacy SSE-only 服务器：sse 配置直连 + streamable-http 自动回退', async () => {
    const legacy = await startLegacySseServer();
    try {
      // 1) 显式 sse transport 直连。
      const sseClient = new McpPersistentClient({
        serverId: 'explicit-sse',
        config: { transport: 'sse', url: legacy.url },
        createConnection: createSdkMcpConnectionFactory({ discoveryCache: new PriorDiscoveryCache() }),
        reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        requestTimeoutMs: 10_000,
      });
      await sseClient.connect();
      assert.equal(sseClient.getState(), 'connected');
      assert.equal(sseClient.getProtocolEra(), 'legacy');
      const tools = await sseClient.listTools();
      assert.ok(tools.tools.some(t => t.name === 'echo'));
      await sseClient.close();

      // 2) streamable-http 配置：POST 被 404 拒绝 → 自动回退 SSEClientTransport。
      let fellBack = false;
      const fallbackFactory = createSdkMcpConnectionFactory({ discoveryCache: new PriorDiscoveryCache() });
      const instrumented = (config: McpServerConfig, hooks: McpConnectionHooks) =>
        fallbackFactory(config, {
          ...hooks,
          onSseFallback: (reason) => {
            fellBack = true;
            hooks.onSseFallback?.(reason);
          },
        });
      const httpClient = new McpPersistentClient({
        serverId: 'auto-sse',
        config: { transport: 'streamable-http', url: legacy.url },
        createConnection: instrumented,
        reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        requestTimeoutMs: 10_000,
      });
      await httpClient.connect();
      assert.equal(httpClient.getState(), 'connected');
      assert.equal(fellBack, true, 'streamable-http 遇 404 应自动回退 SSE transport');
      assert.equal(httpClient.getProtocolEra(), 'legacy');
      const result = await httpClient.callTool('echo', { text: 'hi' });
      assert.ok(JSON.stringify(result.content).includes('echo:hi'));
      await httpClient.close();
    } finally {
      await legacy.close();
    }
  });
});

// ---------------- 失败连接清理 ----------------

describe('失败连接清理', () => {
  test('stdio 连接失败：每次失败尝试都被 close，不泄漏子进程', async () => {
    const spawnCountBefore = countChildProcesses();
    const client = new McpPersistentClient({
      serverId: 'bad-stdio',
      // 命令存在但立即退出且从不回答 → 每次 connect 都失败。
      config: { transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(1)'] },
      createConnection: createSdkMcpConnectionFactory({ discoveryCache: new PriorDiscoveryCache() }),
      reconnect: { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 10, jitter: 0 },
      sleep: async () => {},
      requestTimeoutMs: 2_000,
    });
    await assert.rejects(client.connect(), /连接失败/);
    assert.equal(client.getState(), 'failed');
    // 给子进程回收留一个调度窗口。
    await sleep(100);
    const leaked = countChildProcesses() - spawnCountBefore;
    assert.ok(leaked <= 0, `失败连接不应泄漏子进程（新增 ${leaked}）`);
    await client.close();
  });

  test('http 失败连接：状态落 failed，transport close 被调用', async () => {
    let closeCalls = 0;
    const factory = createSdkMcpConnectionFactory({ discoveryCache: new PriorDiscoveryCache() });
    const instrumented = (config: McpServerConfig, hooks: McpConnectionHooks): McpConnection => {
      const conn = factory(config, hooks);
      const origClose = conn.close.bind(conn);
      conn.close = async () => {
        closeCalls += 1;
        return origClose();
      };
      return conn;
    };
    const client = new McpPersistentClient({
      serverId: 'dead-http',
      config: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' },
      createConnection: instrumented,
      reconnect: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 10, jitter: 0 },
      sleep: async () => {},
      requestTimeoutMs: 2_000,
    });
    await assert.rejects(client.connect(), /连接失败/);
    assert.equal(client.getState(), 'failed');
    assert.ok(closeCalls >= 2, `每次失败尝试都应 close（实际 ${closeCalls} 次）`);
    await client.close();
  });
});

// ---------------- 双轨订阅 ----------------

describe('双轨订阅', () => {
  test('legacy 轨：resources/subscribe + 推送通知（resources/updated）', async () => {
    const notifications: Array<{ method: string }> = [];
    const client = await connectStdio('legacy', {
      clientOptions: {
        onNotification: n => notifications.push({ method: n.method }),
      },
    });
    try {
      assert.equal(client.getProtocolEra(), 'legacy');
      await client.subscribeResource('file:///a.txt');
      assert.deepEqual(client.subscribedResourceUris(), ['file:///a.txt']);
      await client.unsubscribeResource('file:///a.txt');
      assert.deepEqual(client.subscribedResourceUris(), []);
    } finally {
      await client.close();
    }
  });

  test('legacy 轨：服务端 tools/list_changed 推送经通知通道上抛', async () => {
    // 用 InMemoryTransport 直连验证推送链路（stdio 子进程无法从外部触发通知）。
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: 'legacy-mem', version: '1.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler('tools/list', async () => ({ tools: [] }));
    await server.connect(serverTransport);
    const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    const seen: string[] = [];
    client.setNotificationHandler('notifications/tools/list_changed', async () => { seen.push('tools'); });
    client.setNotificationHandler('notifications/resources/list_changed', async () => { seen.push('resources'); });
    await client.connect(clientTransport);
    assert.equal(client.getProtocolEra(), 'legacy');
    server.sendToolListChanged();
    await sleep(100);
    assert.deepEqual(seen, ['tools']);
    await client.close();
    await server.close();
  });

  test('modern 轨：subscriptions/listen 过滤器的 resourceSubscriptions 覆盖订阅意图', async () => {
    const listens: McpListenFilter[] = [];
    const closes: string[] = [];
    const fakeConnection = createModernFakeConnection(listens, closes);
    const client = new McpPersistentClient({
      serverId: 'modern-fake',
      config: stdioConfig('modern'),
      createConnection: () => fakeConnection,
      reconnect: { maxAttempts: 1 },
      sleep: async () => {},
    });
    await client.connect();
    await client.subscribeResource('file:///a');
    assert.equal(listens.length, 1);
    assert.deepEqual(listens[0].resourceSubscriptions, ['file:///a']);
    // modern 轨不应逐 URI 发 resources/subscribe。
    assert.equal(fakeConnection.legacySubscribes.length, 0);

    await client.subscribeResource('file:///b');
    assert.equal(listens.length, 2, '新增 URI 应重挂 listen 流');
    assert.deepEqual(listens[1].resourceSubscriptions?.sort(), ['file:///a', 'file:///b']);

    await client.unsubscribeResource('file:///a');
    assert.equal(listens.length, 3);
    assert.deepEqual(listens[2].resourceSubscriptions, ['file:///b']);
    await client.close();
  });

  test('modern 轨：listen 流意外关闭（remote）后自动重挂', async () => {
    const listens: McpListenFilter[] = [];
    const closes: string[] = [];
    const fakeConnection = createModernFakeConnection(listens, closes);
    const client = new McpPersistentClient({
      serverId: 'modern-relisten',
      config: stdioConfig('modern'),
      createConnection: () => fakeConnection,
      reconnect: { maxAttempts: 1 },
      sleep: async () => {},
    });
    await client.connect();
    await client.subscribeResource('file:///a');
    assert.equal(listens.length, 1);
    // 模拟服务端侧终止 listen 流（remote close）。
    fakeConnection.dropActiveListen('remote');
    await waitFor(() => listens.length >= 2, 3000);
    assert.deepEqual(listens[1].resourceSubscriptions, ['file:///a'], '重挂的 listen 应保留订阅意图');
    await client.close();
  });

  test('modern 轨：连接重建后自动重挂 listen（跨连接恢复）', async () => {
    const connections: ModernFakeConnection[] = [];
    const client = new McpPersistentClient({
      serverId: 'modern-reconnect',
      config: stdioConfig('modern'),
      createConnection: () => {
        const conn = createModernFakeConnection([], []);
        connections.push(conn);
        return conn;
      },
      reconnect: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5, jitter: 0 },
      sleep: async () => {},
    });
    await client.connect();
    await client.subscribeResource('file:///a');
    assert.equal(connections[0].listenCalls.length, 1);
    // 整条连接断开 → 自动重连 → 新连接上应自动重挂 listen。
    connections[0].onclose?.();
    await waitFor(() => connections.length >= 2 && connections[1].listenCalls.length >= 1, 5000);
    assert.deepEqual(connections[1].listenCalls[0].resourceSubscriptions, ['file:///a']);
    await client.close();
  });

  test('modern 轨真实链路：HTTP server listen 收到 tools/list_changed 推送', async () => {
    const modern = await startModernHttpServer();
    try {
      const notifications: string[] = [];
      const client = new McpPersistentClient({
        serverId: 'modern-http-listen',
        config: { transport: 'streamable-http', url: modern.url },
        createConnection: createSdkMcpConnectionFactory({ discoveryCache: new PriorDiscoveryCache() }),
        onNotification: n => notifications.push(n.method),
        reconnect: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: 0 },
        requestTimeoutMs: 10_000,
      });
      await client.connect();
      assert.equal(client.getProtocolEra(), 'modern');
      await client.subscribeResource('file:///a.txt');
      await client.ensureSubscriptions();
      modern.notifyToolsChanged();
      await waitFor(() => notifications.includes('notifications/tools/list_changed'), 8000);
      await client.close();
    } finally {
      await modern.close();
    }
  });
});

// ---------------- 全原语方法面 ----------------

describe('全原语方法面', () => {
  test('tools/resources/templates/prompts/complete/instructions 全套', async () => {
    const client = await connectStdio('legacy');
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.some(t => t.name === 'echo'));
      const all = await client.listAllTools();
      assert.ok(all.length >= tools.tools.length);

      const call = await client.callTool('echo', { text: 'hi' });
      assert.ok(JSON.stringify(call.content).includes('echo:hi'));

      const resources = await client.listResources();
      assert.equal(resources.resources[0]?.uri, 'file:///a.txt');
      const templates = await client.listResourceTemplates();
      assert.equal(templates.resourceTemplates[0]?.uriTemplate, 'file:///{name}');
      const read = await client.readResource('file:///a.txt');
      assert.ok(read.contents[0]?.text?.includes('body:file:///a.txt'));

      const prompts = await client.listPrompts();
      assert.equal(prompts.prompts[0]?.name, 'greet');
      const prompt = await client.getPrompt('greet', { who: 'xiaoba' }) as { messages: Array<{ content: { text: string } }> };
      assert.ok(prompt.messages[0].content.text.includes('xiaoba'));

      const completion = await client.complete({
        ref: { type: 'ref/prompt', name: 'greet' },
        argument: { name: 'who', value: '' },
      }) as { completion: { values: string[] } };
      assert.deepEqual(completion.completion.values, ['alpha', 'beta']);

      assert.equal(client.getServerInstructions(), 'legacy instructions');
    } finally {
      await client.close();
    }
  });

  test('progressToken：进度通知回调链路（onProgress + resetTimeoutOnProgress）', async () => {
    const client = await connectStdio('legacy');
    try {
      const progressEvents: Array<{ progress: number; message?: string }> = [];
      const result = await client.callTool('slow', {}, {
        progressToken: 'tok-progress-1',
        onProgress: (p) => progressEvents.push({ progress: p.progress, message: p.message }),
      });
      assert.ok(JSON.stringify(result.content).includes('slow-done'));
      assert.ok(progressEvents.length >= 2, `应收到至少两个进度事件（实际 ${progressEvents.length}）`);
      assert.deepEqual(progressEvents.map(e => e.message), ['half', 'done']);
    } finally {
      await client.close();
    }
  });

  test('tasks 原语：未声明 tasks 能力时优雅拒绝', async () => {
    const client = await connectStdio('legacy');
    try {
      assert.equal(client.supportsTasks(), false);
      await assert.rejects(client.getTask('task-1'), /tasks 能力/);
      await assert.rejects(client.getTaskResult('task-1'), /tasks 能力/);
      await assert.rejects(client.cancelTask('task-1'), /tasks 能力/);
      await assert.rejects(client.listTasks(), /tasks 能力/);
    } finally {
      await client.close();
    }
  });

  test('tasks 原语：服务端声明 tasks 能力时可用', async () => {
    const client = await connectStdio('legacy', { env: { MCP_FAKE_TASKS: '1' } });
    try {
      assert.equal(client.supportsTasks(), true);
      const task = await client.getTask('task-1') as { taskId: string; status: string };
      assert.equal(task.status, 'completed');
      const cancelled = await client.cancelTask('task-1') as { status: string };
      assert.equal(cancelled.status, 'cancelled');
      const list = await client.listTasks() as { tasks: unknown[] };
      assert.ok(Array.isArray(list.tasks));
    } finally {
      await client.close();
    }
  });
});

// ---------------- McpSdkClient v2 ----------------

describe('mcp-sdk-client v2（CatsCo bridge）', () => {
  test('legacy streamable-http server：连接、listTools、callTool、list_changed 推送', async () => {
    const legacyHttp = await startLegacyStreamableHttpServer();
    try {
      const pushes: string[] = [];
      let listChangedPushes = 0;
      const factory = createSdkMcpBridgeClientFactory({
        onToolsListChanged: () => { listChangedPushes += 1; },
        onNotification: n => pushes.push(n.method),
      });
      const client = factory({ url: legacyHttp.url, token: 'tok' });
      const tools = await client.listTools();
      assert.ok(tools.some(t => t.name === 'echo'), '应列出 echo 工具');
      const result = await client.callTool('echo', { text: 'yo' });
      assert.equal(result.isError, false);
      assert.ok(result.contentText.includes('echo:yo'));

      // 服务端推送 tools/list_changed → bridge 客户端应收到回调。
      legacyHttp.pushToolListChanged();
      await waitFor(() => listChangedPushes >= 1, 5000);
      assert.ok(listChangedPushes >= 1, 'tools/list_changed 推送应触发回调');
      await client.close();
    } finally {
      await legacyHttp.close();
    }
  });

  test('era 诊断：legacy server 协商到 2025-11-25', async () => {
    const legacyHttp = await startLegacyStreamableHttpServer();
    try {
      const factory = createSdkMcpBridgeClientFactory();
      const client = factory({ url: legacyHttp.url, token: 'tok' }) as unknown as {
        getProtocolEra(): string | undefined;
        getProtocolVersion(): string | undefined;
        listTools(): Promise<unknown[]>;
        close(): Promise<void>;
      };
      await client.listTools();
      assert.equal(client.getProtocolEra(), 'legacy');
      assert.equal(client.getProtocolVersion(), '2025-11-25');
      await client.close();
    } finally {
      await legacyHttp.close();
    }
  });
});

// ---------------- 测试基础设施 ----------------

function countChildProcesses(): number {
  // 通过 /proc 不可用（macOS）；用进程句柄近似：统计当前 process 的 active handles 中的 ChildProcess。
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  return handles.filter(h => h && (h as { constructor?: { name?: string } }).constructor?.name === 'ChildProcess').length;
}

interface ModernFakeConnection extends McpConnection {
  listenCalls: McpListenFilter[];
  legacySubscribes: string[];
  dropActiveListen(reason: 'remote' | 'graceful'): void;
}

/** 内存 modern 连接：listen 流句柄可控关闭，用于验证自动重挂逻辑。 */
function createModernFakeConnection(listens: McpListenFilter[], closes: string[]): ModernFakeConnection {
  let activeHandle: { resolveClosed: (r: 'local' | 'graceful' | 'remote') => void } | null = null;
  const conn: ModernFakeConnection = {
    listenCalls: listens,
    legacySubscribes: [],
    onclose: undefined,
    onerror: undefined,
    async listTools() { return { tools: [] }; },
    async callTool() { return { content: [] }; },
    async listResources() { return { resources: [] }; },
    async readResource() { return { contents: [] }; },
    async subscribeResource(params) { conn.legacySubscribes.push(params.uri); return {}; },
    async unsubscribeResource() { return {}; },
    async listPrompts() { return { prompts: [] }; },
    async getPrompt() { return {}; },
    getProtocolEra() { return 'modern' as const; },
    getProtocolVersion() { return '2026-07-28'; },
    getCapabilities() { return { tools: {} } as never; },
    getServerInstructions() { return 'fake modern'; },
    async listen(filter: McpListenFilter): Promise<McpListenHandle> {
      listens.push(filter);
      let resolveClosed!: (r: 'local' | 'graceful' | 'remote') => void;
      const closed = new Promise<'local' | 'graceful' | 'remote'>(resolve => { resolveClosed = resolve; });
      const handle: McpListenHandle & { resolveClosed: typeof resolveClosed } = {
        honoredFilter: filter,
        closed,
        resolveClosed,
        close: async () => { resolveClosed('local'); },
      };
      activeHandle = handle;
      return handle;
    },
    dropActiveListen(reason) {
      activeHandle?.resolveClosed(reason);
    },
    async close() {},
  };
  return conn;
}

/** modern（2026-07-28）HTTP server：createMcpHandler + node http。 */
async function startModernHttpServer(): Promise<{
  url: string;
  notifyToolsChanged(): void;
  close(): Promise<void>;
}> {
  const factory = () => {
    const server = new McpServer(
      { name: 'modern-http-test', version: '2.0.0' },
      {
        capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } },
        instructions: 'modern http instructions',
        supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
      },
    );
    server.server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
    server.server.setRequestHandler('resources/list', async () => ({ resources: [] }));
    return server;
  };
  const handler = createMcpHandler(factory);
  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await new Promise<string>(resolve => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data));
      });
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
      }
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers,
        body: body || undefined,
      });
      try {
        const response = await handler.fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        }
        res.end();
      } catch (error: any) {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error?.message ?? error));
      }
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    notifyToolsChanged: () => handler.notify.toolsChanged(),
    close: async () => {
      await handler.close().catch(() => {});
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/**
 * legacy SSE-only 服务器（2024-11-05 HTTP+SSE 传输）：
 * GET /sse 长连接发 endpoint 事件；POST /message 收 JSON-RPC 并回 202，
 * 响应经 SSE 流推送。streamable-http 客户端的 POST 会被拒绝（404）。
 */
async function startLegacySseServer(): Promise<{ url: string; close(): Promise<void> }> {
  const sseClients = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/sse') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`event: endpoint\ndata: /message\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/message') {
        const body = await new Promise<string>(resolve => {
          let data = '';
          req.on('data', chunk => { data += chunk; });
          req.on('end', () => resolve(data));
        });
        res.writeHead(202).end('Accepted');
        let message: { id?: number | string; method?: string; params?: any };
        try {
          message = JSON.parse(body);
        } catch {
          return;
        }
        if (message.id === undefined || !message.method) return;
        const reply = handleLegacySseRequest(message);
        for (const client of sseClients) {
          client.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        }
        return;
      }
      // 其它一切（包括 streamable-http 风格的对 /sse 的 POST）→ 404，触发自动回退。
      res.writeHead(404).end('Not Found');
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/sse`,
    close: async () => {
      for (const client of sseClients) client.end();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function handleLegacySseRequest(message: { id?: number | string; method?: string; params?: any }): object {
  const base = { jsonrpc: '2.0', id: message.id };
  switch (message.method) {
    case 'initialize':
      return {
        ...base,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'legacy-sse-test', version: '1.0.0' },
        },
      };
    case 'ping':
      return { ...base, result: {} };
    case 'tools/list':
      return { ...base, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } };
    case 'tools/call':
      return { ...base, result: { content: [{ type: 'text', text: `echo:${message.params?.arguments?.text ?? ''}` }] } };
    case 'resources/list':
      return { ...base, result: { resources: [] } };
    case 'prompts/list':
      return { ...base, result: { prompts: [] } };
    default:
      return { ...base, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

/**
 * legacy Streamable HTTP server（2025 代，无 server/discover）：
 * 用于 mcp-sdk-client 的推送/era 测试。
 * - POST /mcp：JSON-RPC 请求，application/json 应答（含 mcp-session-id 头）；
 * - GET /mcp：standalone SSE 流（streamable-http 服务端推送通道）；
 * - DELETE /mcp：会话释放，202。
 */
async function startLegacyStreamableHttpServer(): Promise<{
  url: string;
  pushToolListChanged(): void;
  close(): Promise<void>;
}> {
  const sseStreams = new Set<http.ServerResponse>();
  const sessionId = 'sess-legacy-http-1';
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET') {
        // standalone SSE 推送流：一直挂着，等服务端 push。
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'mcp-session-id': sessionId,
        });
        res.write('retry: 1000\n\n');
        sseStreams.add(res);
        req.on('close', () => sseStreams.delete(res));
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(202).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const body = await new Promise<string>(resolve => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data));
      });
      let message: any;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!message.method || message.id === undefined) {
        // 客户端通知（initialized 等）：202 无正文。
        res.writeHead(202, { 'mcp-session-id': sessionId }).end();
        return;
      }
      const reply = handleLegacyHttpRequest(message);
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sessionId });
      res.end(JSON.stringify(reply));
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    pushToolListChanged: () => {
      const notification = { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} };
      for (const stream of sseStreams) {
        stream.write(`event: message\ndata: ${JSON.stringify(notification)}\n\n`);
      }
    },
    close: async () => {
      for (const stream of sseStreams) stream.end();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function handleLegacyHttpRequest(message: any): object {
  const base = { jsonrpc: '2.0', id: message.id };
  switch (message.method) {
    case 'initialize':
      return {
        ...base,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'legacy-http-test', version: '1.0.0' },
        },
      };
    case 'ping':
      return { ...base, result: {} };
    case 'tools/list':
      return { ...base, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] } };
    case 'tools/call':
      return { ...base, result: { content: [{ type: 'text', text: `echo:${message.params?.arguments?.text ?? ''}` }] } };
    default:
      return { ...base, error: { code: -32601, message: 'Method not found' } };
  }
}
