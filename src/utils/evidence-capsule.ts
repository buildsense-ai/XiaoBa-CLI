/**
 * Evidence Capsule — bounded, redacted external evidence snapshot for
 * upstream-independent review retry (issue #78).
 *
 * When external Session Log Source evidence is admitted as a Learning Episode,
 * an Evidence Capsule is created to:
 *   1. Redact sensitive fields (system prompts, credentials, paths, etc.)
 *      before the evidence reaches Author/Verifier model analysis.
 *   2. Durably pin the redacted evidence so mutating, deleting, or disabling
 *      the upstream source does not affect retry or reassessment.
 *   3. Preserve enough provenance (provider, source identity, event identity,
 *      revision, content hash) and evidence content to reconstruct the
 *      EvidenceBundle required by review retry.
 *   4. Record promotion / audit linkage so the capsule is traceable through
 *      the Capability Transition pipeline.
 *
 * Internal evidence does NOT create capsules — internal log files are runtime-
 * owned and do not require redaction or upstream-independence. The capsule is
 * exclusively for external-origin evidence.
 *
 * See ADR 00XX, issue #78.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  EvidenceBundle,
  BoundedSourceEvidence,
  SkillEvidenceRef,
  ReferencedSkillSnapshot,
  RelatedCurrentSkill,
  RuntimeOwnedReferencedSkillProvenance,
} from './skill-evolution';
import { DistilledKnowledgeCandidate } from './capability-distiller';
import { type SemanticObservation } from './learning-episode';
import { type SessionLogSourceIdentity, type SourceEventIdentity } from './session-log-source';
import { type DistillationTurn, type DistillationUnit } from './distillation-unit';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EVIDENCE_CAPSULE_SCHEMA_VERSION = 1 as const;

/** Hard bounds for external evidence before it becomes durable or model-facing. */
export const MAX_EVIDENCE_CAPSULE_ENTRIES = 64;
/**
 * Per-entry content bound. Kept coherent with MAX_EXTERNAL_TURN_TEXT_BYTES so
 * an ordinary external final that passes turn admission can also form a
 * durable capsule entry. Oversize above this bound remains fail-closed.
 */
export const MAX_EVIDENCE_CAPSULE_ENTRY_CONTENT_BYTES = 16 * 1024;
export const MAX_EVIDENCE_CAPSULE_PAYLOAD_BYTES = 128 * 1024;
export const MAX_EVIDENCE_CAPSULE_OBSERVATIONS = 32;
export const MAX_EVIDENCE_CAPSULE_OBSERVATION_PAYLOAD_BYTES = 16 * 1024;

const MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES = 2 * 1024;
/**
 * Fail-closed bound for one external user/assistant text field after redaction.
 * Sized for ordinary Pi/Codex final responses while remaining far below the
 * capsule payload ceiling. Coherent with MAX_EVIDENCE_CAPSULE_ENTRY_CONTENT_BYTES.
 * Oversize still rejects (no silent truncation of the admission path);
 * operator retry recovers after a policy change.
 */
export const MAX_EXTERNAL_TURN_TEXT_BYTES = 16 * 1024;
const MAX_EXTERNAL_TOOL_ARGUMENT_BYTES = 3 * 1024;
const MAX_EXTERNAL_TOOL_RESULT_BYTES = 4 * 1024;
const MAX_EXTERNAL_TOOL_COUNT = 64;
const MAX_EXTERNAL_VALUE_DEPTH = 4;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type EvidenceCapsuleCategory = 'internal' | 'external';

export interface EvidenceCapsuleProvenance {
  readonly sourceId: string;
  readonly provider: string;
  readonly reader: string;
  readonly category: EvidenceCapsuleCategory;
}

// ---------------------------------------------------------------------------
// Event identity
// ---------------------------------------------------------------------------

export interface EvidenceCapsuleIdentity {
  readonly eventId: string;
  readonly position: number;
  readonly contentHash: string;
  readonly conversationId?: string;
  readonly branchId?: string;
  readonly revision?: string;
}

// ---------------------------------------------------------------------------
// Redacted evidence entry
// ---------------------------------------------------------------------------

export interface EvidenceCapsuleEvidence {
  readonly ref: string;
  readonly content: string;
  readonly role: 'problem-action' | 'verification';
  readonly sourceFilePath?: string;
  readonly turn?: number;
  readonly byteRange?: { start: number; end: number };
}

// ---------------------------------------------------------------------------
// Capsule
// ---------------------------------------------------------------------------

export interface EvidenceCapsule {
  readonly schemaVersion: typeof EVIDENCE_CAPSULE_SCHEMA_VERSION;
  readonly capsuleId: string;
  readonly provenance: EvidenceCapsuleProvenance;
  readonly identity: EvidenceCapsuleIdentity;
  readonly evidenceFingerprint: string;
  readonly episodeId: string;
  readonly bundleId: string;
  readonly completionEvidence: readonly EvidenceCapsuleEvidence[];
  readonly settlementEvidence: readonly EvidenceCapsuleEvidence[];
  readonly semanticObservations: readonly SemanticObservation[];
  readonly redactedAt: string;
  readonly promotionAuditRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Capsule store state
// ---------------------------------------------------------------------------

export interface EvidenceCapsuleStoreState {
  schemaVersion: typeof EVIDENCE_CAPSULE_SCHEMA_VERSION;
  capsules: Record<string, EvidenceCapsule>;
}

// ---------------------------------------------------------------------------
// EvidenceCapsuleStore
// ---------------------------------------------------------------------------

const emptyCapsuleStoreState = (): EvidenceCapsuleStoreState => ({
  schemaVersion: EVIDENCE_CAPSULE_SCHEMA_VERSION,
  capsules: {},
});

export class EvidenceCapsuleStore {
  constructor(private readonly filePath: string) {}

  /** Load the durable capsule store. Corruption fails closed; it never becomes an empty store. */
  load(): EvidenceCapsuleStoreState {
    if (!fs.existsSync(this.filePath)) return emptyCapsuleStoreState();
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as EvidenceCapsuleStoreState & { schemaVersion?: number };
      if (parsed.schemaVersion !== EVIDENCE_CAPSULE_SCHEMA_VERSION
        || !parsed.capsules || typeof parsed.capsules !== 'object') {
        throw new Error(`unsupported or malformed evidence capsule state: ${this.filePath}`);
      }
      return parsed as EvidenceCapsuleStoreState;
    } catch (error) {
      throw new Error(`evidence capsule state is corrupt: ${this.filePath}: ${String(error)}`);
    }
  }

  /** Persist the capsule store atomically via temp-file + rename. */
  save(state: EvidenceCapsuleStoreState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  /** Upsert a capsule and persist. */
  upsert(capsule: EvidenceCapsule): void {
    assertEvidenceCapsuleWithinBounds(capsule);
    const state = this.load();
    const existing = state.capsules[capsule.capsuleId]
      ?? Object.values(state.capsules).find(item => item.bundleId === capsule.bundleId);
    if (existing) {
      if (capsuleImmutableFingerprint(existing) !== capsuleImmutableFingerprint(capsule)) {
        throw new Error(`evidence capsule immutable integrity conflict for bundle ${capsule.bundleId}`);
      }
      return;
    }
    state.capsules[capsule.capsuleId] = {
      ...capsule,
      promotionAuditRefs: [...capsule.promotionAuditRefs],
    } as EvidenceCapsule;
    this.save(state);
  }

  /** Find a capsule by episode id. Returns undefined when not found. */
  findByEpisodeId(episodeId: string): EvidenceCapsule | undefined {
    const state = this.load();
    return Object.values(state.capsules).find(c => c.episodeId === episodeId);
  }

  /** Find a capsule by bundle id. Returns undefined when not found. */
  findByBundleId(bundleId: string): EvidenceCapsule | undefined {
    const state = this.load();
    return Object.values(state.capsules).find(c => c.bundleId === bundleId);
  }

  /** Record a promotion audit transition id for a given capsule. */
  addPromotionAuditRef(capsuleId: string, auditTransitionId: string): void {
    const state = this.load();
    const capsule = state.capsules[capsuleId];
    if (!capsule) return;
    const updated = {
      ...capsule,
      promotionAuditRefs: [...capsule.promotionAuditRefs, auditTransitionId],
    } as EvidenceCapsule;
    state.capsules[capsuleId] = updated;
    this.save(state);
  }

  /**
   * Refresh the settlement evidence of a persisted capsule after Learning
   * Episode maturation. Settlement evidence is runtime-owned maturation
   * metadata, not external content; the durable capsule is pinned at admission
   * while the episode is still settling, so it must be re-derived from the
   * authoritative matured status before review enqueues from the capsule.
   *
   * The settlement ref is lifecycle-neutral and stable across maturation, so
   * only the content (and the recomputed evidenceFingerprint) changes. The
   * completion evidence — pinned external content — is never touched here.
   */
  refreshSettlementEvidence(
    bundleId: string,
    settlementEvidence: readonly {
      ref: string;
      content: string;
      sourceFilePath?: string;
      turn?: number;
      byteRange?: { start: number; end: number };
    }[],
  ): boolean {
    const state = this.load();
    const capsule = Object.values(state.capsules).find(c => c.bundleId === bundleId);
    if (!capsule) return false;
    const redactedSettlement = settlementEvidence.map(entry => redactCapsuleEvidenceEntry({
      ...entry,
      role: 'verification' as const,
    }));
    const updated = {
      ...capsule,
      settlementEvidence: redactedSettlement,
      evidenceFingerprint: computeCapsuleFingerprint(capsule.completionEvidence, redactedSettlement),
    } as EvidenceCapsule;
    assertEvidenceCapsuleWithinBounds(updated);
    state.capsules[capsule.capsuleId] = updated;
    this.save(state);
    return true;
  }

  /**
   * Delete only with an audit reference. Retention/deletion is deliberately
   * explicit so an operator cannot erase evidence without a traceable link.
   */
  delete(capsuleId: string, auditRef: string): boolean {
    if (!auditRef.trim()) throw new Error('capsule deletion requires an audit reference');
    const state = this.load();
    const capsule = state.capsules[capsuleId];
    if (!capsule) return false;
    if (!capsule.promotionAuditRefs.includes(auditRef)) {
      throw new Error(`capsule deletion audit reference is not linked: ${auditRef}`);
    }
    delete state.capsules[capsuleId];
    this.save(state);
    return true;
  }

  /** Add an audit-linked retention/deletion decision without changing evidence. */
  retain(capsuleId: string, auditRef: string): void {
    if (!auditRef.trim()) throw new Error('capsule retention requires an audit reference');
    const state = this.load();
    const capsule = state.capsules[capsuleId];
    if (!capsule) throw new Error(`capsule not found: ${capsuleId}`);
    if (!capsule.promotionAuditRefs.includes(auditRef)) {
      state.capsules[capsuleId] = {
        ...capsule,
        promotionAuditRefs: [...capsule.promotionAuditRefs, auditRef],
      };
      this.save(state);
    }
  }

  /** Count of stored capsules for diagnostics. */
  count(): number {
    return Object.keys(this.load().capsules).length;
  }
}

function capsuleImmutableFingerprint(capsule: EvidenceCapsule): string {
  return hash(JSON.stringify({
    provenance: capsule.provenance,
    identity: capsule.identity,
    episodeId: capsule.episodeId,
    bundleId: capsule.bundleId,
    completionEvidence: capsule.completionEvidence,
    semanticObservations: capsule.semanticObservations,
  }));
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Redact sensitive fields from external evidence content.
 *
 * Strips or replaces:
 *   - System prompts (<system>...</system> or ```system ... ```)
 *   - Prompt traces and intermediate conversation scaffolding
 *   - Credentials, API keys, tokens, passwords, secrets
 *   - Environment variable values that carry secrets
 *   - Local absolute file paths that leak system structure
 *   - Database and API connection URLs with embedded credentials
 *   - Internal routing/diagnostic metadata
 *
 * The output preserves the overall shape and structure of the evidence so
 * Author/Verifier can still evaluate the bounded event, but removes fields
 * that are sensitive, environment-specific, or not relevant to the learning.
 */
export function redactExternalEvidenceContent(content: string): string {
  if (!content) return content;

  let redacted = content;

  // System prompt blocks (XML-style)
  redacted = redacted.replace(/<system>[\s\S]*?<\/system>/gi, '[system prompt redacted]');

  // System prompt blocks (Markdown code-fence style)
  redacted = redacted.replace(/```system[\s\S]*?```/gi, '```system\n[system prompt redacted]\n```');

  // Credentials and tokens (key=value, key: value, --flag value)
  redacted = redacted.replace(
    /\b(api[_-]?key|secret|token|password|credential|auth|apikey)[=:]\s*\S+/gi,
    '$1: [REDACTED]',
  );
  redacted = redacted.replace(
    /(--(?:api-key|token|secret|password|credential|auth-key))\s+\S+/gi,
    '$1 [REDACTED]',
  );

  // Bearer token auth headers
  redacted = redacted.replace(
    /(?:authorization|auth):\s*Bearer\s+\S+/gi,
    'authorization: Bearer [REDACTED]',
  );

  // Environment variable references with known secrets
  redacted = redacted.replace(
    /\b(?:process\.env|process\.env\.get)\(\s*['"`](?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH_KEY)['"`]\s*\)/gi,
    '[ENV REDACTED]',
  );
  // Bare process.env references (no parens) to secret-related env vars
  redacted = redacted.replace(
    /\bprocess\.env\.(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH_KEY|KEY)\b/gi,
    '[ENV REDACTED]',
  );

  // Local absolute filesystem paths (macOS /Users/..., Linux /home/...)
  redacted = redacted.replace(
    /(?:['"`]|(?:^|[\s({:,]))\/(?:Users|home|tmp|var\/log|private)\/[^\s'"`)\]>}]+/g,
    (match) => {
      // Keep node_modules paths and short paths
      if (match.includes('node_modules') || match.length < 15) return match;
      const prefix = /^['"`]/.test(match) ? match[0] : '';
      return prefix ? `${prefix}'[REDACTED_PATH]'` : ' [REDACTED_PATH]';
    },
  );

  // Database / API connection URLs with credentials
  redacted = redacted.replace(
    /(?:https?|mongodb|postgres(?:ql)?|mysql|redis):\/\/[^\s:@]+:[^\s:@]+@[^\s]+/gi,
    (match) => {
      const protocol = match.split('://')[0];
      return `${protocol}://[REDACTED]:[REDACTED]@[REDACTED]`;
    },
  );

  // Prompt traces and internal diagnostic metadata lines
  redacted = redacted.replace(/^.*PROMPT_TRACE[:\s].*$/gmi, '[PROMPT TRACE REDACTED]');
  redacted = redacted.replace(/^.*\[internal\]\s*.*$/gmi, (match) => {
    if (match.length > 120) return '[INTERNAL DIAGNOSTIC REDACTED]';
    return match;
  });

  // Conversation scaffolding and intermediate processing instructions
  redacted = redacted.replace(
    /<thinking>[\s\S]*?<\/thinking>/gi,
    '<thinking>[REDACTED]</thinking>',
  );

  // Empty or whitespace-only lines after redaction
  redacted = redacted.replace(/^\s*[\r\n]/gm, '');

  return redacted.trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8').trimEnd();
}

function redactAndBoundExternalText(value: string, maxBytes = MAX_EXTERNAL_TURN_TEXT_BYTES): string {
  return truncateUtf8(redactExternalEvidenceContent(String(value ?? '')), maxBytes);
}

function opaqueExternalIdentity(value: string, prefix: string): string {
  return `${prefix}-${hash(String(value)).slice(0, 24)}`;
}

function sanitizeExternalValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_EXTERNAL_VALUE_DEPTH) return '[REDACTED_NESTED_VALUE]';
  if (typeof value === 'string') {
    return redactAndBoundExternalText(value, MAX_EXTERNAL_TOOL_ARGUMENT_BYTES);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_EXTERNAL_TOOL_COUNT).map(item => sanitizeExternalValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_EXTERNAL_TOOL_COUNT);
    return Object.fromEntries(entries.map(([key, item]) => [
      truncateUtf8(redactExternalEvidenceContent(key), 128),
      /(?:api[_-]?key|secret|token|password|credential|auth|private[_-]?key)/i.test(key)
        ? '[REDACTED]'
        : sanitizeExternalValue(item, depth + 1),
    ]));
  }
  return '[REDACTED_VALUE]';
}

function sanitizeExternalToolCall(tool: Record<string, unknown>): Record<string, unknown> {
  const rawArguments = JSON.stringify(tool.arguments ?? {});
  assertByteLimit('external tool arguments', rawArguments, MAX_EXTERNAL_TOOL_ARGUMENT_BYTES);
  assertByteLimit('external tool result', String(tool.result ?? ''), MAX_EXTERNAL_TOOL_RESULT_BYTES);
  const argumentsValue = sanitizeExternalValue(tool.arguments);
  const boundedArguments = truncateUtf8(
    JSON.stringify(argumentsValue ?? {}),
    MAX_EXTERNAL_TOOL_ARGUMENT_BYTES,
  );
  const result = redactAndBoundExternalText(String(tool.result ?? ''), MAX_EXTERNAL_TOOL_RESULT_BYTES);
  return {
    id: typeof tool.id === 'string' ? opaqueExternalIdentity(tool.id, 'tool') : 'tool',
    name: redactAndBoundExternalText(String(tool.name ?? 'external-tool'), 128),
    arguments: boundedArguments,
    result,
    ...(typeof tool.duration_ms === 'number' && Number.isFinite(tool.duration_ms)
      ? { duration_ms: Math.max(0, Math.floor(tool.duration_ms)) }
      : {}),
  };
}

function sanitizeExternalTurn(turn: DistillationTurn, safeFilePath: string): DistillationTurn {
  const raw = turn as unknown as Record<string, unknown>;
  const user = (raw.user ?? {}) as Record<string, unknown>;
  const assistant = (raw.assistant ?? {}) as Record<string, unknown>;
  const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
  assertByteLimit('external user text', String(user.text ?? ''), MAX_EXTERNAL_TURN_TEXT_BYTES);
  assertByteLimit('external assistant text', String(assistant.text ?? ''), MAX_EXTERNAL_TURN_TEXT_BYTES);
  if (Array.isArray(user.runtime_feedback)) {
    for (const feedback of user.runtime_feedback) {
      assertByteLimit('external runtime feedback', String(feedback), 1024);
    }
  }
  const sanitized: Record<string, unknown> = {
    turn: typeof raw.turn === 'number' ? raw.turn : 0,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date(0).toISOString(),
    session_id: opaqueExternalIdentity(String(raw.session_id ?? ''), 'external-session'),
    session_type: redactAndBoundExternalText(String(raw.session_type ?? 'external'), 128),
    user: {
      text: redactAndBoundExternalText(String(user.text ?? '')),
      ...(Array.isArray(user.runtime_feedback)
        ? { runtime_feedback: user.runtime_feedback.slice(0, 16).map(item => redactAndBoundExternalText(String(item), 1024)) }
        : {}),
      ...(typeof user.runtime_observation_source === 'string'
        ? { runtime_observation_source: redactAndBoundExternalText(user.runtime_observation_source, 256) }
        : {}),
      // External image ids/paths are not needed for learning admission.
    },
    assistant: {
      text: redactAndBoundExternalText(String(assistant.text ?? '')),
      tool_calls: toolCalls
        .slice(0, MAX_EXTERNAL_TOOL_COUNT)
        .map(tool => sanitizeExternalToolCall((tool ?? {}) as Record<string, unknown>)),
    },
    // Token counts are not learning evidence and must not carry token material
    // across the external privacy boundary.
    tokens: { prompt: 0, completion: 0 },
    origin: { filePath: safeFilePath },
  };

  if (typeof raw.entry_type === 'string') sanitized.entry_type = raw.entry_type;
  if (typeof raw.episode_id === 'string' && raw.episode_id.trim()) {
    sanitized.episode_id = opaqueExternalIdentity(raw.episode_id, 'external-episode');
  }
  return sanitized as unknown as DistillationTurn;
}

/**
 * Sanitize an external Distillation Unit before EvidenceIngestor admission.
 * The returned unit has opaque source/session identities, no prompt metadata,
 * bounded redacted text, and no externally supplied filesystem path.
 */
export function sanitizeExternalDistillationUnit(
  unit: DistillationUnit,
  options: { sourceId: string; eventIdentity?: Pick<SourceEventIdentity, 'eventId' | 'position'> },
): DistillationUnit {
  const eventPart = options.eventIdentity
    ? `${options.eventIdentity.eventId}|${options.eventIdentity.position}`
    : unit.filePath;
  const safeFilePath = `external://event/${hash(`${options.sourceId}|${eventPart}|${unit.byteRange.start}|${unit.byteRange.end}`).slice(0, 24)}.jsonl`;
  const sanitizedUnit: DistillationUnit = {
    filePath: safeFilePath,
    newTurns: unit.newTurns.map(turn => sanitizeExternalTurn(turn, safeFilePath)),
    continuityTurns: unit.continuityTurns.map(turn => sanitizeExternalTurn(turn, safeFilePath)),
    byteRange: unit.byteRange,
    generatedAt: unit.generatedAt,
  };
  assertSanitizedExternalUnitBounds(sanitizedUnit);
  return sanitizedUnit;
}

/** Redact and bound external identity metadata used in durable capsules. */
export function sanitizeExternalSourceIdentity(identity: SessionLogSourceIdentity): SessionLogSourceIdentity {
  return {
    ...identity,
    sourceId: redactAndBoundExternalText(identity.sourceId, MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES),
    label: redactAndBoundExternalText(identity.label, MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES),
    provider: redactAndBoundExternalText(identity.provider, MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES),
    reader: redactAndBoundExternalText(identity.reader, MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES),
  };
}

export function sanitizeExternalEventIdentity(identity: SourceEventIdentity): SourceEventIdentity {
  return {
    eventId: redactAndBoundExternalText(identity.eventId, MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES),
    position: identity.position,
    ...(identity.contentHash
      ? { contentHash: redactAndBoundExternalText(identity.contentHash, MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES) }
      : {}),
    ...(identity.conversationId
      ? { conversationId: redactAndBoundExternalText(identity.conversationId, MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES) }
      : {}),
    ...(identity.branchId
      ? { branchId: redactAndBoundExternalText(identity.branchId, MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES) }
      : {}),
    ...(identity.revision
      ? { revision: redactAndBoundExternalText(identity.revision, MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES) }
      : {}),
  };
}

function assertSanitizedExternalUnitBounds(unit: DistillationUnit): void {
  const turns = [...unit.continuityTurns, ...unit.newTurns];
  const toolDetails = turns.flatMap(turn => turn.assistant.tool_calls.map(tool => {
    const argumentsText = typeof tool.arguments === 'string'
      ? tool.arguments
      : JSON.stringify(tool.arguments ?? '');
    const suffix = argumentsText && argumentsText !== '{}' ? ` ${argumentsText}` : '';
    return `${tool.name}${suffix}: ${String(tool.result || '')}`.trim();
  }));
  const candidateContents = [
    ...toolDetails,
    ...turns.map(turn => turn.user.text),
    ...turns.map(turn => turn.assistant.text),
  ];
  const estimatedEntryCount = toolDetails.length + turns.length + 1;
  if (estimatedEntryCount > MAX_EVIDENCE_CAPSULE_ENTRIES) {
    throw new Error(`external Distillation Unit entry count exceeds ${MAX_EVIDENCE_CAPSULE_ENTRIES}`);
  }
  for (const [index, content] of candidateContents.entries()) {
    assertByteLimit(
      `external Distillation Unit evidence ${index}`,
      content,
      MAX_EVIDENCE_CAPSULE_ENTRY_CONTENT_BYTES,
    );
  }
  assertByteLimit(
    'external Distillation Unit payload',
    JSON.stringify({ source: unit.filePath, contents: candidateContents }),
    MAX_EVIDENCE_CAPSULE_PAYLOAD_BYTES,
  );
}

// ---------------------------------------------------------------------------
// Capsule builder
// ---------------------------------------------------------------------------

export interface BuildEvidenceCapsuleOptions {
  sourceIdentity: SessionLogSourceIdentity;
  eventIdentity: SourceEventIdentity;
  episodeId: string;
  bundleId: string;
  completionEvidence: readonly {
    ref: string;
    content: string;
    role: 'problem-action' | 'verification';
    sourceFilePath?: string;
    turn?: number;
    byteRange?: { start: number; end: number };
  }[];
  settlementEvidence: readonly {
    ref: string;
    content: string;
    role: 'problem-action' | 'verification';
    sourceFilePath?: string;
    turn?: number;
    byteRange?: { start: number; end: number };
  }[];
  semanticObservations?: readonly SemanticObservation[];
  now?: Date;
}

function assertByteLimit(label: string, value: string, maxBytes: number): void {
  const actualBytes = Buffer.byteLength(value, 'utf8');
  if (actualBytes > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte external evidence limit`);
  }
}

function assertRawEvidenceBounds(options: BuildEvidenceCapsuleOptions): void {
  const entries = [...options.completionEvidence, ...options.settlementEvidence];
  if (entries.length > MAX_EVIDENCE_CAPSULE_ENTRIES) {
    throw new Error(`external evidence entry count exceeds ${MAX_EVIDENCE_CAPSULE_ENTRIES}`);
  }
  for (const [index, entry] of entries.entries()) {
    assertByteLimit(`external evidence entry ${index}`, entry.content, MAX_EVIDENCE_CAPSULE_ENTRY_CONTENT_BYTES);
  }
  const observations = options.semanticObservations ?? [];
  if (observations.length > MAX_EVIDENCE_CAPSULE_OBSERVATIONS) {
    throw new Error(`external observation count exceeds ${MAX_EVIDENCE_CAPSULE_OBSERVATIONS}`);
  }
  const observationPayload = JSON.stringify(observations);
  assertByteLimit(
    'external observation payload',
    observationPayload,
    MAX_EVIDENCE_CAPSULE_OBSERVATION_PAYLOAD_BYTES,
  );
  const rawPayload = JSON.stringify({
    completion: options.completionEvidence,
    settlement: options.settlementEvidence,
    observations,
  });
  assertByteLimit('external capsule input payload', rawPayload, MAX_EVIDENCE_CAPSULE_PAYLOAD_BYTES);
}

/** Validate a capsule immediately before durable persistence. */
export function assertEvidenceCapsuleWithinBounds(capsule: EvidenceCapsule): void {
  const entries = [...capsule.completionEvidence, ...capsule.settlementEvidence];
  if (entries.length > MAX_EVIDENCE_CAPSULE_ENTRIES) {
    throw new Error(`evidence capsule entry count exceeds ${MAX_EVIDENCE_CAPSULE_ENTRIES}`);
  }
  for (const [index, entry] of entries.entries()) {
    assertByteLimit(`evidence capsule entry ${index}`, entry.content, MAX_EVIDENCE_CAPSULE_ENTRY_CONTENT_BYTES);
    if (entry.ref) assertByteLimit(`evidence capsule entry ${index} ref`, entry.ref, MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES);
    if (entry.sourceFilePath) {
      assertByteLimit(
        `evidence capsule entry ${index} source reference`,
        entry.sourceFilePath,
        MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES,
      );
    }
  }
  if (capsule.semanticObservations.length > MAX_EVIDENCE_CAPSULE_OBSERVATIONS) {
    throw new Error(`evidence capsule observation count exceeds ${MAX_EVIDENCE_CAPSULE_OBSERVATIONS}`);
  }
  const observationPayload = JSON.stringify(capsule.semanticObservations);
  assertByteLimit(
    'evidence capsule observation payload',
    observationPayload,
    MAX_EVIDENCE_CAPSULE_OBSERVATION_PAYLOAD_BYTES,
  );
  const payload = JSON.stringify(capsule);
  assertByteLimit('evidence capsule payload', payload, MAX_EVIDENCE_CAPSULE_PAYLOAD_BYTES);
}

/**
 * Build a bounded, redacted Evidence Capsule from an admitted external event.
 *
 * Every evidence entry's content is redacted before durable storage.
 * The capsule records provenance (source identity, provider), event identity,
 * and a stable content hash derived from the redacted evidence.
 */
export function buildEvidenceCapsule(options: BuildEvidenceCapsuleOptions): EvidenceCapsule {
  assertRawEvidenceBounds(options);
  const now = options.now ?? new Date();
  const capsuleId = `capsule-${hash([options.bundleId, now.toISOString()].join('|')).slice(0, 20)}`;

  // Redact each evidence entry's content before durable persistence
  const redactedCompletion = options.completionEvidence.map(redactCapsuleEvidenceEntry) satisfies EvidenceCapsuleEvidence[];
  const redactedSettlement = options.settlementEvidence.map(redactCapsuleEvidenceEntry) satisfies EvidenceCapsuleEvidence[];

  // Compute hash from the redacted evidence content (stable across restarts)
  const evidenceFingerprint = computeCapsuleFingerprint(redactedCompletion, redactedSettlement);

  const safeSourceIdentity = sanitizeExternalSourceIdentity(options.sourceIdentity);
  const safeEventIdentity = sanitizeExternalEventIdentity(options.eventIdentity);
  const capsule: EvidenceCapsule = {
    schemaVersion: EVIDENCE_CAPSULE_SCHEMA_VERSION,
    capsuleId,
    provenance: {
      sourceId: safeSourceIdentity.sourceId,
      provider: safeSourceIdentity.provider,
      reader: safeSourceIdentity.reader,
      category: safeSourceIdentity.category,
    },
    identity: {
      eventId: safeEventIdentity.eventId,
      position: safeEventIdentity.position,
      contentHash: safeEventIdentity.contentHash ?? 'no-event-hash',
      conversationId: safeEventIdentity.conversationId,
      branchId: safeEventIdentity.branchId,
      revision: safeEventIdentity.revision,
    },
    evidenceFingerprint,
    episodeId: options.episodeId,
    bundleId: options.bundleId,
    completionEvidence: redactedCompletion,
    settlementEvidence: redactedSettlement,
    semanticObservations: [...(options.semanticObservations ?? [])].map(redactSemanticObservation),
    redactedAt: now.toISOString(),
    promotionAuditRefs: [],
  };
  assertEvidenceCapsuleWithinBounds(capsule);
  return capsule;
}

// ---------------------------------------------------------------------------
// Bundle reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct a complete, valid EvidenceBundle from a stored Evidence Capsule.
 *
 * This bundle:
 *   - Contains redacted evidence content as BoundedSourceEvidence so that
 *     validateEvidenceBundle passes (every completion/settlement ref maps
 *     to a sourceEvidence entry with the correct role).
 *   - Carries the same bundleId and episode identity so that the existing
 *     review deduplication (hasReviewedEpisode, queue state) works.
 *   - Carries only the caller-selected bounded Current Skill context; capsule
 *     reconstruction never expands that set from the global Registry.
 *   - Reconstructs a fallback DistilledKnowledgeCandidate when the capsule
 *     does not carry a full candidate object — this satisfies the
 *     EvidenceBundle.episode contract without requiring the original
 *     episode data.
 *
 * Retry invariance: the reconstructed bundle from a pinned capsule does
 * not depend on the upstream external source. Mutating or deleting the
 * upstream does not change the capsule or the reconstructed bundle.
 */
export function reconstructBundleFromCapsule(
  capsule: EvidenceCapsule,
  referencedSkills: readonly ReferencedSkillSnapshot[],
  relatedCurrentSkills: readonly RelatedCurrentSkill[],
  referencedSkillProvenance?: RuntimeOwnedReferencedSkillProvenance,
): EvidenceBundle {
  // Reconstruct evidence refs from capsule evidence entries
  const completionEvidence: readonly SkillEvidenceRef[] = capsule.completionEvidence.map(e => ({
    ref: e.ref,
    sourceFilePath: e.sourceFilePath,
    turn: e.turn,
    byteRange: e.byteRange,
  }));

  const settlementEvidence: readonly SkillEvidenceRef[] = capsule.settlementEvidence.map(e => ({
    ref: e.ref,
    sourceFilePath: e.sourceFilePath,
    turn: e.turn,
    byteRange: e.byteRange,
  }));

  // Build BoundedSourceEvidence from the capsule's redacted content so
  // validateEvidenceBundle accepts every ref with the correct role.
  const sourceEvidence: readonly BoundedSourceEvidence[] = [
    ...capsule.completionEvidence.map(e => ({
      ref: e.ref,
      role: 'problem-action' as const,
      content: e.content,
      sourceFilePath: e.sourceFilePath,
      turn: e.turn,
      byteRange: e.byteRange,
    })),
    ...capsule.settlementEvidence.map(e => ({
      ref: e.ref,
      role: 'verification' as const,
      content: e.content,
      sourceFilePath: e.sourceFilePath,
      turn: e.turn,
      byteRange: e.byteRange,
    })),
  ];

  // Build a fallback DistilledKnowledgeCandidate from capsule metadata.
  // This satisfies the EvidenceBundle.episode contract without requiring the
  // original episode's full candidate object.
  //
  // The solved-loop is reconstructed from the capsule's bounded, redacted
  // completion evidence and durable semantic observations (Progressive
  // Trust). A bounded successful external completion must not be downgraded
  // to bare admission metadata ("external event was admitted" / "redacted and
  // pinned"): the trigger / action / result that Author/Verifier need to
  // evaluate a narrow Capability update must survive reconstruction. This
  // stays provider-neutral and bounded/redacted; private ~/.codex or ~/.pi
  // log formats are never parsed — only the official rendered Timeline snapshot
  // already pinned in the capsule is used. When the capsule carries no
  // recognizable completion content, the honest admission-metadata fallback
  // remains (we never manufacture success).
  const capabilityId = `capsule-${capsule.episodeId.replace(/^episode-/, '')}`;
  const completionContent = capsule.completionEvidence.map(e => e.content).filter(c => c.trim().length > 0);
  const actionPatternFromContent = completionContent.join(' ').slice(0, 280) || 'External event evidence';
  const solvedLoop = reconstructExternalSolvedLoop(capsule, completionContent);
  const candidate: DistilledKnowledgeCandidate = {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId,
    title: `External evidence: ${capsule.provenance.provider} (${capsule.provenance.sourceId})`,
    applicability: `External evidence from ${capsule.provenance.provider} admitted at ${capsule.redactedAt}.`,
    actionPattern: actionPatternFromContent,
    boundaries: [
      'External evidence requires Author/Verifier evaluation.',
      'Evidence is redacted and may omit sensitive context.',
    ],
    risks: [
      'Evidence originates from an external source and is redacted.',
      'The upstream source may have changed since the capsule was created.',
    ],
    solvedLoop,
    provenance: capsule.completionEvidence.map((e, index) => ({
      filePath: e.sourceFilePath ?? capsule.provenance.sourceId,
      turn: e.turn ?? 0,
      role: index === 0 ? 'problem-action' as const : 'verification' as const,
      unitByteRange: e.byteRange ?? { start: 0, end: 1 },
      ...(capsule.provenance.category === 'external' ? {
        provider: capsule.provenance.provider,
        ...(capsule.identity.conversationId ? { threadId: capsule.identity.conversationId } : {}),
        ...(capsule.identity.contentHash ? { contentHash: capsule.identity.contentHash } : {}),
      } : {}),
    })),
    generatedAt: capsule.redactedAt,
    sourceUnit: {
      filePath: capsule.provenance.sourceId,
      byteRange: { start: 0, end: 1 },
      generatedAt: capsule.redactedAt,
    },
  };

  return {
    bundleId: capsule.bundleId,
    authority: { kind: 'learning-episode', episodeId: capsule.episodeId },
    episode: candidate,
    completionEvidence,
    settlementEvidence,
    boundedContinuity: [],
    semanticObservations: capsule.semanticObservations.length > 0
      ? capsule.semanticObservations
      : undefined,
    referencedSkills,
    relatedCurrentSkills,
    referencedSkillProvenance,
    sourceEvidence,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Bound a reconstructed solved-loop field so the candidate stays bounded. */
const MAX_EXTERNAL_SOLVED_LOOP_FIELD_CHARS = 360 as const;

function boundedField(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return fallback;
  if (trimmed.length <= MAX_EXTERNAL_SOLVED_LOOP_FIELD_CHARS) return trimmed;
  return trimmed.slice(0, MAX_EXTERNAL_SOLVED_LOOP_FIELD_CHARS).trimEnd();
}

function firstObservationValue(
  observations: readonly SemanticObservation[],
  kind: SemanticObservation['kind'],
): string | undefined {
  const value = observations.find(item => item.kind === kind)?.value?.trim();
  return value || undefined;
}

/**
 * Reconstruct a bounded, redacted external solved-loop from the capsule.
 *
 * Uses only capsule-pinned, already-redacted content and durable semantic
 * observations — never private upstream log formats. Falls back to honest
 * admission metadata when there is no recognizable completion content, so a
 * bounded successful outcome is preserved without ever manufacturing success.
 */
function reconstructExternalSolvedLoop(
  capsule: EvidenceCapsule,
  completionContent: readonly string[],
): {
  problem: string;
  action: string;
  verification: string;
  noCorrection: string;
} {
  const observations = capsule.semanticObservations ?? [];
  const userIntent = firstObservationValue(observations, 'user-intent');
  const hasCompletion = completionContent.length > 0;
  const admissionFallback = `Admitted external event ${capsule.identity.eventId}`;

  const problem = boundedField(
    userIntent ?? (hasCompletion ? completionContent[0]! : undefined),
    admissionFallback,
  );

  const action = hasCompletion
    ? boundedField(completionContent.join(' '), 'The external event was admitted as a Learning Episode.')
    : 'The external event was admitted as a Learning Episode.';

  // Solved-loop verification must come from pinned completionEvidence with
  // role='verification' — actual artifact outcome content, not lifecycle
  // metadata. Settlement content only proves maturation (episode closed);
  // it must never masquerade as the recognizable artifact result that
  // Progressive Trust's isSettledLowRiskExternalAtom requires.
  // If no completion verification evidence exists, fall back to redacted
  // admission metadata — Progressive Trust will then correctly reject the
  // atom because the result is not recognizable.
  const completionVerificationContent = capsule.completionEvidence
    .filter(e => e.role === 'verification' && e.content.trim().length > 0)
    .map(e => e.content)
    .join(' ');
  const verification = boundedField(
    completionVerificationContent || undefined,
    `Redacted and pinned at ${capsule.redactedAt}.`,
  );

  return {
    problem,
    action,
    verification,
    noCorrection: 'No contradiction signal was present at admission.',
  };
}

function redactSourceReference(value: string): string {
  return truncateUtf8(redactExternalEvidenceContent(value), MAX_EVIDENCE_CAPSULE_REFERENCE_BYTES);
}

/** Redact one pre-persistence evidence entry into its durable capsule form. */
function redactCapsuleEvidenceEntry(
  entry: {
    ref: string;
    content: string;
    role: 'problem-action' | 'verification';
    sourceFilePath?: string;
    turn?: number;
    byteRange?: { start: number; end: number };
  },
): EvidenceCapsuleEvidence {
  return {
    ref: redactSourceReference(entry.ref),
    content: redactExternalEvidenceContent(entry.content),
    role: entry.role,
    sourceFilePath: entry.sourceFilePath ? redactSourceReference(entry.sourceFilePath) : undefined,
    turn: entry.turn,
    byteRange: entry.byteRange,
  };
}

/** Stable fingerprint over redacted completion + settlement evidence. */
function computeCapsuleFingerprint(
  completion: readonly EvidenceCapsuleEvidence[],
  settlement: readonly EvidenceCapsuleEvidence[],
): string {
  return hash(
    JSON.stringify({
      completion: completion.map(e => ({ ref: e.ref, content: e.content, role: e.role })),
      settlement: settlement.map(e => ({ ref: e.ref, content: e.content, role: e.role })),
    }),
  );
}

function redactSemanticObservation(observation: SemanticObservation): SemanticObservation {
  return {
    kind: observation.kind,
    value: redactExternalEvidenceContent(observation.value),
    sourceRefs: observation.sourceRefs?.map(ref => redactExternalEvidenceContent(ref)),
  };
}
