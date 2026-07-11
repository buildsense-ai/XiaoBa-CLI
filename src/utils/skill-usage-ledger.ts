import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PathResolver } from './path-resolver';

/**
 * The usage ledger is an append-only fact store.  A load says only that the
 * skill tool returned a generated Current Skill; an outcome says only that a
 * later observation was associated with the same Learning Episode.
 */
export const SKILL_USAGE_LEDGER_SCHEMA_VERSION = 1 as const;

export type SkillUsageOutcomeKind = 'verified_success' | 'deferred' | 'contradiction';

export interface GeneratedSkillLoadFact {
  factId: string;
  source: 'generated-current';
  skillName: string;
  skillFilePath: string;
  capabilityHandle?: string;
  runtimeSessionId?: string;
  /** Optional for direct callers; runtime tool calls should always provide it. */
  episodeId?: string;
  loadedAt: string;
}

export interface SkillUsageOutcomeFact {
  factId: string;
  loadFactId: string;
  source: 'generated-current';
  skillName: string;
  capabilityHandle?: string;
  episodeId: string;
  outcome: SkillUsageOutcomeKind;
  /** A Learning Episode evidence ref or durable contradiction signal id. */
  evidenceRefs: string[];
  observedAt: string;
}

export interface SkillUsageLedgerState {
  schemaVersion: typeof SKILL_USAGE_LEDGER_SCHEMA_VERSION;
  loads: GeneratedSkillLoadFact[];
  outcomes: SkillUsageOutcomeFact[];
  stateCorrupt?: boolean;
}

export interface RecordGeneratedSkillLoadInput {
  skillName: string;
  skillFilePath: string;
  capabilityHandle?: string;
  runtimeSessionId?: string;
  episodeId?: string;
  loadedAt?: Date;
}

export interface RecordSkillUsageOutcomeInput {
  loadFactId: string;
  episodeId: string;
  outcome: SkillUsageOutcomeKind;
  evidenceRefs?: readonly string[];
  observedAt?: Date;
}

export interface SkillUsageTurnLogger {
  recordGeneratedSkillLoad(input: RecordGeneratedSkillLoadInput): GeneratedSkillLoadFact;
  recordSameEpisodeOutcome(input: RecordSkillUsageOutcomeInput): SkillUsageOutcomeFact;
}

export function emptySkillUsageLedgerState(): SkillUsageLedgerState {
  return {
    schemaVersion: SKILL_USAGE_LEDGER_SCHEMA_VERSION,
    loads: [],
    outcomes: [],
  };
}

export function defaultSkillUsageLedgerPath(): string {
  return PathResolver.getDataPath('skill-usage-ledger.json');
}

export function loadSkillUsageLedger(filePath: string): SkillUsageLedgerState {
  if (!fs.existsSync(filePath)) return emptySkillUsageLedgerState();

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SkillUsageLedgerState>;
    if (
      parsed?.schemaVersion !== SKILL_USAGE_LEDGER_SCHEMA_VERSION
      || !Array.isArray(parsed.loads)
      || !Array.isArray(parsed.outcomes)
    ) {
      throw new Error('invalid skill usage ledger schema');
    }

    const loads = parsed.loads.filter(isLoadFact).map(normalizeLoadFact);
    const loadIds = new Set(loads.map(load => load.factId));
    const outcomes = parsed.outcomes
      .filter(isOutcomeFact)
      .map(normalizeOutcomeFact)
      .filter(outcome => loadIds.has(outcome.loadFactId));

    return {
      schemaVersion: SKILL_USAGE_LEDGER_SCHEMA_VERSION,
      loads,
      outcomes,
    };
  } catch {
    quarantineCorruptLedger(filePath);
    return { ...emptySkillUsageLedgerState(), stateCorrupt: true };
  }
}

export function saveSkillUsageLedger(filePath: string, state: SkillUsageLedgerState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const payload = {
    schemaVersion: SKILL_USAGE_LEDGER_SCHEMA_VERSION,
    // Never persist the diagnostic corruption marker as if it were a fact.
    loads: state.loads,
    outcomes: state.outcomes,
  } satisfies Omit<SkillUsageLedgerState, 'stateCorrupt'>;

  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup only; preserve the original write error.
    }
    throw error;
  }
}

export class SkillUsageLedger implements SkillUsageTurnLogger {
  private readonly generatedSkillsRoot: string;

  constructor(
    private readonly filePath: string = defaultSkillUsageLedgerPath(),
    generatedSkillsRoot: string = path.join(PathResolver.getSkillsPath(), 'generated-distilled'),
  ) {
    this.generatedSkillsRoot = path.resolve(generatedSkillsRoot);
  }

  load(): SkillUsageLedgerState {
    return loadSkillUsageLedger(this.filePath);
  }

  recordGeneratedSkillLoad(input: RecordGeneratedSkillLoadInput): GeneratedSkillLoadFact {
    const skillName = input.skillName.trim();
    const skillFilePath = path.resolve(input.skillFilePath);
    if (!skillName) throw new Error('A generated skill load requires a skill name.');
    if (!isGeneratedCurrentSkillPath(skillFilePath, this.generatedSkillsRoot)) {
      throw new Error('Only generated Current Skills can be recorded in the Skill Usage Ledger.');
    }

    const fact: GeneratedSkillLoadFact = {
      factId: `skill-load-${randomUUID()}`,
      source: 'generated-current',
      skillName,
      skillFilePath,
      ...(input.capabilityHandle?.trim() && { capabilityHandle: input.capabilityHandle.trim() }),
      ...(input.runtimeSessionId?.trim() && { runtimeSessionId: input.runtimeSessionId.trim() }),
      ...(input.episodeId?.trim() && { episodeId: input.episodeId.trim() }),
      loadedAt: (input.loadedAt ?? new Date()).toISOString(),
    };
    const state = this.load();
    if (state.stateCorrupt) {
      throw new Error('Skill Usage Ledger state was corrupt and has been quarantined.');
    }
    state.loads.push(fact);
    saveSkillUsageLedger(this.filePath, state);
    return fact;
  }

  recordSameEpisodeOutcome(input: RecordSkillUsageOutcomeInput): SkillUsageOutcomeFact {
    const state = this.load();
    if (state.stateCorrupt) {
      throw new Error('Skill Usage Ledger state was corrupt and has been quarantined.');
    }
    const load = state.loads.find(item => item.factId === input.loadFactId);
    if (!load) throw new Error(`Cannot associate outcome with unknown skill load ${input.loadFactId}.`);

    const episodeId = input.episodeId.trim();
    if (!episodeId) throw new Error('A skill usage outcome requires a Learning Episode id.');
    if (!load.episodeId || load.episodeId !== episodeId) {
      throw new Error('A skill usage outcome must belong to the same Learning Episode as the skill load.');
    }

    const evidenceRefs = uniqueStrings(input.evidenceRefs ?? []);
    // A durable signal id makes repeated log extraction idempotent without
    // changing the append-only fact semantics.
    const existing = state.outcomes.find(outcome =>
      outcome.loadFactId === load.factId
      && outcome.episodeId === episodeId
      && outcome.outcome === input.outcome
      && (
        (evidenceRefs.length === 0 && outcome.evidenceRefs.length === 0)
        || (evidenceRefs.length > 0 && evidenceRefs.every(ref => outcome.evidenceRefs.includes(ref)))
      ),
    );
    if (existing) return existing;

    const fact: SkillUsageOutcomeFact = {
      factId: `skill-outcome-${randomUUID()}`,
      loadFactId: load.factId,
      source: 'generated-current',
      skillName: load.skillName,
      ...(load.capabilityHandle && { capabilityHandle: load.capabilityHandle }),
      episodeId,
      outcome: input.outcome,
      evidenceRefs,
      observedAt: (input.observedAt ?? new Date()).toISOString(),
    };
    state.outcomes.push(fact);
    saveSkillUsageLedger(this.filePath, state);
    return fact;
  }

  getFilePath(): string {
    return this.filePath;
  }
}

export function isGeneratedCurrentSkillPath(
  skillFilePath: string,
  generatedSkillsRoot: string = path.join(PathResolver.getSkillsPath(), 'generated-distilled'),
): boolean {
  const filePath = path.resolve(skillFilePath);
  const root = path.resolve(generatedSkillsRoot);
  const relative = path.relative(root, filePath);
  return path.basename(filePath) === 'SKILL.md'
    && relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function capabilityHandleFromGeneratedSkillPath(
  skillFilePath: string,
  generatedSkillsRoot: string = path.join(PathResolver.getSkillsPath(), 'generated-distilled'),
): string | undefined {
  if (!isGeneratedCurrentSkillPath(skillFilePath, generatedSkillsRoot)) return undefined;
  const relative = path.relative(path.resolve(generatedSkillsRoot), path.resolve(skillFilePath));
  const firstSegment = relative.split(path.sep)[0];
  return firstSegment && firstSegment !== 'SKILL.md' ? firstSegment : undefined;
}

function isLoadFact(value: unknown): value is GeneratedSkillLoadFact {
  const item = value as Partial<GeneratedSkillLoadFact> | null;
  return !!item
    && item.source === 'generated-current'
    && typeof item.factId === 'string'
    && typeof item.skillName === 'string'
    && typeof item.skillFilePath === 'string'
    && typeof item.loadedAt === 'string';
}

function isOutcomeFact(value: unknown): value is SkillUsageOutcomeFact {
  const item = value as Partial<SkillUsageOutcomeFact> | null;
  return !!item
    && item.source === 'generated-current'
    && typeof item.factId === 'string'
    && typeof item.loadFactId === 'string'
    && typeof item.skillName === 'string'
    && typeof item.episodeId === 'string'
    && isOutcomeKind(item.outcome)
    && Array.isArray(item.evidenceRefs)
    && typeof item.observedAt === 'string';
}

function normalizeLoadFact(fact: GeneratedSkillLoadFact): GeneratedSkillLoadFact {
  return {
    ...fact,
    skillName: fact.skillName.trim(),
    skillFilePath: path.resolve(fact.skillFilePath),
    ...(fact.capabilityHandle?.trim() && { capabilityHandle: fact.capabilityHandle.trim() }),
    ...(fact.runtimeSessionId?.trim() && { runtimeSessionId: fact.runtimeSessionId.trim() }),
    ...(fact.episodeId?.trim() && { episodeId: fact.episodeId.trim() }),
  };
}

function normalizeOutcomeFact(fact: SkillUsageOutcomeFact): SkillUsageOutcomeFact {
  return {
    ...fact,
    skillName: fact.skillName.trim(),
    episodeId: fact.episodeId.trim(),
    evidenceRefs: uniqueStrings(fact.evidenceRefs),
  };
}

function isOutcomeKind(value: unknown): value is SkillUsageOutcomeKind {
  return value === 'verified_success' || value === 'deferred' || value === 'contradiction';
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function quarantineCorruptLedger(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    fs.renameSync(filePath, `${filePath}.corrupt.${Date.now()}`);
  } catch {
    // The empty isolated state is still safer than trusting partial JSON.
  }
}
