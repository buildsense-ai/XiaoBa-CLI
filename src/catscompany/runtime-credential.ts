import type { CatsCompanyConfig } from './types';
import type { CatsCoAuthSnapshot } from './local-config';

export const CATSCO_RUNTIME_MUTATION_GRANT_SCOPE = 'skill_mutation:grant';
export const CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE = 'skill_mutation:activation_ack';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface CatsCoRuntimeCredential {
  botUid: string;
  bodyId: string;
  installationId: string;
  scopes: string[];
  credential: string;
  expiresAt: number;
}

export interface IssueCatsCoRuntimeCredentialOptions {
  httpBaseUrl: string;
  userToken: string;
  botUid: string;
  bodyId: string;
  installationId: string;
  scopes?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function issueCatsCoRuntimeCredential(
  options: IssueCatsCoRuntimeCredentialOptions,
): Promise<CatsCoRuntimeCredential> {
  const fetchImpl = options.fetchImpl || fetch;
  const userToken = String(options.userToken || '').trim();
  const botUid = String(options.botUid || '').trim();
  const bodyId = String(options.bodyId || '').trim();
  const installationId = String(options.installationId || '').trim();
  const requestedScopes = normalizeRequestedScopes(options.scopes);
  if (!userToken || !/^\d+$/.test(botUid) || Number(botUid) <= 0 || !bodyId || !installationId) {
    throw new Error('CatsCo Runtime credential request is missing a trusted owner or Runtime binding.');
  }
  const base = String(options.httpBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('CatsCo Runtime credential endpoint is missing.');
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const response = await fetchImpl(`${base}/api/bots/runtime-credential`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      bot_uid: Number(botUid),
      body_id: bodyId,
      installation_id: installationId,
      ...(options.scopes ? { scopes: requestedScopes } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 201) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
    throw new Error(`CatsCo Runtime credential request failed: ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  const responseBotUid = String(payload.bot_uid || '').trim();
  const responseBodyId = String(payload.body_id || '').trim();
  const responseInstallationId = String(payload.installation_id || '').trim();
  const credential = String(payload.credential || '').trim();
  const expiresAt = Number(payload.expires_at);
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.map(scope => String(scope || '').trim()).filter(Boolean)
    : [];
  if (
    responseBotUid !== botUid
    || responseBodyId !== bodyId
    || responseInstallationId !== installationId
    || !credential
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
    || !requestedScopes.every(scope => scopes.includes(scope))
    || scopes.some(scope => (
      scope !== CATSCO_RUNTIME_MUTATION_GRANT_SCOPE
      && scope !== CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE
    ))
  ) {
    throw new Error('CatsCo returned an invalid Runtime credential binding.');
  }
  return { botUid, bodyId, installationId, scopes, credential, expiresAt };
}

export async function provisionCatsCoRuntimeCredential(
  config: CatsCompanyConfig,
  auth: CatsCoAuthSnapshot,
  options: Pick<IssueCatsCoRuntimeCredentialOptions, 'fetchImpl' | 'timeoutMs' | 'scopes'> = {},
): Promise<CatsCompanyConfig> {
  const requestedScopes = normalizeRequestedScopes(options.scopes);
  const needsActivationAck = requestedScopes.includes(CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE);
  const existingGrantCredential = String(config.runtimeCredential || '').trim();
  if (
    (!needsActivationAck && existingGrantCredential)
    || (needsActivationAck && getUsableCatsCoRuntimeActivationAckCredential(config))
  ) {
    return config;
  }
  const userToken = String(auth.token || '').trim();
  const actorUid = String(auth.uid || '').trim();
  const ownerUid = String(config.ownerUserId || '').trim();
  const botUid = String(config.botUid || '').trim();
  const bodyId = String(config.bodyId || '').trim();
  const installationId = String(config.installationId || config.bodyId || '').trim();
  // Automatic provisioning is deliberately owner-only. Server runtimes that
  // do not keep a human session use the explicit credential configuration
  // paths instead. In particular, an old grant-only credential is never
  // guessed to contain the activation ACK scope.
  if (!userToken || !actorUid || !ownerUid || actorUid !== ownerUid || !botUid || !bodyId || !installationId) {
    return config;
  }
  const issued = await issueCatsCoRuntimeCredential({
    httpBaseUrl: config.httpBaseUrl || 'https://app.catsco.cc',
    userToken,
    botUid,
    bodyId,
    installationId,
    ...options,
  });
  return {
    ...config,
    ...(!existingGrantCredential ? {
      runtimeCredential: issued.credential,
      runtimeCredentialExpiresAt: issued.expiresAt,
    } : {}),
    ...(needsActivationAck ? {
      runtimeActivationAckCredential: issued.credential,
      runtimeActivationAckCredentialExpiresAt: issued.expiresAt,
    } : {}),
  };
}

export function getUsableCatsCoRuntimeActivationAckCredential(
  config: Pick<
    CatsCompanyConfig,
    'runtimeActivationAckCredential' | 'runtimeActivationAckCredentialExpiresAt'
  >,
  now = Date.now(),
): string | undefined {
  const credential = String(config.runtimeActivationAckCredential || '').trim();
  if (!credential) return undefined;
  const expiresAt = Number(config.runtimeActivationAckCredentialExpiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now) return undefined;
  return credential;
}

function normalizeRequestedScopes(input: string[] | undefined): string[] {
  if (input === undefined) return [CATSCO_RUNTIME_MUTATION_GRANT_SCOPE];
  const scopes = input.map(value => String(value || '').trim());
  const allowed = new Set([
    CATSCO_RUNTIME_MUTATION_GRANT_SCOPE,
    CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE,
  ]);
  if (
    scopes.length === 0
    || !scopes.includes(CATSCO_RUNTIME_MUTATION_GRANT_SCOPE)
    || new Set(scopes).size !== scopes.length
    || scopes.some(scope => !allowed.has(scope))
  ) {
    throw new Error('CatsCo Runtime credential request contains invalid scopes.');
  }
  return [
    CATSCO_RUNTIME_MUTATION_GRANT_SCOPE,
    ...(scopes.includes(CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE)
      ? [CATSCO_RUNTIME_ACTIVATION_ACK_SCOPE]
      : []),
  ];
}
