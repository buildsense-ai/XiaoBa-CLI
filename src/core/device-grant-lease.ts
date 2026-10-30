import type { ScopedDeviceGrant } from '../types/session-identity';
import type { ToolExecutionContext } from '../types/tool';
import { validateDeviceGrant } from './device-grants';
import { Logger } from '../utils/logger';
import { CatsSendError } from '../catscompany/send-error';

export const DEVICE_GRANT_RENEW_BEFORE_MS = 6 * 60_000;
export const DEVICE_GRANT_HEARTBEAT_MS = 30_000;
const DEVICE_GRANT_MAX_EXTENSION_MS = 10 * 60_000;
const DEVICE_GRANT_MAX_CHAIN_MS = 24 * 60 * 60_000;
const DIAGNOSTIC_INTERVAL_MS = 60_000;

export class DeviceGrantRenewalError extends Error {
  constructor(public readonly reason: 'denied' | 'invalid_response') {
    super('设备授权续期失败；未改变目标设备或重放操作。');
    this.name = 'DeviceGrantRenewalError';
  }
}

type RenewalOutcome = 'attempted' | 'renewed' | 'unsupported' | 'invalid_grant' | 'expired'
  | 'superseded' | 'stale_response' | 'invalid_response' | 'denied' | 'timeout' | 'transport' | 'failed';

/** Require exactly the same authority. Only ID/expiry can change, never identity,
 * operation set, target scope or original creation time. */
export function isDeviceGrantRenewal(old: ScopedDeviceGrant, next: ScopedDeviceGrant, now = Date.now()): boolean {
  const keys: (keyof ScopedDeviceGrant)[] = ['kind', 'source', 'status', 'identityTrust', 'identitySource',
    'deviceId', 'deviceBodyId', 'deviceInstallationId', 'ownerUserId', 'sessionKey', 'topicId', 'topicType',
    'actorUserId', 'agentId', 'agentBodyId', 'targetScope', 'selectionRevision', 'createdAt'];
  return !!next && keys.every(key => old[key] === next[key]) && next.status === 'active'
    && next.identityTrust === 'server_canonical' && typeof next.grantId === 'string' && !!next.grantId
    && next.grantId !== old.grantId && Number.isFinite(next.expiresAt)
    // Compare two server-issued timestamps, not server expiry against a narrow
    // local-clock window. Fixed host skew must not silently reject every renewal.
    && next.expiresAt > now && next.expiresAt >= old.expiresAt
    && next.expiresAt <= old.expiresAt + DEVICE_GRANT_MAX_EXTENSION_MS
    && next.expiresAt <= old.createdAt + DEVICE_GRANT_MAX_CHAIN_MS
    && Array.isArray(next.operations) && next.operations.length === old.operations.length
    && next.operations.every(op => old.operations.includes(op))
    && old.operations.every(op => next.operations.includes(op));
}

/** One lease per active runner; never persists credentials or replays tools. */
export class DeviceGrantLease {
  private pending?: Promise<void>;
  private stopped = false;
  private retryAt = new WeakMap<ScopedDeviceGrant, number>();
  private counters: Partial<Record<RenewalOutcome, number>> = {};
  private reportedAt = new Map<RenewalOutcome, number>();

  constructor(private context: () => Partial<ToolExecutionContext> | undefined,
    private active: () => boolean = () => true,
    private now: () => number = Date.now) {}

  stop(): void { this.stopped = true; }

  getDiagnostics(): Readonly<Partial<Record<RenewalOutcome, number>>> { return { ...this.counters }; }

  private note(outcome: RenewalOutcome): void {
    this.counters[outcome] = (this.counters[outcome] || 0) + 1;
    if (outcome === 'attempted' || outcome === 'superseded') return;
    const now = this.now();
    const last = this.reportedAt.get(outcome);
    if (last !== undefined && now - last < DIAGNOSTIC_INTERVAL_MS) return;
    this.reportedAt.set(outcome, now);
    // Fixed enums/counters only. Never log grants, raw errors, user paths or
    // tokens; the active runner supplies session association through Logger.
    const message = `[device_grant_renewal] outcome=${outcome} count=${this.counters[outcome]} attempts=${this.counters.attempted || 0} renewed=${this.counters.renewed || 0}`;
    if (outcome === 'renewed') Logger.info(message);
    else Logger.warning(message);
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.refreshOnce().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async refreshOnce(): Promise<void> {
    const context = this.context();
    const renew = context?.thinToolRpc?.renewGrant;
    if (context?.surface !== 'catscompany' || !context.executionScope?.isTrusted
      || context.executionScope.identityTrust !== 'server_canonical'
      || this.stopped || !this.active() || context?.abortSignal?.aborted) return;
    if (!context.deviceGrants?.length) return;
    if (!renew) { this.note('unsupported'); return; }
    for (const grant of context.deviceGrants || []) {
      const now = this.now();
      if (this.stopped || !this.active() || context.abortSignal?.aborted) return;
      // A new human turn supersedes older grants for the same authority. Do
      // not keep every historical grant alive as follow-ups accumulate.
      if (context.deviceGrants?.some(newer => newer.createdAt > grant.createdAt
        && newer.deviceId === grant.deviceId && newer.actorUserId === grant.actorUserId
        && newer.sessionKey === grant.sessionKey && newer.agentId === grant.agentId
        && newer.targetScope === grant.targetScope && newer.selectionRevision === grant.selectionRevision
        && newer.status === 'active' && newer.identityTrust === 'server_canonical')) { this.note('superseded'); continue; }
      if (!context.executionScope || !grant.operations.length || grant.ownerUserId !== grant.actorUserId
        || (context.deviceSelection?.revision || '') !== (grant.selectionRevision || '')
        || !validateDeviceGrant(context, grant, { deviceId: grant.deviceId, operation: grant.operations[0], now }).ok) {
        this.note(grant.expiresAt <= now ? 'expired' : 'invalid_grant'); continue;
      }
      if (grant.expiresAt - now > DEVICE_GRANT_RENEW_BEFORE_MS || (this.retryAt.get(grant) || 0) > now) continue;
      const snapshot = { ...grant, operations: [...grant.operations] };
      this.retryAt.set(grant, now + DEVICE_GRANT_HEARTBEAT_MS);
      this.note('attempted');
      try {
        const next = await renew(snapshot);
        const current = this.context();
        if (this.stopped || !this.active() || current?.abortSignal?.aborted
          || current?.executionScope !== context.executionScope || !current?.deviceGrants?.includes(grant)
          || grant.grantId !== snapshot.grantId
          || (current.deviceSelection?.revision || '') !== (snapshot.selectionRevision || '')) { this.note('stale_response'); continue; }
        if (!isDeviceGrantRenewal(snapshot, next, this.now())
          || !validateDeviceGrant(current, next, { deviceId: snapshot.deviceId, operation: snapshot.operations[0], now: this.now() }).ok) {
          this.note('invalid_response'); continue;
        }
        // Keep already-resolved route references valid without substituting a
        // different device or rewriting the operation set.
        grant.grantId = next.grantId;
        grant.expiresAt = next.expiresAt;
        this.note('renewed');
      } catch (error) {
        // Transport loss/denial must not invent authority or replay an operation.
        // The original grant remains bounded and dispatch fails closed at expiry.
        this.note(error instanceof DeviceGrantRenewalError ? error.reason
          : error instanceof CatsSendError && (error.kind === 'timeout' || error.kind === 'transport') ? error.kind : 'failed');
      }
    }
  }
}
