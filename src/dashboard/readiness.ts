import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillManager } from '../skills/skill-manager';
import { RuntimeSurface, validateRuntimeProfile } from '../runtime/runtime-profile';
import { resolveRuntimeProfileFromConfig } from '../runtime/runtime-profile-config';
import { ChatConfig } from '../types';
import { ServiceInfo, ServiceManager } from './service-manager';
import { readDashboardEnvFile } from './settings';
import { resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';
import { getWeixinChannelStatus } from './weixin-channel-binding';

export type DashboardReadinessStatus = 'ready' | 'warning' | 'blocked';
export type DashboardReadinessCheckStatus = 'pass' | 'warning' | 'fail';
export type DashboardReadinessCheckSeverity = 'blocker' | 'warning' | 'info';

export interface DashboardReadinessAction {
  label: string;
  target: 'settings' | 'catsco' | 'skills' | 'diagnostics' | 'service';
}

export interface DashboardReadinessCheck {
  id: string;
  label: string;
  status: DashboardReadinessCheckStatus;
  severity: DashboardReadinessCheckSeverity;
  message: string;
  action?: DashboardReadinessAction;
}

export interface DashboardReadinessSection {
  id: 'model' | 'catsco' | 'runtimeProfile' | 'skills';
  label: string;
  status: DashboardReadinessStatus;
  summary: string;
  checks: DashboardReadinessCheck[];
  action?: DashboardReadinessAction;
}

export interface DashboardServicePreflight {
  generatedAt: string;
  service: Pick<ServiceInfo, 'name' | 'label' | 'status'>;
  status: DashboardReadinessStatus;
  canStart: boolean;
  checks: DashboardReadinessCheck[];
  blockingChecks: string[];
  warningChecks: string[];
}

export interface DashboardReadinessSnapshot {
  generatedAt: string;
  status: DashboardReadinessStatus;
  sections: DashboardReadinessSection[];
  services: DashboardServicePreflight[];
  recentIssues: Array<{
    service: string;
    message: string;
  }>;
}

export interface DashboardReadinessOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  config?: ChatConfig;
  catsCoOverrides?: Record<string, unknown>;
  now?: Date;
}

const DEFAULT_MODEL_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL_NAME = 'gpt-3.5-turbo';
const SUPPORTED_PROVIDERS = new Set(['openai', 'anthropic']);
type SupportedProvider = 'openai' | 'anthropic';

export async function getDashboardReadiness(
  serviceManager: ServiceManager,
  options: DashboardReadinessOptions = {},
): Promise<DashboardReadinessSnapshot> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const runtimeRoot = path.resolve(options.runtimeRoot ?? process.cwd());
  const config = options.config ?? {};
  const env = getEffectiveCatsCoRuntimeEnv(runtimeRoot, getEffectiveDashboardEnv(runtimeRoot, options.env), config, options.catsCoOverrides);
  const services = serviceManager.getAll().map(service => getServicePreflight(
    serviceManager,
    service.name,
    { runtimeRoot, env, config, catsCoOverrides: options.catsCoOverrides, now: options.now },
  ));
  const sections = [
    buildModelSection(env, config),
    buildCatsCoSection(serviceManager, env, config),
    buildRuntimeProfileSection(runtimeRoot, env, config),
    await buildSkillsSection(runtimeRoot),
  ];

  return {
    generatedAt,
    status: combineStatuses(sections.map(section => section.status)),
    sections,
    services,
    recentIssues: serviceManager.getAll()
      .filter(service => service.lastError)
      .map(service => ({
        service: service.name,
        message: sanitizeRuntimeMessage(service.lastError || '', runtimeRoot),
      })),
  };
}

export function getServicePreflight(
  serviceManager: ServiceManager,
  name: string,
  options: DashboardReadinessOptions = {},
): DashboardServicePreflight {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? process.cwd());
  const config = options.config ?? {};
  const env = getEffectiveCatsCoRuntimeEnv(runtimeRoot, getEffectiveDashboardEnv(runtimeRoot, options.env), config, options.catsCoOverrides);
  const service = serviceManager.getService(name);
  if (!service) {
    throw new Error(`Service "${name}" not found`);
  }

  const checks = [
    ...buildModelChecks(env, config),
    ...buildRuntimeChecks(service, runtimeRoot, env, config, serviceNameToSurface(name)),
    ...buildServiceSpecificChecks(name, env, config, runtimeRoot),
  ];
  const status = statusFromChecks(checks);

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    service: {
      name: service.name,
      label: service.label,
      status: service.status,
    },
    status,
    canStart: status !== 'blocked' && service.status !== 'running',
    checks,
    blockingChecks: checks
      .filter(check => check.status === 'fail' && check.severity === 'blocker')
      .map(check => check.id),
    warningChecks: checks
      .filter(check => check.status !== 'pass' && check.severity === 'warning')
      .map(check => check.id),
  };
}

function getEffectiveDashboardEnv(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...readDashboardEnvFile(runtimeRoot),
  };
}

function getEffectiveCatsCoRuntimeEnv(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  config: ChatConfig,
  catsCoOverrides?: Record<string, unknown>,
): NodeJS.ProcessEnv {
  const catsCoRuntime = resolveCatsCoRuntimeConfig({
    runtimeRoot,
    env,
    config,
    overrides: catsCoOverrides,
    migrateLegacyEnvBinding: true,
  });
  const effectiveEnv = {
    ...env,
    ...catsCoRuntime.envOverlay,
  };
  if (!catsCoRuntime.bodyConfigured) {
    delete effectiveEnv.CATSCO_BOT_UID;
    delete effectiveEnv.CATSCOMPANY_BOT_UID;
    delete effectiveEnv.CATSCO_API_KEY;
    delete effectiveEnv.CATSCOMPANY_API_KEY;
  }
  return effectiveEnv;
}

function buildModelSection(
  env: NodeJS.ProcessEnv,
  config: ChatConfig,
): DashboardReadinessSection {
  const checks = buildModelChecks(env, config);
  const status = statusFromChecks(checks);
  const customReady = checks
    .filter(check => check.id.startsWith('model.custom.'))
    .every(check => check.status === 'pass');
  const relayReady = checks.some(check => check.id === 'model.managed.relay' && check.status === 'pass');
  return {
    id: 'model',
    label: '模型来源',
    status,
    summary: relayReady
      ? '当前使用 CatsCo 中转模型启动本地 agent'
      : customReady
      ? '当前使用自定义模型启动本地 agent；也可以一键切换 CatsCo 中转'
      : '当前需要配置模型来源，可登录 CatsCo 后启用中转模型',
    checks,
    action: status === 'ready' ? undefined : { label: '打开设置', target: 'settings' },
  };
}

function buildModelChecks(
  env: NodeJS.ProcessEnv,
  config: ChatConfig,
): DashboardReadinessCheck[] {
  const provider = resolveProvider(env, config);
  const apiBase = resolveModelApiBase(env, config);
  const model = resolveModelName(env, config);
  const apiKey = firstNonEmpty(env.GAUZ_LLM_API_KEY, config.apiKey);
  const catsCoToken = firstNonEmpty(env.CATSCO_USER_TOKEN, env.CATSCOMPANY_USER_TOKEN);
  const catsCoUserUid = firstNonEmpty(env.CATSCO_USER_UID, env.CATSCOMPANY_USER_UID);
  const relayConfigured = isCatsRelayModelConfigured(provider, apiBase, model, apiKey);
  const relayCheck = relayConfigured
    ? passCheck(
      'model.managed.relay',
      'CatsCo 中转模型',
      `已启用 CatsCo 中转：${provider} / ${model}`,
    )
    : catsCoToken && catsCoUserUid
      ? failCheck(
        'model.managed.relay',
        'CatsCo 中转模型',
        '已登录 CatsCo，可在设置里一键启用 CatsCo 中转模型',
        'warning',
        { label: '打开设置', target: 'settings' },
      )
      : failCheck(
        'model.managed.account',
        'CatsCo 中转模型',
        '登录 CatsCo 后才可使用中转模型；当前请使用自定义模型',
        'warning',
        { label: '打开 CatsCo', target: 'catsco' },
      );

  if (relayConfigured) {
    return [relayCheck];
  }

  return [
    relayCheck,
    provider && SUPPORTED_PROVIDERS.has(provider)
      ? passCheck('model.custom.provider', '自定义模型服务', `自定义模型服务类型为 ${provider}`)
      : failCheck('model.custom.provider', '自定义模型服务', '自定义模型服务类型不受支持', 'blocker', {
        label: '打开设置',
        target: 'settings',
      }),
    isValidUrl(apiBase, ['http:', 'https:'])
      ? passCheck('model.custom.apiBase', '自定义模型地址', '自定义模型地址格式有效')
      : failCheck('model.custom.apiBase', '自定义模型地址', '自定义模型地址必须是有效的 HTTP(S) URL', 'blocker', {
        label: '打开设置',
        target: 'settings',
      }),
    model
      ? passCheck('model.custom.model', '自定义模型', `自定义模型已选择：${model}`)
      : failCheck('model.custom.model', '自定义模型', '需要选择自定义模型', 'blocker', {
        label: '打开设置',
        target: 'settings',
      }),
    apiKey
      ? passCheck('model.custom.credential', '自定义模型访问凭证', '自定义模型访问凭证已配置')
      : failCheck('model.custom.credential', '自定义模型访问凭证', '需要先配置自定义模型访问凭证', 'blocker', {
        label: '打开设置',
        target: 'settings',
      }),
  ];
}

function buildRuntimeProfileSection(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  config: ChatConfig,
): DashboardReadinessSection {
  const checks = buildRuntimeProfileChecks(runtimeRoot, env, config, 'catscompany');
  const status = statusFromChecks(checks);
  return {
    id: 'runtimeProfile',
    label: 'Runtime Profile',
    status,
    summary: status === 'ready'
      ? 'Runtime Profile 可用于新 session'
      : 'Runtime Profile 需要处理后再启动',
    checks,
    action: status === 'ready' ? undefined : { label: '打开设置', target: 'settings' },
  };
}

function buildRuntimeChecks(
  service: ServiceInfo,
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  config: ChatConfig,
  surface: RuntimeSurface,
): DashboardReadinessCheck[] {
  return [
    commandExists(service.command, env)
      ? passCheck('runtime.command', '启动命令', '启动命令可用')
      : failCheck('runtime.command', '启动命令', '启动命令不可用，请检查安装状态', 'blocker', {
        label: '打开诊断',
        target: 'diagnostics',
      }),
    ...buildRuntimeProfileChecks(runtimeRoot, env, config, surface),
  ];
}

function buildRuntimeProfileChecks(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  config: ChatConfig,
  surface: RuntimeSurface,
): DashboardReadinessCheck[] {
  const provider = resolveProvider(env, config);
  const resolved = resolveRuntimeProfileFromConfig({
    env,
    runtimeRoot,
    workingDirectory: runtimeRoot,
    surface,
    model: {
      provider: isSupportedProvider(provider) ? provider : undefined,
      apiUrl: resolveModelApiBase(env, config),
      model: resolveModelName(env, config),
    },
  });
  const validationIssues = validateRuntimeProfile(resolved.profile);
  const profileIssues = [
    ...resolved.config.issues.map(issue => `${issue.path}: ${issue.message}`),
    ...validationIssues.map(issue => summarizeRuntimeValidationIssue(issue)),
  ];

  return [
    profileIssues.length === 0
      ? passCheck('runtime.profile', 'Profile 校验', 'Runtime Profile 校验通过')
      : failCheck(
        'runtime.profile',
        'Profile 校验',
        sanitizeRuntimeMessage(profileIssues.join('; '), runtimeRoot),
        'blocker',
        { label: '打开设置', target: 'settings' },
      ),
    fs.existsSync(resolved.profile.workingDirectory)
      ? passCheck('runtime.workingDirectory', '工作目录', '工作目录可访问')
      : failCheck('runtime.workingDirectory', '工作目录', '工作目录不可访问', 'blocker', {
        label: '打开设置',
        target: 'settings',
      }),
  ];
}

function buildCatsCoSection(
  serviceManager: ServiceManager,
  env: NodeJS.ProcessEnv,
  config: ChatConfig,
): DashboardReadinessSection {
  const service = serviceManager.getService('catscompany');
  const checks = buildCatsCoChatChecks(env, config);
  if (service?.status === 'running') {
    checks.push(passCheck('catsco.connector', 'CatsCompany connector', 'CatsCompany connector 正在运行'));
  } else if (statusFromChecks(checks) === 'ready') {
    checks.push(failCheck('catsco.connector', 'CatsCompany connector', 'CatsCompany connector 尚未启动', 'warning', {
      label: '启动 CatsCompany connector',
      target: 'service',
    }));
  } else {
    checks.push(failCheck('catsco.connector', 'CatsCompany connector', '完成 CatsCo 账号和 agent 绑定后再启动 CatsCompany connector', 'warning', {
      label: '打开 CatsCo',
      target: 'catsco',
    }));
  }

  const status = statusFromChecks(checks);
  return {
    id: 'catsco',
    label: 'CatsCo Chat',
    status,
    summary: status === 'ready'
      ? 'CatsCo Chat 可对话'
      : 'CatsCo Chat 还没有准备好',
    checks,
    action: status === 'ready' ? { label: '打开 Chat', target: 'catsco' } : { label: '打开 CatsCo', target: 'catsco' },
  };
}

function buildCatsCoChatChecks(
  env: NodeJS.ProcessEnv,
  config: ChatConfig,
): DashboardReadinessCheck[] {
  const accountToken = firstNonEmpty(env.CATSCO_USER_TOKEN, env.CATSCOMPANY_USER_TOKEN);
  const userUid = firstNonEmpty(env.CATSCO_USER_UID, env.CATSCOMPANY_USER_UID);
  const botUid = firstNonEmpty(env.CATSCO_BOT_UID, env.CATSCOMPANY_BOT_UID);
  const apiKey = firstNonEmpty(env.CATSCO_API_KEY, env.CATSCOMPANY_API_KEY, config.catscompany?.apiKey);
  const httpBaseUrl = firstNonEmpty(
    env.CATSCO_HTTP_BASE_URL,
    env.CATSCOMPANY_HTTP_BASE_URL,
    config.catscompany?.httpBaseUrl,
  )
    || 'https://app.catsco.cc';
  const serverUrl = firstNonEmpty(
    env.CATSCO_SERVER_URL,
    env.CATSCOMPANY_SERVER_URL,
    config.catscompany?.serverUrl,
  );

  return [
    isValidUrl(httpBaseUrl, ['http:', 'https:'])
      ? passCheck('catsco.httpBaseUrl', 'CatsCo API 地址', 'CatsCo API 地址格式有效')
      : failCheck('catsco.httpBaseUrl', 'CatsCo API 地址', 'CatsCo API 地址必须是有效的 HTTP(S) URL', 'blocker', {
        label: '打开设置',
        target: 'settings',
      }),
    serverUrl && isValidUrl(serverUrl, ['ws:', 'wss:'])
      ? passCheck('catsco.serverUrl', 'CatsCo 服务器 WebSocket', 'CatsCo 服务器 WebSocket 地址格式有效')
      : failCheck('catsco.serverUrl', 'CatsCo 服务器 WebSocket', '需要配置 CatsCo 服务器 WebSocket 地址', 'blocker', {
        label: '打开设置',
        target: 'settings',
      }),
    accountToken && userUid
      ? passCheck('catsco.account', '账号', 'CatsCo 账号已登录')
      : failCheck('catsco.account', '账号', '需要先登录 CatsCo 账号', 'blocker', {
        label: '打开 CatsCo',
        target: 'catsco',
      }),
    apiKey && botUid
      ? passCheck('catsco.binding', 'Agent 绑定', 'CatsCo agent 已绑定')
      : failCheck('catsco.binding', 'Agent 绑定', '需要创建或绑定 CatsCo agent', 'blocker', {
        label: '打开 CatsCo',
        target: 'catsco',
      }),
    userUid && botUid
      ? passCheck('catsco.topic', 'Chat 会话', 'Chat 会话已就绪')
      : failCheck('catsco.topic', 'Chat 会话', '账号和 agent 绑定后才能生成 Chat 会话', 'blocker', {
        label: '打开 CatsCo',
        target: 'catsco',
      }),
  ];
}

function buildServiceSpecificChecks(
  name: string,
  env: NodeJS.ProcessEnv,
  config: ChatConfig,
  runtimeRoot: string,
): DashboardReadinessCheck[] {
  if (name === 'catscompany') {
    const serverUrl = firstNonEmpty(
      env.CATSCO_SERVER_URL,
      env.CATSCOMPANY_SERVER_URL,
      config.catscompany?.serverUrl,
    );
    const apiKey = firstNonEmpty(
      env.CATSCO_API_KEY,
      env.CATSCOMPANY_API_KEY,
      config.catscompany?.apiKey,
    );
    return [
      serverUrl && isValidUrl(serverUrl, ['ws:', 'wss:'])
        ? passCheck('service.catsco.serverUrl', 'CatsCo 服务器 WebSocket', 'CatsCo 服务器 WebSocket 地址格式有效')
        : failCheck('service.catsco.serverUrl', 'CatsCo 服务器 WebSocket', '需要配置 CatsCo 服务器 WebSocket 地址', 'blocker', {
          label: '打开设置',
          target: 'settings',
        }),
      apiKey
        ? passCheck('service.catsco.apiKey', 'CatsCo Agent 凭证', 'CatsCo Agent 凭证已配置')
        : failCheck('service.catsco.apiKey', 'CatsCo Agent 凭证', '需要配置 CatsCo agent 访问凭证', 'blocker', {
          label: '打开 CatsCo',
          target: 'catsco',
        }),
    ];
  }

  if (name === 'feishu') {
    return [
      firstNonEmpty(env.FEISHU_APP_ID, config.feishu?.appId)
        ? passCheck('service.feishu.appId', '飞书 App ID', '飞书 App ID 已配置')
        : failCheck('service.feishu.appId', '飞书 App ID', '需要配置 FEISHU_APP_ID', 'blocker', {
          label: '打开设置',
          target: 'settings',
        }),
      firstNonEmpty(env.FEISHU_APP_SECRET, config.feishu?.appSecret)
        ? passCheck('service.feishu.appSecret', '飞书 App Secret', '飞书 App Secret 已配置')
        : failCheck('service.feishu.appSecret', '飞书 App Secret', '需要配置 FEISHU_APP_SECRET', 'blocker', {
          label: '打开设置',
          target: 'settings',
        }),
    ];
  }

  if (name === 'weixin') {
    const status = getWeixinChannelStatus({ runtimeRoot, env });
    return [
      status.currentAgent
        ? passCheck('service.weixin.agent', '微信所属 Agent', `微信将接入当前 agent ${status.currentAgent.name || status.currentAgent.uid}`)
        : failCheck('service.weixin.agent', '微信所属 Agent', status.reason || '请先选择并绑定 CatsCo agent', 'blocker', {
          label: '打开 CatsCo',
          target: 'catsco',
        }),
      status.configured
        ? passCheck('service.weixin.binding', '微信通道绑定', `微信通道已绑定到 agent ${status.binding?.agentName || status.binding?.agentUid}`)
        : failCheck('service.weixin.binding', '微信通道绑定', status.reason || '请先在当前 agent 下扫码绑定微信', 'blocker', {
          label: '打开设置',
          target: 'settings',
        }),
      firstNonEmpty(env.WEIXIN_TOKEN)
        ? passCheck('service.weixin.token', '微信 Token', '微信 Token 已配置')
        : failCheck('service.weixin.token', '微信 Token', '需要在当前 agent 下扫码获取微信 Token', 'blocker', {
          label: '打开设置',
          target: 'settings',
        }),
    ];
  }

  return [];
}

async function buildSkillsSection(runtimeRoot: string): Promise<DashboardReadinessSection> {
  const checks: DashboardReadinessCheck[] = [];
  const manager = new SkillManager();

  try {
    await manager.loadSkills();
    checks.push(passCheck('skills.load', 'Skills', 'Skills 可加载'));
  } catch (error: any) {
    checks.push(failCheck(
      'skills.load',
      'Skills',
      sanitizeRuntimeMessage(error?.message || String(error), runtimeRoot),
      'warning',
      { label: '打开 Skills', target: 'skills' },
    ));
  }

  const status = statusFromChecks(checks);
  return {
    id: 'skills',
    label: 'Skills',
    status,
    summary: status === 'ready'
      ? `${manager.getAllSkills().length} 个 skill 已加载`
      : 'Skill 状态需要在 Skill Hub 中查看',
    checks,
    action: { label: '打开 Skills', target: 'skills' },
  };
}

function resolveProvider(env: NodeJS.ProcessEnv, config: ChatConfig): string {
  const explicit = firstNonEmpty(env.GAUZ_LLM_PROVIDER)?.toLowerCase();
  if (explicit) return explicit;
  if (config.provider) return config.provider;

  const apiBase = resolveModelApiBase(env, config).toLowerCase();
  const model = resolveModelName(env, config).toLowerCase();
  return apiBase.includes('anthropic') || apiBase.includes('claude') || model.includes('claude')
    ? 'anthropic'
    : 'openai';
}

function isSupportedProvider(value: string): value is SupportedProvider {
  return SUPPORTED_PROVIDERS.has(value);
}

function resolveModelApiBase(env: NodeJS.ProcessEnv, config: ChatConfig): string {
  return firstNonEmpty(env.GAUZ_LLM_API_BASE, config.apiUrl) || DEFAULT_MODEL_API_BASE;
}

function resolveModelName(env: NodeJS.ProcessEnv, config: ChatConfig): string {
  return firstNonEmpty(env.GAUZ_LLM_MODEL, config.model) || DEFAULT_MODEL_NAME;
}

function isCatsRelayModelConfigured(
  provider: string,
  apiBase: string,
  model: string,
  apiKey?: string,
): boolean {
  if (!apiKey || !model) return false;
  if (provider !== 'anthropic' && provider !== 'openai') return false;

  try {
    const parsed = new URL(apiBase);
    return parsed.hostname.toLowerCase() === 'relay.catsco.cc';
  } catch {
    return apiBase.toLowerCase().includes('relay.catsco.cc');
  }
}

function summarizeRuntimeValidationIssue(issue: { path: string; message: string }): string {
  if (issue.path.startsWith('tools.enabled')) {
    if (/Duplicate runtime tool/i.test(issue.message)) {
      return `${issue.path}: Duplicate runtime tool configured`;
    }
    if (/Unknown runtime tool/i.test(issue.message)) {
      return `${issue.path}: Unknown runtime tool configured`;
    }
  }
  return `${issue.path}: Invalid runtime profile value`;
}

function serviceNameToSurface(name: string): RuntimeSurface {
  if (name === 'feishu') return 'feishu';
  if (name === 'catscompany') return 'catscompany';
  if (name === 'weixin') return 'weixin';
  return 'cli';
}

function statusFromChecks(checks: DashboardReadinessCheck[]): DashboardReadinessStatus {
  if (checks.some(check => check.status === 'fail' && check.severity === 'blocker')) {
    return 'blocked';
  }
  if (checks.some(check => check.status !== 'pass')) {
    return 'warning';
  }
  return 'ready';
}

function combineStatuses(statuses: DashboardReadinessStatus[]): DashboardReadinessStatus {
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('warning')) return 'warning';
  return 'ready';
}

function passCheck(id: string, label: string, message: string): DashboardReadinessCheck {
  return {
    id,
    label,
    status: 'pass',
    severity: 'info',
    message,
  };
}

function failCheck(
  id: string,
  label: string,
  message: string,
  severity: 'blocker' | 'warning',
  action?: DashboardReadinessAction,
): DashboardReadinessCheck {
  return {
    id,
    label,
    status: severity === 'warning' ? 'warning' : 'fail',
    severity,
    message,
    action,
  };
}

function isValidUrl(value: string | undefined, protocols: string[]): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return undefined;
}

function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  if (path.isAbsolute(trimmed) || trimmed.includes(path.sep)) {
    return fs.existsSync(trimmed);
  }

  const searchPath = env.PATH || process.env.PATH || '';
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean)
    : [''];
  const candidates = process.platform === 'win32' && path.extname(trimmed)
    ? [trimmed]
    : [trimmed, ...extensions.map(extension => `${trimmed}${extension.toLowerCase()}`), ...extensions.map(extension => `${trimmed}${extension.toUpperCase()}`)];

  return searchPath
    .split(path.delimiter)
    .filter(Boolean)
    .some(dir => candidates.some(candidate => fs.existsSync(path.join(dir, candidate))));
}

function sanitizeRuntimeMessage(message: string, runtimeRoot: string): string {
  const replacements = [
    runtimeRoot,
    os.homedir(),
  ].filter(Boolean);

  return replacements.reduce((text, value) => (
    text.split(value).join('[path]')
  ), message);
}
