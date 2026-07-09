import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Capability Registry state store (issue #16).
 *
 * A durable runtime-owned current-state view of distilled capabilities. The
 * registry tracks the stable capability identity, the Active Snapshot that is
 * the executable expression of the capability, the routing description,
 * evidence refs, related snapshot IDs, status, and timestamps. It is **not** the
 * audit source of truth: it must remain rebuildable from installed snapshots,
 * review outcomes, provenance refs, and branch logs.
 *
 * This first V2 slice implements the narrow end-to-end path for three state
 * transitions:
 *
 *  - `new_capability`   — create a registry entry and set the initial Active
 *                        Snapshot.
 *  - `append_evidence`  — append evidence refs and update timestamps without
 *                        changing `activeSnapshotId`.
 *  - `supersede_snapshot` — install/select a new Active Snapshot, preserve the
 *                        prior active snapshot in `relatedSnapshotIds`, and
 *                        preserve evidence refs (issue #17).
 *
 * Registry state is persisted atomically (temp file + rename) and recovers
 * safely from corrupt state by quarantining the corrupt file so installed
 * snapshots and audit logs are never destroyed.
 *
 * See CONTEXT.md → "Capability Registry", "Active Snapshot",
 *   "Skill Evidence Append".
 * See ADR 0002 → "Independent Capability Registry".
 * See ADR 0004 → "Active Snapshot Updates Only on Material Guidance Change".
 * See docs/prd/runtime-capability-registry-v2.md.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Schema version for forward compatibility. */
export const CAPABILITY_REGISTRY_SCHEMA_VERSION = 1 as const;

/** Capability lifecycle status. */
export type CapabilityStatus = 'active' | 'superseded' | 'retired';

const VALID_CAPABILITY_STATUSES = new Set<CapabilityStatus>([
  'active',
  'superseded',
  'retired',
]);

/**
 * An evidence ref identifies a solved-loop evidence record that supports a
 * capability. The triple (sourceFilePath, turn, byteRange) is the durable
 * identity used for idempotent comparison; `evidenceId` is a stable digest that
 * makes equality checks cheap and avoids re-reading source logs.
 */
export interface EvidenceRef {
  /** Stable digest of the evidence record (deterministic from source identity). */
  evidenceId: string;
  /** Session log file path that holds the evidence. */
  sourceFilePath: string;
  /** Turn number within the source session log file. */
  turn: number;
  /** Byte range of the evidence record in the source log file. */
  byteRange: { start: number; end: number };
  /** ISO timestamp the evidence ref was appended to the registry. */
  appendedAt: string;
}

/**
 * A registry entry records the current consolidation state of one capability.
 *
 * Per ADR 0004, `append_evidence` updates `evidenceRefs` and `updatedAt` only;
 * it never changes `activeSnapshotId`. `activeSnapshotId` changes only through
 * a later `supersede_snapshot` transition (issue #17): when promotion review
 * determines that action pattern or boundaries materially changed, supersede
 * installs/selects a new Active Snapshot, preserves the prior active snapshot in
 * `relatedSnapshotIds`, and preserves evidence refs.
 */
export interface CapabilityRegistryEntry {
  /** Stable capability identity. */
  capabilityId: string;
  /** Active Snapshot identity (the `SKILL.md` snapshot currently selected). */
  activeSnapshotId: string;
  /** Lifecycle status of the capability. */
  status: CapabilityStatus;
  /** Routable When/Do summary matching the active skill's description. */
  routingDescription: string;
  /** Evidence refs backing this capability (idempotent append). */
  evidenceRefs: EvidenceRef[];
  /** Related snapshot IDs (historical/immutable snapshots for this capability). */
  relatedSnapshotIds: string[];
  /** ISO timestamp of registry entry creation. */
  createdAt: string;
  /** ISO timestamp of the last registry update. */
  updatedAt: string;
  /**
   * Optional source/review metadata preserved to support a later rebuild from
   * audit sources. This slice stores the originating review-outcome identity
   * and the distillation unit source so the registry can be rebuilt without
   * re-running the reviewer.
   */
  sourceReview?: {
    /** Review decision that produced the initial Active Snapshot. */
    decision: string;
    /** ISO timestamp of the originating review. */
    reviewedAt: string;
    /** Distillation Unit source identity. */
    sourceUnit: {
      filePath: string;
      byteRange: { start: number; end: number };
    };
  };
}

/**
 * The durable Capability Registry state file payload.
 */
export interface CapabilityRegistryState {
  schemaVersion: typeof CAPABILITY_REGISTRY_SCHEMA_VERSION;
  /** Map of capabilityId → registry entry. */
  capabilities: Record<string, CapabilityRegistryEntry>;
  /** Set when the state file was corrupt and quarantined on load. */
  stateCorrupt?: boolean;
}

// ---------------------------------------------------------------------------
// Public: empty / load / save
// ---------------------------------------------------------------------------

/** Return a fresh empty registry state. */
export function emptyCapabilityRegistryState(): CapabilityRegistryState {
  return {
    schemaVersion: CAPABILITY_REGISTRY_SCHEMA_VERSION,
    capabilities: {},
  };
}

/**
 * Load the Capability Registry state file from a runtime data root.
 *
 * When the state file does not exist, returns an empty registry. When the
 * state file is corrupt (unparseable JSON), the corrupt file is quarantined
 * (renamed to `<path>.corrupt.<timestamp>`) and an empty registry with
 * `stateCorrupt: true` is returned — installed snapshots and audit logs are
 * never touched.
 */
export function loadCapabilityRegistry(stateFilePath: string): CapabilityRegistryState {
  if (!fs.existsSync(stateFilePath)) {
    return emptyCapabilityRegistryState();
  }

  const raw = fs.readFileSync(stateFilePath, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as Partial<CapabilityRegistryState>;
    return {
      schemaVersion: CAPABILITY_REGISTRY_SCHEMA_VERSION,
      capabilities: sanitizeCapabilities(parsed.capabilities),
    };
  } catch {
    quarantineCorruptState(stateFilePath);
    return { ...emptyCapabilityRegistryState(), stateCorrupt: true };
  }
}

/**
 * Atomically persist the Capability Registry state file.
 *
 * Uses a temp file + `renameSync` so an interruption never leaves a partial
 * JSON state. The temp file is cleaned up on failure.
 */
export function saveCapabilityRegistry(
  stateFilePath: string,
  state: CapabilityRegistryState,
): void {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  const payload: CapabilityRegistryState = {
    schemaVersion: CAPABILITY_REGISTRY_SCHEMA_VERSION,
    capabilities: state.capabilities || {},
  };
  const tmpPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmpPath, stateFilePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; preserve the original error.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Public: `new_capability` transition
// ---------------------------------------------------------------------------

/** Input shape for creating a new registry entry. */
export interface NewCapabilityInput {
  /** Stable capability identity. */
  capabilityId: string;
  /** Initial Active Snapshot identity. */
  activeSnapshotId: string;
  /** Routable When/Do summary. */
  routingDescription: string;
  /** Initial evidence refs. */
  evidenceRefs: EvidenceRef[];
  /** Related snapshot IDs (at minimum, the initial active snapshot). */
  relatedSnapshotIds: string[];
  /** ISO timestamp of entry creation. */
  createdAt: string;
  /** Optional source/review metadata for later rebuild. */
  sourceReview?: CapabilityRegistryEntry['sourceReview'];
}

/**
 * `new_capability` transition: create a registry entry with capability
 * identity, Active Snapshot identity, routing description, evidence refs,
 * related snapshot IDs, status, and timestamps.
 *
 * Throws if a capability with the same `capabilityId` already exists in the
 * registry. The caller is responsible for deduplication decisions (via the
 * later Capability Prefilter + Promotion Review Branch); `new_capability` is
 * the deterministic write path for the "this is a new capability" decision.
 */
export function newCapability(
  state: CapabilityRegistryState,
  input: NewCapabilityInput,
): CapabilityRegistryEntry {
  assertNonEmpty(input.capabilityId, 'capabilityId');
  assertNonEmpty(input.activeSnapshotId, 'activeSnapshotId');

  if (state.capabilities[input.capabilityId]) {
    throw new Error(
      `Cannot create capability "${input.capabilityId}": a registry entry with this capabilityId already exists.`,
    );
  }

  const entry: CapabilityRegistryEntry = {
    capabilityId: input.capabilityId,
    activeSnapshotId: input.activeSnapshotId,
    status: 'active',
    routingDescription: input.routingDescription,
    evidenceRefs: dedupeEvidenceRefs(input.evidenceRefs),
    relatedSnapshotIds: dedupeStrings(input.relatedSnapshotIds),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    sourceReview: input.sourceReview,
  };

  state.capabilities[input.capabilityId] = entry;
  return entry;
}

// ---------------------------------------------------------------------------
// Public: `append_evidence` transition
// ---------------------------------------------------------------------------

/** Input shape for appending evidence to an existing registry entry. */
export interface AppendEvidenceInput {
  /** Stable capability identity to append evidence to. */
  capabilityId: string;
  /** Evidence refs to append. */
  evidenceRefs: EvidenceRef[];
  /** ISO timestamp of the append. */
  appendedAt: string;
}

/**
 * `append_evidence` transition: append evidence refs and update registry
 * timestamps **without changing `activeSnapshotId`** (ADR 0004).
 *
 * Duplicate evidence refs (matched by `evidenceId`) are handled idempotently:
 * appending the same evidence again does not duplicate entries and does not
 * change `updatedAt` when no new evidence was actually added.
 *
 * Throws if the capability does not exist in the registry. Evidence append is
 * only valid for an existing capability; a new capability must go through
 * `new_capability` first.
 */
export function appendEvidence(
  state: CapabilityRegistryState,
  input: AppendEvidenceInput,
): CapabilityRegistryEntry {
  assertNonEmpty(input.capabilityId, 'capabilityId');

  const entry = state.capabilities[input.capabilityId];
  if (!entry) {
    throw new Error(
      `Cannot append evidence to capability "${input.capabilityId}": no such registry entry.`,
    );
  }

  const before = entry.evidenceRefs;
  const merged = dedupeEvidenceRefs([...before, ...input.evidenceRefs]);

  // Idempotent: when no new evidence refs were added, do not touch `updatedAt`.
  if (merged.length === before.length) {
    return entry;
  }

  entry.evidenceRefs = merged;
  entry.updatedAt = input.appendedAt;
  // activeSnapshotId is intentionally left unchanged (ADR 0004).
  return entry;
}

// ---------------------------------------------------------------------------
// Public: `supersede_snapshot` transition
// ---------------------------------------------------------------------------

/** Input shape for superseding the active snapshot of an existing capability. */
export interface SupersedeSnapshotInput {
  /** Stable capability identity to supersede the active snapshot of. */
  capabilityId: string;
  /** Identity of the reviewed new Active Snapshot to select. */
  newActiveSnapshotId: string;
  /** ISO timestamp the supersede transition was applied. */
  supersededAt: string;
  /**
   * Optional updated routing description matching the new active skill's
   * `When / Do` summary. When provided and non-empty, the entry's
   * `routingDescription` is updated; otherwise it is left unchanged.
   */
  routingDescription?: string;
}

/**
 * `supersede_snapshot` transition: install/select a new Active Snapshot for an
 * existing capability (ADR 0004 / issue #17).
 *
 * This transition:
 *
 *  - updates `activeSnapshotId` to the reviewed new snapshot;
 *  - preserves the prior active snapshot in `relatedSnapshotIds` so historical
 *    snapshots remain connected to the capability (equivalent audit metadata);
 *  - adds the new active snapshot to `relatedSnapshotIds`;
 *  - preserves `evidenceRefs` across the transition;
 *  - optionally updates `routingDescription` when a new one is provided; and
 *  - updates `updatedAt`.
 *
 * It never deletes or overwrites immutable `SKILL.md` snapshots; it only mutates
 * registry state. Throws if the capability does not exist, or if the new
 * active snapshot is identical to the current one (supersede implies a
 * material change, not a no-op).
 */
export function supersedeSnapshot(
  state: CapabilityRegistryState,
  input: SupersedeSnapshotInput,
): CapabilityRegistryEntry {
  assertNonEmpty(input.capabilityId, 'capabilityId');
  assertNonEmpty(input.newActiveSnapshotId, 'newActiveSnapshotId');

  const entry = state.capabilities[input.capabilityId];
  if (!entry) {
    throw new Error(
      `Cannot supersede snapshot for capability "${input.capabilityId}": no such registry entry.`,
    );
  }

  if (input.newActiveSnapshotId === entry.activeSnapshotId) {
    throw new Error(
      `Cannot supersede snapshot for capability "${input.capabilityId}": newActiveSnapshotId is already the active snapshot.`,
    );
  }

  // Preserve the prior active snapshot in the related set so historical
  // immutable snapshots stay connected to the capability.
  const priorActiveSnapshotId = entry.activeSnapshotId;
  entry.relatedSnapshotIds = dedupeStrings([
    ...entry.relatedSnapshotIds,
    priorActiveSnapshotId,
    input.newActiveSnapshotId,
  ]);

  entry.activeSnapshotId = input.newActiveSnapshotId;

  if (isNonEmptyString(input.routingDescription)) {
    entry.routingDescription = input.routingDescription;
  }

  entry.updatedAt = input.supersededAt;
  // evidenceRefs are intentionally preserved across supersede transitions.
  return entry;
}

// ---------------------------------------------------------------------------
// Public: lookup helpers
// ---------------------------------------------------------------------------

/** Return a registry entry by capabilityId, or `undefined`. */
export function getCapability(
  state: CapabilityRegistryState,
  capabilityId: string,
): CapabilityRegistryEntry | undefined {
  return state.capabilities[capabilityId];
}

// ---------------------------------------------------------------------------
// Public: evidence ref helpers
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic `evidenceId` digest from a source identity triple.
 * The digest is stable across runs and lets `append_evidence` compare refs
 * idempotently without re-reading source logs.
 */
export function computeEvidenceId(
  sourceFilePath: string,
  turn: number,
  byteRange: { start: number; end: number },
): string {
  const content = JSON.stringify({
    sourceFilePath,
    turn,
    byteRange: { start: byteRange.start, end: byteRange.end },
  });
  const hash = crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, 16);
  // Include the path and turn in the id for human readability while keeping the
  // digest suffix for collision resistance across different source files.
  const safePath = sourceFilePath.replace(/[^A-Za-z0-9._-]/g, '_').slice(-32);
  return `${safePath}:${turn}:${hash}`;
}

/**
 * Build an `EvidenceRef` from a source identity triple and an append
 * timestamp, computing the `evidenceId` deterministically.
 */
export function makeEvidenceRef(
  sourceFilePath: string,
  turn: number,
  byteRange: { start: number; end: number },
  appendedAt: string,
): EvidenceRef {
  return {
    evidenceId: computeEvidenceId(sourceFilePath, turn, byteRange),
    sourceFilePath,
    turn,
    byteRange: { start: byteRange.start, end: byteRange.end },
    appendedAt,
  };
}

// ---------------------------------------------------------------------------
// Internal: validation + sanitization
// ---------------------------------------------------------------------------

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new Error(`Capability Registry: ${label} must be a non-empty string.`);
  }
}

/**
 * Sanitize a parsed `capabilities` map so a slightly malformed state file does
 * not crash the loader. Only entries with a non-empty `capabilityId` and
 * `activeSnapshotId` are kept; the rest are dropped (they can be rebuilt from
 * audit sources later).
 */
function sanitizeCapabilities(
  raw: unknown,
): Record<string, CapabilityRegistryEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const result: Record<string, CapabilityRegistryEntry> = {};
  for (const key of Object.keys(source)) {
    const entry = source[key];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Partial<CapabilityRegistryEntry>;
    if (!isNonEmptyString(e.capabilityId) || !isNonEmptyString(e.activeSnapshotId)) {
      continue;
    }
    result[e.capabilityId] = {
      capabilityId: e.capabilityId,
      activeSnapshotId: e.activeSnapshotId,
      status: sanitizeCapabilityStatus(e.status),
      routingDescription: isString(e.routingDescription)
        ? e.routingDescription
        : '',
      evidenceRefs: sanitizeEvidenceRefs(e.evidenceRefs),
      relatedSnapshotIds: sanitizeStringList(e.relatedSnapshotIds),
      createdAt: isString(e.createdAt) ? e.createdAt : '',
      updatedAt: isString(e.updatedAt) ? e.updatedAt : '',
      sourceReview: sanitizeSourceReview(e.sourceReview),
    };
  }
  return result;
}

function sanitizeCapabilityStatus(value: unknown): CapabilityStatus {
  return isString(value) && VALID_CAPABILITY_STATUSES.has(value as CapabilityStatus)
    ? (value as CapabilityStatus)
    : 'active';
}

function sanitizeEvidenceRefs(raw: unknown): EvidenceRef[] {
  if (!Array.isArray(raw)) return [];
  const refs: EvidenceRef[] = [];
  for (const ref of raw) {
    if (!ref || typeof ref !== 'object') continue;
    const candidate = ref as Partial<EvidenceRef>;
    if (
      !isNonEmptyString(candidate.evidenceId) ||
      !isString(candidate.sourceFilePath) ||
      typeof candidate.turn !== 'number' ||
      !candidate.byteRange ||
      typeof candidate.byteRange.start !== 'number' ||
      typeof candidate.byteRange.end !== 'number' ||
      !isString(candidate.appendedAt)
    ) {
      continue;
    }
    refs.push({
      evidenceId: candidate.evidenceId,
      sourceFilePath: candidate.sourceFilePath,
      turn: candidate.turn,
      byteRange: {
        start: candidate.byteRange.start,
        end: candidate.byteRange.end,
      },
      appendedAt: candidate.appendedAt,
    });
  }
  return dedupeEvidenceRefs(refs);
}

function sanitizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return dedupeStrings(raw.filter(isString));
}

function sanitizeSourceReview(
  raw: unknown,
): CapabilityRegistryEntry['sourceReview'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const review = raw as CapabilityRegistryEntry['sourceReview'];
  if (
    !review ||
    !isString(review.decision) ||
    !isString(review.reviewedAt) ||
    !review.sourceUnit ||
    !isString(review.sourceUnit.filePath) ||
    typeof review.sourceUnit.byteRange?.start !== 'number' ||
    typeof review.sourceUnit.byteRange?.end !== 'number'
  ) {
    return undefined;
  }
  return {
    decision: review.decision,
    reviewedAt: review.reviewedAt,
    sourceUnit: {
      filePath: review.sourceUnit.filePath,
      byteRange: {
        start: review.sourceUnit.byteRange.start,
        end: review.sourceUnit.byteRange.end,
      },
    },
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

/**
 * Deduplicate evidence refs by `evidenceId`, preserving insertion order (first
 * occurrence wins). This is the core idempotency mechanism for `append_evidence`
 * and for `new_capability` initial evidence.
 */
function dedupeEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  for (const ref of refs) {
    if (!ref || !ref.evidenceId) continue;
    if (seen.has(ref.evidenceId)) continue;
    seen.add(ref.evidenceId);
    result.push(ref);
  }
  return result;
}

/** Deduplicate string arrays preserving insertion order. */
function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal: corrupt-state quarantine
// ---------------------------------------------------------------------------

/**
 * Quarantine a corrupt state file by renaming it to
 * `<path>.corrupt.<timestamp>`. This preserves the corrupt file for inspection
 * while letting the next load start from a clean empty registry. It never
 * touches installed snapshots or audit logs.
 */
function quarantineCorruptState(stateFilePath: string): void {
  try {
    if (!fs.existsSync(stateFilePath)) return;
    const corruptPath = `${stateFilePath}.corrupt.${Date.now()}`;
    fs.renameSync(stateFilePath, corruptPath);
  } catch {
    // Best-effort quarantine only. If quarantine fails the next load will
    // re-attempt to parse and quarantine; an empty registry is still returned.
  }
}
