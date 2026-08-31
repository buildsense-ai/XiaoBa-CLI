import * as crypto from 'crypto';
import type {
  BotSkillActivationIdentity,
  BotSkillActivationJournal,
  BotSkillActivationAckInspection,
} from './activation-state';
import { BotSkillActivationStateStore } from './activation-state';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const MAX_INT64 = 9_223_372_036_854_775_807n;

export type BotSkillActivationAckWarningCode =
  | 'STATE_INVALID'
  | 'MUTATION_ID_INVALID'
  | 'RUNTIME_IDENTITY_MISMATCH'
  | 'CREDENTIAL_REJECTED'
  | 'ACK_NOT_AVAILABLE'
  | 'ACTIVATION_FACT_CONFLICT'
  | 'ACK_RETRYABLE'
  | 'ACK_RESPONSE_INVALID';

export type BotSkillActivationAckPollStatus =
  | 'idle'
  | 'local_apply_pending'
  | 'already_acked'
  | 'backoff'
  | 'acked'
  | 'retry_scheduled'
  | 'blocked';

export interface BotSkillActivationAckPollResult {
  status: BotSkillActivationAckPollStatus;
  warningCode?: BotSkillActivationAckWarningCode;
  mutationId?: string;
}

interface BotSkillActivationAckStateStore {
  inspectForAck(botId: string, skillsRoot: string): BotSkillActivationAckInspection;
  markAcked(
    botId: string,
    skillsRoot: string,
    identity: BotSkillActivationIdentity,
  ): BotSkillActivationJournal;
}

export interface BotSkillActivationAckWorkerOptions {
  runtimeRoot: string;
  skillsRoot: string;
  botId: string;
  bodyId: string;
  installationId: string;
  activationAckCredential: string;
  httpBaseUrl: string;
  stateStore?: BotSkillActivationAckStateStore;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  onWarning?: (code: BotSkillActivationAckWarningCode) => void;
}

/**
 * E3 only closes the remote acknowledgement half of the activation saga.
 * It never stages, installs, removes, or reloads a Skill. The E1 journal and
 * applied marker must already prove that the complete revision is live.
 */
export class BotSkillActivationAckWorker {
  private readonly stateStore: BotSkillActivationAckStateStore;
  private readonly fetchImpl: typeof fetch;
  private readonly botId: string;
  private readonly skillsRoot: string;
  private readonly bodyIdHash: string;
  private readonly activationAckCredential: string;
  private readonly endpointBase: string;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly onWarning?: (code: BotSkillActivationAckWarningCode) => void;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<BotSkillActivationAckPollResult>;
  private failures = 0;
  private nextAttemptAt = 0;

  constructor(options: BotSkillActivationAckWorkerOptions) {
    this.botId = normalizePositiveInt64(options.botId, 'Bot ID');
    const bodyId = normalizeRuntimeIdentity(options.bodyId, 'body ID');
    normalizeRuntimeIdentity(options.installationId, 'installation ID');
    this.activationAckCredential = String(options.activationAckCredential || '').trim();
    if (!this.activationAckCredential) throw new Error('Dedicated Runtime credential is required for Skill activation ACK');
    this.endpointBase = normalizeHttpBaseUrl(options.httpBaseUrl);
    this.skillsRoot = String(options.skillsRoot || '').trim();
    if (!this.skillsRoot) throw new Error('Skill workspace is required for activation ACK');
    this.bodyIdHash = crypto.createHash('sha256').update(bodyId, 'utf8').digest('hex');
    this.stateStore = options.stateStore ?? new BotSkillActivationStateStore(options.runtimeRoot);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.requestTimeoutMs = positiveDuration(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
    this.onWarning = options.onWarning;
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    (this.timer as any).unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  pollOnce(): Promise<BotSkillActivationAckPollResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.pollOnceInternal().catch(() => this.block('STATE_INVALID'));
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    return run;
  }

  private async pollOnceInternal(): Promise<BotSkillActivationAckPollResult> {
    if (this.now() < this.nextAttemptAt) return { status: 'backoff' };
    let recovery: BotSkillActivationAckInspection;
    try {
      recovery = this.stateStore.inspectForAck(this.botId, this.skillsRoot);
    } catch {
      return this.block('STATE_INVALID');
    }
    switch (recovery.status) {
    case 'none':
      this.resetBackoff();
      return { status: 'idle' };
    case 'not_ready':
      this.resetBackoff();
      return { status: 'local_apply_pending' };
    case 'acked':
      this.resetBackoff();
      return { status: 'already_acked', mutationId: recovery.journal.mutationId };
    case 'retry_ack':
      return this.acknowledge(recovery.journal);
    }
  }

  private async acknowledge(journal: BotSkillActivationJournal): Promise<BotSkillActivationAckPollResult> {
    let mutationId: string;
    try {
      mutationId = normalizePositiveInt64(journal.mutationId, 'mutation ID');
    } catch {
      return this.block('MUTATION_ID_INVALID');
    }
    if (!journal.runtimeBodyIdHash || journal.runtimeBodyIdHash !== this.bodyIdHash) {
      return this.block('RUNTIME_IDENTITY_MISMATCH', mutationId);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.endpointBase}/api/bot/skill-mutations/${mutationId}/activation`,
        {
          method: 'POST',
          headers: {
            'X-CatsCo-Runtime-Credential': this.activationAckCredential,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            appliedDefinitionRevision: journal.definitionRevision,
            skillSetHash: journal.skillSetHash,
            result: 'applied',
          }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
    } catch {
      return this.retry('ACK_RETRYABLE', mutationId);
    }

    if (response.status !== 200) {
      if (response.status === 401 || response.status === 403) {
        return this.retry('CREDENTIAL_REJECTED', mutationId);
      }
      if (response.status === 404) return this.retry('ACK_NOT_AVAILABLE', mutationId);
      if (response.status === 409) return this.block('ACTIVATION_FACT_CONFLICT', mutationId);
      if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        return this.retry('ACK_RETRYABLE', mutationId);
      }
      return this.block('ACK_RESPONSE_INVALID', mutationId);
    }

    let payload: Record<string, unknown>;
    try {
      payload = await response.json() as Record<string, unknown>;
    } catch {
      return this.retry('ACK_RESPONSE_INVALID', mutationId);
    }
    if (
      normalizeResponseID(payload.mutation_id) !== mutationId
      || payload.status !== 'active'
      || Number(payload.applied_definition_revision) !== journal.definitionRevision
    ) {
      return this.block('ACK_RESPONSE_INVALID', mutationId);
    }

    try {
      this.stateStore.markAcked(this.botId, this.skillsRoot, journal);
    } catch {
      return this.block('STATE_INVALID', mutationId);
    }
    this.resetBackoff();
    return { status: 'acked', mutationId };
  }

  private retry(
    warningCode: BotSkillActivationAckWarningCode,
    mutationId?: string,
  ): BotSkillActivationAckPollResult {
    this.failures += 1;
    const delay = Math.min(
      this.pollIntervalMs * (2 ** Math.min(this.failures - 1, 10)),
      MAX_RETRY_DELAY_MS,
    );
    this.nextAttemptAt = this.now() + delay;
    if (this.failures === 1 || this.failures % 12 === 0) this.notifyWarning(warningCode);
    return { status: 'retry_scheduled', warningCode, mutationId };
  }

  private block(
    warningCode: BotSkillActivationAckWarningCode,
    mutationId?: string,
  ): BotSkillActivationAckPollResult {
    this.failures += 1;
    this.nextAttemptAt = this.now() + MAX_RETRY_DELAY_MS;
    if (this.failures === 1 || this.failures % 12 === 0) this.notifyWarning(warningCode);
    return { status: 'blocked', warningCode, mutationId };
  }

  private resetBackoff(): void {
    this.failures = 0;
    this.nextAttemptAt = 0;
  }

  private notifyWarning(code: BotSkillActivationAckWarningCode): void {
    try {
      this.onWarning?.(code);
    } catch {
      // Observability hooks must never break acknowledgement retry semantics.
    }
  }
}

export function isBotSkillActivationAckWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.XIAOBA_SKILL_MUTATION_ACTIVATION_ACK_WORKER_ENABLED || '').trim().toLowerCase() === 'true';
}

function normalizePositiveInt64(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[1-9]\d{0,18}$/.test(normalized)) throw new Error(`${label} is invalid`);
  const parsed = BigInt(normalized);
  if (parsed > MAX_INT64) throw new Error(`${label} is invalid`);
  return normalized;
}

function normalizeRuntimeIdentity(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 128 || /[\r\n\0]/.test(normalized)) {
    throw new Error(`Runtime ${label} is invalid`);
  }
  return normalized;
}

function normalizeHttpBaseUrl(value: unknown): string {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  const parsed = new URL(normalized);
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
    throw new Error('CatsCo HTTP endpoint is invalid');
  }
  return normalized;
}

function normalizeResponseID(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string') {
    try {
      return normalizePositiveInt64(value, 'response mutation ID');
    } catch {
      return '';
    }
  }
  return '';
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}
