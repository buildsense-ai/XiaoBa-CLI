/**
 * CatsCo MCP 工具桥的 SDK 客户端实现（生产路径，@modelcontextprotocol/client v2）。
 *
 * v2 升级要点：
 * - 代际协商 mode 'auto'：连接时先探 server/discover（2026-07-28 modern），
 *   不识别的 server 自动回退 initialize（2025-11-25 legacy），平台升级协议零改动接入；
 * - 长连接保持 + tools/list_changed 推送：服务端推送清单变更时经回调上抛，
 *   桥接层可热刷新而无需轮询；
 * - StreamableHTTPClientTransport + Bearer 头组合不变，close() 仍向平台发送 DELETE 释放会话。
 */
import {
  Client,
  StreamableHTTPClientTransport,
  type ProtocolEra,
} from '@modelcontextprotocol/client';
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

export interface SdkMcpBridgeClientOptions {
  /** 服务端推送 tools/list_changed 时的回调（v2 长连接推送支持）。 */
  onToolsListChanged?: () => void;
  /** 服务端通知的通用回调（list_changed 之外的推送也会送达）。 */
  onNotification?: (notification: { method: string; params?: unknown }) => void;
  /** 连接断开回调（非主动 close 触发）。 */
  onConnectionLost?: () => void;
}

export function createSdkMcpBridgeClientFactory(
  options: SdkMcpBridgeClientOptions = {},
): McpBridgeClientFactory {
  return (endpoint: McpBridgeEndpoint) => new SdkMcpBridgeClient(normalizeEndpoint(endpoint), options);
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

  constructor(endpoint: McpBridgeEndpoint, private readonly options: SdkMcpBridgeClientOptions = {}) {
    this.client = new Client(
      { name: 'xiaoba-mcp-bridge', version: '0.2.0' },
      {
        capabilities: {},
        // 声明 modern 草稿版本 + auto 协商：双代（2026-07-28 / 2025-11-25）自适应。
        supportedProtocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        versionNegotiation: { mode: 'auto' },
      },
    );

    // tools/list_changed 推送：modern 代走 subscriptions/listen 流，legacy 代走
    //  unsolicited 通知 —— v2 两条轨都 dispatch 到同一个 handler，桥接层无感知。
    this.client.setNotificationHandler('notifications/tools/list_changed', async () => {
      try {
        this.options.onToolsListChanged?.();
      } catch { /* 回调异常不拖垮通知通道 */ }
      this.notify('notifications/tools/list_changed', {});
    });
    this.client.fallbackNotificationHandler = async (notification) => {
      this.notify(notification.method, notification.params);
    };
    this.client.onclose = () => {
      if (!this.closed) {
        this.connected = false;
        try {
          this.options.onConnectionLost?.();
        } catch { /* 回调异常不影响状态 */ }
      }
    };

    this.transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: { authorization: `Bearer ${endpoint.token}` },
      },
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.options.onNotification?.({ method, params });
    } catch { /* 回调异常不拖垮通知通道 */ }
  }

  /** 协商到的协议代际（连接后可用；诊断用）。 */
  getProtocolEra(): ProtocolEra | undefined {
    return this.client.getProtocolEra();
  }

  /** 协商到的协议版本字符串（连接后可用；诊断用）。 */
  getProtocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error('MCP 客户端已关闭');
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    await this.ensureConnected();
    const result = await this.client.listTools({ cursor: undefined }, { timeout: MCP_BRIDGE_LIST_TIMEOUT_MS });
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
