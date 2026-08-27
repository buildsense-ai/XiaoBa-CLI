import * as fs from 'fs';
import * as path from 'path';
import { withExclusiveFileLock } from '../core/file-lock';
import {
  REVIEW_RUN_STORE_SCHEMA_VERSION,
  type ReviewRunRecord,
  type ReviewRunStoreState,
} from './review-runtime-types';
import type { AgentRunGoalResolution } from '../core/agent-run-types';

function emptyState(): ReviewRunStoreState {
  return {
    schemaVersion: REVIEW_RUN_STORE_SCHEMA_VERSION,
    runs: {},
    findingToRun: {},
  };
}

function corruptionMarkerPath(filePath: string): string {
  return `${filePath}.state-corrupt`;
}

function latchCorruption(filePath: string, reason: string): void {
  const marker = corruptionMarkerPath(filePath);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, `${new Date().toISOString()} ${reason}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
}

function quarantine(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(filePath, `${filePath}.corrupt.${stamp}`);
  } catch {
    // Best effort only. The corruption marker remains the fail-closed latch.
  }
}

const REVIEW_STATUSES = new Set(['active', 'awaiting_approval', 'waiting_for_input', 'blocked', 'complete_issue', 'complete_close', 'cancelled']);
const REVIEW_STATES = new Set(['INCOMPLETE', 'COMPLETE_ISSUE', 'COMPLETE_CLOSE']);
const TASK_STATUSES = new Set(['proposed', 'approved', 'running', 'waiting_for_input', 'result_pending_commit', 'committed', 'interrupted', 'failed', 'cancelled']);
const TASK_RISKS = new Set(['low', 'medium', 'high']);

function isRun(value: unknown, runId: string): value is ReviewRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Partial<ReviewRunRecord>;
  if (run.runId !== runId || !text(run.findingId) || !text(run.sessionKey) || !text(run.goal)
    || (run.goalResolution !== undefined && !isGoalResolution(run.goalResolution))
    || !text(run.envelopePath) || !REVIEW_STATUSES.has(String(run.status))
    || !REVIEW_STATES.has(String(run.reviewState)) || !text(run.createdAt) || !text(run.updatedAt)
    || !run.tasks || typeof run.tasks !== 'object' || Array.isArray(run.tasks)
    || !Array.isArray(run.events)) return false;
  if (!Object.entries(run.tasks).every(([taskId, task]) => isTask(task, taskId, runId))) return false;
  if (!run.events.every(event => isEvent(event, runId, run.findingId!))) return false;
  return true;
}

function isTask(value: unknown, taskId: string, runId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  if (task.taskId !== taskId || task.runId !== runId || !TASK_STATUSES.has(String(task.status))
    || !TASK_RISKS.has(String(task.risk)) || typeof task.approvalRequired !== 'boolean') return false;
  for (const field of ['title', 'objective', 'expectedArtifact', 'stopCondition', 'safetyBoundary', 'proposedAt', 'proposedBy']) {
    if (!text(task[field])) return false;
  }
  for (const field of ['idempotencyKey', 'agentType', 'skillName', 'toolScope', 'approvedAt', 'approvedBy', 'approvalNote', 'subAgentId', 'startedAt', 'finishedAt', 'resultSummary', 'committedAt', 'failureReason', 'recoveryNote']) {
    if (task[field] !== undefined && !text(task[field])) return false;
  }
  for (const field of ['allowedTools', 'outputFiles', 'committedEvidenceIds']) {
    const value = task[field];
    if (value !== undefined && (!Array.isArray(value) || value.some(item => !text(item)))) return false;
  }
  if (task.maxTurns !== undefined && (typeof task.maxTurns !== 'number' || !Number.isFinite(task.maxTurns))) return false;
  return true;
}

function isEvent(value: unknown, runId: string, findingId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.runId === runId && event.findingId === findingId
    && text(event.eventId) && text(event.type) && text(event.at) && text(event.actor) && text(event.summary)
    && (event.taskId === undefined || text(event.taskId));
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class ReviewRunStore {
  private state: ReviewRunStoreState;
  private readonly lockPath: string;

  constructor(readonly filePath: string) {
    this.lockPath = `${filePath}.lock`;
    this.state = this.load();
  }

  isCorrupt(): boolean {
    return this.state.stateCorrupt === true;
  }

  refresh(): void {
    this.state = this.load();
    this.assertWritable();
  }

  list(): ReviewRunRecord[] {
    return Object.values(this.state.runs).map(cloneRun);
  }

  get(runId: string): ReviewRunRecord | undefined {
    const run = this.state.runs[runId];
    return run ? cloneRun(run) : undefined;
  }

  findByFindingId(findingId: string): ReviewRunRecord | undefined {
    const runId = this.state.findingToRun[findingId];
    return runId ? this.get(runId) : undefined;
  }

  create(run: ReviewRunRecord): ReviewRunRecord {
    return withExclusiveFileLock(this.lockPath, () => {
      this.state = this.load();
      this.assertWritable();
      if (this.state.runs[run.runId]) throw new Error(`Review Run already exists: ${run.runId}`);
      const existingRunId = this.state.findingToRun[run.findingId];
      if (existingRunId) return cloneRun(this.state.runs[existingRunId]);
      this.state.runs[run.runId] = cloneRun(run);
      this.state.findingToRun[run.findingId] = run.runId;
      this.save();
      return cloneRun(run);
    });
  }

  update(runId: string, mutate: (run: ReviewRunRecord) => void): ReviewRunRecord {
    return withExclusiveFileLock(this.lockPath, () => {
      this.state = this.load();
      this.assertWritable();
      const existing = this.state.runs[runId];
      if (!existing) throw new Error(`Unknown Review Run: ${runId}`);
      const next = cloneRun(existing);
      mutate(next);
      if (next.runId !== runId
        || next.findingId !== existing.findingId
        || next.sessionKey !== existing.sessionKey
        || next.goal !== existing.goal
        || JSON.stringify(next.goalResolution) !== JSON.stringify(existing.goalResolution)
        || next.envelopePath !== existing.envelopePath
        || next.createdAt !== existing.createdAt) {
        throw new Error('Review Run identity field is immutable');
      }
      next.updatedAt = new Date().toISOString();
      this.state.runs[runId] = next;
      this.save();
      return cloneRun(next);
    });
  }

  private load(): ReviewRunStoreState {
    if (fs.existsSync(corruptionMarkerPath(this.filePath))) {
      return { ...emptyState(), stateCorrupt: true };
    }
    if (!fs.existsSync(this.filePath)) return emptyState();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<ReviewRunStoreState>;
      if (parsed.schemaVersion !== REVIEW_RUN_STORE_SCHEMA_VERSION
        || !parsed.runs || typeof parsed.runs !== 'object'
        || !parsed.findingToRun || typeof parsed.findingToRun !== 'object') {
        throw new Error('invalid schema');
      }
      const runs: Record<string, ReviewRunRecord> = {};
      for (const [runId, run] of Object.entries(parsed.runs)) {
        if (!isRun(run, runId)) throw new Error(`invalid run ${runId}`);
        runs[runId] = cloneRun(run);
      }
      for (const [findingId, runId] of Object.entries(parsed.findingToRun)) {
        if (!runs[runId] || runs[runId].findingId !== findingId) {
          throw new Error(`invalid finding index ${findingId}`);
        }
      }
      return {
        schemaVersion: REVIEW_RUN_STORE_SCHEMA_VERSION,
        runs,
        findingToRun: { ...parsed.findingToRun },
      };
    } catch {
      latchCorruption(this.filePath, 'invalid Review Run store');
      quarantine(this.filePath);
      return { ...emptyState(), stateCorrupt: true };
    }
  }

  private assertWritable(): void {
    if (this.state.stateCorrupt || fs.existsSync(corruptionMarkerPath(this.filePath))) {
      throw new Error(`Cannot write corrupt Review Run store: ${this.filePath}`);
    }
  }

  private save(): void {
    this.assertWritable();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({
        schemaVersion: REVIEW_RUN_STORE_SCHEMA_VERSION,
        runs: this.state.runs,
        findingToRun: this.state.findingToRun,
      }, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw error;
    }
  }
}

function cloneRun(run: ReviewRunRecord): ReviewRunRecord {
  return JSON.parse(JSON.stringify(run)) as ReviewRunRecord;
}


function isGoalResolution(value: unknown): value is AgentRunGoalResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const resolution = value as Partial<AgentRunGoalResolution>;
  if (!['explicit', 'ai_generated', 'profile_fallback'].includes(String(resolution.source))) return false;
  if (typeof resolution.profileId !== 'string' || !resolution.profileId.trim()) return false;
  if (typeof resolution.runType !== 'string' || !resolution.runType.trim()) return false;
  if (!Array.isArray(resolution.completionCriteria) || resolution.completionCriteria.length === 0
    || resolution.completionCriteria.some(value => typeof value !== 'string' || !value.trim())) return false;
  if (typeof resolution.generatedAt !== 'string' || !Number.isFinite(Date.parse(resolution.generatedAt))) return false;
  if (resolution.generator !== undefined && (typeof resolution.generator !== 'string' || !resolution.generator.trim())) return false;
  if (resolution.fallbackReason !== undefined && (typeof resolution.fallbackReason !== 'string' || !resolution.fallbackReason.trim())) return false;
  return true;
}
