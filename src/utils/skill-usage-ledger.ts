import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { LearningEpisode } from './learning-episode';

export const SKILL_USAGE_LEDGER_SCHEMA_VERSION = 1 as const;

export type SkillUsageOutcome = 'verified-success' | 'deferred' | 'contradicted';

/** Runtime-owned identity for an active generated Current Skill. */
export interface GeneratedCurrentSkillIdentity {
  capabilityHandle: string;
  routingName: string;
  skillFilePath: string;
  guidanceHash: string;
}

export interface GeneratedSkillLoadFact {
  schemaVersion: typeof SKILL_USAGE_LEDGER_SCHEMA_VERSION;
  kind: 'generated-skill-load';
  factId: string;
  recordedAt: string;
  runtimeSessionId: string;
  episodeId: string;
  /** The route the caller requested; retained only as resolution context. */
  requestedRoutingName?: string;
  skill: GeneratedCurrentSkillIdentity;
}

export interface SkillUsageOutcomeFact {
  schemaVersion: typeof SKILL_USAGE_LEDGER_SCHEMA_VERSION;
  kind: 'episode-outcome';
  factId: string;
  recordedAt: string;
  loadFactId: string;
  episodeId: string;
  outcome: SkillUsageOutcome;
  evidenceRefs: string[];
}

export type SkillUsageLedgerFact = GeneratedSkillLoadFact | SkillUsageOutcomeFact;

export interface RecordGeneratedSkillLoadInput {
  runtimeSessionId: string;
  episodeId: string;
  skill: GeneratedCurrentSkillIdentity;
  requestedRoutingName?: string;
  recordedAt?: Date;
}

interface RecordSkillUsageOutcomeBase {
  episodeId: string;
  runtimeSessionId: string;
  evidenceRefs: readonly string[];
  recordedAt?: Date;
}

export type RecordSkillUsageOutcomeInput = RecordSkillUsageOutcomeBase & (
  | {
      outcome: 'contradicted';
      /** Exact load facts this correction evidence is allowed to qualify. */
      targetLoadFactIds: readonly string[];
    }
  | {
      outcome: Exclude<SkillUsageOutcome, 'contradicted'>;
      targetLoadFactIds?: readonly string[];
    }
);

/**
 * Append-only facts about generated Current Skill loading and same-episode
 * outcomes. Facts intentionally do not claim that a loaded skill was followed
 * or caused the episode outcome.
 */
export class SkillUsageLedger {
  constructor(private readonly filePath: string) {}

  recordGeneratedSkillLoad(input: RecordGeneratedSkillLoadInput): GeneratedSkillLoadFact {
    assertGeneratedCurrentSkill(input.skill);
    assertNonEmpty(input.runtimeSessionId, 'runtimeSessionId');
    assertNonEmpty(input.episodeId, 'episodeId');
    const fact: GeneratedSkillLoadFact = {
      schemaVersion: SKILL_USAGE_LEDGER_SCHEMA_VERSION,
      kind: 'generated-skill-load',
      factId: `skill-load_${crypto.randomUUID().replace(/-/g, '')}`,
      recordedAt: (input.recordedAt ?? new Date()).toISOString(),
      runtimeSessionId: input.runtimeSessionId,
      episodeId: input.episodeId,
      ...(input.requestedRoutingName?.trim() && { requestedRoutingName: input.requestedRoutingName.trim() }),
      skill: { ...input.skill },
    };
    this.append(fact);
    return fact;
  }

  recordOutcome(input: RecordSkillUsageOutcomeInput): SkillUsageOutcomeFact[] {
    assertNonEmpty(input.episodeId, 'episodeId');
    assertNonEmpty(input.runtimeSessionId, 'runtimeSessionId');
    const evidenceRefs = canonicalEvidenceRefs(input.evidenceRefs);
    if (evidenceRefs.length === 0) throw new Error('Skill Usage Ledger outcome requires evidence refs.');
    const facts = this.listFacts();
    const targetLoadFactIds = new Set(uniqueNonEmpty(input.targetLoadFactIds ?? []));
    // A contradiction is negative evidence only about a bound Skill load. An
    // episode-level correction alone does not prove that every loaded Skill
    // was followed or caused the corrected result; the single-load fallback
    // below is safe only when the correction contains no loaded identity.
    if (input.outcome === 'contradicted' && targetLoadFactIds.size === 0) return [];
    const loads = facts.filter((fact): fact is GeneratedSkillLoadFact =>
      fact.kind === 'generated-skill-load'
      && fact.episodeId === input.episodeId
      && fact.runtimeSessionId === input.runtimeSessionId
      && (targetLoadFactIds.size === 0 || targetLoadFactIds.has(fact.factId)),
    );
    const existing = new Set(facts
      .filter((fact): fact is SkillUsageOutcomeFact => fact.kind === 'episode-outcome')
      .map(fact => outcomeIdempotencyKey(fact.loadFactId, fact.outcome, fact.evidenceRefs)));
    const recordedAt = (input.recordedAt ?? new Date()).toISOString();
    const outcomes: SkillUsageOutcomeFact[] = [];
    for (const load of loads) {
      const idempotencyKey = outcomeIdempotencyKey(load.factId, input.outcome, evidenceRefs);
      if (existing.has(idempotencyKey)) continue;
      const fact: SkillUsageOutcomeFact = {
        schemaVersion: SKILL_USAGE_LEDGER_SCHEMA_VERSION,
        kind: 'episode-outcome',
        factId: `skill-outcome_${crypto.randomUUID().replace(/-/g, '')}`,
        recordedAt,
        loadFactId: load.factId,
        episodeId: input.episodeId,
        outcome: input.outcome,
        evidenceRefs,
      };
      this.append(fact);
      existing.add(idempotencyKey);
      outcomes.push(fact);
    }
    return outcomes;
  }

  /** Persist only observable settlement facts for loads already tied to this episode. */
  recordEpisodeOutcome(episode: LearningEpisode, recordedAt?: Date): SkillUsageOutcomeFact[] {
    const episodeId = episode.agentTurnEpisodeId;
    // Legacy logs have no canonical AgentTurn correlation. Never join them by
    // timestamp, session proximity, or the distillation-owned episode id.
    if (!episodeId) return [];
    if (episode.contradictionSignals.length === 0) return [];
    const loads = this.listFacts().filter((fact): fact is GeneratedSkillLoadFact =>
      fact.kind === 'generated-skill-load'
      && fact.episodeId === episodeId
      && fact.runtimeSessionId === episode.runtimeSessionId,
    );
    const loadGroups = groupLoadsByStableSkillIdentity(loads);
    const singleSkillIdentity = loadGroups.length === 1;
    const mentionsAnyLoadedSkillIdentity = (message: string): boolean =>
      loads.some(load => mentionsLoadedSkillIdentity(message, load));
    const outcomes: SkillUsageOutcomeFact[] = [];
    for (const group of loadGroups) {
      const canonicalLoad = group[group.length - 1]!;
      const evidenceRefs = episode.contradictionSignals
        .filter(signal => group.some(load => explicitlyTargetsLoadedSkill(signal.message, load))
          || (singleSkillIdentity && !mentionsAnyLoadedSkillIdentity(signal.message)))
        .map(signal => signal.source.ref);
      if (evidenceRefs.length === 0) continue;
      outcomes.push(...this.recordOutcome({
        episodeId,
        runtimeSessionId: episode.runtimeSessionId,
        outcome: 'contradicted',
        evidenceRefs,
        targetLoadFactIds: [canonicalLoad.factId],
        recordedAt,
      }));
    }
    return outcomes;
  }

  listFacts(): SkillUsageLedgerFact[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      return fs.readFileSync(this.filePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap(line => {
          try {
            const fact = JSON.parse(line) as unknown;
            return isLedgerFact(fact) ? [fact] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  private append(fact: SkillUsageLedgerFact): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(fact)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function assertGeneratedCurrentSkill(skill: GeneratedCurrentSkillIdentity): void {
  assertNonEmpty(skill.capabilityHandle, 'capabilityHandle');
  assertNonEmpty(skill.routingName, 'routingName');
  assertNonEmpty(skill.guidanceHash, 'guidanceHash');
  assertNonEmpty(skill.skillFilePath, 'skillFilePath');
  if (!skill.skillFilePath.split(/[\\/]+/).includes('generated-distilled')) {
    throw new Error('Skill Usage Ledger accepts generated Current Skills only.');
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (!value?.trim()) throw new Error(`${name} must be a non-empty string.`);
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()))];
}

function canonicalEvidenceRefs(values: readonly string[]): string[] {
  return uniqueNonEmpty(values).sort((left, right) => left.localeCompare(right, 'en'));
}

function outcomeIdempotencyKey(
  loadFactId: string,
  outcome: SkillUsageOutcome,
  evidenceRefs: readonly string[],
): string {
  return JSON.stringify([loadFactId, outcome, canonicalEvidenceRefs(evidenceRefs)]);
}

/**
 * Bind correction evidence to a stable Skill identity. A single generated
 * load may safely inherit an otherwise unqualified correction; multiple loads
 * still require an explicit identity. Semantic similarity is never used.
 */
function explicitlyTargetsLoadedSkill(message: string, load: GeneratedSkillLoadFact): boolean {
  return loadedSkillIdentifiers(load).some(identifier => containsExactIdentifier(message, identifier));
}

function mentionsLoadedSkillIdentity(message: string, load: GeneratedSkillLoadFact): boolean {
  return loadedSkillIdentifiers(load).some(identifier => containsExactIdentifier(message, identifier));
}

function loadedSkillIdentifiers(load: GeneratedSkillLoadFact): string[] {
  return uniqueNonEmpty([
    load.skill.capabilityHandle,
    load.skill.routingName,
    load.requestedRoutingName ?? '',
  ]);
}

/**
 * A Capability Handle is the stable identity across guidance revisions and
 * route migrations; repeated load events are observations, not distinct
 * Skills.
 * Collapse them before binding correction evidence so an anonymous correction
 * remains unambiguous when one stable revision was loaded more than once.
 * The latest append-only fact is the canonical outcome anchor so Curator
 * lookup sees the most recent loaded revision; aliases from every event remain
 * available for exact explicit targeting.
 */
function groupLoadsByStableSkillIdentity(
  loads: readonly GeneratedSkillLoadFact[],
): GeneratedSkillLoadFact[][] {
  const groups = new Map<string, GeneratedSkillLoadFact[]>();
  for (const load of loads) {
    const key = load.skill.capabilityHandle;
    const group = groups.get(key);
    if (group) group.push(load);
    else groups.set(key, [load]);
  }
  return [...groups.values()];
}

function containsExactIdentifier(message: string, identifier: string): boolean {
  const normalizedMessage = message.normalize('NFKC').toLowerCase();
  const normalizedIdentifier = identifier.normalize('NFKC').toLowerCase().trim();
  if (!normalizedIdentifier) return false;
  const escaped = normalizedIdentifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`, 'u')
    .test(normalizedMessage);
}

/**
 * Read-side validation for persisted ledger facts. It must be at least as
 * strict as the write-side assertions in `recordGeneratedSkillLoad` /
 * `recordOutcome`: nonempty identity and correlation fields, the
 * generated-distilled path invariant for generated Current Skill loads, and a
 * valid outcome enum. Malformed or corrupt JSONL facts are ignored (never
 * thrown) so a single bad line cannot poison the trusted dependency seam.
 */
function isLedgerFact(value: unknown): value is SkillUsageLedgerFact {
  if (!value || typeof value !== 'object') return false;
  const fact = value as Partial<SkillUsageLedgerFact>;
  if (fact.schemaVersion !== SKILL_USAGE_LEDGER_SCHEMA_VERSION || typeof fact.factId !== 'string') return false;
  if (typeof fact.recordedAt !== 'string') return false;
  if (fact.kind === 'generated-skill-load') {
    return isNonEmpty(fact.episodeId)
      && isNonEmpty(fact.runtimeSessionId)
      && (fact.requestedRoutingName === undefined || typeof fact.requestedRoutingName === 'string')
      && isValidGeneratedCurrentSkillIdentity(fact.skill);
  }
  return fact.kind === 'episode-outcome'
    && isNonEmpty(fact.loadFactId)
    && isNonEmpty(fact.episodeId)
    && (fact.outcome === 'verified-success' || fact.outcome === 'deferred' || fact.outcome === 'contradicted')
    && Array.isArray(fact.evidenceRefs)
    && fact.evidenceRefs.every(ref => typeof ref === 'string');
}

function isValidGeneratedCurrentSkillIdentity(skill: unknown): boolean {
  if (!skill || typeof skill !== 'object') return false;
  const identity = skill as Partial<GeneratedCurrentSkillIdentity>;
  // Mirror write-side assertGeneratedCurrentSkill exactly: nonempty
  // capabilityHandle, routingName, guidanceHash, skillFilePath, and the
  // generated-distilled path invariant.
  return isNonEmpty(identity.capabilityHandle)
    && isNonEmpty(identity.routingName)
    && isNonEmpty(identity.guidanceHash)
    && isNonEmpty(identity.skillFilePath)
    && identity.skillFilePath!.split(/[\\/]+/).includes('generated-distilled');
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
