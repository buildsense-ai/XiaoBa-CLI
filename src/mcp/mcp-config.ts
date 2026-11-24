/**
 * 通用 MCP Server 配置：多 Server 的加载、环境变量展开与校验。
 *
 * 配置来源（按合并顺序，后者覆盖同名 server）：
 * 1. JSON 配置文件：`XIAOBA_MCP_CONFIG` 指定的路径，或显式传入 loadMcpConfig 的 path。
 * 2. 环境变量 JSON：`XIAOBA_MCP_SERVERS`（与文件 `mcpServers`/`servers` 同构的 JSON 对象）。
 *
 * 文件内部支持 `${VAR}` / `${VAR:-default}` 展开，值可以指向其它环境变量 ——
 * token 这类敏感字段因此不必明文写进配置文件。
 *
 * 校验是 fail-fast 的：任何一条 server 配置不合法都会让整份配置报错，
 * 避免「一半的 server 悄悄没连上」这种最难排查的状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface McpStdioServerConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  /** 追加到默认白名单环境之上的变量；值为 "${VAR}" 时展开自 process.env。 */
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerConfig {
  transport: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
  /** 等价于 headers.Authorization = `Bearer <token>`；两者都给时以显式 header 为准。 */
  bearerToken?: string;
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpManagerFileConfig {
  servers: Record<string, McpServerConfig>;
}

export class McpConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`MCP 配置无效:\n- ${issues.join('\n- ')}`);
    this.name = 'McpConfigError';
    this.issues = issues;
  }
}

const SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
/** 默认配置文件位置（环境变量 XIAOBA_MCP_CONFIG 可覆盖）。 */
export const DEFAULT_MCP_CONFIG_PATH = path.join(os.homedir(), '.xiaoba', 'mcp-servers.json');
export const MCP_CONFIG_PATH_ENV = 'XIAOBA_MCP_CONFIG';
export const MCP_SERVERS_ENV = 'XIAOBA_MCP_SERVERS';

/** 展开字符串中的 ${VAR} / ${VAR:-default}；未设置且无默认值时报错（不静默留空）。 */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g, (_match, name: string, fallback?: string) => {
    const resolved = env[name];
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback;
    throw new McpConfigError([`环境变量 ${name} 未设置（配置里引用了 \${${name}}）`]);
  });
}

function deepExpand(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return expandEnvVars(value, env);
  if (Array.isArray(value)) return value.map(item => deepExpand(item, env));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepExpand(item, env);
    }
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStringMap(value: unknown, field: string, issues: string[]): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push(`${field} 必须是对象`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      issues.push(`${field}.${key} 必须是字符串`);
      continue;
    }
    out[key] = item;
  }
  return out;
}

/** 校验单条 server 配置；不合法时抛 McpConfigError。 */
export function validateServerConfig(serverId: string, raw: unknown): McpServerConfig {
  const issues: string[] = [];
  if (!SERVER_ID_PATTERN.test(serverId)) {
    issues.push(`server id "${serverId}" 只能包含字母、数字、下划线和连字符`);
  }
  const fail = () => {
    throw new McpConfigError(issues.map(issue => `[${serverId}] ${issue}`));
  };
  if (!isRecord(raw)) {
    throw new McpConfigError([`[${serverId}] server 配置必须是对象`]);
  }
  // transport 缺失时按字段推断：有 url → streamable-http，有 command → stdio。
  const transport = raw.transport ?? (typeof raw.url === 'string' ? 'streamable-http' : 'stdio');

  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) {
      issues.push('command 必填且必须是非空字符串');
    }
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(item => typeof item !== 'string'))) {
      issues.push('args 必须是字符串数组');
    }
    if (raw.cwd !== undefined && typeof raw.cwd !== 'string') {
      issues.push('cwd 必须是字符串');
    }
    const env = validateStringMap(raw.env, 'env', issues);
    if (issues.length > 0) fail();
    return {
      transport: 'stdio',
      command: (raw.command as string).trim(),
      ...(Array.isArray(raw.args) ? { args: raw.args as string[] } : {}),
      ...(env ? { env } : {}),
      ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd } : {}),
    };
  }

  if (transport === 'sse') {
    throw new McpConfigError([
      `[${serverId}] 不支持旧版 legacy sse transport，请使用 streamable-http 或 stdio`,
    ]);
  }

  if (transport === 'streamable-http' || transport === 'http') {
    if (typeof raw.url !== 'string' || !raw.url.trim()) {
      issues.push('url 必填且必须是非空字符串');
    } else {
      try {
        const parsed = new URL(raw.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          issues.push(`url 协议必须是 http/https（得到 ${parsed.protocol}）`);
        }
      } catch {
        issues.push(`url 无法解析: ${raw.url}`);
      }
    }
    if (raw.bearerToken !== undefined && typeof raw.bearerToken !== 'string') {
      issues.push('bearerToken 必须是字符串');
    }
    if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0)) {
      issues.push('timeoutMs 必须是正数');
    }
    const headers = validateStringMap(raw.headers, 'headers', issues);
    if (issues.length > 0) fail();
    return {
      transport: 'streamable-http',
      url: (raw.url as string).trim().replace(/\/+$/, ''),
      ...(headers ? { headers } : {}),
      ...(typeof raw.bearerToken === 'string' && raw.bearerToken ? { bearerToken: raw.bearerToken } : {}),
      ...(typeof raw.timeoutMs === 'number' ? { timeoutMs: raw.timeoutMs } : {}),
    };
  }

  throw new McpConfigError([`[${serverId}] 未知 transport "${String(transport)}"（支持 stdio / streamable-http）`]);
}

/**
 * 校验一份「servers 表」对象（`{ <serverId>: <config> }`）。
 * 文件里 `mcpServers` 与 `servers` 两个键等价（前者对齐 mcp.json 惯例）。
 */
export function parseServersTable(raw: unknown): Record<string, McpServerConfig> {
  if (!isRecord(raw)) {
    throw new McpConfigError(['配置必须是对象']);
  }
  const table = raw.mcpServers ?? raw.servers ?? raw;
  if (!isRecord(table)) {
    throw new McpConfigError(['mcpServers/servers 必须是对象']);
  }
  const servers: Record<string, McpServerConfig> = {};
  const issues: string[] = [];
  for (const [serverId, serverRaw] of Object.entries(table)) {
    try {
      servers[serverId] = validateServerConfig(serverId, serverRaw);
    } catch (error: any) {
      if (error instanceof McpConfigError) {
        issues.push(...error.issues);
      } else {
        issues.push(`[${serverId}] ${error?.message ?? error}`);
      }
    }
  }
  if (issues.length > 0) throw new McpConfigError(issues);
  return servers;
}

export interface LoadMcpConfigOptions {
  /** 显式配置文件路径；未给时读 env[XIAOBA_MCP_CONFIG]，再依次尝试 <runtimeRoot>/mcp-servers.json 与 DEFAULT_MCP_CONFIG_PATH。 */
  path?: string;
  /** 可选运行时数据目录，优先于 ~/.xiaoba/mcp-servers.json。 */
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** 文件不存在时是否报错（默认 false：返回空表，仅由 env 变量提供配置）。 */
  requireFile?: boolean;
  /** 容忍单条 server 配置错误（跳过无效条目并回调 onServerError，避免拖垮整个管理器与 Artifact Bridge）。 */
  tolerateInvalidServers?: boolean;
  onServerError?: (serverId: string, error: Error) => void;
}

function parseServersTableTolerant(
  raw: unknown,
  onServerError?: (serverId: string, error: Error) => void,
): Record<string, McpServerConfig> {
  if (!isRecord(raw)) {
    throw new McpConfigError(['配置必须是对象']);
  }
  const table = raw.mcpServers ?? raw.servers ?? raw;
  if (!isRecord(table)) {
    throw new McpConfigError(['mcpServers/servers 必须是对象']);
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [serverId, serverRaw] of Object.entries(table)) {
    try {
      servers[serverId] = validateServerConfig(serverId, serverRaw);
    } catch (error: any) {
      onServerError?.(serverId, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return servers;
}

/**
 * 加载并校验 MCP 配置：文件（若存在）+ XIAOBA_MCP_SERVERS 环境变量 JSON 合并。
 * 字符串值里的 ${VAR} 在解析前从 env 展开。
 */
export function loadMcpConfig(options: LoadMcpConfigOptions = {}): McpManagerFileConfig {
  const env = options.env ?? process.env;
  const runtimeConfigPath = options.runtimeRoot
    ? path.join(options.runtimeRoot, 'mcp-servers.json')
    : undefined;
  const configPath =
    options.path ??
    env[MCP_CONFIG_PATH_ENV]?.trim() ??
    (runtimeConfigPath && fs.existsSync(runtimeConfigPath) ? runtimeConfigPath : DEFAULT_MCP_CONFIG_PATH);
  const merged: Record<string, McpServerConfig> = {};
  const parseTable = (raw: unknown) =>
    options.tolerateInvalidServers
      ? parseServersTableTolerant(raw, options.onServerError)
      : parseServersTable(raw);

  if (fs.existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error: any) {
      throw new McpConfigError([`配置文件 ${configPath} 不是合法 JSON: ${error?.message ?? error}`]);
    }
    const expanded = deepExpand(parsed, env);
    Object.assign(merged, parseTable(expanded));
  } else if (options.requireFile) {
    throw new McpConfigError([`配置文件不存在: ${configPath}`]);
  }

  const envJson = env[MCP_SERVERS_ENV]?.trim();
  if (envJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(envJson);
    } catch (error: any) {
      throw new McpConfigError([`${MCP_SERVERS_ENV} 不是合法 JSON: ${error?.message ?? error}`]);
    }
    Object.assign(merged, parseTable(parsed));
  }

  return { servers: merged };
}
