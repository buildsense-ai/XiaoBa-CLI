import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { ChatConfig } from '../types';
import { CatsCompanyConfig } from './types';
import {
  CatsCoAuthSnapshot,
  CatsCoLocalConfig,
  DEFAULT_CATSCO_HTTP_BASE_URL,
  DEFAULT_CATSCO_WS_URL,
  createCatsCoLocalConfigService,
} from './local-config';

export type CatsCoRuntimeMissingField = 'serverUrl' | 'apiKey' | 'bodyId';

export interface CatsCoRuntimeConfigConflict {
  field: 'httpBaseUrl' | 'serverUrl' | 'botUid' | 'apiKey';
  typed?: string;
  env?: string;
  legacyConfig?: string;
}

export interface CatsCoRuntimeConfigResolution {
  runtimeRoot: string;
  auth: CatsCoAuthSnapshot;
  localConfig: CatsCoLocalConfig;
  connector?: CatsCompanyConfig;
  missing: CatsCoRuntimeMissingField[];
  accountConnected: boolean;
  bodyConfigured: boolean;
  connectorReady: boolean;
  chatReady: boolean;
  unconfirmedBotBinding: boolean;
  conflicts: CatsCoRuntimeConfigConflict[];
  envOverlay: Record<string, string>;
}

export interface CatsCoRuntimeConfigOptions {
  runtimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  config?: ChatConfig;
  overrides?: Record<string, unknown>;
  migrateLegacyEnvBinding?: boolean;
}

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

export function resolveCatsCoRuntimeConfig(
  options: CatsCoRuntimeConfigOptions = {},
): CatsCoRuntimeConfigResolution {
  const runtimeRoot = options.runtimeRoot || process.cwd();
  const env = options.env || process.env;
  const config = options.config || {};
  const fileEnv = readEnvFile(runtimeRoot);
  const effectiveEnv = {
    ...fileEnv,
    ...env,
  };
  const service = createCatsCoLocalConfigService({ runtimeRoot, env: effectiveEnv });
  let localConfig = service.load();
  let auth = service.getAuthState(options.overrides || {});
  if (options.migrateLegacyEnvBinding && migrateLegacyEnvBinding(service, localConfig, auth)) {
    localConfig = service.load();
    auth = service.getAuthState(options.overrides || {});
  }

  const explicitServerUrl = firstNonEmpty(
    options.overrides?.serverUrl,
    effectiveEnv.CATSCO_SERVER_URL,
    effectiveEnv.CATSCOMPANY_SERVER_URL,
    localConfig.endpoints?.serverUrl,
  );
  const explicitHttpBaseUrl = firstNonEmpty(
    options.overrides?.httpBaseUrl,
    effectiveEnv.CATSCO_HTTP_BASE_URL,
    effectiveEnv.CATSCOMPANY_HTTP_BASE_URL,
    localConfig.endpoints?.httpBaseUrl,
  );
  const serverUrl = firstNonEmpty(explicitServerUrl, config.catscompany?.serverUrl, auth.serverUrl);
  const rawApiKey = firstNonEmpty(auth.apiKey, config.catscompany?.apiKey);
  const httpBaseUrl = normalizeBaseUrl(
    firstNonEmpty(explicitHttpBaseUrl, config.catscompany?.httpBaseUrl, auth.httpBaseUrl),
    DEFAULT_CATSCO_HTTP_BASE_URL,
    { upgradeCatsCoHttp: true },
  );
  const proposedBotBinding = Boolean(options.overrides?.botUid && options.overrides?.apiKey);
  const confirmedLocalBotBinding = hasConfirmedLocalBotBinding(localConfig, auth.uid);
  const rawBotUid = auth.botUid;
  const botUid = proposedBotBinding || confirmedLocalBotBinding ? rawBotUid : undefined;
  const apiKey = proposedBotBinding || confirmedLocalBotBinding ? rawApiKey : undefined;
  const bodyId = localConfig.device?.bodyId;
  const installationId = localConfig.device?.installationId || bodyId;

  const missing: CatsCoRuntimeMissingField[] = [];
  if (!serverUrl) missing.push('serverUrl');
  if (!apiKey) missing.push('apiKey');
  if (!bodyId) missing.push('bodyId');

  const accountConnected = Boolean(auth.token && auth.uid);
  const bodyConfigured = Boolean(botUid && apiKey && serverUrl && bodyId);
  const connector: CatsCompanyConfig | undefined = bodyConfigured && serverUrl && apiKey && bodyId
    ? {
      serverUrl,
      apiKey,
      bodyId,
      installationId,
      deviceName: localConfig.device?.name,
      httpBaseUrl,
      sessionTTL: config.catscompany?.sessionTTL,
    }
    : undefined;
  const connectorReady = Boolean(serverUrl && apiKey);
  const chatReady = Boolean(accountConnected && bodyConfigured);
  const unconfirmedBotBinding = Boolean(rawBotUid && rawApiKey && serverUrl && !bodyConfigured);

  return {
    runtimeRoot,
    auth: {
      ...auth,
      serverUrl: serverUrl || DEFAULT_CATSCO_WS_URL,
      httpBaseUrl,
      apiKey,
      botUid,
    },
    localConfig,
    connector,
    missing,
    accountConnected,
    bodyConfigured,
    connectorReady,
    chatReady,
    unconfirmedBotBinding,
    conflicts: detectConflicts(localConfig, effectiveEnv, config),
    envOverlay: buildCatsCoRuntimeEnvOverlay({
      ...auth,
      serverUrl: serverUrl || DEFAULT_CATSCO_WS_URL,
      httpBaseUrl,
      apiKey,
      botUid,
    }, localConfig),
  };
}

function migrateLegacyEnvBinding(
  service: ReturnType<typeof createCatsCoLocalConfigService>,
  localConfig: CatsCoLocalConfig,
  auth: CatsCoAuthSnapshot,
): boolean {
  if (hasConfirmedLocalBotBinding(localConfig, auth.uid)) return false;
  const userUid = String(auth.uid || '').trim();
  const token = String(auth.token || '').trim();
  const botUid = String(auth.botUid || '').trim();
  const apiKey = String(auth.apiKey || '').trim();
  if (!userUid || !token || !botUid || !apiKey) return false;
  if (/^sk-/i.test(apiKey)) return false;
  service.writeBotBinding(auth, {
    userUid,
    username: auth.username,
    displayName: auth.displayName,
    botUid,
    apiKey,
    bindingSource: 'legacy-env-migration',
  });
  return true;
}

function hasConfirmedLocalBotBinding(localConfig: CatsCoLocalConfig, userUid?: string): boolean {
  const bot = localConfig.currentBot;
  const expectedUserUid = String(userUid || '').trim();
  const boundByUserUid = String(bot?.boundByUserUid || '').trim();
  return Boolean(
    bot?.uid
      && bot.apiKey
      && boundByUserUid
      && (!expectedUserUid || boundByUserUid === expectedUserUid)
      && bot.bindingSource,
  );
}

export function buildCatsCoRuntimeEnvOverlay(
  auth: CatsCoAuthSnapshot,
  localConfig?: CatsCoLocalConfig,
): Record<string, string> {
  const overlay: Record<string, string> = {};
  const aliases: Array<[string, string | undefined]> = [
    ['CATSCO_HTTP_BASE_URL', auth.httpBaseUrl],
    ['CATSCO_SERVER_URL', auth.serverUrl],
    ['CATSCO_USER_TOKEN', auth.token],
    ['CATSCO_USER_UID', auth.uid],
    ['CATSCO_USER_NAME', auth.username],
    ['CATSCO_USER_DISPLAY_NAME', auth.displayName],
    ['CATSCO_BOT_UID', auth.botUid],
    ['CATSCO_API_KEY', auth.apiKey],
    ['CATSCO_DEVICE_ID', localConfig?.device?.deviceId],
    ['CATSCO_BODY_ID', localConfig?.device?.bodyId],
    ['CATSCO_INSTALLATION_ID', localConfig?.device?.installationId],
    ['CATSCOMPANY_HTTP_BASE_URL', auth.httpBaseUrl],
    ['CATSCOMPANY_SERVER_URL', auth.serverUrl],
    ['CATSCOMPANY_USER_TOKEN', auth.token],
    ['CATSCOMPANY_USER_UID', auth.uid],
    ['CATSCOMPANY_USER_NAME', auth.username],
    ['CATSCOMPANY_USER_DISPLAY_NAME', auth.displayName],
    ['CATSCOMPANY_BOT_UID', auth.botUid],
    ['CATSCOMPANY_API_KEY', auth.apiKey],
    ['CATSCOMPANY_DEVICE_ID', localConfig?.device?.deviceId],
    ['CATSCOMPANY_BODY_ID', localConfig?.device?.bodyId],
    ['CATSCOMPANY_INSTALLATION_ID', localConfig?.device?.installationId],
  ];

  for (const [key, value] of aliases) {
    const text = String(value || '').trim();
    if (text) overlay[key] = text;
  }

  return overlay;
}

function detectConflicts(
  localConfig: CatsCoLocalConfig,
  env: NodeJS.ProcessEnv,
  config: ChatConfig,
): CatsCoRuntimeConfigConflict[] {
  const conflicts: CatsCoRuntimeConfigConflict[] = [];
  addConflict(conflicts, 'httpBaseUrl', localConfig.endpoints?.httpBaseUrl, firstNonEmpty(env.CATSCO_HTTP_BASE_URL, env.CATSCOMPANY_HTTP_BASE_URL), config.catscompany?.httpBaseUrl);
  addConflict(conflicts, 'serverUrl', localConfig.endpoints?.serverUrl, firstNonEmpty(env.CATSCO_SERVER_URL, env.CATSCOMPANY_SERVER_URL), config.catscompany?.serverUrl);
  addConflict(conflicts, 'botUid', localConfig.currentBot?.uid, firstNonEmpty(env.CATSCO_BOT_UID, env.CATSCOMPANY_BOT_UID), undefined);
  addConflict(conflicts, 'apiKey', localConfig.currentBot?.apiKey, firstNonEmpty(env.CATSCO_API_KEY, env.CATSCOMPANY_API_KEY), config.catscompany?.apiKey);
  return conflicts;
}

function addConflict(
  conflicts: CatsCoRuntimeConfigConflict[],
  field: CatsCoRuntimeConfigConflict['field'],
  typed?: string,
  env?: string,
  legacyConfig?: string,
): void {
  const typedValue = String(typed || '').trim();
  const envValue = String(env || '').trim();
  const legacyValue = String(legacyConfig || '').trim();
  if (!typedValue) return;
  if ((envValue && envValue !== typedValue) || (legacyValue && legacyValue !== typedValue)) {
    conflicts.push({
      field,
      typed: typedValue,
      env: envValue || undefined,
      legacyConfig: legacyValue || undefined,
    });
  }
}
