import { Logger } from './logger';

export interface TransientInjected {
  prefix: string;
  role: string;
  placement: 'before_last_user' | 'tail' | 'system';
  contentLen: number;
}

export interface TransientSuppressed {
  prefix: string;
  reason: string;
}

export interface TransientObservation {
  turn?: number;
  sessionId?: string;
  provider?: string;
  model?: string;
  requestId?: string;
  injected: TransientInjected[];
  suppressed: TransientSuppressed[];
  systemHash?: string;
  systemHashChanged?: boolean;
  systemLen?: number;
}

const LOG_PREFIX = '[TRANSIENT_OBSERVE]';

export interface TransientObservationMeta {
  turn?: number;
  sessionId?: string;
  provider?: string;
  model?: string;
  requestId?: string;
  systemHash?: string;
  systemLen?: number;
}

const previousSystemHashes = new Map<string, string>();

export function isTransientObserveEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.XIAOBA_TRANSIENT_OBSERVE || '');
}

export class TransientObserver {
  private injected: TransientInjected[] = [];
  private suppressed: TransientSuppressed[] = [];

  recordInjected(prefix: string, role: string, placement: TransientInjected['placement'], contentLen: number): void {
    this.injected.push({ prefix, role, placement, contentLen });
  }

  recordSuppressed(prefix: string, reason: string): void {
    this.suppressed.push({ prefix, reason });
  }

  buildObservation(meta?: TransientObservationMeta): TransientObservation {
    const obs: TransientObservation = {
      turn: meta?.turn,
      sessionId: meta?.sessionId,
      provider: meta?.provider,
      model: meta?.model,
      requestId: meta?.requestId,
      injected: this.injected,
      suppressed: this.suppressed,
    };

    if (meta?.systemHash) {
      const bucketKey = buildSystemHashBucketKey(meta);
      const previousSystemHash = previousSystemHashes.get(bucketKey);
      obs.systemHash = meta.systemHash;
      obs.systemLen = meta.systemLen;
      obs.systemHashChanged = previousSystemHash !== undefined && previousSystemHash !== meta.systemHash;
      previousSystemHashes.set(bucketKey, meta.systemHash);
    }

    return obs;
  }

  log(meta?: TransientObservationMeta): void {
    if (!isTransientObserveEnabled()) return;
    const obs = this.buildObservation(meta);
    Logger.info(`${LOG_PREFIX} ${JSON.stringify(obs)}`);
  }

  get injectedCount(): number {
    return this.injected.length;
  }

  get suppressedCount(): number {
    return this.suppressed.length;
  }
}

export function createTransientObserver(): TransientObserver {
  return new TransientObserver();
}

export function resetPreviousSystemHash(): void {
  previousSystemHashes.clear();
}

function buildSystemHashBucketKey(meta: TransientObservationMeta): string {
  const sessionId = meta.sessionId || 'unknown-session';
  const provider = meta.provider || 'unknown-provider';
  const model = meta.model || 'unknown-model';
  return `${sessionId}|${provider}|${model}`;
}
