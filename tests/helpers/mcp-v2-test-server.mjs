/**
 * 测试用 stdio MCP server（@modelcontextprotocol/server v2）。
 *
 * 两种模式（argv[2]）：
 * - modern：经 serveStdio 入口（安装 server/discover handler），auto 协商应命中
 *   2026-07-28 modern 代；
 * - legacy：手接 StdioServerTransport（无 discover handler），auto 协商必须回退
 *   2025-11-25 legacy initialize 握手。
 *
 * 任务原语：tasks 能力声明与否由环境变量 MCP_FAKE_TASKS=1 控制；
 * tasks/get 等被排除在 typed handler 表之外（2026 代 deprecation），
 * 这里用字符串+schema 重载注册（客户端侧同构）。
 */
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  GetTaskResultSchema,
  ListTasksResultSchema,
  CancelTaskResultSchema,
} from '@modelcontextprotocol/core';

const mode = process.argv[2] === 'legacy' ? 'legacy' : 'modern';
const withTasks = process.env.MCP_FAKE_TASKS === '1';

const capabilities = {
  tools: { listChanged: true },
  resources: { subscribe: true, listChanged: true },
  prompts: { listChanged: true },
  completions: {},
  ...(withTasks ? { tasks: {} } : {}),
};

function createServer() {
  const server = new Server(
    { name: `fake-${mode}-stdio`, version: '1.0.0' },
    {
      capabilities,
      instructions: `${mode} instructions`,
      ...(mode === 'modern' ? { supportedProtocolVersions: ['2026-07-28', '2025-11-25'] } : {}),
    },
  );
  server.onerror = (error) => {
    process.stderr.write(`fake-server error: ${error.message}\n`);
  };

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      { name: 'echo', description: 'Echo tool', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'slow', description: 'Progress reporting tool', inputSchema: { type: 'object' } },
    ],
  }));
  server.setRequestHandler('tools/call', async (req, ctx) => {
    if (req.params.name === 'slow') {
      const token = req.params._meta?.progressToken;
      if (token !== undefined) {
        // 上报两个进度点，验证 progressToken → notifications/progress → onProgress 链路。
        // 间隔一拍：客户端的 progress handler 随请求完成即注销，连发会丢第二点。
        await server.notification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: 0.5, total: 1, message: 'half' },
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        await server.notification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: 1, total: 1, message: 'done' },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { content: [{ type: 'text', text: 'slow-done' }] };
    }
    const text = req.params.arguments?.text ?? '';
    return { content: [{ type: 'text', text: `echo:${text}` }] };
  });
  server.setRequestHandler('resources/list', async () => ({
    resources: [{ uri: 'file:///a.txt', name: 'a', mimeType: 'text/plain' }],
  }));
  server.setRequestHandler('resources/templates/list', async () => ({
    resourceTemplates: [{ uriTemplate: 'file:///{name}', name: 'file-template' }],
  }));
  server.setRequestHandler('resources/read', async (req) => ({
    contents: [{ uri: req.params.uri, text: `body:${req.params.uri}`, mimeType: 'text/plain' }],
  }));
  server.setRequestHandler('resources/subscribe', async () => ({}));
  server.setRequestHandler('resources/unsubscribe', async () => ({}));
  server.setRequestHandler('prompts/list', async () => ({
    prompts: [{ name: 'greet', description: 'Greeting prompt', arguments: [{ name: 'who', required: false }] }],
  }));
  server.setRequestHandler('prompts/get', async (req) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `hello ${req.params.arguments?.who ?? 'world'}` } }],
  }));
  server.setRequestHandler('completion/complete', async () => ({
    completion: { values: ['alpha', 'beta'], total: 2, hasMore: false },
  }));

  if (withTasks) {
    // tasks/* 被排除在 typed method 表之外，用字符串+schema 重载注册。
    // params schema 用 passthrough shim（SDK 要求必须提供）。
    const anyParams = { '~standard': { version: 1, vendor: 'xiaoba-test', validate: (v) => ({ value: v }) } };
    const taskBase = {
      taskId: 'task-1',
      createdAt: '2026-01-01T00:00:00Z',
      lastUpdatedAt: '2026-01-01T00:00:01Z',
      ttl: 60_000,
      pollInterval: 1_000,
    };
    server.setRequestHandler('tasks/get', { params: anyParams, result: GetTaskResultSchema }, async () => ({
      ...taskBase,
      status: 'completed',
      statusMessage: 'done',
    }));
    server.setRequestHandler('tasks/result', { params: anyParams, result: GetTaskResultSchema }, async () => ({
      ...taskBase,
      status: 'completed',
    }));
    server.setRequestHandler('tasks/cancel', { params: anyParams, result: CancelTaskResultSchema }, async () => ({
      ...taskBase,
      status: 'cancelled',
    }));
    server.setRequestHandler('tasks/list', { params: anyParams, result: ListTasksResultSchema }, async () => ({
      tasks: [],
    }));
  }

  return server;
}

if (mode === 'modern') {
  await serveStdio(() => createServer());
} else {
  // legacy：手接 transport —— 没有 server/discover handler，auto 协商必须回退 initialize。
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
