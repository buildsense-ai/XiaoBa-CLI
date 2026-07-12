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
  recordedAt?: Date;
}

export interface RecordSkillUsageOutcomeInput {
  episodeId: string;
  outcome: SkillUsageOutcome;
  evidenceRefs: readonly string[];
  recordedAt?: Date;
}

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
      skill: { ...input.skill },
    };
    this.append(fact);
    return fact;
  }

  recordOutcome(input: RecordSkillUsageOutcomeInput): SkillUsageOutcomeFact[] {
    assertNonEmpty(input.episodeId, 'episodeId');
    const evidenceRefs = uniqueNonEmpty(input.evidenceRefs);
    if (evidenceRefs.length === 0) throw new Error('Skill Usage Ledger outcome requires evidence refs.');
    const facts = this.listFacts();
    const loads = facts.filter((fact): fact is GeneratedSkillLoadFact =>
      fact.kind === 'generated-skill-load' && fact.episodeId === input.episodeId,
    );
    const existing = new Set(facts
      .filter((fact): fact is SkillUsageOutcomeFact => fact.kind === 'episode-outcome')
      .map(fact => `${fact.loadFactId}:${fact.outcome}`));
    const recordedAt = (input.recordedAt ?? new Date()).toISOString();
    const outcomes: SkillUsageOutcomeFact[] = [];
    for (const load of loads) {
      if (existing.has(`${load.factId}:${input.outcome}`)) continue;
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
    if (episode.status === 'eligible') {
      return this.recordOutcome({
        episodeId,
        outcome: 'verified-success',
        evidenceRefs: episode.completionEvidence.map(item => item.ref),
        recordedAt,
      });
    }
    if (episode.contradictionSignals.length > 0 || episode.status === 'contradicted') {
      return this.recordOutcome({
        episodeId,
        outcome: 'contradicted',
        evidenceRefs: episode.contradictionSignals.map(item => item.source.ref),
        recordedAt,
      });
    }
    return [];
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

function isLedgerFact(value: unknown): value is SkillUsageLedgerFact {
  if (!value || typeof value !== 'object') return false;
  const fact = value as Partial<SkillUsageLedgerFact>;
  if (fact.schemaVersion !== SKILL_USAGE_LEDGER_SCHEMA_VERSION || typeof fact.factId !== 'string') return false;
  if (fact.kind === 'generated-skill-load') {
    return typeof fact.episodeId === 'string'
      && typeof fact.runtimeSessionId === 'string'
      && !!fact.skill
      && typeof fact.skill.capabilityHandle === 'string'
      && typeof fact.skill.skillFilePath === 'string';
  }
  return fact.kind === 'episode-outcome'
    && typeof fact.loadFactId === 'string'
    && typeof fact.episodeId === 'string'
    && (fact.outcome === 'verified-success' || fact.outcome === 'deferred' || fact.outcome === 'contradicted')
    && Array.isArray(fact.evidenceRefs);
}
