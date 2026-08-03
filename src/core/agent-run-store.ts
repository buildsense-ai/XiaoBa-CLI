import * as fs from 'node:fs';
import * as path from 'node:path';
import { withExclusiveFileLock } from './file-lock';

import type {
  AgentRunArtifactRef,
  AgentRunEvent,
  AgentRunGoalCheck,
  AgentRunPublicProjection,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunSubjectRef,
  AgentRunTriggerRef,
} from './agent-run-types';

const SCHEMA_VERSION = 1;
const STATUSES = new Set<AgentRunStatus>([
  'queued',
  'active',
  'waiting_for_input',
  'blocked',
  'completed',
  'cancelled',
]);

interface AgentRunStoreState {
  schemaVersion: 1;
  runs: AgentRunRecord[];
}

export interface AgentRunStoreOptions {
  filePath?: string;
  stateFilePath?: string;
  corruptMarkerPath?: string;
  clock?: () => Date;
}

export type CreateAgentRunInput = Omit<
  AgentRunRecord,
  'createdAt' | 'updatedAt' | 'events' | 'artifacts' | 'subjects'
> & {
  createdAt?: string;
  updatedAt?: string;
  events?: AgentRunEvent[];
  artifacts?: AgentRunArtifactRef[];
  subjects?: AgentRunSubjectRef[];
};

export type AgentRunUpdate = Partial<AgentRunRecord> | ((record: AgentRunRecord) => AgentRunRecord | void);

export class AgentRunStore {
  private readonly stateFilePath: string;
  private readonly corruptMarkerPath: string;
  private readonly lockPath: string;
  private readonly clock: () => Date;
  private readonly records = new Map<string, AgentRunRecord>();
  private readonly idempotencyIndex = new Map<string, string>();
  private corrupt = false;

  constructor(options: AgentRunStoreOptions | string) {
    const normalized = typeof options === 'string' ? { filePath: options } : options;
    const stateFilePath = normalized.stateFilePath ?? normalized.filePath;
    if (!stateFilePath) throw new Error('AgentRunStore requires filePath or stateFilePath');
    this.stateFilePath = stateFilePath;
    this.corruptMarkerPath = normalized.corruptMarkerPath ?? `${stateFilePath}.corrupt`;
    this.lockPath = `${stateFilePath}.lock`;
    this.clock = normalized.clock ?? (() => new Date());
    this.load();
  }

  create(input: CreateAgentRunInput): AgentRunRecord {
    return withExclusiveFileLock(this.lockPath, () => {
      this.reloadFromDisk();
      this.assertHealthy();
      const now = this.clock().toISOString();
      const record = validateRecord({
        ...clone(input),
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? input.createdAt ?? now,
        events: input.events ?? [],
        artifacts: input.artifacts ?? [],
        subjects: input.subjects ?? [],
      });
      const idempotencyKey = record.triggerRef.idempotencyKey;
      if (idempotencyKey) {
        const existingRunId = this.idempotencyIndex.get(indexKey(record.triggerRef.source, idempotencyKey));
        if (existingRunId) return clone(this.records.get(existingRunId)!);
      }
      if (this.records.has(record.runId)) throw new Error(`agent run already exists: ${record.runId}`);

      try {
        this.records.set(record.runId, record);
        this.addToIdempotencyIndex(record);
        this.persist();
      } catch (error) {
        this.records.delete(record.runId);
        this.rebuildIdempotencyIndex();
        throw error;
      }
      return clone(record);
    });
  }

  refresh(): void {
    this.reloadFromDisk();
    this.assertHealthy();
  }

  get(runId: string): AgentRunRecord | undefined {
    this.assertHealthy();
    const record = this.records.get(requireNonEmptyString(runId, 'runId'));
    return record ? clone(record) : undefined;
  }

  list(): AgentRunRecord[] {
    this.assertHealthy();
    return [...this.records.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId))
      .map(clone);
  }

  findByIdempotencyKey(source: string, idempotencyKey: string): AgentRunRecord | undefined {
    this.assertHealthy();
    const runId = this.idempotencyIndex.get(indexKey(
      requireNonEmptyString(source, 'source'),
      requireNonEmptyString(idempotencyKey, 'idempotencyKey'),
    ));
    return runId ? clone(this.records.get(runId)!) : undefined;
  }

  migrateTriggerIdempotencyKey(
    runId: string,
    source: string,
    expectedPreviousKey: string,
    nextKey: string,
  ): AgentRunRecord {
    return withExclusiveFileLock(this.lockPath, () => {
      this.reloadFromDisk();
      this.assertHealthy();
      const normalizedRunId = requireNonEmptyString(runId, 'runId');
      const previous = this.records.get(normalizedRunId);
      if (!previous) throw new Error(`agent run not found: ${normalizedRunId}`);
      const normalizedSource = requireNonEmptyString(source, 'source');
      const previousKey = requireNonEmptyString(expectedPreviousKey, 'expectedPreviousKey');
      const normalizedNextKey = requireNonEmptyString(nextKey, 'nextKey');
      if (previous.triggerRef.source !== normalizedSource) {
        throw new Error(`agent run Trigger source does not match: ${normalizedRunId}`);
      }
      if (previous.triggerRef.idempotencyKey === normalizedNextKey) return clone(previous);
      if (previous.triggerRef.idempotencyKey !== previousKey) {
        throw new Error(`agent run Trigger identity changed during migration: ${normalizedRunId}`);
      }
      const conflictingRunId = this.idempotencyIndex.get(indexKey(normalizedSource, normalizedNextKey));
      if (conflictingRunId && conflictingRunId !== normalizedRunId) {
        throw new Error(`duplicate trigger idempotency key for source ${normalizedSource}`);
      }
      const migrated = validateRecord({
        ...clone(previous),
        triggerRef: { ...clone(previous.triggerRef), idempotencyKey: normalizedNextKey },
        updatedAt: this.clock().toISOString(),
      });
      this.records.set(normalizedRunId, migrated);
      this.rebuildIdempotencyIndex();
      try {
        this.persist();
      } catch (error) {
        this.records.set(normalizedRunId, previous);
        this.rebuildIdempotencyIndex();
        throw error;
      }
      return clone(migrated);
    });
  }

  update(runId: string, update: AgentRunUpdate): AgentRunRecord {
    const normalizedRunId = requireNonEmptyString(runId, 'runId');
    this.refresh();
    const snapshot = this.records.get(normalizedRunId);
    if (!snapshot) throw new Error(`agent run not found: ${normalizedRunId}`);

    const working = clone(snapshot);
    let candidate: AgentRunRecord;
    if (typeof update === 'function') {
      const returned = update(working);
      candidate = returned === undefined ? working : returned;
    } else {
      candidate = { ...working, ...clone(update) };
    }

    return withExclusiveFileLock(this.lockPath, () => {
      this.reloadFromDisk();
      this.assertHealthy();
      const previous = this.records.get(normalizedRunId);
      if (!previous) throw new Error(`agent run not found: ${normalizedRunId}`);
      if (JSON.stringify(previous) !== JSON.stringify(snapshot)) {
        throw new Error(`agent run changed concurrently: ${normalizedRunId}`);
      }
      assertIdentityUnchanged(previous, candidate);
      const validated = validateRecord({ ...candidate, updatedAt: this.clock().toISOString() });
      this.records.set(normalizedRunId, validated);
      this.rebuildIdempotencyIndex();
      try {
        this.persist();
      } catch (error) {
        this.records.set(normalizedRunId, previous);
        this.rebuildIdempotencyIndex();
        throw error;
      }
      return clone(validated);
    });
  }

  project(runId: string): AgentRunPublicProjection | undefined {
    const record = this.get(runId);
    return record ? projectAgentRun(record) : undefined;
  }

  assertHealthy(): void {
    if (this.corrupt || fs.existsSync(this.corruptMarkerPath)) {
      this.corrupt = true;
      throw new Error(`agent run store is corrupt and quarantined: ${this.corruptMarkerPath}`);
    }
  }

  private reloadFromDisk(): void {
    this.records.clear();
    this.idempotencyIndex.clear();
    this.corrupt = false;
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.corruptMarkerPath)) {
      this.corrupt = true;
      return;
    }
    if (!fs.existsSync(this.stateFilePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8')) as unknown;
      const state = validateState(parsed);
      for (const record of state.runs) this.records.set(record.runId, record);
      this.rebuildIdempotencyIndex();
    } catch (error) {
      this.failClosed(error);
    }
  }

  private failClosed(error: unknown): void {
    this.corrupt = true;
    fs.mkdirSync(path.dirname(this.corruptMarkerPath), { recursive: true });
    fs.writeFileSync(this.corruptMarkerPath, JSON.stringify({
      detectedAt: this.clock().toISOString(),
      sourcePath: this.stateFilePath,
      reason: error instanceof Error ? error.message : String(error),
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const suffix = this.clock().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(this.stateFilePath, `${this.stateFilePath}.corrupt-${suffix}`);
      }
    } catch {
      // The marker is authoritative even when the source cannot be moved.
    }
  }

  private persist(): void {
    this.assertHealthy();
    const state: AgentRunStoreState = {
      schemaVersion: SCHEMA_VERSION,
      runs: [...this.records.values()].map(clone),
    };
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    const temporaryPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, this.stateFilePath);
    } finally {
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch {
        // A stale private temp file is safer than masking the persistence error.
      }
    }
  }

  private addToIdempotencyIndex(record: AgentRunRecord): void {
    const idempotencyKey = record.triggerRef.idempotencyKey;
    if (!idempotencyKey) return;
    const key = indexKey(record.triggerRef.source, idempotencyKey);
    const existing = this.idempotencyIndex.get(key);
    if (existing && existing !== record.runId) {
      throw new Error(`duplicate trigger idempotency key for source ${record.triggerRef.source}`);
    }
    this.idempotencyIndex.set(key, record.runId);
  }

  private rebuildIdempotencyIndex(): void {
    this.idempotencyIndex.clear();
    for (const record of this.records.values()) this.addToIdempotencyIndex(record);
  }
}

export function projectAgentRun(record: AgentRunRecord): AgentRunPublicProjection {
  const validated = validateRecord(record);
  return {
    runId: validated.runId,
    runType: validated.runType,
    status: validated.status,
    initialGoal: validated.initialGoal,
    trigger: {
      source: validated.triggerRef.source,
      id: validated.triggerRef.id,
      ...(validated.triggerRef.summary ? { summary: validated.triggerRef.summary } : {}),
    },
    ...(validated.parentRunId ? { parentRunId: validated.parentRunId } : {}),
    ...(validated.branchPurpose ? { branchPurpose: validated.branchPurpose } : {}),
    createdAt: validated.createdAt,
    updatedAt: validated.updatedAt,
    ...(validated.lastWakeAt ? { lastWakeAt: validated.lastWakeAt } : {}),
    ...(validated.nextWakeAt ? { nextWakeAt: validated.nextWakeAt } : {}),
    blocked: validated.status === 'blocked' || !!validated.blocker,
    ...(validated.lastGoalCheck ? {
      lastGoalCheck: {
        checkedAt: validated.lastGoalCheck.checkedAt,
        complete: validated.lastGoalCheck.complete,
        capabilitiesExhausted: validated.lastGoalCheck.capabilitiesExhausted,
        hasNextAction: !!validated.lastGoalCheck.nextAction,
        hasBlocker: !!validated.lastGoalCheck.blocker,
        hasStopCondition: !!validated.lastGoalCheck.stopCondition,
      },
    } : {}),
    events: validated.events.map(event => ({
      ...(event.eventId ? { eventId: event.eventId } : {}),
      type: event.type,
      summary: publicEventSummary(event),
      createdAt: event.createdAt,
    })),
    artifacts: validated.artifacts.map(artifact => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      label: artifact.label,
      createdAt: artifact.createdAt,
    })),
    subjects: validated.subjects.map(subject => ({
      kind: subject.kind,
      id: subject.id,
      ...(subject.label ? { label: subject.label } : {}),
    })),
  };
}

const PUBLIC_EVENT_TYPES = new Set(['progress']);
const PRIVATE_EVENT_SUMMARIES: Readonly<Record<string, string>> = {
  supervisor_config: 'Supervisor configuration recorded',
  supervisor_input: 'Run input recorded',
  supervisor_context: 'Run context recorded',
  supervisor_final: 'Agent final recorded',
  goal_checked: 'Goal Check recorded',
};

function publicEventSummary(event: AgentRunEvent): string {
  if (PUBLIC_EVENT_TYPES.has(event.type)) return event.summary;
  return PRIVATE_EVENT_SUMMARIES[event.type] ?? 'Event details hidden';
}

export const toPublicAgentRunProjection = projectAgentRun;
export const projectAgentRunRecord = projectAgentRun;

export function validateAgentRunGoalCheck(value: unknown): AgentRunGoalCheck {
  const object = requireObject(value, 'goal check');
  const complete = requireBoolean(object.complete, 'lastGoalCheck.complete');
  const check: AgentRunGoalCheck = {
    checkedAt: requireTimestamp(object.checkedAt, 'lastGoalCheck.checkedAt'),
    complete,
    capabilitiesExhausted: requireBoolean(
      object.capabilitiesExhausted,
      'lastGoalCheck.capabilitiesExhausted',
    ),
    summary: requireNonEmptyString(object.summary, 'lastGoalCheck.summary'),
    ...(optionalString(object.nextAction) ? { nextAction: optionalString(object.nextAction) } : {}),
    ...(optionalString(object.blocker) ? { blocker: optionalString(object.blocker) } : {}),
    ...(optionalString(object.stopCondition) ? { stopCondition: optionalString(object.stopCondition) } : {}),
    ...(object.nextWakeAt !== undefined
      ? { nextWakeAt: requireTimestamp(object.nextWakeAt, 'lastGoalCheck.nextWakeAt') }
      : {}),
  };
  if (!complete && !check.nextAction && !check.blocker) {
    throw new Error('incomplete goal check requires nextAction or blocker');
  }
  if (!complete && !check.stopCondition) {
    throw new Error('incomplete goal check requires stopCondition');
  }
  return check;
}

export const validateGoalCheck = validateAgentRunGoalCheck;

function validateState(value: unknown): AgentRunStoreState {
  if (Array.isArray(value)) return { schemaVersion: 1, runs: validateRuns(value) };
  const object = requireObject(value, 'agent run store state');
  if (object.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported agent run store schema version');
  return { schemaVersion: 1, runs: validateRuns(object.runs) };
}

function validateRuns(value: unknown): AgentRunRecord[] {
  if (!Array.isArray(value)) throw new Error('agent run store runs must be an array');
  const seen = new Set<string>();
  const idempotencyKeys = new Set<string>();
  return value.map((entry, index) => {
    const record = validateRecord(entry, `runs[${index}]`);
    if (seen.has(record.runId)) throw new Error(`duplicate agent run id: ${record.runId}`);
    seen.add(record.runId);
    const key = record.triggerRef.idempotencyKey
      ? indexKey(record.triggerRef.source, record.triggerRef.idempotencyKey)
      : undefined;
    if (key && idempotencyKeys.has(key)) throw new Error('duplicate trigger idempotency key');
    if (key) idempotencyKeys.add(key);
    return record;
  });
}

function validateRecord(value: unknown, field = 'agent run'): AgentRunRecord {
  const object = requireObject(value, field);
  const triggerRef = validateTriggerRef(object.triggerRef, `${field}.triggerRef`);
  const events = requireArray(object.events, `${field}.events`).map((event, index) =>
    validateEvent(event, `${field}.events[${index}]`));
  const artifacts = requireArray(object.artifacts, `${field}.artifacts`).map((artifact, index) =>
    validateArtifact(artifact, `${field}.artifacts[${index}]`));
  const subjects = requireArray(object.subjects, `${field}.subjects`).map((subject, index) =>
    validateSubject(subject, `${field}.subjects[${index}]`));
  const status = object.status;
  if (typeof status !== 'string' || !STATUSES.has(status as AgentRunStatus)) {
    throw new Error(`${field}.status is invalid`);
  }
  return {
    runId: requireNonEmptyString(object.runId, `${field}.runId`),
    runType: requireNonEmptyString(object.runType, `${field}.runType`),
    triggerRef,
    sessionKey: requireNonEmptyString(object.sessionKey, `${field}.sessionKey`),
    initialGoal: requireNonEmptyString(object.initialGoal, `${field}.initialGoal`),
    status: status as AgentRunStatus,
    ...(optionalString(object.parentRunId) ? { parentRunId: optionalString(object.parentRunId) } : {}),
    ...(optionalString(object.branchPurpose) ? { branchPurpose: optionalString(object.branchPurpose) } : {}),
    createdAt: requireTimestamp(object.createdAt, `${field}.createdAt`),
    updatedAt: requireTimestamp(object.updatedAt, `${field}.updatedAt`),
    ...(object.lastWakeAt !== undefined
      ? { lastWakeAt: requireTimestamp(object.lastWakeAt, `${field}.lastWakeAt`) }
      : {}),
    ...(object.nextWakeAt !== undefined
      ? { nextWakeAt: requireTimestamp(object.nextWakeAt, `${field}.nextWakeAt`) }
      : {}),
    ...(optionalString(object.blocker) ? { blocker: optionalString(object.blocker) } : {}),
    ...(object.lastGoalCheck !== undefined
      ? { lastGoalCheck: validateAgentRunGoalCheck(object.lastGoalCheck) }
      : {}),
    events,
    artifacts,
    subjects,
  };
}

function validateTriggerRef(value: unknown, field: string): AgentRunTriggerRef {
  const object = requireObject(value, field);
  return {
    source: requireNonEmptyString(object.source, `${field}.source`),
    id: requireNonEmptyString(object.id, `${field}.id`),
    ...(optionalString(object.idempotencyKey)
      ? { idempotencyKey: optionalString(object.idempotencyKey) }
      : {}),
    ...(optionalString(object.actor) ? { actor: optionalString(object.actor) } : {}),
    ...(optionalString(object.summary) ? { summary: optionalString(object.summary) } : {}),
  };
}

function validateEvent(value: unknown, field: string): AgentRunEvent {
  const object = requireObject(value, field);
  return {
    ...(optionalString(object.eventId) ? { eventId: optionalString(object.eventId) } : {}),
    type: requireNonEmptyString(object.type, `${field}.type`),
    summary: requireNonEmptyString(object.summary, `${field}.summary`),
    createdAt: requireTimestamp(object.createdAt, `${field}.createdAt`),
  };
}

function validateArtifact(value: unknown, field: string): AgentRunArtifactRef {
  const object = requireObject(value, field);
  return {
    artifactId: requireNonEmptyString(object.artifactId, `${field}.artifactId`),
    kind: requireNonEmptyString(object.kind, `${field}.kind`),
    label: requireNonEmptyString(object.label, `${field}.label`),
    ref: requireNonEmptyString(object.ref, `${field}.ref`),
    createdAt: requireTimestamp(object.createdAt, `${field}.createdAt`),
  };
}

function validateSubject(value: unknown, field: string): AgentRunSubjectRef {
  const object = requireObject(value, field);
  return {
    kind: requireNonEmptyString(object.kind, `${field}.kind`),
    id: requireNonEmptyString(object.id, `${field}.id`),
    ...(optionalString(object.ref) ? { ref: optionalString(object.ref) } : {}),
    ...(optionalString(object.label) ? { label: optionalString(object.label) } : {}),
  };
}

function assertIdentityUnchanged(previous: AgentRunRecord, candidate: AgentRunRecord): void {
  const immutable: Array<keyof AgentRunRecord> = [
    'runId',
    'runType',
    'triggerRef',
    'sessionKey',
    'initialGoal',
    'parentRunId',
    'createdAt',
  ];
  for (const field of immutable) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(candidate[field])) {
      throw new Error(`agent run identity field is immutable: ${field}`);
    }
  }
}

function indexKey(source: string, idempotencyKey: string): string {
  return `${source}\u0000${idempotencyKey}`;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} must be an ISO-8601 timestamp`);
  return new Date(milliseconds).toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
