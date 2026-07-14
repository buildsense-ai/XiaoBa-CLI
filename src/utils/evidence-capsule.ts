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
  CurrentSkillRegistryState,
} from './skill-evolution';
import { DistilledKnowledgeCandidate } from './capability-distiller';
import { type SemanticObservation } from './learning-episode';
import { type SessionLogSourceIdentity, type SourceEventIdentity } from './session-log-source';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EVIDENCE_CAPSULE_SCHEMA_VERSION = 1 as const;

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

  /** Load the durable capsule store. Returns empty state on first load or corruption. */
  load(): EvidenceCapsuleStoreState {
    if (!fs.existsSync(this.filePath)) return emptyCapsuleStoreState();
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as EvidenceCapsuleStoreState & { schemaVersion?: number };
      if (!parsed.capsules || typeof parsed.capsules !== 'object') return emptyCapsuleStoreState();
      if (parsed.schemaVersion !== EVIDENCE_CAPSULE_SCHEMA_VERSION) return emptyCapsuleStoreState();
      return parsed as EvidenceCapsuleStoreState;
    } catch {
      // Corrupted file: quarantine and return empty
      this.quarantineFile();
      return emptyCapsuleStoreState();
    }
  }

  /** Persist the capsule store atomically via temp-file + rename. */
  save(state: EvidenceCapsuleStoreState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Upsert a capsule and persist. */
  upsert(capsule: EvidenceCapsule): void {
    const state = this.load();
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

  /** Count of stored capsules for diagnostics. */
  count(): number {
    return Object.keys(this.load().capsules).length;
  }

  private quarantineFile(): void {
    try {
      const quarantinePath = `${this.filePath}.quarantine.${Date.now()}.${process.pid}`;
      fs.renameSync(this.filePath, quarantinePath);
    } catch {
      // Best-effort quarantine; fail silently to avoid cascading errors.
    }
  }
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

/**
 * Build a bounded, redacted Evidence Capsule from an admitted external event.
 *
 * Every evidence entry's content is redacted before durable storage.
 * The capsule records provenance (source identity, provider), event identity,
 * and a stable content hash derived from the redacted evidence.
 */
export function buildEvidenceCapsule(options: BuildEvidenceCapsuleOptions): EvidenceCapsule {
  const now = options.now ?? new Date();
  const capsuleId = `capsule-${hash([options.bundleId, now.toISOString()].join('|')).slice(0, 20)}`;

  // Redact each evidence entry's content before durable persistence
  const redactedCompletion = options.completionEvidence.map(e => ({
    ref: e.ref,
    content: redactExternalEvidenceContent(e.content),
    role: e.role as 'problem-action' | 'verification',
    sourceFilePath: e.sourceFilePath,
    turn: e.turn,
    byteRange: e.byteRange,
  })) satisfies EvidenceCapsuleEvidence[];

  const redactedSettlement = options.settlementEvidence.map(e => ({
    ref: e.ref,
    content: redactExternalEvidenceContent(e.content),
    role: e.role as 'problem-action' | 'verification',
    sourceFilePath: e.sourceFilePath,
    turn: e.turn,
    byteRange: e.byteRange,
  })) satisfies EvidenceCapsuleEvidence[];

  // Compute hash from the redacted evidence content (stable across restarts)
  const evidenceFingerprint = sha256(
    JSON.stringify({
      completion: redactedCompletion.map(e => ({ ref: e.ref, content: e.content, role: e.role })),
      settlement: redactedSettlement.map(e => ({ ref: e.ref, content: e.content, role: e.role })),
    }),
  );

  return {
    schemaVersion: EVIDENCE_CAPSULE_SCHEMA_VERSION,
    capsuleId,
    provenance: {
      sourceId: options.sourceIdentity.sourceId,
      provider: options.sourceIdentity.provider,
      reader: options.sourceIdentity.reader,
      category: options.sourceIdentity.category,
    },
    identity: {
      eventId: options.eventIdentity.eventId,
      position: options.eventIdentity.position,
      contentHash: evidenceFingerprint,
    },
    episodeId: options.episodeId,
    bundleId: options.bundleId,
    completionEvidence: redactedCompletion,
    settlementEvidence: redactedSettlement,
    semanticObservations: [...(options.semanticObservations ?? [])],
    redactedAt: now.toISOString(),
    promotionAuditRefs: [],
  };
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
 *   - Includes current registry context so Author/Verifier can evaluate
 *     against the live capability set.
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
  registry: CurrentSkillRegistryState,
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
  const capabilityId = `capsule-${capsule.episodeId.replace(/^episode-/, '')}`;
  const candidate: DistilledKnowledgeCandidate = {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId,
    title: `External evidence: ${capsule.provenance.provider} (${capsule.provenance.sourceId})`,
    applicability: `External evidence from ${capsule.provenance.provider} admitted at ${capsule.redactedAt}.`,
    actionPattern: capsule.completionEvidence.map(e => e.content).join('; ').slice(0, 280) || 'External event evidence',
    boundaries: [
      'External evidence requires Author/Verifier evaluation.',
      'Evidence is redacted and may omit sensitive context.',
    ],
    risks: [
      'Evidence originates from an external source and is redacted.',
      'The upstream source may have changed since the capsule was created.',
    ],
    solvedLoop: {
      problem: `Admitted external event ${capsule.identity.eventId}`,
      action: 'The external event was admitted as a Learning Episode.',
      verification: `Redacted and pinned at ${capsule.redactedAt}.`,
      noCorrection: 'No contradiction signal was present at admission.',
    },
    provenance: capsule.completionEvidence.map((e, index) => ({
      filePath: e.sourceFilePath ?? capsule.provenance.sourceId,
      turn: e.turn ?? 0,
      role: index === 0 ? 'problem-action' as const : 'verification' as const,
      unitByteRange: e.byteRange ?? { start: 0, end: 1 },
    })),
    generatedAt: capsule.redactedAt,
    sourceUnit: {
      filePath: capsule.provenance.sourceId,
      byteRange: { start: 0, end: 1 },
      generatedAt: capsule.redactedAt,
    },
  };

  // Current registry context for Author/Verifier evaluation
  const relatedCurrentSkills: readonly RelatedCurrentSkill[] = Object.values(registry.capabilities).map(
    record => ({
      handle: record.handle,
      revision: record.revision,
      routingName: record.routingName,
      description: record.description,
      guidanceHash: record.guidanceHash,
    }),
  );

  return {
    bundleId: capsule.bundleId,
    episode: candidate,
    completionEvidence,
    settlementEvidence,
    boundedContinuity: [],
    semanticObservations: capsule.semanticObservations.length > 0
      ? capsule.semanticObservations
      : undefined,
    referencedSkills,
    relatedCurrentSkills,
    sourceEvidence,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Export store helpers for constructor injection. */
export function defaultEvidenceCapsuleAtomicWrite(filePath: string, state: EvidenceCapsuleStoreState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}
