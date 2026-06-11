import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { randomUUID } from 'crypto';

export interface CatsCoLocalAccount {
  token: string;
  uid: string;
  username?: string;
  displayName?: string;
}

export interface CatsCoLocalBot {
  uid: string;
  name?: string;
  username?: string;
  apiKey: string;
  boundAt?: string;
  boundByUserUid?: string;
  bindingSource?: string;
}

export interface CatsCoLocalDevice {
  deviceId: string;
  bodyId: string;
  installationId: string;
  name?: string;
}

export interface CatsCoLocalDeviceConnector {
  token: string;
  ownerUid?: string;
  deviceId: string;
  installationId: string;
  name?: string;
  capabilities?: string[];
  allowWriteFile?: boolean;
  allowShell?: boolean;
  pairedAt?: string;
  tokenExpiresAt?: string;
}

export interface CatsCoLocalConfig {
  version: 1;
  endpoints?: {
    httpBaseUrl?: string;
    serverUrl?: string;
  };
  account?: CatsCoLocalAccount;
  currentBot?: CatsCoLocalBot;
  device?: CatsCoLocalDevice;
  deviceConnector?: CatsCoLocalDeviceConnector;
  preferences?: {
    autoConnect?: boolean;
    switchConfirmEnabled?: boolean;
    closeToTray?: boolean;
  };
  updatedAt?: string;
}

export interface CatsCoAuthSnapshot {
  token?: string;
  uid?: string;
  username?: string;
  displayName?: string;
  httpBaseUrl: string;
  serverUrl: string;
  botUid?: string;
  apiKey?: string;
}

export interface CatsCoLocalConfigServiceOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_CATSCO_HTTP_BASE_URL = 'https://app.catsco.cc';
export const DEFAULT_CATSCO_WS_URL = 'wss://app.catsco.cc/v0/channels';

const CONFIG_VERSION = 1;

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return undefined;
}

function normalizeBaseUrl(
  value: unknown,
  fallback: string,
  options: { upgradeCatsCoHttp?: boolean } = {},
): string {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return fallback;
  if (options.upgradeCatsCoHttp) {
    try {
      const url = new URL(text);
      if (url.protocol === 'http:' && url.hostname === 'app.catsco.cc') {
        url.protocol = 'https:';
        return url.toString().replace(/\/+$/, '');
      }
    } catch {
      // Keep validation at the caller boundary; this helper only normalizes known legacy values.
    }
  }
  return text;
}

function readEnvFile(runtimeRoot: string): Record<string, string> {
  const envPath = path.join(runtimeRoot, '.env');
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
}

function writeEnvUpdates(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  updates: Record<string, string | undefined>,
): string[] {
  const envPath = path.join(runtimeRoot, '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const updatedKeys: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const escaped = value.replace(/\n/g, '\\n');
    const line = `${key}=${escaped}`;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content += `${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${line}\n`;
    }
    env[key] = value;
    updatedKeys.push(key);
  }

  fs.writeFileSync(envPath, content, { encoding: 'utf-8', mode: 0o600 });
  chmodOwnerOnly(envPath);
  return updatedKeys;
}

function removeEnvKeys(runtimeRoot: string, env: NodeJS.ProcessEnv, keys: string[]): string[] {
  const envPath = path.join(runtimeRoot, '.env');
  const removed: string[] = [];

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
      removed.push(key);
    }
  }

  if (!fs.existsSync(envPath)) return removed;

  let content = fs.readFileSync(envPath, 'utf-8');
  for (const key of keys) {
    const regex = new RegExp(`^${key}=.*(?:\\r?\\n|$)`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, '');
      if (!removed.includes(key)) removed.push(key);
    }
  }

  fs.writeFileSync(envPath, content, { encoding: 'utf-8', mode: 0o600 });
  chmodOwnerOnly(envPath);
  return removed;
}

function chmodOwnerOnly(filePath: string, mode = 0o600): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Permission hardening should not make existing installs unusable.
  }
}

function chmodPrivateDirectory(dirPath: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Best-effort hardening for existing directories.
  }
}

export function resolveCatsCoLocalConfigPath(
  runtimeRoot = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = firstNonEmpty(env.CATSCO_LOCAL_CONFIG_PATH, env.CATSCO_CONFIG_PATH);
  if (explicit) return path.resolve(explicit);
  return path.join(runtimeRoot, '.xiaoba', 'catsco.json');
}

export class CatsCoLocalConfigService {
  private readonly runtimeRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly configPath: string;

  constructor(options: CatsCoLocalConfigServiceOptions = {}) {
    this.runtimeRoot = options.runtimeRoot || process.cwd();
    this.env = options.env || process.env;
    this.configPath = resolveCatsCoLocalConfigPath(this.runtimeRoot, this.env);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  load(): CatsCoLocalConfig {
    if (!fs.existsSync(this.configPath)) {
      return this.defaultConfig();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      if (parsed && parsed.version === CONFIG_VERSION) {
        return parsed as CatsCoLocalConfig;
      }
    } catch {
      // Fall through to default config. The caller can still recover from legacy .env.
    }
    return this.defaultConfig();
  }

  save(config: CatsCoLocalConfig): void {
    const dirPath = path.dirname(this.configPath);
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    chmodPrivateDirectory(dirPath);
    const next: CatsCoLocalConfig = {
      ...config,
      version: CONFIG_VERSION,
      updatedAt: new Date().toISOString(),
    };
    const tempPath = `${this.configPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
    chmodOwnerOnly(tempPath);
    fs.renameSync(tempPath, this.configPath);
    chmodOwnerOnly(this.configPath);
  }

  getAuthState(overrides: Record<string, unknown> = {}): CatsCoAuthSnapshot {
    const config = this.load();
    const legacy = readEnvFile(this.runtimeRoot);
    const account = config.account;
    const endpoints = config.endpoints || {};
    const bot = config.currentBot;

    return {
      token: firstNonEmpty(
        overrides.token,
        this.env.CATSCO_USER_TOKEN,
        legacy.CATSCO_USER_TOKEN,
        this.env.CATSCOMPANY_USER_TOKEN,
        legacy.CATSCOMPANY_USER_TOKEN,
        account?.token,
      ),
      uid: firstNonEmpty(
        overrides.uid,
        this.env.CATSCO_USER_UID,
        legacy.CATSCO_USER_UID,
        this.env.CATSCOMPANY_USER_UID,
        legacy.CATSCOMPANY_USER_UID,
        account?.uid,
      ),
      username: firstNonEmpty(
        this.env.CATSCO_USER_NAME,
        legacy.CATSCO_USER_NAME,
        this.env.CATSCOMPANY_USER_NAME,
        legacy.CATSCOMPANY_USER_NAME,
        account?.username,
      ),
      displayName: firstNonEmpty(
        this.env.CATSCO_USER_DISPLAY_NAME,
        legacy.CATSCO_USER_DISPLAY_NAME,
        this.env.CATSCOMPANY_USER_DISPLAY_NAME,
        legacy.CATSCOMPANY_USER_DISPLAY_NAME,
        account?.displayName,
      ),
      httpBaseUrl: normalizeBaseUrl(
        firstNonEmpty(
          overrides.httpBaseUrl,
          this.env.CATSCO_HTTP_BASE_URL,
          legacy.CATSCO_HTTP_BASE_URL,
          this.env.CATSCOMPANY_HTTP_BASE_URL,
          legacy.CATSCOMPANY_HTTP_BASE_URL,
          endpoints.httpBaseUrl,
        ),
        DEFAULT_CATSCO_HTTP_BASE_URL,
        { upgradeCatsCoHttp: true },
      ),
      serverUrl: normalizeBaseUrl(
        firstNonEmpty(
          overrides.serverUrl,
          this.env.CATSCO_SERVER_URL,
          legacy.CATSCO_SERVER_URL,
          this.env.CATSCOMPANY_SERVER_URL,
          legacy.CATSCOMPANY_SERVER_URL,
          endpoints.serverUrl,
        ),
        DEFAULT_CATSCO_WS_URL,
      ),
      botUid: firstNonEmpty(
        overrides.botUid,
        bot?.uid,
        this.env.CATSCO_BOT_UID,
        legacy.CATSCO_BOT_UID,
        this.env.CATSCOMPANY_BOT_UID,
        legacy.CATSCOMPANY_BOT_UID,
      ),
      apiKey: firstNonEmpty(
        overrides.apiKey,
        bot?.apiKey,
        this.env.CATSCO_API_KEY,
        legacy.CATSCO_API_KEY,
        this.env.CATSCOMPANY_API_KEY,
        legacy.CATSCOMPANY_API_KEY,
      ),
    };
  }

  persistAccountSession(state: CatsCoAuthSnapshot, login: any): string[] {
    const uid = String(login.uid || state.uid || '').trim();
    const username = String(login.username || state.username || '').trim();
    const displayName = String(login.display_name || login.username || state.displayName || username || '').trim();
    const token = String(login.token || state.token || '').trim();
    const config = this.load();
    this.save({
      ...config,
      endpoints: {
        ...(config.endpoints || {}),
        httpBaseUrl: state.httpBaseUrl,
        serverUrl: state.serverUrl,
      },
      account: token ? {
        token,
        uid,
        username,
        displayName,
      } : config.account,
    });

    return writeEnvUpdates(this.runtimeRoot, this.env, {
      CATSCO_HTTP_BASE_URL: state.httpBaseUrl,
      CATSCO_SERVER_URL: state.serverUrl,
      CATSCO_USER_TOKEN: token,
      CATSCO_USER_UID: uid,
      CATSCO_USER_NAME: username,
      CATSCO_USER_DISPLAY_NAME: displayName,
      CATSCOMPANY_HTTP_BASE_URL: state.httpBaseUrl,
      CATSCOMPANY_SERVER_URL: state.serverUrl,
      CATSCOMPANY_USER_TOKEN: token,
      CATSCOMPANY_USER_UID: uid,
      CATSCOMPANY_USER_NAME: username,
      CATSCOMPANY_USER_DISPLAY_NAME: displayName,
    });
  }

  ensureDeviceId(): string {
    const config = this.load();
    const legacy = readEnvFile(this.runtimeRoot);
    const existing = firstNonEmpty(
      config.device?.deviceId,
      this.env.CATSCO_DEVICE_ID,
      legacy.CATSCO_DEVICE_ID,
      this.env.CATSCOMPANY_DEVICE_ID,
      legacy.CATSCOMPANY_DEVICE_ID,
    );
    const deviceId = existing || `device_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const device = {
      ...(config.device || {}),
      deviceId,
      bodyId: config.device?.bodyId || deviceId,
      installationId: config.device?.installationId || deviceId,
    };
    this.save({ ...config, device });
    writeEnvUpdates(this.runtimeRoot, this.env, {
      CATSCO_DEVICE_ID: deviceId,
      CATSCOMPANY_DEVICE_ID: deviceId,
    });
    return deviceId;
  }

  writeBotBinding(state: CatsCoAuthSnapshot, input: {
    userUid: string;
    username?: string;
    displayName?: string;
    botUid: string;
    botName?: string;
    botUsername?: string;
    apiKey: string;
    bindingSource?: string;
  }): string[] {
    const deviceId = this.ensureDeviceId();
    const username = input.username || state.username || '';
    const displayName = input.displayName || input.username || state.displayName || '';
    const config = this.load();
    this.save({
      ...config,
      endpoints: {
        ...(config.endpoints || {}),
        httpBaseUrl: state.httpBaseUrl,
        serverUrl: state.serverUrl,
      },
      account: state.token ? {
        token: state.token,
        uid: input.userUid,
        username,
        displayName,
      } : config.account,
      currentBot: {
        uid: input.botUid,
        name: input.botName || config.currentBot?.name || 'Bot',
        username: input.botUsername || config.currentBot?.username || '',
        apiKey: input.apiKey,
        boundAt: new Date().toISOString(),
        boundByUserUid: input.userUid,
        bindingSource: input.bindingSource || 'explicit',
      },
      device: {
        ...(config.device || {}),
        deviceId,
        bodyId: deviceId,
        installationId: deviceId,
      },
    });

    return writeEnvUpdates(this.runtimeRoot, this.env, {
      CATSCO_HTTP_BASE_URL: state.httpBaseUrl,
      CATSCO_SERVER_URL: state.serverUrl,
      CATSCO_USER_TOKEN: state.token,
      CATSCO_USER_UID: input.userUid,
      CATSCO_USER_NAME: username,
      CATSCO_USER_DISPLAY_NAME: displayName,
      CATSCO_BOT_UID: input.botUid,
      CATSCO_API_KEY: input.apiKey,
      CATSCO_BODY_ID: deviceId,
      CATSCO_INSTALLATION_ID: deviceId,
      CATSCOMPANY_HTTP_BASE_URL: state.httpBaseUrl,
      CATSCOMPANY_SERVER_URL: state.serverUrl,
      CATSCOMPANY_USER_TOKEN: state.token,
      CATSCOMPANY_USER_UID: input.userUid,
      CATSCOMPANY_USER_NAME: username,
      CATSCOMPANY_USER_DISPLAY_NAME: displayName,
      CATSCOMPANY_BOT_UID: input.botUid,
      CATSCOMPANY_API_KEY: input.apiKey,
      CATSCOMPANY_BODY_ID: deviceId,
      CATSCOMPANY_INSTALLATION_ID: deviceId,
    });
  }

  writeDeviceConnectorEnrollment(state: CatsCoAuthSnapshot, input: {
    token: string;
    ownerUid?: string;
    deviceId: string;
    installationId?: string;
    name?: string;
    capabilities?: string[];
    allowWriteFile?: boolean;
    allowShell?: boolean;
    tokenExpiresAt?: string;
  }): string[] {
    const deviceId = String(input.deviceId || '').trim();
    if (!deviceId) {
      throw new Error('deviceId is required');
    }
    const installationId = String(input.installationId || deviceId).trim();
    const config = this.load();
    this.save({
      ...config,
      endpoints: {
        ...(config.endpoints || {}),
        httpBaseUrl: state.httpBaseUrl,
        serverUrl: state.serverUrl,
      },
      device: {
        ...(config.device || {}),
        deviceId,
        bodyId: deviceId,
        installationId,
        name: input.name || config.device?.name,
      },
      deviceConnector: {
        token: input.token,
        ownerUid: input.ownerUid || state.uid,
        deviceId,
        installationId,
        name: input.name,
        capabilities: input.capabilities,
        allowWriteFile: Boolean(input.allowWriteFile),
        allowShell: Boolean(input.allowShell),
        pairedAt: new Date().toISOString(),
        tokenExpiresAt: input.tokenExpiresAt,
      },
    });

    return writeEnvUpdates(this.runtimeRoot, this.env, {
      CATSCO_HTTP_BASE_URL: state.httpBaseUrl,
      CATSCO_SERVER_URL: state.serverUrl,
      CATSCO_CONNECTOR_TOKEN: input.token,
      CATSCO_DEVICE_ID: deviceId,
      CATSCO_BODY_ID: deviceId,
      CATSCO_INSTALLATION_ID: installationId,
      CATSCOMPANY_HTTP_BASE_URL: state.httpBaseUrl,
      CATSCOMPANY_SERVER_URL: state.serverUrl,
      CATSCOMPANY_CONNECTOR_TOKEN: input.token,
      CATSCOMPANY_DEVICE_ID: deviceId,
      CATSCOMPANY_BODY_ID: deviceId,
      CATSCOMPANY_INSTALLATION_ID: installationId,
    });
  }

  clearAccount(): string[] {
    const config = this.load();
    this.save({
      ...config,
      account: undefined,
    });
    return removeEnvKeys(this.runtimeRoot, this.env, [
      'CATSCO_USER_TOKEN',
      'CATSCO_USER_UID',
      'CATSCO_USER_NAME',
      'CATSCO_USER_DISPLAY_NAME',
      'CATSCOMPANY_USER_TOKEN',
      'CATSCOMPANY_USER_UID',
      'CATSCOMPANY_USER_NAME',
      'CATSCOMPANY_USER_DISPLAY_NAME',
    ]);
  }

  updateEndpoints(endpoints: { httpBaseUrl?: string; serverUrl?: string }): string[] {
    const config = this.load();
    const nextEndpoints = { ...(config.endpoints || {}) };
    const clearKeys: string[] = [];
    if (endpoints.httpBaseUrl !== undefined) {
      const httpBaseUrl = String(endpoints.httpBaseUrl || '').trim();
      if (httpBaseUrl) {
        nextEndpoints.httpBaseUrl = httpBaseUrl;
      } else {
        delete nextEndpoints.httpBaseUrl;
        clearKeys.push('CATSCO_HTTP_BASE_URL', 'CATSCOMPANY_HTTP_BASE_URL');
      }
    }
    if (endpoints.serverUrl !== undefined) {
      const serverUrl = String(endpoints.serverUrl || '').trim();
      if (serverUrl) {
        nextEndpoints.serverUrl = serverUrl;
      } else {
        delete nextEndpoints.serverUrl;
        clearKeys.push('CATSCO_SERVER_URL', 'CATSCOMPANY_SERVER_URL');
      }
    }
    this.save({
      ...config,
      endpoints: nextEndpoints,
    });
    const updated = writeEnvUpdates(this.runtimeRoot, this.env, {
      CATSCO_HTTP_BASE_URL: nextEndpoints.httpBaseUrl,
      CATSCO_SERVER_URL: nextEndpoints.serverUrl,
      CATSCOMPANY_HTTP_BASE_URL: nextEndpoints.httpBaseUrl,
      CATSCOMPANY_SERVER_URL: nextEndpoints.serverUrl,
    });
    const removed = clearKeys.length > 0
      ? removeEnvKeys(this.runtimeRoot, this.env, clearKeys)
      : [];
    return [...updated, ...removed];
  }

  updatePreferences(preferences: Partial<NonNullable<CatsCoLocalConfig['preferences']>>): NonNullable<CatsCoLocalConfig['preferences']> {
    const config = this.load();
    const next = {
      autoConnect: preferences.autoConnect ?? config.preferences?.autoConnect ?? true,
      switchConfirmEnabled: preferences.switchConfirmEnabled ?? config.preferences?.switchConfirmEnabled ?? true,
      closeToTray: preferences.closeToTray ?? config.preferences?.closeToTray ?? true,
    };
    this.save({
      ...config,
      preferences: next,
    });
    return next;
  }

  toDashboardConfigPayload(): Record<string, unknown> {
    const state = this.getAuthState();
    const config = this.load();
    const hasConfirmedBot = Boolean(
      config.currentBot?.uid
        && config.currentBot.apiKey
        && config.currentBot.boundByUserUid
        && config.currentBot.bindingSource,
    );
    return {
      ok: true,
      version: config.version,
      configPath: this.configPath,
      hasAccount: Boolean(state.token && state.uid),
      hasBot: hasConfirmedBot,
      account: state.uid
        ? { uid: state.uid, username: state.username || '', displayName: state.displayName || state.username || '' }
        : null,
      currentBot: hasConfirmedBot
        ? {
          uid: config.currentBot?.uid || '',
          name: config.currentBot?.name || 'Bot',
          boundByUserUid: config.currentBot?.boundByUserUid || '',
          bindingSource: config.currentBot?.bindingSource || '',
          boundAt: config.currentBot?.boundAt || '',
        }
        : null,
      device: config.device
        ? {
          deviceId: config.device.deviceId,
          bodyId: config.device.bodyId,
          installationId: config.device.installationId,
          name: config.device.name || '',
        }
        : null,
      deviceConnector: config.deviceConnector
        ? {
          ownerUid: config.deviceConnector.ownerUid || '',
          deviceId: config.deviceConnector.deviceId,
          installationId: config.deviceConnector.installationId,
          name: config.deviceConnector.name || '',
          capabilities: config.deviceConnector.capabilities || [],
          allowWriteFile: Boolean(config.deviceConnector.allowWriteFile),
          allowShell: Boolean(config.deviceConnector.allowShell),
          pairedAt: config.deviceConnector.pairedAt || '',
          hasToken: Boolean(config.deviceConnector.token),
        }
        : null,
      preferences: {
        autoConnect: config.preferences?.autoConnect ?? true,
        switchConfirmEnabled: config.preferences?.switchConfirmEnabled ?? true,
        closeToTray: config.preferences?.closeToTray ?? true,
      },
    };
  }

  private defaultConfig(): CatsCoLocalConfig {
    return {
      version: CONFIG_VERSION,
      preferences: {
        autoConnect: true,
        switchConfirmEnabled: true,
        closeToTray: true,
      },
    };
  }
}

export function createCatsCoLocalConfigService(options: CatsCoLocalConfigServiceOptions = {}): CatsCoLocalConfigService {
  return new CatsCoLocalConfigService(options);
}
