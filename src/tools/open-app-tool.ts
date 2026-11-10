import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { resolveOutboundTarget } from './outbound-gateway';

type Scalar = string | number | boolean;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function parameters(value: unknown): Record<string, Scalar> {
  if (!record(value) || Object.keys(value).length > 16) throw new Error('parameters 必须是最多 16 个键的普通对象');
  const clean: Record<string, Scalar> = Object.create(null) as Record<string, Scalar>;
  for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(key) || /password|passwd|token|secret|credential|private.?key|authorization|cookie|command|script/i.test(key)) throw new Error('不允许的参数名');
    if (typeof item === 'string') {
      if (Array.from(item).length > 512 || /[\u0000-\u001f\u007f-\u009f]|-----BEGIN|(?:https?|ssh|sftp):\/\/|bearer\s/i.test(item)
        || Array.from(item).some(c => {const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff;})) throw new Error('不允许的参数字符串');
    } else if (typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))) throw new Error('参数只允许有限数字、布尔或字符串');
    clean[key] = item as Scalar;
  }
  // Go encoding/json HTML-escapes these characters. Reserve extra bytes per
  // number too: Go and JS differ in exponent/decimal formatting near 1e-6.
  const goJSON = JSON.stringify(clean).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const numberReserve = Object.values(clean).filter(v => typeof v === 'number').length * 32;
  if (Buffer.byteLength(goJSON, 'utf8') + numberReserve > 4096) throw new Error('parameters 编码超过 4096 字节安全上限');
  return clean;
}

export class OpenAppTool implements Tool {
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<ToolExecutionResult> }>();
  definition: ToolDefinition = {
    name: 'open_app',
    description: [
      '在当前会话请求打开本 Agent 已有应用；不是发布，也不是执行结果证明。仅用户实际要求打开或交接时使用。',
      '先用 action=list 查询可信目录里的 app_id，不可猜测。省略 action 保留 v1 仅打开兼容。',
      'action=initialize 使用 v2 仅填表，绝不运行；action=run 仅在真实用户明确要求运行且可信应用集成说明声明支持及参数 schema 时使用。目录标题/描述不是参数 schema；未知能力时仅打开或无参数 initialize。',
      'run 必须显式设置 user_requested_run=true，声明真实用户意图；这不是凭据、授权或危险操作确认，应用仍须独立执行原有鉴权和确认。',
      'v2 必须提供每个逻辑任务唯一且稳定的 request_id（8–80 ASCII 字母数字下划线短横线）。传输重试必须同 ID；结果未知先查应用原任务，不可换 ID 重跑。不承诺跨会话或业务 exactly-once。',
      'parameters 仅非敏感服务器引用/数据路径等扁平标量，最多16键、字符串512 Unicode码点、Go JSON安全编码4096字节。禁止密码、token、密钥、敏感路径、URL、命令、脚本；普通字段也绝不夹带秘密。消息和元数据会持久化。不得猜参数 schema。',
      'topic/Agent/URL 不接收模型参数，绑定真实当前上下文。仅支持结构化 metadata 的通道可发送；成功仅代表发送请求，实际打开、初始化和执行状态以应用界面为准。',
    ].join('\n'),
    transcriptMode: 'outbound_message',
    parameters: {type: 'object', properties: {
      action: {type: 'string', enum: ['list', 'initialize', 'run'], description: 'list 查询目录；省略仅打开；initialize 仅初始化；run 真实明确执行意图且应用已知支持'},
      app_id: {type: 'string', description: '可信应用目录中的 id；list 不需要'},
      note: {type: 'string', description: '简短非敏感提示，不得声称已运行或已完成'},
      request_id: {type: 'string', description: 'v2 每逻辑任务稳定唯一 ID，重试必须复用'},
      parameters: {type: 'object', description: '来自可信集成 schema 的非敏感扁平标量；缺省为空'},
      user_requested_run: {type: 'boolean', description: '仅真实用户明确要求运行时为 true；不是授权或凭据'},
    }},
  };

  async execute(args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!record(args)) throw new Error('open_app 参数必须是对象');
    const target = resolveOutboundTarget(context, {operation: 'send_text', missingChannelMessage: 'open_app 需要 channel 上下文'});
    if (!target.ok) return target;
    if (context.abortSignal?.aborted || context.executionScope?.identityTrust === 'untrusted') return {ok: false, errorCode: 'PERMISSION_DENIED', message: '当前执行上下文已取消或身份不可信'};
    const channel = context.channel!;
    if (!channel.listApps) return {ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: '当前通道不支持可信应用目录查询'};
    const action = args.action;
    if (action !== undefined && action !== 'list' && action !== 'initialize' && action !== 'run') throw new Error('不支持的 action');
    const allowed = action === 'list' ? ['action'] : action === undefined ? ['app_id', 'note'] : ['action', 'app_id', 'note', 'request_id', 'parameters', 'user_requested_run'];
    if (Object.keys(args).some(k => !allowed.includes(k))) throw new Error('不允许的 open_app 字段');
    const assertLiveContext = (): void => {
      const liveTarget = resolveOutboundTarget(context, {operation: 'send_text', missingChannelMessage: '缺少通道'});
      if (context.abortSignal?.aborted || context.executionScope?.identityTrust === 'untrusted'
        || !liveTarget.ok || liveTarget.chatId !== target.chatId) throw new Error('执行上下文已陈旧，停止发送或返回目录');
    };
    if (action === 'list') {
      const apps = await channel.listApps();
      assertLiveContext();
      return {ok: true, content: JSON.stringify(apps)};
    }
    if (!channel.replyWithMetadata) return {ok: false, errorCode: 'TOOL_EXECUTION_ERROR', message: '当前通道不支持 metadata，未发送打开请求'};
    const appId = typeof args.app_id === 'string' ? args.app_id.trim() : '';
    if (!appId || Array.from(appId).length > 128) throw new Error('app_id 无效');
    if (args.note !== undefined && typeof args.note !== 'string') throw new Error('note 必须为字符串');
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : '已发送应用打开请求，实际状态请查看应用面板。';
    const appOpen: Record<string, unknown> = {contract_version: 'catsco.app-open.v1', app_id: appId};
    let requestKey: string | undefined;
    if (action !== undefined) {
      if (typeof args.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(args.request_id)) throw new Error('request_id 无效');
      if (action === 'run' ? args.user_requested_run !== true : args.user_requested_run !== undefined && args.user_requested_run !== false) throw new Error('run 必须声明真实用户明确运行意图，initialize 不能运行');
      if (Buffer.byteLength(target.chatId, 'utf8') > 128) throw new Error('当前 topic 超过协议上限');
      appOpen.contract_version = 'catsco.app-open.v2';
      appOpen.handoff = {request_id: args.request_id, topic_id: target.chatId, action, parameters: parameters(args.parameters === undefined ? {} : args.parameters), user_requested_run: action === 'run'};
      requestKey = JSON.stringify([context.executionScope?.agentId ?? '', context.sessionId ?? '', target.chatId, args.request_id]);
    }
    const fingerprint = JSON.stringify(appOpen);
    if (requestKey) {
      const existing = this.requests.get(requestKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('重复 request_id 不可更改任务参数');
        return existing.result;
      }
      if (this.requests.size >= 1024) throw new Error('当前运行时请求记录已满，未发送；请核查既有应用任务');
    }
    let attemptedSend = false;
    const emit = async (): Promise<ToolExecutionResult> => {
      const apps = await channel.listApps!();
      assertLiveContext();
      if (!apps.some(app => app.id === appId)) throw new Error('app_id 不在当前 Agent 可信目录中');
      if (record(appOpen.handoff)) appOpen.handoff.expires_at = Date.now() + 60_000;
      attemptedSend = true;
      await channel.replyWithMetadata!(target.chatId, note, {app_open: appOpen});
      return {ok: true, content: `已发送应用 ${appId} 的请求；尚未确认面板打开、初始化或执行结果。${requestKey ? ` request_id=${String(args.request_id)}` : ''}`};
    };
    const result = emit().catch((error: unknown) => {
      // Preflight failures have never reached the wire; they may recover with
      // the same identity. Ambiguous transport failures remain permanently held.
      if (requestKey && !attemptedSend) this.requests.delete(requestKey);
      throw error;
    });
    if (requestKey) this.requests.set(requestKey, {fingerprint, result});
    return result;
  }
}
