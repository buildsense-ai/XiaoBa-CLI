/**
 * Receiver-side RPC telemetry for slow tool calls（当前仅跟踪 grep）。
 *
 * 背景（2026-10-01 实例 .34 诊断）：一次真实 turn 花费 533s，其中 grep 工具窗口
 * 约 507s。现有接收端日志无法区分"工具执行耗时"与"结果回传传输耗时"，也
 * 无法按 request 关联 start → execute-end → result-sent 三个时间点。
 *
 * 本模块是纯 telemetry 层：所有方法只做数据 sanitize 与格式化，返回日志
 * 字符串；调用方（device_rpc / thin_tool_rpc 接收端）负责计时与 Logger 输出。
 * 不改变信任根、校验、shutdown fence 或结果/错误传输形状，也不产生任何
 * 模型可见文本。
 *
 * 隐私 fence（硬约束）：只允许记录 request ID（清洗后）、工具枚举、时序、
 * ok/errorCode 与长度聚合；绝不记录 pattern/路径/参数、消息体、输出正文或
 * 凭据。不可信的 request/error 标签一律先做类型门（仅接受 string 与有限
 * number，绝不触发自定义 coercion/toString hook）、去控制字符并截断长度，
 * 再在拼入日志前按 RFC3986 unreserved 白名单百分号编码，使内嵌的
 * `tool=`/`phase=`/`ok=` 等无法伪造 key=value 字段；常规 nonce 请求 ID
 * （字母数字与 -._~）保持原样可读、可关联。
 */

export type RpcTelemetryChannel = 'device_rpc' | 'thin_tool_rpc';

export type RpcTelemetryPhase = 'received' | 'execute_end' | 'result_sent' | 'dropped_shutdown';

/** 接收端工具枚举（import_file 是 send_file 的别名，统一归一化）。 */
const RPC_TELEMETRY_TOOL_ENUM: ReadonlySet<string> = new Set([
  'read_file',
  'resolve_common_directory',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'send_file',
  'execute_shell',
]);

/** 当前仅跟踪 grep（耗时诊断），其他工具不产生 telemetry 日志。 */
export const RPC_TELEMETRY_TRACKED_TOOLS: ReadonlySet<string> = new Set(['grep']);

const MAX_RPC_TELEMETRY_ID_CHARS = 80;
const MAX_RPC_TELEMETRY_CODE_CHARS = 48;

/** C0/C1 控制字符统一替换为空格，防止日志注入与换行伪造。 */
const CONTROL_CHARS_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * 日志字段值的类型门：仅接受 string 与有限 number（number 走固定 coercion，
 * 无自定义 hook）。其余类型（对象/数组/null/undefined/Symbol/BigInt/布尔/
 * 函数等）一律返回空串，绝不调用 String()，从而不会触发对象的
 * toString/Symbol.toPrimitive（可能抛错或执行任意代码）。
 */
function rpcTelemetryLabelSource(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 清洗不可信标签：类型门 → 去控制字符 → 收敛空白 → 限制长度。 */
export function sanitizeRpcTelemetryLabel(value: unknown, maxChars: number): string {
  const text = rpcTelemetryLabelSource(value);
  return text.replace(CONTROL_CHARS_PATTERN, ' ').replace(/\s+/g, ' ').trim().slice(0, Math.max(0, maxChars));
}

/** 拼入日志 key=value 字段时保持原样的白名单字符（RFC3986 unreserved）。 */
const RPC_FIELD_SAFE_CHAR_PATTERN = /[A-Za-z0-9._~-]/;

/**
 * 将清洗后的值百分号编码（标准 UTF-8 %XX）后拼入日志字段：内嵌的 `=`、
 * 空白、引号、括号等全部转义，无法伪造 `tool=`/`phase=`/`ok=` 等 key=value
 * 字段；unreserved 集合内的常规 nonce 字符串原样保留、可读可关联。
 * 输出长度最多约为清洗后长度的 3 倍（上层已限长，结果仍有界）。
 */
export function encodeRpcTelemetryFieldValue(value: string): string {
  let encoded = '';
  for (const char of value) {
    if (RPC_FIELD_SAFE_CHAR_PATTERN.test(char)) {
      encoded += char;
      continue;
    }
    const codePoint = char.codePointAt(0) as number;
    const utf8: number[] = [];
    if (codePoint <= 0x7f) {
      utf8.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      utf8.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      utf8.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      utf8.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
    for (const byte of utf8) {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return encoded;
}

/** 归一化为接收端工具枚举；未知工具一律记为 unknown（不透传原始字符串）。 */
export function normalizeRpcTelemetryTool(value: unknown): string {
  const cleaned = sanitizeRpcTelemetryLabel(value, MAX_RPC_TELEMETRY_ID_CHARS).toLowerCase();
  const canonical = cleaned === 'import_file' ? 'send_file' : cleaned;
  return RPC_TELEMETRY_TOOL_ENUM.has(canonical) ? canonical : 'unknown';
}

/** 清洗 request ID：控制字符 + 长度上限。 */
export function sanitizeRpcTelemetryRequestId(value: unknown): string {
  return sanitizeRpcTelemetryLabel(value, MAX_RPC_TELEMETRY_ID_CHARS);
}

/** 清洗 error code：控制字符 + 长度上限（error message 永不进入 telemetry）。 */
export function sanitizeRpcTelemetryErrorCode(value: unknown): string {
  return sanitizeRpcTelemetryLabel(value, MAX_RPC_TELEMETRY_CODE_CHARS);
}

/** 工具结果的 content 长度聚合（仅统计字符串长度，不泄露内容）。 */
export function toolResultContentChars(result: unknown): number | undefined {
  if (!result || typeof result !== 'object' || !('content' in result)) return undefined;
  const content = (result as { content?: unknown }).content;
  return typeof content === 'string' ? content.length : undefined;
}

function formatMs(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return 0;
  return Math.max(0, Math.round(durationMs));
}

function formatChars(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export interface RpcTelemetryExecuteEndInput {
  ok: boolean;
  errorCode?: unknown;
}

export interface RpcTelemetryResultSentInput {
  ok: boolean;
  errorCode?: unknown;
  /** 结果 content 长度聚合（仅 ok 结果有意义）。 */
  resultChars?: number;
  /** 结果回传失败（异常/shutdown 丢弃走 dropped_shutdown）。 */
  sendFailed?: boolean;
}

/**
 * 单个 RPC 请求的 telemetry 时间线。
 * begin() 返回 undefined 表示该工具不在跟踪范围（零开销、零日志）。
 */
export class RpcToolTelemetrySpan {
  readonly channel: RpcTelemetryChannel;
  readonly tool: string;
  readonly requestId: string;
  private readonly startMs: number;
  private executeEndMarked = false;
  private executeEndMs = 0;

  private constructor(channel: RpcTelemetryChannel, tool: string, requestId: string, startMs: number) {
    this.channel = channel;
    this.tool = tool;
    this.requestId = requestId;
    this.startMs = startMs;
  }

  /**
   * 仅当工具在跟踪范围内且存在可关联的 request ID 时返回 span。
   * trackedTools 可注入以便测试。
   */
  static begin(input: {
    channel: RpcTelemetryChannel;
    requestId: unknown;
    toolName: unknown;
    now?: number;
    trackedTools?: ReadonlySet<string>;
  }): RpcToolTelemetrySpan | undefined {
    const tool = normalizeRpcTelemetryTool(input.toolName);
    const tracked = input.trackedTools ?? RPC_TELEMETRY_TRACKED_TOOLS;
    if (!tracked.has(tool)) return undefined;
    const requestId = sanitizeRpcTelemetryRequestId(input.requestId);
    if (!requestId) return undefined;
    const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
    return new RpcToolTelemetrySpan(input.channel, tool, requestId, now);
  }

  private prefix(phase: RpcTelemetryPhase): string {
    return `[CatsCompany][${this.channel}][telemetry] request=${encodeRpcTelemetryFieldValue(this.requestId)} tool=${encodeRpcTelemetryFieldValue(this.tool)} phase=${phase}`;
  }

  /** 接收请求（时间线起点）。 */
  received(now: number = Date.now()): string {
    return `${this.prefix('received')} at=${formatMs(now)}`;
  }

  /**
   * 工具执行结束（含被校验/权限拒绝：ok=false）。拒绝的 RPC 永远不会以
   * ok=true 出现在 telemetry 中。
   */
  executeEnd(input: RpcTelemetryExecuteEndInput, now: number = Date.now()): string {
    this.executeEndMarked = true;
    this.executeEndMs = now;
    const durationMs = formatMs(now - this.startMs);
    if (input.ok) {
      return `${this.prefix('execute_end')} ok=true durationMs=${durationMs}`;
    }
    const errorCode = encodeRpcTelemetryFieldValue(sanitizeRpcTelemetryErrorCode(input.errorCode)) || 'unknown_error';
    return `${this.prefix('execute_end')} ok=false errorCode=${errorCode} durationMs=${durationMs}`;
  }

  /**
   * 结果已回传。durationMs=接收→回传全程；transportMs=执行结束→回传完成
   * （返回传输耗时）。sendFailed=true 表示回传本身抛错（执行结果保持原样）。
   */
  resultSent(input: RpcTelemetryResultSentInput, now: number = Date.now()): string {
    const durationMs = formatMs(now - this.startMs);
    const transportMs = formatMs(now - (this.executeEndMarked ? this.executeEndMs : this.startMs));
    const segments = [
      this.prefix('result_sent'),
      input.ok ? 'ok=true' : 'ok=false',
      `durationMs=${durationMs}`,
      `transportMs=${transportMs}`,
    ];
    if (!input.ok) {
      const errorCode = encodeRpcTelemetryFieldValue(sanitizeRpcTelemetryErrorCode(input.errorCode)) || 'unknown_error';
      segments.push(`errorCode=${errorCode}`);
    }
    const resultChars = formatChars(input.resultChars);
    if (input.ok && resultChars !== undefined) segments.push(`resultChars=${resultChars}`);
    if (input.sendFailed) segments.push('sendFailed=true');
    return segments.join(' ');
  }

  /** shutdown fence 丢弃结果：执行完成但未回传，保证时间线可配对收尾。 */
  dropped(now: number = Date.now()): string {
    return `${this.prefix('dropped_shutdown')} durationMs=${formatMs(now - this.startMs)}`;
  }
}
