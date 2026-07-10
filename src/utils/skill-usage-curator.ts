import * as fs from 'fs';
import * as path from 'path';
import type { LearningEpisode } from './learning-episode';
import {
  CapabilityTransitionKind,
  EvidenceBundle,
  SkillEvolutionRuntime,
} from './skill-evolution';
import {
  GeneratedCurrentSkillIdentity,
  SkillUsageLedger,
  SkillUsageOutcomeFact,
} from './skill-usage-ledger';

export const SKILL_USAGE_CURATOR_SCHEMA_VERSION = 1 as const;

export interface CuratorReassessment {
  skill: GeneratedCurrentSkillIdentity;
  outcomeFacts: SkillUsageOutcomeFact[];
  expedited: boolean;
  bundle: EvidenceBundle;
}

export interface SkillUsageCuratorOptions {
  ledger: SkillUsageLedger;
  statePath: string;
  intervalMs: number;
  runtime?: SkillEvolutionRuntime;
  reassess?: (request: CuratorReassessment) => Promise<CapabilityTransitionKind>;
  successThreshold?: number;
  deferThreshold?: number;
  now?: () => Date;
}

export interface CuratorRunResult {
  ran: boolean;
  expedited: boolean;
  transitions: Array<{ capabilityHandle: string; transition: CapabilityTransitionKind }>;
}

interface CuratorWake {
  capabilityHandle: string;
  outcomeFactIds: string[];
  requestedAt: string;
}

interface CuratorState {
  schemaVersion: typeof SKILL_USAGE_CURATOR_SCHEMA_VERSION;
  lastRoutineRunAt: string | null;
  reviewedOutcomeFactIds: string[];
  expedited: Record<string, CuratorWake>;
}

/**
 * Low-frequency reassessment selector. It has no skill-writing behavior: all
 * replacement, merge, and retirement decisions are returned by the existing
 * Author/Verifier and Capability Transition runtime.
 */
export class SkillUsageCurator {
  private readonly now: () => Date;
  private readonly successThreshold: number;
  private readonly deferThreshold: number;

  constructor(private readonly options: SkillUsageCuratorOptions) {
    this.now = options.now ?? (() => new Date());
    this.successThreshold = Math.max(1, options.successThreshold ?? 2);
    this.deferThreshold = Math.max(1, options.deferThreshold ?? 2);
  }

  observeEpisode(episode: LearningEpisode): SkillUsageOutcomeFact[] {
    const facts = this.options.ledger.recordEpisodeOutcome(episode, this.now());
    for (const fact of facts) if (fact.outcome === 'contradicted') this.requestExpeditedWake(fact);
    return facts;
  }

  recordDeferredOutcome(episodeId: string, evidenceRefs: readonly string[]): SkillUsageOutcomeFact[] {
    return this.options.ledger.recordOutcome({ episodeId, outcome: 'deferred', evidenceRefs, recordedAt: this.now() });
  }

  requestExpeditedWake(outcome: SkillUsageOutcomeFact): void {
    if (outcome.outcome !== 'contradicted') return;
    const load = this.options.ledger.listFacts().find(fact => fact.kind === 'generated-skill-load' && fact.factId === outcome.loadFactId);
    if (!load || load.kind !== 'generated-skill-load') return;
    const state = this.loadState();
    const existing = state.expedited[load.skill.capabilityHandle];
    state.expedited[load.skill.capabilityHandle] = {
      capabilityHandle: load.skill.capabilityHandle,
      outcomeFactIds: [...new Set([...(existing?.outcomeFactIds ?? []), outcome.factId])],
      requestedAt: existing?.requestedAt ?? this.now().toISOString(),
    };
    this.saveState(state);
  }

  pendingExpeditedWakes(): CuratorWake[] {
    return Object.values(this.loadState().expedited);
  }

  async runDue(): Promise<CuratorRunResult> {
    const state = this.loadState();
    const now = this.now();
    const expeditedHandles = new Set(Object.keys(state.expedited));
    const routineDue = !state.lastRoutineRunAt
      || now.getTime() - Date.parse(state.lastRoutineRunAt) >= this.options.intervalMs;
    if (!routineDue && expeditedHandles.size === 0) return { ran: false, expedited: false, transitions: [] };

    const facts = this.options.ledger.listFacts();
    const loads = new Map(facts.filter(fact => fact.kind === 'generated-skill-load').map(fact => [fact.factId, fact]));
    const outcomes = facts.filter((fact): fact is SkillUsageOutcomeFact => fact.kind === 'episode-outcome');
    const current = this.options.runtime?.getRegistry().capabilities ?? {};
    const selected = new Map<string, { skill: GeneratedCurrentSkillIdentity; outcomes: SkillUsageOutcomeFact[]; expedited: boolean }>();

    for (const outcome of outcomes) {
      if (state.reviewedOutcomeFactIds.includes(outcome.factId)) continue;
      const load = loads.get(outcome.loadFactId);
      if (!load || !current[load.skill.capabilityHandle]) continue;
      const entry = selected.get(load.skill.capabilityHandle) ?? {
        skill: load.skill,
        outcomes: [],
        expedited: expeditedHandles.has(load.skill.capabilityHandle),
      };
      entry.outcomes.push(outcome);
      selected.set(load.skill.capabilityHandle, entry);
    }

    const transitions: CuratorRunResult['transitions'] = [];
    for (const [capabilityHandle, selection] of selected) {
      const contradictions = selection.outcomes.some(outcome => outcome.outcome === 'contradicted');
      const successes = selection.outcomes.filter(outcome => outcome.outcome === 'verified-success').length;
      const defers = selection.outcomes.filter(outcome => outcome.outcome === 'deferred').length;
      if (!selection.expedited && !contradictions && successes < this.successThreshold && defers < this.deferThreshold) continue;
      const request: CuratorReassessment = {
        skill: selection.skill,
        outcomeFacts: selection.outcomes,
        expedited: selection.expedited || contradictions,
        bundle: this.buildEvidenceBundle(selection.skill, selection.outcomes),
      };
      const transition = await this.reassess(request);
      transitions.push({ capabilityHandle, transition });
      state.reviewedOutcomeFactIds = [...new Set([...state.reviewedOutcomeFactIds, ...selection.outcomes.map(item => item.factId)])];
      delete state.expedited[capabilityHandle];
    }
    if (routineDue) state.lastRoutineRunAt = now.toISOString();
    this.saveState(state);
    return { ran: true, expedited: expeditedHandles.size > 0, transitions };
  }

  private async reassess(request: CuratorReassessment): Promise<CapabilityTransitionKind> {
    if (this.options.reassess) return this.options.reassess(request);
    if (!this.options.runtime) return 'defer';
    return (await this.options.runtime.reviewAndApply(request.bundle)).transition;
  }

  private buildEvidenceBundle(skill: GeneratedCurrentSkillIdentity, outcomes: SkillUsageOutcomeFact[]): EvidenceBundle {
    const registry = this.options.runtime?.getRegistry();
    const record = registry?.capabilities[skill.capabilityHandle];
    const facts = this.options.ledger.listFacts();
    const loads = new Map(facts.filter(fact => fact.kind === 'generated-skill-load').map(fact => [fact.factId, fact]));
    const completionEvidence = outcomes.map(outcome => ({ ref: `ledger:${loads.get(outcome.loadFactId)?.factId ?? outcome.loadFactId}` }));
    const settlementEvidence = outcomes.map(outcome => ({ ref: `ledger:${outcome.factId}` }));
    return {
      bundleId: `usage-curation:${skill.capabilityHandle}:${outcomes.map(item => item.factId).sort().join(',')}`,
      episode: {
        kind: 'usage-reassessment',
        capabilityHandle: skill.capabilityHandle,
        routingName: skill.routingName,
        factualOutcomeIds: outcomes.map(item => item.factId),
      },
      completionEvidence,
      settlementEvidence,
      boundedContinuity: [],
      referencedSkills: record?.referencedSkills ?? [],
      relatedCurrentSkills: Object.values(registry?.capabilities ?? {}).map(item => ({
        handle: item.handle,
        revision: item.revision,
        routingName: item.routingName,
        description: item.description,
        guidanceHash: item.guidanceHash,
      })),
    };
  }

  private loadState(): CuratorState {
    if (!fs.existsSync(this.options.statePath)) return emptyState();
    try {
      const state = JSON.parse(fs.readFileSync(this.options.statePath, 'utf8')) as CuratorState;
      if (state.schemaVersion !== SKILL_USAGE_CURATOR_SCHEMA_VERSION || !Array.isArray(state.reviewedOutcomeFactIds) || !state.expedited) throw new Error('invalid state');
      return state;
    } catch {
      return emptyState();
    }
  }

  private saveState(state: CuratorState): void {
    fs.mkdirSync(path.dirname(this.options.statePath), { recursive: true });
    const temporary = `${this.options.statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.options.statePath);
  }
}

function emptyState(): CuratorState {
  return {
    schemaVersion: SKILL_USAGE_CURATOR_SCHEMA_VERSION,
    lastRoutineRunAt: null,
    reviewedOutcomeFactIds: [],
    expedited: {},
  };
}
