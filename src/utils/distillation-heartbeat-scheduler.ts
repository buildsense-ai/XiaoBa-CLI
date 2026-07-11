import * as fs from 'fs';
import * as path from 'path';
import {
  CrossFileContinuityOptions,
  DistillationUnit,
  extractDistillationUnit,
} from './distillation-unit';
import {
  advanceCursor,
  getCursor,
  loadLogCursorState,
  markCursorFailed,
  saveLogCursorState,
} from './log-cursor-state';
import { getDistillationHeartbeatConfig } from './distillation-heartbeat-config';
import { LearningEpisodeStore } from './learning-episode';
import { Logger } from './logger';

/**
 * Runtime-scoped Distillation Heartbeat scheduler.
 *
 * Mirrors the CatsCo log upload scheduler pattern: a runtime-owned
 * `setTimeout`-based scheduler that wakes on a configurable cadence (first
 * default six hours), finds session logs with unprocessed append ranges
 * through durable Log Cursor state, extracts Distillation Units, and records
 * that the heartbeat ran.
 *
 * The heartbeat is runtime-scoped: it is started by `runtime-command-support`
 * alongside the CatsCo log upload scheduler and does not require a user turn to
 * fire. Missed heartbeats catch up from stored cursor state because cursor
 * advancement is durable and keyed by byte offset (see `log-cursor-state.ts`).
 *
 * See CONTEXT.md → "Distillation Heartbeat".
 * See ADR 0001 → "Runtime Heartbeat Log Distillation".
 */

export type HeartbeatReason = 'startup' | 'scheduled' | 'settlement-deadline' | 'manual';

export interface HeartbeatRunResult {
  /** Number of Distillation Units produced this cycle. */
  unitsProcessed: number;
  /** Number of session log files whose cursor advanced this cycle. */
  advancedFiles: number;
  /** Whether this cycle actually executed (vs. being skipped/guarded). */
  ran: boolean;
}

export interface HeartbeatRecord {
  schemaVersion: 1;
  /** ISO timestamp of the last heartbeat run. */
  lastRunAt: string;
  /** Monotonic count of heartbeat runs since record creation. */
  runCount: number;
  /** Reason of the last run. */
  lastReason: HeartbeatReason;
  /** Distillation Units produced by the last run. */
  lastUnitsProcessed: number;
  /** Files whose cursor advanced on the last run. */
  lastAdvancedFiles: number;
}

export type DistillationUnitProcessor = (unit: DistillationUnit) => unknown | Promise<unknown>;

/**
 * Optional hook invoked once after a heartbeat cycle finishes processing all
 * Distillation Units (issue #29). The runtime wires it to
 * `DistillationPipeline.reviewEligibleQueueEntries` so the heartbeat also
 * re-reviews eligible Needs Review Queue entries on every cycle. The hook is
 * best-effort: it must not throw, and a failing hook never blocks the
 * heartbeat or cursor advancement.
 */
export type HeartbeatCycleCompleteHook = () => Promise<void> | void;

/**
 * Hook for the V3 settlement path. It runs even when the session-log scan
 * produces no Distillation Unit, which is what makes a settlement deadline a
 * real wake rather than merely a shorter discovery interval.
 */
export type SettlementDeadlineWakeHook = () => Promise<void> | void;

/** Runtime V3 Skill Usage Curator pass. Best-effort like the existing hooks. */
export type CuratorReviewHook = () => Promise<void> | void;

const DEFAULT_PROCESSOR: DistillationUnitProcessor = () => {
  // Issue #2 scope: the heartbeat owns the runtime path that extracts
  // Distillation Units and records the run. The distillation/review/install
  // pipeline (issues #3–#6) replaces this no-op sink later.
};

const MIN_TIMEOUT_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function emptyHeartbeatRecord(): HeartbeatRecord {
  return {
    schemaVersion: 1,
    lastRunAt: '',
    runCount: 0,
    lastReason: 'manual',
    lastUnitsProcessed: 0,
    lastAdvancedFiles: 0,
  };
}

export class DistillationHeartbeatScheduler {
  private readonly workingDirectory: string;
  private readonly processor: DistillationUnitProcessor;
  private readonly cycleCompleteHook: HeartbeatCycleCompleteHook | null;
  private readonly settlementDeadlineWakeHook: SettlementDeadlineWakeHook | null;
  private readonly curatorReviewHook: CuratorReviewHook | null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private stopped = false;

  constructor(
    workingDirectory: string = process.cwd(),
    processor: DistillationUnitProcessor = DEFAULT_PROCESSOR,
    cycleCompleteHook: HeartbeatCycleCompleteHook | null = null,
    settlementDeadlineWakeHook: SettlementDeadlineWakeHook | null = null,
    curatorReviewHook: CuratorReviewHook | null = null,
  ) {
    this.workingDirectory = workingDirectory;
    this.processor = processor;
    this.cycleCompleteHook = cycleCompleteHook;
    this.settlementDeadlineWakeHook = settlementDeadlineWakeHook;
    this.curatorReviewHook = curatorReviewHook;
  }

  /**
   * Runtime guard mirroring `CatscoLogUploadScheduler.shouldStartForCurrentRuntime`.
   * The heartbeat is disabled for inspector role runtimes and when the config
   * master switch is off, so tests and rollout can guard it via env.
   */
  static shouldStartForCurrentRuntime(
    workingDirectory: string = process.cwd(),
    env: NodeJS.ProcessEnv = process.env,
  ): boolean {
    const normalizedRole = String(env.XIAOBA_ROLE || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-');
    if (normalizedRole === 'inspector-cat') {
      return false;
    }
    const config = getDistillationHeartbeatConfig(workingDirectory, env);
    return config.enabled;
  }

  async start(): Promise<void> {
    if (
      this.started
      || !DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(this.workingDirectory)
    ) {
      return;
    }

    this.started = true;
    this.stopped = false;
    Logger.info('[DistillationHeartbeat] scheduler started');

    void (async () => {
      await this.runHeartbeat('startup');
      this.scheduleNextRun();
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    Logger.info('[DistillationHeartbeat] scheduler stopped');
  }

  /**
   * Run one heartbeat cycle. Walks the session log tree, extracts Distillation
   * Units from newly appended content via durable Log Cursor state, invokes the
   * processor for each unit, and durably records that the heartbeat ran.
   *
   * Because cursor advancement is durable and keyed by byte offset, a missed
   * heartbeat catches up from stored cursor state on the next run.
   */
  async runHeartbeat(reason: HeartbeatReason = 'manual'): Promise<HeartbeatRunResult> {
    if (
      this.running
      || this.stopped
      || !DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(this.workingDirectory)
    ) {
      return { unitsProcessed: 0, advancedFiles: 0, ran: false };
    }

    this.running = true;
    try {
      const config = getDistillationHeartbeatConfig(this.workingDirectory);
      const sessionLogsRoot = resolveSessionLogsRoot(config.logsRoot);
      if (!fs.existsSync(sessionLogsRoot) || !fs.statSync(sessionLogsRoot).isDirectory()) {
        this.recordHeartbeat(config.heartbeatRecordPath, reason, 0, 0);
        await this.runSettlementDeadlineWakeHook();
        await this.runCycleCompleteHook();
        await this.runCuratorReviewHook();
        return { unitsProcessed: 0, advancedFiles: 0, ran: true };
      }

      const units: DistillationUnit[] = [];
      let advancedFiles = 0;
      // Process one file at a time so an async Branch Promotion Reviewer can
      // finish before that file's cursor is advanced. The existing sync
      // processors remain valid because `await` also accepts void.
      const files = collectJsonlFilesForHeartbeat(sessionLogsRoot);
      for (const filePath of files) {
        const result = await processSessionLogAsync(
          filePath,
          config.stateFilePath,
          this.processor,
          files,
        );
        if (result.processed && result.distillationUnit) units.push(result.distillationUnit);
        if (result.advanced) advancedFiles++;
      }

      this.recordHeartbeat(config.heartbeatRecordPath, reason, units.length, advancedFiles);

      if (units.length > 0) {
        Logger.info(
          `[DistillationHeartbeat] extracted ${units.length} distillation unit(s) across ${advancedFiles} file(s) (${reason})`,
        );
      } else {
        Logger.info(`[DistillationHeartbeat] no new session log appends (${reason})`);
      }

      await this.runSettlementDeadlineWakeHook();

      // Issue #29: after the new-candidate pass, re-review eligible Needs Review
      // Queue entries so the heartbeat autonomously consumes retry-eligible
      // reviews (reviewer version, registry-state, explicit-command, or
      // matching-evidence changes). The hook is best-effort.
      await this.runCycleCompleteHook();
      await this.runCuratorReviewHook();

      return { unitsProcessed: units.length, advancedFiles, ran: true };
    } catch (error: any) {
      Logger.warning(`[DistillationHeartbeat] cycle failed (${reason}): ${error.message}`);
      return { unitsProcessed: 0, advancedFiles: 0, ran: true };
    } finally {
      this.running = false;
    }
  }

  /**
   * Best-effort invocation of the cycle-complete hook (issue #29). A throwing
   * hook is logged and never blocks the heartbeat or cursor advancement.
   */
  private async runCycleCompleteHook(): Promise<void> {
    if (!this.cycleCompleteHook) return;
    try {
      await this.cycleCompleteHook();
    } catch (error: any) {
      Logger.warning(
        `[DistillationHeartbeat] cycle-complete hook failed: ${error?.message ?? error}`,
      );
    }
  }

  private async runSettlementDeadlineWakeHook(): Promise<void> {
    if (!this.settlementDeadlineWakeHook) return;
    try {
      await this.settlementDeadlineWakeHook();
    } catch (error: any) {
      Logger.warning(
        `[DistillationHeartbeat] settlement-deadline wake failed: ${error?.message ?? error}`,
      );
    }
  }

  private async runCuratorReviewHook(): Promise<void> {
    if (!this.curatorReviewHook) return;
    try {
      await this.curatorReviewHook();
    } catch (error: any) {
      Logger.warning(
        `[DistillationHeartbeat] curator review failed: ${error?.message ?? error}`,
      );
    }
  }

  private scheduleNextRun(): void {
    if (this.stopped) {
      return;
    }

    const config = getDistillationHeartbeatConfig(this.workingDirectory);
    const intervalDelay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, config.intervalHours * 60 * 60 * 1000),
    );
    const settlementDelay = this.settlementDeadlineWakeHook
      ? nextSettlementDeadlineDelay(config.learningEpisodeStorePath, new Date())
      : null;
    const delay = settlementDelay === null
      ? intervalDelay
      : Math.min(intervalDelay, settlementDelay);
    this.timer = setTimeout(async () => {
      const reason = this.settlementDeadlineWakeHook
        && nextSettlementDeadlineDelay(config.learningEpisodeStorePath, new Date()) === 0
        ? 'settlement-deadline'
        : 'scheduled';
      await this.runHeartbeat(reason);
      this.scheduleNextRun();
    }, delay);
  }

  private recordHeartbeat(
    recordPath: string,
    reason: HeartbeatReason,
    unitsProcessed: number,
    advancedFiles: number,
  ): void {
    let record: HeartbeatRecord;
    try {
      if (fs.existsSync(recordPath)) {
        record = JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as HeartbeatRecord;
      } else {
        record = emptyHeartbeatRecord();
      }
    } catch {
      record = emptyHeartbeatRecord();
    }

    record.lastRunAt = new Date().toISOString();
    record.runCount += 1;
    record.lastReason = reason;
    record.lastUnitsProcessed = unitsProcessed;
    record.lastAdvancedFiles = advancedFiles;

    try {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      const tmpPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, recordPath);
    } catch (error: any) {
      Logger.warning(`[DistillationHeartbeat] failed to record heartbeat: ${error.message}`);
    }
  }
}

function nextSettlementDeadlineDelay(storePath: string, now: Date): number | null {
  const store = new LearningEpisodeStore(storePath).load();
  const deadlines = Object.values(store.episodes)
    .filter(episode => episode.status === 'settling')
    .map(episode => Date.parse(episode.settlementDeadline))
    .filter(deadline => Number.isFinite(deadline));
  if (deadlines.length === 0) return null;
  return Math.max(0, Math.min(...deadlines) - now.getTime());
}

async function processSessionLogAsync(
  filePath: string,
  stateFilePath: string,
  processor: DistillationUnitProcessor,
  orderedFilePaths: readonly string[] = [filePath],
): Promise<{
  distillationUnit: DistillationUnit | null;
  advanced: boolean;
  processed: boolean;
}> {
  // Keep the extraction/cursor semantics in distillation-unit.ts while
  // allowing the processor to be asynchronous. This mirrors processSessionLog
  // and intentionally advances the cursor only after the branch commit.
  const state = loadLogCursorState(stateFilePath);
  const cursor = getCursor(state, filePath);
  let extracted;
  try {
    const crossFileContinuity: CrossFileContinuityOptions = {
      orderedFilePaths,
      // The extractor derives the current file's identity from its first new
      // turn, then requires every predecessor/current turn to match it.
    };
    extracted = extractDistillationUnit(filePath, cursor, { crossFileContinuity });
  } catch (error) {
    markCursorFailed(state, filePath, cursor.byteOffset, error);
    saveLogCursorState(stateFilePath, state);
    return { distillationUnit: null, advanced: false, processed: false };
  }
  if (extracted.distillationUnit) {
    try {
      await processor(extracted.distillationUnit);
      advanceCursor(state, extracted.newCursor);
      saveLogCursorState(stateFilePath, state);
      return { distillationUnit: extracted.distillationUnit, advanced: true, processed: true };
    } catch (error) {
      markCursorFailed(state, filePath, cursor.byteOffset, error);
      saveLogCursorState(stateFilePath, state);
      return { distillationUnit: extracted.distillationUnit, advanced: false, processed: false };
    }
  }
  if (extracted.advanced) {
    advanceCursor(state, extracted.newCursor);
    saveLogCursorState(stateFilePath, state);
  }
  return { distillationUnit: null, advanced: extracted.advanced, processed: false };
}

function collectJsonlFilesForHeartbeat(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJsonlFilesForHeartbeat(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
  }
  return files.sort();
}

export function loadHeartbeatRecord(recordPath: string): HeartbeatRecord {
  try {
    if (!fs.existsSync(recordPath)) {
      return emptyHeartbeatRecord();
    }
    return JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as HeartbeatRecord;
  } catch {
    return emptyHeartbeatRecord();
  }
}

function resolveSessionLogsRoot(logsRoot: string): string {
  const normalizedRoot = path.resolve(logsRoot);
  return path.basename(normalizedRoot) === 'sessions'
    ? normalizedRoot
    : path.join(normalizedRoot, 'sessions');
}
