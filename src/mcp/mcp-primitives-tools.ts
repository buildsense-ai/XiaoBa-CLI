/**
 * MCP Resources / Prompts / Completion 元工具。
 *
 * 当任意 MCP server 可用时，向 ToolManager 注册 6 个轻量内置元工具：
 * - mcp_list_resources      — 列出资源（支持 serverId / cursor / includeTemplates）
 * - mcp_read_resource       — 读取资源（text / blob / resource_link，带大小上限与结构化元数据）
 * - mcp_subscribe_resource  — 订阅/退订资源更新（作用域限定当前会话）
 * - mcp_list_prompts        — 列出提示词模板
 * - mcp_get_prompt          — 获取渲染后的提示词
 * - mcp_complete            — completion/complete 自动补全
 *
 * 与 McpClientManager / McpPersistentClient 的耦合收敛为窄接口
 * `McpPrimitivesClient`：Track 1 升级 SDK v2 时只需重新满足这个接口即可合并。
 */
import type { ContentBlock } from '../types/index';
import type {
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from '../types/tool';
import {
  McpPrimitivesCache,
  extractCachePolicy,
} from './mcp-primitives-cache';

/** 元工具消费的客户端窄接口（由 McpClientManager 适配提供）。 */
export interface McpPrimitivesClient {
  listResources(serverId: string, cursor?: string): Promise<unknown>;
  listResourceTemplates(serverId: string, cursor?: string): Promise<unknown>;
  readResource(serverId: string, uri: string): Promise<unknown>;
  subscribeResource(serverId: string, uri: string): Promise<unknown>;
  unsubscribeResource(serverId: string, uri: string): Promise<unknown>;
  listPrompts(serverId: string, cursor?: string): Promise<unknown>;
  getPrompt(serverId: string, name: string, args?: Record<string, string>): Promise<unknown>;
  complete(serverId: string, ref: unknown, argument: unknown, context?: unknown): Promise<unknown>;
}

export interface McpPrimitivesToolsOptions {
  client: McpPrimitivesClient;
  cache: McpPrimitivesCache;
  /** 可选：列出当前可用 serverId，校验入参并给出更好的错误信息。 */
  listServerIds?: () => string[];
  /** 文本内容字符上限（默认 100_000）。 */
  maxTextChars?: number;
  /** base64 blob 大小上限（默认 1MB base64 ≈ 750KB 二进制）。 */
  maxBlobChars?: number;
}

export const MCP_PRIMITIVES_TOOL_NAMES = [
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_subscribe_resource',
  'mcp_list_prompts',
  'mcp_get_prompt',
  'mcp_complete',
] as const;

const DEFAULT_MAX_TEXT_CHARS = 100_000;
const DEFAULT_MAX_BLOB_CHARS = 1_048_576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ok(content: string | ContentBlock[]): ToolExecutionResult {
  return { ok: true, content };
}

function fail(errorCode: string, message: string, retryable = false): ToolExecutionResult {
  return { ok: false, errorCode, message, retryable };
}

function structuredResult(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/**
 * 读取资源内容的统一渲染：
 * - text 内容直接内嵌（超限截断并标注）；
 * - 支持的图片 mimeType 的 blob 转本地 image block（超限拒绝并退化为元数据文本）；
 * - 其余 blob / resource_link / 未知块序列化为结构化元数据文本块。
 */
export function renderResourceContents(
  contents: unknown,
  options: { maxTextChars?: number; maxBlobChars?: number } = {},
): string | ContentBlock[] {
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxBlobChars = options.maxBlobChars ?? DEFAULT_MAX_BLOB_CHARS;
  const list = Array.isArray(contents) ? contents : [];
  if (list.length === 0) return '（资源无内容）';

  const blocks: ContentBlock[] = [];
  const LOCAL_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

  for (const item of list) {
    if (!isRecord(item)) {
      blocks.push({ type: 'text', text: `[mcp resource content] ${JSON.stringify(item)}` });
      continue;
    }
    // resource_link：不内嵌内容，渲染链接与元数据。
    if (item.type === 'resource_link') {
      blocks.push({
        type: 'text',
        text: `[mcp resource_link] ${structuredResult({
          uri: item.uri,
          name: item.name,
          description: item.description,
          mimeType: item.mimeType,
        })}`,
      });
      continue;
    }
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType : undefined;
    if (typeof item.text === 'string') {
      let text = item.text;
      let truncated = false;
      if (text.length > maxTextChars) {
        text = text.slice(0, maxTextChars);
        truncated = true;
      }
      blocks.push({
        type: 'text',
        text: truncated
          ? `${text}\n[mcp resource text truncated at ${maxTextChars} chars, total ${item.text.length}]`
          : text,
      });
      continue;
    }
    if (typeof item.blob === 'string') {
      const blobSize = item.blob.length;
      if (blobSize > maxBlobChars) {
        blocks.push({
          type: 'text',
          text: `[mcp blob omitted: ${mimeType ?? 'unknown'} exceeds size cap ${maxBlobChars} base64 chars (got ${blobSize})]`,
        });
        continue;
      }
      if (mimeType && LOCAL_IMAGE_MIME.has(mimeType)) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: item.blob,
          },
        });
        continue;
      }
      // 非图片 blob：不内嵌原始 base64，只给结构化元数据。
      blocks.push({
        type: 'text',
        text: `[mcp blob] ${structuredResult({
          uri: item.uri,
          mimeType: mimeType ?? 'application/octet-stream',
          base64Length: blobSize,
          approxBytes: Math.floor((blobSize * 3) / 4),
        })}`,
      });
      continue;
    }
    blocks.push({ type: 'text', text: `[mcp resource content] ${structuredResult(item)}` });
  }

  // 纯单文本块时退化为字符串，保持与本地工具结果习惯一致。
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
  return blocks;
}

/** 创建 6 个 MCP 元工具。每个工具的 execute 都自带异常兜底，绝不向上抛。 */
export function createMcpPrimitivesTools(options: McpPrimitivesToolsOptions): Tool[] {
  const { client, cache } = options;
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxBlobChars = options.maxBlobChars ?? DEFAULT_MAX_BLOB_CHARS;

  const resolveServerId = (args: Record<string, unknown>): { serverId?: string; error?: ToolExecutionResult } => {
    const raw = args.serverId;
    if (typeof raw !== 'string' || !raw.trim()) {
      return { error: fail('invalid_arguments', '缺少必填参数 serverId（MCP server 标识）') };
    }
    const serverId = raw.trim();
    if (options.listServerIds) {
      const available = options.listServerIds();
      if (!available.includes(serverId)) {
        return {
          error: fail(
            'mcp_server_not_found',
            `MCP server "${serverId}" 不存在或未连接。可用: ${available.length > 0 ? available.join(', ') : '（无）'}`,
          ),
        };
      }
    }
    return { serverId };
  };

  const stringArg = (args: Record<string, unknown>, key: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const sessionIdOf = (context?: ToolExecutionContext): string | undefined =>
    context?.sessionId;

  const guard = async (
    fn: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> => {
    try {
      return await fn();
    } catch (error: any) {
      return fail('mcp_request_failed', `MCP 请求失败: ${error?.message ?? error}`, true);
    }
  };

  const definition = (
    name: string,
    description: string,
    properties: Record<string, { type: string; description: string; enum?: string[] }>,
    required: string[],
  ): ToolDefinition => ({
    name,
    description,
    parameters: {
      type: 'object',
      properties: properties as ToolDefinition['parameters']['properties'],
      ...(required.length > 0 ? { required } : {}),
    },
  });

  const serverIdProp = {
    type: 'string',
    description: 'MCP server 标识（与 mcp-servers.json 配置一致）',
  };

  return [
    {
      definition: definition(
        'mcp_list_resources',
        '列出指定 MCP server 的资源（resources/list），可选包含 URI 模板。结果按 server 的 ttlMs/cacheScope 策略本地缓存。',
        {
          serverId: serverIdProp,
          cursor: { type: 'string', description: '分页游标（上一页返回的 nextCursor）' },
          includeTemplates: { type: 'boolean', description: '同时列出 resources/templates（URI 模板）' },
        },
        ['serverId'],
      ),
      execute: (rawArgs: unknown, context?: ToolExecutionContext) => guard(async () => {
        const args = isRecord(rawArgs) ? rawArgs : {};
        const { serverId, error } = resolveServerId(args);
        if (error) return error;
        const cursor = stringArg(args, 'cursor');
        const includeTemplates = args.includeTemplates === true;
        const cacheKey = `list:${cursor ?? ''}:tpl=${includeTemplates ? '1' : '0'}`;
        const cached = cache.get(serverId!, 'resources', cacheKey, sessionIdOf(context));
        if (cached !== undefined) return ok(structuredResult(cached));

        const listResult = await client.listResources(serverId!, cursor) as Record<string, unknown>;
        const combined: Record<string, unknown> = {
          resources: listResult.resources ?? [],
          ...(listResult.nextCursor ? { nextCursor: listResult.nextCursor } : {}),
        };
        if (includeTemplates) {
          const tplResult = await client.listResourceTemplates(serverId!, cursor) as Record<string, unknown>;
          combined.resourceTemplates = tplResult.resourceTemplates ?? [];
        }
        cache.set(serverId!, 'resources', cacheKey, combined, extractCachePolicy(listResult), sessionIdOf(context));
        return ok(structuredResult(combined));
      }),
    },
    {
      definition: definition(
        'mcp_read_resource',
        '读取指定 MCP server 上的一个资源（resources/read）。文本内嵌返回，图片以多模态块返回，二进制与 resource_link 返回结构化元数据。',
        {
          serverId: serverIdProp,
          uri: { type: 'string', description: '资源 URI（可为具体 URI 或由模板实例化）' },
        },
        ['serverId', 'uri'],
      ),
      execute: (rawArgs: unknown, context?: ToolExecutionContext) => guard(async () => {
        const args = isRecord(rawArgs) ? rawArgs : {};
        const { serverId, error } = resolveServerId(args);
        if (error) return error;
        const uri = stringArg(args, 'uri');
        if (!uri) return fail('invalid_arguments', '缺少必填参数 uri');
        const cacheKey = `read:${uri}`;
        const cached = cache.get(serverId!, 'resources', cacheKey, sessionIdOf(context));
        if (cached !== undefined) {
          return ok(renderResourceContents((cached as { contents?: unknown }).contents, { maxTextChars, maxBlobChars }));
        }
        const result = await client.readResource(serverId!, uri) as Record<string, unknown>;
        cache.set(serverId!, 'resources', cacheKey, result, extractCachePolicy(result), sessionIdOf(context));
        return ok(renderResourceContents(result.contents, { maxTextChars, maxBlobChars }));
      }),
    },
    {
      definition: definition(
        'mcp_subscribe_resource',
        '订阅指定 MCP server 资源的更新通知（resources/subscribe）。订阅作用域限定当前会话；传 unsubscribe=true 退订。',
        {
          serverId: serverIdProp,
          uri: { type: 'string', description: '要订阅/退订的资源 URI' },
          unsubscribe: { type: 'boolean', description: 'true 时退订该资源' },
        },
        ['serverId', 'uri'],
      ),
      execute: (rawArgs: unknown) => guard(async () => {
        const args = isRecord(rawArgs) ? rawArgs : {};
        const { serverId, error } = resolveServerId(args);
        if (error) return error;
        const uri = stringArg(args, 'uri');
        if (!uri) return fail('invalid_arguments', '缺少必填参数 uri');
        if (args.unsubscribe === true) {
          await client.unsubscribeResource(serverId!, uri);
          return ok(`已退订资源 ${uri}（server: ${serverId}）`);
        }
        await client.subscribeResource(serverId!, uri);
        return ok(`已订阅资源 ${uri}（server: ${serverId}）。资源更新会通过通知送达，但不唤醒新的模型回合。`);
      }),
    },
    {
      definition: definition(
        'mcp_list_prompts',
        '列出指定 MCP server 的提示词模板（prompts/list）。结果按 server 的 ttlMs/cacheScope 策略本地缓存。',
        {
          serverId: serverIdProp,
          cursor: { type: 'string', description: '分页游标（上一页返回的 nextCursor）' },
        },
        ['serverId'],
      ),
      execute: (rawArgs: unknown, context?: ToolExecutionContext) => guard(async () => {
        const args = isRecord(rawArgs) ? rawArgs : {};
        const { serverId, error } = resolveServerId(args);
        if (error) return error;
        const cursor = stringArg(args, 'cursor');
        const cacheKey = `list:${cursor ?? ''}`;
        const cached = cache.get(serverId!, 'prompts', cacheKey, sessionIdOf(context));
        if (cached !== undefined) return ok(structuredResult(cached));
        const result = await client.listPrompts(serverId!, cursor) as Record<string, unknown>;
        cache.set(serverId!, 'prompts', cacheKey, result, extractCachePolicy(result), sessionIdOf(context));
        return ok(structuredResult(result));
      }),
    },
    {
      definition: definition(
        'mcp_get_prompt',
        '获取并渲染指定 MCP server 的提示词模板（prompts/get），arguments 为模板变量（字符串键值对）。',
        {
          serverId: serverIdProp,
          name: { type: 'string', description: '提示词模板名称' },
          arguments: { type: 'object', description: '模板变量（字符串键值对）' },
        },
        ['serverId', 'name'],
      ),
      execute: (rawArgs: unknown, context?: ToolExecutionContext) => guard(async () => {
        const args = isRecord(rawArgs) ? rawArgs : {};
        const { serverId, error } = resolveServerId(args);
        if (error) return error;
        const name = stringArg(args, 'name');
        if (!name) return fail('invalid_arguments', '缺少必填参数 name');
        let promptArgs: Record<string, string> | undefined;
        if (isRecord(args.arguments)) {
          promptArgs = {};
          for (const [key, value] of Object.entries(args.arguments)) {
            if (value !== undefined && value !== null) promptArgs[key] = String(value);
          }
        }
        const cacheKey = `get:${name}:${JSON.stringify(promptArgs ?? {})}`;
        const cached = cache.get(serverId!, 'prompts', cacheKey, sessionIdOf(context));
        if (cached !== undefined) return ok(structuredResult(cached));
        const result = await client.getPrompt(serverId!, name, promptArgs) as Record<string, unknown>;
        cache.set(serverId!, 'prompts', cacheKey, result, extractCachePolicy(result), sessionIdOf(context));
        return ok(structuredResult(result));
      }),
    },
    {
      definition: definition(
        'mcp_complete',
        '对 MCP server 的 prompt 参数或 resource URI 做自动补全（completion/complete）。ref 形如 {"type":"ref/prompt","name":"..."} 或 {"type":"ref/resource","uri":"..."}。',
        {
          serverId: serverIdProp,
          ref: { type: 'object', description: '补全目标引用：{"type":"ref/prompt","name":...} 或 {"type":"ref/resource","uri":...}' },
          argument: { type: 'object', description: '正在补全的参数：{"name":"...","value":"..."}' },
          context: { type: 'object', description: '已填写的其它参数（可选），形如 {"arguments":{"k":"v"}}' },
        },
        ['serverId', 'ref', 'argument'],
      ),
      execute: (rawArgs: unknown, context?: ToolExecutionContext) => guard(async () => {
        const args = isRecord(rawArgs) ? rawArgs : {};
        const { serverId, error } = resolveServerId(args);
        if (error) return error;
        if (!isRecord(args.ref)) return fail('invalid_arguments', '缺少必填参数 ref（对象）');
        if (!isRecord(args.argument)) return fail('invalid_arguments', '缺少必填参数 argument（对象）');
        const cacheKey = `complete:${JSON.stringify([args.ref, args.argument, args.context ?? null])}`;
        const cached = cache.get(serverId!, 'completion', cacheKey, sessionIdOf(context));
        if (cached !== undefined) return ok(structuredResult(cached));
        const result = await client.complete(serverId!, args.ref, args.argument, args.context) as Record<string, unknown>;
        cache.set(serverId!, 'completion', cacheKey, result, extractCachePolicy(result), sessionIdOf(context));
        return ok(structuredResult(result));
      }),
    },
  ];
}
