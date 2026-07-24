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
  GeneratedSkillLoadFact,
  SkillUsageLedger,
  SkillUsageOutcomeFact,
} from './skill-usage-ledger';

export const SKILL_USAGE_CURATOR_SCHEMA_VERSION = 1 as const;

export interface CuratorReassessment {
  skill: GeneratedCurrentSkillIdentity;
  outcomeFacts: SkillUsageOutcomeFact[];
  bundle: EvidenceBundle;
}

export interface SkillUsageCuratorOptions {
  ledger: SkillUsageLedger;
  statePath: string;
  intervalMs: number;
  runtime?: SkillEvolutionRuntime;
  reassess?: (request: CuratorReassessment) => Promise<CapabilityTransitionKind>;
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

  constructor(private readonly options: SkillUsageCuratorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Return runtime-owned `GeneratedSkillLoadFact` entries tied to one episode
   * by both canonical AgentTurn and runtime-session identity. This is the
   * trusted dependency fact seam for Evidence Bundle construction — it is
   * never derived from untrusted external/capsule semantic content.
   */
  listLoadFactsForEpisode(
    episode: Pick<LearningEpisode, 'agentTurnEpisodeId' | 'runtimeSessionId'>,
  ): readonly GeneratedSkillLoadFact[] {
    if (!episode.agentTurnEpisodeId || !episode.runtimeSessionId) return [];
    return this.options.ledger
      .listFacts()
      .filter((fact): fact is GeneratedSkillLoadFact =>
        fact.kind === 'generated-skill-load'
        && fact.episodeId === episode.agentTurnEpisodeId
        && fact.runtimeSessionId === episode.runtimeSessionId,
      );
  }

  observeEpisode(episode: LearningEpisode): SkillUsageOutcomeFact[] {
    const facts = this.options.ledger.recordEpisodeOutcome(episode, this.now());
    for (const fact of facts) if (fact.outcome === 'contradicted') this.requestExpeditedWake(fact);
    return facts;
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

  /**
   * Rebuild expedited wake state from durable ledger facts.
   *
   * The outcome append and curator-state rename are separate durable writes.
   * A process can stop between them, so the JSONL ledger is the source of
   * truth and the wake map is a rebuildable scheduling projection.
   */
  recoverExpeditedWakes(): void {
    const state = this.loadState();
    const facts = this.options.ledger.listFacts();
    const loads = new Map(
      facts
        .filter((fact): fact is GeneratedSkillLoadFact => fact.kind === 'generated-skill-load')
        .map(fact => [fact.factId, fact]),
    );
    let changed = false;

    for (const outcome of facts) {
      if (
        outcome.kind !== 'episode-outcome'
        || outcome.outcome !== 'contradicted'
        || state.reviewedOutcomeFactIds.includes(outcome.factId)
      ) continue;
      const load = loads.get(outcome.loadFactId);
      if (!load) continue;
      const existing = state.expedited[load.skill.capabilityHandle];
      if (existing?.outcomeFactIds.includes(outcome.factId)) continue;
      state.expedited[load.skill.capabilityHandle] = {
        capabilityHandle: load.skill.capabilityHandle,
        outcomeFactIds: [...new Set([...(existing?.outcomeFactIds ?? []), outcome.factId])],
        requestedAt: existing?.requestedAt ?? this.now().toISOString(),
      };
      changed = true;
    }

    if (changed) this.saveState(state);
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
    const outcomes = facts.filter((fact): fact is SkillUsageOutcomeFact => (
      fact.kind === 'episode-outcome' && fact.outcome === 'contradicted'
    ));
    const current = this.options.runtime?.getRegistry().capabilities ?? {};
    const selected = new Map<string, { skill: GeneratedCurrentSkillIdentity; outcomes: SkillUsageOutcomeFact[] }>();
    const obsoleteOutcomeFactIds: string[] = [];
    const obsoleteHandles = new Set<string>();

    for (const outcome of outcomes) {
      if (state.reviewedOutcomeFactIds.includes(outcome.factId)) continue;
      const load = loads.get(outcome.loadFactId);
      const currentSkill = load && current[load.skill.capabilityHandle];
      if (!load || !currentSkill || !isCurrentSkillIdentity(currentSkill, load.skill)) {
        obsoleteOutcomeFactIds.push(outcome.factId);
        if (load) obsoleteHandles.add(load.skill.capabilityHandle);
        continue;
      }
      const entry = selected.get(load.skill.capabilityHandle) ?? {
        skill: load.skill,
        outcomes: [],
      };
      entry.outcomes.push(outcome);
      selected.set(load.skill.capabilityHandle, entry);
    }

    // `reviewedOutcomeFactIds` suppresses identical wake/review work; it must
    // not erase factual contradiction history after a semantic defer. Once a
    // new outcome triggers this handle, rebuild the fixed bundle from every
    // contradiction still bound to the active revision so evidence accumulates
    // without adding a second curator lifecycle or retry ledger.
    for (const [capabilityHandle, selection] of selected) {
      selection.outcomes = outcomes.filter(outcome => {
        const load = loads.get(outcome.loadFactId);
        const currentSkill = load && current[capabilityHandle];
        return !!load
          && load.skill.capabilityHandle === capabilityHandle
          && !!currentSkill
          && isCurrentSkillIdentity(currentSkill, load.skill);
      });
    }

    // Ledger facts remain durable historical evidence, but outcomes linked to
    // a replaced revision must never be reconsidered as evidence for its
    // successor. Mark them consumed locally and clear a stale-only wake.
    if (obsoleteOutcomeFactIds.length > 0) {
      state.reviewedOutcomeFactIds = [...new Set([...state.reviewedOutcomeFactIds, ...obsoleteOutcomeFactIds])];
      for (const handle of obsoleteHandles) if (!selected.has(handle)) delete state.expedited[handle];
    }

    const transitions: CuratorRunResult['transitions'] = [];
    for (const [capabilityHandle, selection] of selected) {
      const request: CuratorReassessment = {
        skill: selection.skill,
        outcomeFacts: selection.outcomes,
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
    return (await this.options.runtime.reviewUsageAndApply(request.bundle)).transition;
  }

  private buildEvidenceBundle(skill: GeneratedCurrentSkillIdentity, outcomes: SkillUsageOutcomeFact[]): EvidenceBundle {
    const registry = this.options.runtime?.getRegistry();
    const record = registry?.capabilities[skill.capabilityHandle];
    const facts = this.options.ledger.listFacts();
    const loads = new Map(facts.filter(fact => fact.kind === 'generated-skill-load').map(fact => [fact.factId, fact]));
    const completionEvidence = [...new Set(outcomes.map(outcome => `ledger:${loads.get(outcome.loadFactId)?.factId ?? outcome.loadFactId}`))]
      .map(ref => ({ ref }));
    const settlementEvidence = outcomes.map(outcome => ({ ref: `ledger:${outcome.factId}` }));
    const sourceEvidence = [
      ...completionEvidence.map(item => {
        const loadId = item.ref.slice('ledger:'.length);
        const load = loads.get(loadId);
        return {
          ref: item.ref,
          role: 'problem-action' as const,
          content: `Factual generated Current Skill load: ${load?.skill.routingName ?? skill.routingName} (${load?.skill.guidanceHash ?? skill.guidanceHash}).`,
        };
      }),
      ...outcomes.map(outcome => ({
        ref: `ledger:${outcome.factId}`,
        role: 'verification' as const,
        content: `Factual same-Learning-Episode outcome: ${outcome.outcome}. Evidence references: ${outcome.evidenceRefs.join(', ')}.`,
      })),
    ];
    return {
      bundleId: `usage-curation:${skill.capabilityHandle}:${outcomes.map(item => item.factId).sort().join(',')}`,
      authority: {
        kind: 'usage-reassessment',
        targetCapabilityHandle: skill.capabilityHandle,
      },
      episode: {
        kind: 'usage-reassessment',
        capabilityHandle: skill.capabilityHandle,
        routingName: skill.routingName,
        factualOutcomes: outcomes.map(outcome => ({
          factId: outcome.factId,
          episodeId: outcome.episodeId,
          outcome: outcome.outcome,
          evidenceRefs: [...outcome.evidenceRefs],
          recordedAt: outcome.recordedAt,
        })),
      },
      completionEvidence,
      settlementEvidence,
      boundedContinuity: [],
      referencedSkills: record?.referencedSkills ?? [],
      // A usage correction is already bound to one runtime-owned load fact.
      // Keep the fixed review basis single-target: unrelated Registry entries
      // add prompt noise and can make the first entry look like the target.
      relatedCurrentSkills: record ? [{
        handle: record.handle,
        revision: record.revision,
        routingName: record.routingName,
        description: record.description,
        guidanceHash: record.guidanceHash,
      }] : [],
      sourceEvidence,
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

function isCurrentSkillIdentity(
  current: { routingName: string; skillFilePath: string; guidanceHash: string },
  loaded: GeneratedCurrentSkillIdentity,
): boolean {
  return current.routingName === loaded.routingName
    && current.skillFilePath === loaded.skillFilePath
    && current.guidanceHash === loaded.guidanceHash;
}

function emptyState(): CuratorState {
  return {
    schemaVersion: SKILL_USAGE_CURATOR_SCHEMA_VERSION,
    lastRoutineRunAt: null,
    reviewedOutcomeFactIds: [],
    expedited: {},
  };
}
