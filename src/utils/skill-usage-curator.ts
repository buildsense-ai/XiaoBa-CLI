import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  CapabilityTransitionKind,
  EvidenceBundle,
  SkillEvolutionResult,
} from './skill-evolution';
import { PathResolver } from './path-resolver';
import {
  GeneratedSkillLoadFact,
  SkillUsageLedger,
  SkillUsageLedgerState,
  SkillUsageOutcomeFact,
  isGeneratedCurrentSkillPath,
} from './skill-usage-ledger';

/** Operational Curator state is separate from the append-only fact ledger. */
export const SKILL_USAGE_CURATOR_SCHEMA_VERSION = 1 as const;

export type SkillCuratorClassification = 'observe' | 'reassess' | 'expedited_reassess';

export interface ExpeditedCuratorWake {
  wakeId: string;
  skillKey: string;
  skillName: string;
  capabilityHandle?: string;
  outcomeFactIds: string[];
  createdAt: string;
  latestObservedAt: string;
}

export interface SkillUsageCuratorState {
  schemaVersion: typeof SKILL_USAGE_CURATOR_SCHEMA_VERSION;
  expeditedWakes: ExpeditedCuratorWake[];
  /** Outcome facts already handed to the Author/Verifier seam. */
  reviewedOutcomeFactIds: string[];
  stateCorrupt?: boolean;
}

export interface SkillUsageCuratorPolicy {
  staleAfterMs?: number;
  successReassessmentThreshold?: number;
  deferralReassessmentThreshold?: number;
}

export interface SkillUsageSummary {
  skillKey: string;
  skillName: string;
  skillFilePath: string;
  capabilityHandle?: string;
  latestLoadedAt: string;
  loadCount: number;
  verifiedSuccessCount: number;
  deferredCount: number;
  contradictionCount: number;
  hasOutcomeEvidence: boolean;
  isStale: boolean;
  classification: SkillCuratorClassification;
  /** The facts the Author/Verifier evidence builder should preserve. */
  loadFactIds: string[];
  outcomeFactIds: string[];
}

export interface CuratorReviewRequest {
  summary: SkillUsageSummary;
  ledger: SkillUsageLedgerState;
  expeditedWake?: ExpeditedCuratorWake;
  evidenceBundle: EvidenceBundle;
}

export type CuratorReviewHandler = (
  request: CuratorReviewRequest,
) => Promise<SkillEvolutionResult>;

export type CuratorEvidenceBundleBuilder = (
  summary: SkillUsageSummary,
  ledger: SkillUsageLedgerState,
) => EvidenceBundle | Promise<EvidenceBundle>;

export interface SkillUsageCuratorOptions extends SkillUsageCuratorPolicy {
  ledger: SkillUsageLedger;
  statePath?: string;
  generatedSkillsRoot?: string;
  now?: () => Date;
  evidenceBundleBuilder?: CuratorEvidenceBundleBuilder;
  review?: CuratorReviewHandler;
}

export interface CuratorRunResult {
  classified: number;
  reviewed: number;
  expeditedReviewed: number;
  transitions: Array<CapabilityTransitionKind | undefined>;
}

export function emptySkillUsageCuratorState(): SkillUsageCuratorState {
  return {
    schemaVersion: SKILL_USAGE_CURATOR_SCHEMA_VERSION,
    expeditedWakes: [],
    reviewedOutcomeFactIds: [],
  };
}

export function defaultSkillUsageCuratorStatePath(): string {
  return PathResolver.getDataPath('skill-usage-curator.json');
}

export function loadSkillUsageCuratorState(filePath: string): SkillUsageCuratorState {
  if (!fs.existsSync(filePath)) return emptySkillUsageCuratorState();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SkillUsageCuratorState>;
    if (parsed?.schemaVersion !== SKILL_USAGE_CURATOR_SCHEMA_VERSION || !Array.isArray(parsed.expeditedWakes)) {
      throw new Error('invalid skill usage curator schema');
    }
    return {
      schemaVersion: SKILL_USAGE_CURATOR_SCHEMA_VERSION,
      expeditedWakes: parsed.expeditedWakes.filter(isWake).map(normalizeWake),
      reviewedOutcomeFactIds: Array.isArray(parsed.reviewedOutcomeFactIds)
        ? [...new Set(parsed.reviewedOutcomeFactIds.filter((value): value is string => typeof value === 'string'))]
        : [],
    };
  } catch {
    quarantineCorruptState(filePath);
    return { ...emptySkillUsageCuratorState(), stateCorrupt: true };
  }
}

export function saveSkillUsageCuratorState(filePath: string, state: SkillUsageCuratorState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify({
      schemaVersion: SKILL_USAGE_CURATOR_SCHEMA_VERSION,
      expeditedWakes: state.expeditedWakes,
      reviewedOutcomeFactIds: state.reviewedOutcomeFactIds,
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

export class SkillUsageCurator {
  private readonly statePath: string;
  private readonly generatedSkillsRoot: string;
  private readonly now: () => Date;
  private readonly staleAfterMs: number;
  private readonly successThreshold: number;
  private readonly deferralThreshold: number;

  constructor(private readonly options: SkillUsageCuratorOptions) {
    this.statePath = options.statePath ?? defaultSkillUsageCuratorStatePath();
    this.generatedSkillsRoot = path.resolve(
      options.generatedSkillsRoot ?? path.join(PathResolver.getSkillsPath(), 'generated-distilled'),
    );
    this.now = options.now ?? (() => new Date());
    this.staleAfterMs = positiveNumber(options.staleAfterMs, 30 * 24 * 60 * 60 * 1000);
    this.successThreshold = positiveInteger(options.successReassessmentThreshold, 3);
    this.deferralThreshold = positiveInteger(options.deferralReassessmentThreshold, 2);
  }

  loadState(): SkillUsageCuratorState {
    return loadSkillUsageCuratorState(this.statePath);
  }

  /**
   * Direct contradiction is urgency, not authority.  Each skill has at most
   * one pending wake; later contradictions append their fact ids to it.
   */
  syncExpeditedWakes(): ExpeditedCuratorWake[] {
    const ledger = this.options.ledger.load();
    const state = this.loadState();
    const reviewed = new Set(state.reviewedOutcomeFactIds);
    let changed = false;
    for (const outcome of ledger.outcomes.filter(item => item.outcome === 'contradiction' && !reviewed.has(item.factId))) {
      const load = ledger.loads.find(item => item.factId === outcome.loadFactId);
      if (!load || !this.isCuratableLoad(load)) continue;
      const skillKey = keyFor(load);
      const existing = state.expeditedWakes.find(wake => wake.skillKey === skillKey);
      if (existing) {
        if (!existing.outcomeFactIds.includes(outcome.factId)) {
          existing.outcomeFactIds.push(outcome.factId);
          existing.latestObservedAt = maxIso(existing.latestObservedAt, outcome.observedAt);
          changed = true;
        }
        continue;
      }
      state.expeditedWakes.push({
        wakeId: `curator-wake-${randomUUID()}`,
        skillKey,
        skillName: load.skillName,
        ...(load.capabilityHandle && { capabilityHandle: load.capabilityHandle }),
        outcomeFactIds: [outcome.factId],
        createdAt: this.now().toISOString(),
        latestObservedAt: outcome.observedAt,
      });
      changed = true;
    }
    if (changed) saveSkillUsageCuratorState(this.statePath, state);
    return state.expeditedWakes;
  }

  getPendingExpeditedWakes(): ExpeditedCuratorWake[] {
    return this.syncExpeditedWakes();
  }

  classify(): SkillUsageSummary[] {
    const ledger = this.options.ledger.load();
    const curatorState = this.loadState();
    const reviewed = new Set(curatorState.reviewedOutcomeFactIds);
    const wakes = this.syncExpeditedWakes();
    const bySkill = new Map<string, GeneratedSkillLoadFact[]>();
    for (const load of ledger.loads) {
      if (!this.isCuratableLoad(load)) continue;
      const list = bySkill.get(keyFor(load)) ?? [];
      list.push(load);
      bySkill.set(keyFor(load), list);
    }

    return [...bySkill.entries()].map(([skillKey, loads]) => {
      const allOutcomes = ledger.outcomes.filter(outcome =>
        loads.some(load => load.factId === outcome.loadFactId),
      );
      const outcomes = allOutcomes.filter(outcome => !reviewed.has(outcome.factId));
      const latestLoadedAt = loads.reduce((latest, load) => maxIso(latest, load.loadedAt), loads[0]!.loadedAt);
      const isStale = this.now().getTime() - Date.parse(latestLoadedAt) >= this.staleAfterMs;
      const wake = wakes.find(item => item.skillKey === skillKey);
      const verifiedSuccessCount = countOutcome(outcomes, 'verified_success');
      const deferredCount = countOutcome(outcomes, 'deferred');
      const contradictionCount = countOutcome(outcomes, 'contradiction');
      const hasOutcomeEvidence = allOutcomes.length > 0;
      const classification: SkillCuratorClassification = wake || contradictionCount > 0
        ? 'expedited_reassess'
        : hasOutcomeEvidence && (
          isStale
          || verifiedSuccessCount >= this.successThreshold
          || deferredCount >= this.deferralThreshold
        )
          ? 'reassess'
          : 'observe';
      const first = loads[0]!;
      return {
        skillKey,
        skillName: first.skillName,
        skillFilePath: first.skillFilePath,
        ...(first.capabilityHandle && { capabilityHandle: first.capabilityHandle }),
        latestLoadedAt,
        loadCount: loads.length,
        verifiedSuccessCount,
        deferredCount,
        contradictionCount,
        hasOutcomeEvidence,
        isStale,
        classification,
        loadFactIds: loads.map(load => load.factId),
        outcomeFactIds: allOutcomes.map(outcome => outcome.factId),
      } satisfies SkillUsageSummary;
    }).sort((left, right) => {
      const priority = { expedited_reassess: 0, reassess: 1, observe: 2 };
      return priority[left.classification] - priority[right.classification]
        || left.skillKey.localeCompare(right.skillKey);
    });
  }

  /**
   * Dispatches only to the existing Evidence Bundle -> Author/Verifier ->
   * Capability Transition seam supplied by the caller.  The Curator never
   * edits a skill, registry, audit, or manual skill itself.
   */
  async reviewDue(): Promise<CuratorRunResult> {
    const summaries = this.classify();
    const result: CuratorRunResult = {
      classified: summaries.length,
      reviewed: 0,
      expeditedReviewed: 0,
      transitions: [],
    };
    if (!this.options.evidenceBundleBuilder || !this.options.review) return result;

    const ledger = this.options.ledger.load();
    const wakes = this.loadState().expeditedWakes;
    for (const summary of summaries.filter(item => item.classification !== 'observe')) {
      const evidenceBundle = await this.options.evidenceBundleBuilder(summary, ledger);
      const wake = wakes.find(item => item.skillKey === summary.skillKey);
      const reviewResult = await this.options.review({ summary, ledger, expeditedWake: wake, evidenceBundle });
      result.reviewed++;
      if (wake) result.expeditedReviewed++;
      result.transitions.push(reviewResult.transition);
      this.markReviewed(summary.outcomeFactIds);
      if (wake) this.removeWake(wake.wakeId);
    }
    return result;
  }

  private removeWake(wakeId: string): void {
    const state = this.loadState();
    state.expeditedWakes = state.expeditedWakes.filter(wake => wake.wakeId !== wakeId);
    saveSkillUsageCuratorState(this.statePath, state);
  }

  private markReviewed(outcomeFactIds: readonly string[]): void {
    if (outcomeFactIds.length === 0) return;
    const state = this.loadState();
    state.reviewedOutcomeFactIds = [...new Set([...state.reviewedOutcomeFactIds, ...outcomeFactIds])];
    saveSkillUsageCuratorState(this.statePath, state);
  }

  private isCuratableLoad(load: GeneratedSkillLoadFact): boolean {
    return load.source === 'generated-current'
      && isGeneratedCurrentSkillPath(load.skillFilePath, this.generatedSkillsRoot);
  }
}

function keyFor(load: GeneratedSkillLoadFact): string {
  return load.capabilityHandle || `${load.skillName}:${load.skillFilePath}`;
}

function countOutcome(outcomes: readonly SkillUsageOutcomeFact[], kind: SkillUsageOutcomeFact['outcome']): number {
  return outcomes.filter(outcome => outcome.outcome === kind).length;
}

function maxIso(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function isWake(value: unknown): value is ExpeditedCuratorWake {
  const item = value as Partial<ExpeditedCuratorWake> | null;
  return !!item
    && typeof item.wakeId === 'string'
    && typeof item.skillKey === 'string'
    && typeof item.skillName === 'string'
    && Array.isArray(item.outcomeFactIds)
    && typeof item.createdAt === 'string'
    && typeof item.latestObservedAt === 'string';
}

function normalizeWake(wake: ExpeditedCuratorWake): ExpeditedCuratorWake {
  return {
    ...wake,
    outcomeFactIds: [...new Set(wake.outcomeFactIds.filter(value => typeof value === 'string'))],
  };
}

function quarantineCorruptState(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.corrupt.${Date.now()}`);
  } catch {
    // Best-effort quarantine; callers receive an isolated empty state.
  }
}
