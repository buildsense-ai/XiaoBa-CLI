import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/config';
import { ChatConfig } from '../types';
import { CatsCompanyConfig } from '../catscompany/types';
import {
  DEFAULT_CATSCO_HTTP_BASE_URL,
  createCatsCoLocalConfigService,
} from '../catscompany/local-config';
import { resolveCatsCoRuntimeConfig } from '../catscompany/runtime-config';
import { CatsCoDeviceConnector } from '../catscompany/device-connector';

export interface DeviceConnectorCommandOptions {
  pair?: string;
  name?: string;
  allowWrite?: boolean;
  allowShell?: boolean;
  capability?: string[];
  httpBaseUrl?: string;
  serverUrl?: string;
  runtimeRoot?: string;
}

export interface DeviceConnectorConfigResolution {
  config?: CatsCompanyConfig;
  missing: Array<'serverUrl' | 'connectorToken' | 'deviceId'>;
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return undefined;
}

function normalizeCapabilities(options: DeviceConnectorCommandOptions, saved?: string[]): string[] {
  const values = new Set<string>();
  for (const item of saved && saved.length > 0 ? saved : ['read_file', 'glob', 'grep']) {
    const text = String(item || '').trim();
    if (text) values.add(text);
  }
  for (const item of options.capability || []) {
    const text = String(item || '').trim();
    if (text) values.add(text);
  }
  if (options.allowWrite) values.add('write_file');
  if (options.allowShell) values.add('execute_shell');
  return Array.from(values);
}

function normalizeSavedCapabilities(saved?: string[]): string[] | undefined {
  if (!saved || saved.length === 0) return undefined;
  const values = new Set<string>();
  for (const item of saved) {
    const text = String(item || '').trim();
    if (text) values.add(text);
  }
  return values.size > 0 ? Array.from(values) : undefined;
}

function limitToApprovedCapabilities(capabilities: string[], approved?: string[]): string[] {
  if (!approved || approved.length === 0) return capabilities;
  const allowed = new Set(approved);
  return capabilities.filter(capability => allowed.has(capability));
}

export function resolveDeviceConnectorCommandConfig(
  config: ChatConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: DeviceConnectorCommandOptions = {},
): DeviceConnectorConfigResolution {
  const resolved = resolveCatsCoRuntimeConfig({
    runtimeRoot: options.runtimeRoot || process.env.XIAOBA_RUNTIME_ROOT || process.cwd(),
    env,
    config,
    overrides: {
      httpBaseUrl: options.httpBaseUrl,
      serverUrl: options.serverUrl,
    },
  });
  const local = resolved.localConfig;
  const saved = local.deviceConnector;
  const token = firstNonEmpty(
    env.CATSCO_CONNECTOR_TOKEN,
    env.CATSCOMPANY_CONNECTOR_TOKEN,
    saved?.token,
  );
  const deviceId = firstNonEmpty(
    env.CATSCO_DEVICE_ID,
    env.CATSCOMPANY_DEVICE_ID,
    saved?.deviceId,
    local.device?.deviceId,
  );
  const installationId = firstNonEmpty(
    env.CATSCO_INSTALLATION_ID,
    env.CATSCOMPANY_INSTALLATION_ID,
    saved?.installationId,
    local.device?.installationId,
    deviceId,
  );
  const serverUrl = firstNonEmpty(options.serverUrl, resolved.auth.serverUrl);
  const httpBaseUrl = firstNonEmpty(options.httpBaseUrl, resolved.auth.httpBaseUrl, DEFAULT_CATSCO_HTTP_BASE_URL);
  const approvedCapabilities = normalizeSavedCapabilities(saved?.capabilities);
  const capabilities = limitToApprovedCapabilities(normalizeCapabilities(options, saved?.capabilities), approvedCapabilities);

  const missing: DeviceConnectorConfigResolution['missing'] = [];
  if (!serverUrl) missing.push('serverUrl');
  if (!token) missing.push('connectorToken');
  if (!deviceId) missing.push('deviceId');

  return {
    missing,
    config: missing.length === 0 ? {
      serverUrl: serverUrl!,
      httpBaseUrl,
      authMode: 'device_connector',
      connectorToken: token,
      bodyId: deviceId,
      installationId,
      deviceName: options.name || saved?.name || local.device?.name,
      capabilities,
      allowWriteFile: capabilities.includes('write_file') && Boolean(options.allowWrite || saved?.allowWriteFile),
      allowShell: capabilities.includes('execute_shell') && Boolean(options.allowShell || saved?.allowShell),
    } : undefined,
  };
}

export async function deviceConnectorCommand(options: DeviceConnectorCommandOptions = {}): Promise<void> {
  const config = ConfigManager.getConfig();
  const runtimeRoot = options.runtimeRoot || process.env.XIAOBA_RUNTIME_ROOT || process.cwd();
  const service = createCatsCoLocalConfigService({ runtimeRoot });
  if (options.pair) {
    await enrollDeviceConnector(service, config, options);
  } else {
    await refreshSavedDeviceConnector(service, config, options).catch((err: any) => {
      Logger.warning(`CatsCo Device Connector token 刷新失败，将继续使用本地 token: ${err?.message || err}`);
    });
  }

  const resolved = resolveDeviceConnectorCommandConfig(config, process.env, options);
  if (!resolved.config) {
    Logger.error(`CatsCo Device Connector 配置缺失：${resolved.missing.join(', ') || 'unknown'}。`);
    Logger.error('请先在 CatsCo 网页端生成配对码，然后运行 catsco device-connector --pair <code>。');
    process.exit(1);
  }

  const connector = new CatsCoDeviceConnector(resolved.config);
  const shutdown = async () => {
    await connector.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await connector.start();
}

export async function enrollDeviceConnector(
  service: ReturnType<typeof createCatsCoLocalConfigService>,
  config: ChatConfig,
  options: DeviceConnectorCommandOptions,
): Promise<void> {
  const resolved = resolveCatsCoRuntimeConfig({
    runtimeRoot: options.runtimeRoot || process.env.XIAOBA_RUNTIME_ROOT || process.cwd(),
    config,
    overrides: {
      httpBaseUrl: options.httpBaseUrl,
      serverUrl: options.serverUrl,
    },
  });
  const deviceId = service.ensureDeviceId();
  const capabilities = normalizeCapabilities(options);
  const res = await fetch(`${resolved.auth.httpBaseUrl}/api/device-connectors/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairing_code: options.pair,
      device_id: deviceId,
      installation_id: deviceId,
      device_name: options.name,
      capabilities,
    }),
  });
  if (!res.ok) {
    let reason = '';
    try {
      const body = await res.json() as any;
      reason = String(body?.error || body?.message || '').trim();
    } catch {
      // Keep the status fallback below when the response is not JSON.
    }
    throw new Error(`CatsCo Device Connector 配对失败: ${reason || res.status}`);
  }
  const body = await res.json() as any;
  const token = String(body.connector_token || '').trim();
  const enrolledDevice = body.device || {};
  const enrolledDeviceId = String(enrolledDevice.deviceId || enrolledDevice.device_id || deviceId).trim();
  const installationId = String(enrolledDevice.installationId || enrolledDevice.installation_id || enrolledDeviceId).trim();
  const enrolledCapabilities = normalizeCapabilityList(enrolledDevice.capabilities || body.capabilities || capabilities);
  if (!token || !enrolledDeviceId) {
    throw new Error('CatsCo Device Connector 配对响应缺少 token 或 deviceId。');
  }
  service.writeDeviceConnectorEnrollment(resolved.auth, {
    token,
    ownerUid: String(enrolledDevice.ownerUserId || enrolledDevice.owner_user_id || resolved.auth.uid || ''),
    deviceId: enrolledDeviceId,
    installationId,
    name: String(enrolledDevice.displayName || enrolledDevice.display_name || options.name || ''),
    capabilities: enrolledCapabilities,
    allowWriteFile: Boolean(options.allowWrite && enrolledCapabilities.includes('write_file')),
    allowShell: Boolean(options.allowShell && enrolledCapabilities.includes('execute_shell')),
    tokenExpiresAt: tokenExpiresAtFromExpiresIn(body.expires_in),
  });
  Logger.success(`CatsCo Device Connector 已绑定设备：${enrolledDeviceId}`);
}

async function refreshSavedDeviceConnector(
  service: ReturnType<typeof createCatsCoLocalConfigService>,
  config: ChatConfig,
  options: DeviceConnectorCommandOptions,
): Promise<void> {
  const local = service.load();
  const connector = local.deviceConnector;
  if (!connector?.token) return;
  const resolved = resolveCatsCoRuntimeConfig({
    runtimeRoot: options.runtimeRoot || process.env.XIAOBA_RUNTIME_ROOT || process.cwd(),
    config,
    overrides: {
      httpBaseUrl: options.httpBaseUrl,
      serverUrl: options.serverUrl,
    },
  });
  const res = await fetch(`${resolved.auth.httpBaseUrl}/api/device-connectors/token/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `DeviceConnector ${connector.token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`refresh failed: ${res.status}`);
  }
  const body = await res.json() as any;
  const token = String(body.connector_token || '').trim();
  if (!token) {
    throw new Error('refresh response missing connector token');
  }
  service.writeDeviceConnectorEnrollment(resolved.auth, {
    token,
    ownerUid: connector.ownerUid,
    deviceId: connector.deviceId,
    installationId: connector.installationId,
    name: connector.name,
    capabilities: connector.capabilities,
    allowWriteFile: connector.allowWriteFile,
    allowShell: connector.allowShell,
    tokenExpiresAt: tokenExpiresAtFromExpiresIn(body.expires_in),
  });
}

function tokenExpiresAtFromExpiresIn(expiresIn: unknown): string | undefined {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function normalizeCapabilityList(value: unknown): string[] {
  if (!Array.isArray(value)) return ['read_file', 'glob', 'grep'];
  const values = new Set<string>();
  for (const item of value) {
    const text = String(item || '').trim();
    if (text) values.add(text);
  }
  return values.size > 0 ? Array.from(values) : ['read_file'];
}
