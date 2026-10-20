/**
 * CatsCo MCP 工具桥的 SDK 客户端实现（生产路径）。
 * 复用 `scripts/mcp-smoke.mjs` 已验证的 SDK 组合：
 * StreamableHTTPClientTransport + Bearer 头，close() 会向平台发送 DELETE 以释放会话。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  McpBridgeCallResult,
  McpBridgeClient,
  McpBridgeClientFactory,
  McpBridgeEndpoint,
} from './mcp-tool-bridge';

/** 单次 tools/call 请求超时：平台同步等待窗口最长 45s，留足余量。 */
export const MCP_BRIDGE_CALL_TIMEOUT_MS = 120_000;
/** tools/list 请求超时。 */
export const MCP_BRIDGE_LIST_TIMEOUT_MS = 30_000;

export function createSdkMcpBridgeClientFactory(): McpBridgeClientFactory {
  return (endpoint: McpBridgeEndpoint) => new SdkMcpBridgeClient(normalizeEndpoint(endpoint));
}

/** 防御性：避免端点 URL 带尾斜杠导致 SDK `new URL` 异常。 */
function normalizeEndpoint(endpoint: McpBridgeEndpoint): McpBridgeEndpoint {
  return { url: endpoint.url.replace(/\/+$/, ''), token: endpoint.token };
}

class SdkMcpBridgeClient implements McpBridgeClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;
  private closed = false;

  constructor(endpoint: McpBridgeEndpoint) {
    this.client = new Client({ name: 'xiaoba-mcp-bridge', version: '0.1.0' });
    this.transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: { authorization: `Bearer ${endpoint.token}` },
      },
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error('MCP 客户端已关闭');
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    await this.ensureConnected();
    const result = await this.client.listTools(undefined, { timeout: MCP_BRIDGE_LIST_TIMEOUT_MS });
    return (result.tools ?? []).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpBridgeCallResult> {
    await this.ensureConnected();
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: MCP_BRIDGE_CALL_TIMEOUT_MS },
    );
    return {
      isError: result.isError === true,
      contentText: extractTextContent(result.content),
      structured: result.structuredContent,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.connected) return;
    try {
      await this.client.close();
    } finally {
      this.connected = false;
    }
  }
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts.join('\n');
}
