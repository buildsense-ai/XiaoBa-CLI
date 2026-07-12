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
import {
  RuntimeLearningCurationReport,
  RuntimeLearningDiscoveryReport,
  RuntimeLearningIngestionReport,
  RuntimeLearningMaturationReport,
  RuntimeLearningWakeContext,
  RuntimeLearningWakeReport,
} from './runtime-learning-coordinator';

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
  /** Discovery-stage outcome for this wake. */
  discovery: RuntimeLearningDiscoveryReport;
  /** Durable admission-stage outcome for this wake. */
  ingestion: RuntimeLearningIngestionReport;
  /** Settlement/maturation outcome for this wake. */
  maturation: RuntimeLearningMaturationReport;
  /** Capability-learning review outcome for this wake. */
  review: RuntimeLearningWakeReport['review'];
  /** Current-skill curation outcome for this wake. */
  curation: RuntimeLearningCurationReport;
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

/** Shared Runtime Learning coordinator for discovery/manual/scheduled wakes. */
export type RuntimeLearningWakeHook = (
  context: RuntimeLearningWakeContext,
) => Promise<RuntimeLearningWakeReport> | RuntimeLearningWakeReport;

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

function emptyWakeReport(ran: boolean): HeartbeatRunResult {
  return {
    unitsProcessed: 0,
    advancedFiles: 0,
    ran,
    discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
    ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
    maturation: { maturedEpisodes: 0, becameEligible: 0, becameContradicted: 0 },
    review: {
      reviewedEpisodes: 0,
      reviewedQueueEntries: 0,
      deferredQueueReviews: 0,
      operationalQueueReviews: 0,
      deferredRetries: 0,
      operationalRetries: 0,
      transitionsByKind: {},
    },
    curation: { ran: false, expedited: false, transitionsByKind: {} },
  };
}

export class DistillationHeartbeatScheduler {
  private readonly workingDirectory: string;
  private readonly processor: DistillationUnitProcessor;
  private readonly cycleCompleteHook: HeartbeatCycleCompleteHook | null;
  private readonly settlementDeadlineWakeHook: SettlementDeadlineWakeHook | null;
  private readonly curatorReviewHook: CuratorReviewHook | null;
  private readonly runtimeLearningWakeHook: RuntimeLearningWakeHook | null;
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
    runtimeLearningWakeHook: RuntimeLearningWakeHook | null = null,
  ) {
    this.workingDirectory = workingDirectory;
    this.processor = processor;
    this.cycleCompleteHook = cycleCompleteHook;
    this.settlementDeadlineWakeHook = settlementDeadlineWakeHook;
    this.curatorReviewHook = curatorReviewHook;
    this.runtimeLearningWakeHook = runtimeLearningWakeHook;
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
   * Run one heartbeat cycle. Discovery wakes walk the session log tree,
   * extract Distillation Units from newly appended content via durable Log
   * Cursor state, invoke the processor for each unit, and durably record that
   * the heartbeat ran. Settlement-deadline wakes skip session-log discovery
   * entirely and run only the due Runtime Learning coordination path.
   *
   * Because cursor advancement is durable and keyed by byte offset, a missed
   * heartbeat catches up from stored cursor state on the next discovery wake.
   */
  async runHeartbeat(reason: HeartbeatReason = 'manual'): Promise<HeartbeatRunResult> {
    if (
      this.running
      || this.stopped
      || !DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(this.workingDirectory)
    ) {
      return emptyWakeReport(false);
    }

    this.running = true;
    const wake = emptyWakeReport(true);
    try {
      const config = getDistillationHeartbeatConfig(this.workingDirectory);
      const sessionLogsRoot = resolveSessionLogsRoot(config.logsRoot);
      const shouldScan = reason !== 'settlement-deadline';
      if (shouldScan && fs.existsSync(sessionLogsRoot) && fs.statSync(sessionLogsRoot).isDirectory()) {
        const files = collectJsonlFilesForHeartbeat(sessionLogsRoot);
        wake.discovery.scanned = true;
        wake.discovery.filesScanned = files.length;

        // Process one file at a time so an async Branch Promotion Reviewer can
        // finish before that file's cursor is advanced. The existing sync
        // processors remain valid because `await` also accepts void.
        for (const filePath of files) {
          const result = await processSessionLogAsync(
            filePath,
            config.stateFilePath,
            this.processor,
            files,
          );
          if (result.processed && result.distillationUnit) wake.discovery.unitsProcessed++;
          if (result.advanced) wake.discovery.advancedFiles++;
          wake.ingestion.admittedEpisodes += result.admittedEpisodes;
          wake.ingestion.contradictionSignals += result.contradictionSignals;
        }
      }

      wake.unitsProcessed = wake.discovery.unitsProcessed;
      wake.advancedFiles = wake.discovery.advancedFiles;
      this.recordHeartbeat(config.heartbeatRecordPath, reason, wake.unitsProcessed, wake.advancedFiles);

      if (wake.unitsProcessed > 0) {
        Logger.info(
          `[DistillationHeartbeat] extracted ${wake.unitsProcessed} distillation unit(s) across ${wake.advancedFiles} file(s) (${reason})`,
        );
      } else if (wake.discovery.scanned) {
        Logger.info(`[DistillationHeartbeat] no new session log appends (${reason})`);
      } else {
        Logger.info(`[DistillationHeartbeat] skipped session log scan (${reason})`);
      }

      const coordinated = await this.runRuntimeLearningWakeHook({
        reason,
        discovery: wake.discovery,
        ingestion: wake.ingestion,
      });
      if (coordinated) {
        wake.maturation = coordinated.maturation;
        wake.review = coordinated.review;
        wake.curation = coordinated.curation;
      } else {
        await this.runSettlementDeadlineWakeHook();

        // Issue #29: after the new-candidate pass, re-review eligible Needs Review
        // Queue entries so the heartbeat autonomously consumes retry-eligible
        // reviews (reviewer version, registry-state, explicit-command, or
        // matching-evidence changes). The hook is best-effort.
        await this.runCycleCompleteHook();
        await this.runCuratorReviewHook();
      }

      return wake;
    } catch (error: any) {
      Logger.warning(`[DistillationHeartbeat] cycle failed (${reason}): ${error.message}`);
      return wake;
    } finally {
      this.running = false;
    }
  }

  private async runRuntimeLearningWakeHook(
    context: RuntimeLearningWakeContext,
  ): Promise<RuntimeLearningWakeReport | null> {
    if (!this.runtimeLearningWakeHook) return null;
    try {
      return await this.runtimeLearningWakeHook(context);
    } catch (error: any) {
      Logger.warning(
        `[DistillationHeartbeat] runtime learning coordination failed: ${error?.message ?? error}`,
      );
      return null;
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
    const settlementDelay = this.settlementDeadlineWakeHook || this.runtimeLearningWakeHook
      ? nextSettlementDeadlineDelay(config.learningEpisodeStorePath, new Date())
      : null;
    const delay = settlementDelay === null
      ? intervalDelay
      : Math.min(intervalDelay, settlementDelay);
    this.timer = setTimeout(async () => {
      const reason = (this.settlementDeadlineWakeHook || this.runtimeLearningWakeHook)
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
  admittedEpisodes: number;
  contradictionSignals: number;
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
    return {
      distillationUnit: null,
      advanced: false,
      processed: false,
      admittedEpisodes: 0,
      contradictionSignals: 0,
    };
  }
  if (extracted.distillationUnit) {
    try {
      const processorResult = await processor(extracted.distillationUnit);
      const ingestion = summarizeIngestionResult(processorResult);
      advanceCursor(state, extracted.newCursor);
      saveLogCursorState(stateFilePath, state);
      return {
        distillationUnit: extracted.distillationUnit,
        advanced: true,
        processed: true,
        admittedEpisodes: ingestion.admittedEpisodes,
        contradictionSignals: ingestion.contradictionSignals,
      };
    } catch (error) {
      markCursorFailed(state, filePath, cursor.byteOffset, error);
      saveLogCursorState(stateFilePath, state);
      return {
        distillationUnit: extracted.distillationUnit,
        advanced: false,
        processed: false,
        admittedEpisodes: 0,
        contradictionSignals: 0,
      };
    }
  }
  if (extracted.advanced) {
    advanceCursor(state, extracted.newCursor);
    saveLogCursorState(stateFilePath, state);
  }
  return {
    distillationUnit: null,
    advanced: extracted.advanced,
    processed: false,
    admittedEpisodes: 0,
    contradictionSignals: 0,
  };
}

function summarizeIngestionResult(result: unknown): RuntimeLearningIngestionReport {
  if (!isEvidenceIngestionResult(result)) {
    return { admittedEpisodes: 0, contradictionSignals: 0 };
  }
  return {
    admittedEpisodes: result.admittedEpisodeIds.length,
    contradictionSignals: result.contradictionSignalIds.length,
  };
}

function isEvidenceIngestionResult(result: unknown): result is {
  admittedEpisodeIds: readonly unknown[];
  contradictionSignalIds: readonly unknown[];
} {
  return !!result
    && typeof result === 'object'
    && Array.isArray((result as { admittedEpisodeIds?: unknown }).admittedEpisodeIds)
    && Array.isArray((result as { contradictionSignalIds?: unknown }).contradictionSignalIds);
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
