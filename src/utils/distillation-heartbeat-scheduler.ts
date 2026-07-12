/**
 * Distillation Heartbeat Scheduler — thin wake-loop adapter (issue #53).
 *
 * Production path: the scheduler is a thin timer that calls
 * `RuntimeLearning.wake()` on each tick. All intelligence (session log
 * scanning, evidence ingestion, settlement, review, curation, wake
 * coordination) lives in the deep `RuntimeLearning` module.
 *
 * Legacy path (deprecated): tests may construct the scheduler with a
 * processor function and optional hooks using the static `legacy()`
 * factory. Production startup uses the `RuntimeLearning` constructor.
 *
 * The heartbeat owns:
 *   - The setTimeout-based timer
 *   - Runtime guard (`shouldStartForCurrentRuntime`)
 *   - Heartbeat record keeping
 *   - Due-work-based next-wake planning
 *
 * See CONTEXT.md → "Distillation Heartbeat".
 * See ADR 0001 → "Runtime Heartbeat Log Distillation".
 */

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
import { DueWorkPlanner } from './due-work-planner';
import { Logger } from './logger';
import type { RuntimeLearning } from './runtime-learning';
import type {
  RuntimeLearningReason,
  RuntimeLearningHeartbeatResult,
  RuntimeLearningCurationReport,
  RuntimeLearningDiscoveryReport,
  RuntimeLearningIngestionReport,
  RuntimeLearningMaturationReport,
  RuntimeLearningReviewReport,
} from './runtime-learning';

// ---------------------------------------------------------------------------
// Public types (preserved for backward compatibility)
// ---------------------------------------------------------------------------

export type HeartbeatReason = RuntimeLearningReason;

export interface HeartbeatRunResult extends RuntimeLearningHeartbeatResult {
  // Same shape as RuntimeLearningHeartbeatResult — re-exported for compat.
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

/** @deprecated Legacy processor type for test-only scheduler construction. */
export type DistillationUnitProcessor = (unit: DistillationUnit) => unknown | Promise<unknown>;

/** @deprecated Legacy hook for test-only scheduler construction. */
export type HeartbeatCycleCompleteHook = () => Promise<void> | void;

/** @deprecated Legacy hook for test-only scheduler construction. */
export type SettlementDeadlineWakeHook = () => Promise<void> | void;

/** @deprecated Legacy hook for test-only scheduler construction. */
export type CuratorReviewHook = () => Promise<void> | void;

/** @deprecated Legacy hook for test-only scheduler construction. */
export type RuntimeLearningWakeHook = (
  context: RuntimeLearningWakeContext,
) => Promise<RuntimeLearningWakeReport> | RuntimeLearningWakeReport;

/**
 * @deprecated Legacy Runtime Learning context, kept for test compatibility.
 * Production wakes go through `RuntimeLearning.wake()` directly.
 */
export interface RuntimeLearningWakeContext {
  reason: RuntimeLearningReason;
  discovery: RuntimeLearningDiscoveryReport;
  ingestion: RuntimeLearningIngestionReport;
  dueWork?: import('./due-work-planner').DueWork;
}

/**
 * @deprecated Legacy report type, kept for test compatibility.
 */
export interface RuntimeLearningWakeReport {
  maturation: RuntimeLearningMaturationReport;
  review: RuntimeLearningReviewReport;
  curation: RuntimeLearningCurationReport;
}

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

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

function emptyWakeResult(): HeartbeatRunResult {
  return {
    unitsProcessed: 0,
    advancedFiles: 0,
    ran: false,
    discovery: { scanned: false, filesScanned: 0, unitsProcessed: 0, advancedFiles: 0 },
    ingestion: { admittedEpisodes: 0, contradictionSignals: 0 },
    maturation: { status: 'skipped', maturedEpisodes: 0, becameEligible: 0, becameContradicted: 0 },
    review: {
      status: 'skipped',
      reviewedEpisodes: 0,
      reviewedQueueEntries: 0,
      deferredQueueReviews: 0,
      operationalQueueReviews: 0,
      deferredRetries: 0,
      operationalRetries: 0,
      transitionsByKind: {},
    },
    curation: { status: 'skipped', ran: false, expedited: false, transitionsByKind: {} },
  };
}

/**
 * Internal legacy state for the test-only scheduler path.
 * Keeps the session-log scanning logic that tests depend on.
 */
interface LegacyState {
  processor: DistillationUnitProcessor;
  cycleCompleteHook: HeartbeatCycleCompleteHook | null;
  settlementDeadlineWakeHook: SettlementDeadlineWakeHook | null;
  curatorReviewHook: CuratorReviewHook | null;
  runtimeLearningWakeHook: RuntimeLearningWakeHook | null;
}

// ---------------------------------------------------------------------------
// DistillationHeartbeatScheduler
// ---------------------------------------------------------------------------

/**
 * Thin wake-loop adapter for Runtime Learning.
 *
 * Production path: constructed with a `RuntimeLearning` instance; the
 * `runHeartbeat()` method delegates directly to `RuntimeLearning.wake()`.
 *
 * Legacy path (for tests): use `DistillationHeartbeatScheduler.legacy()`
 * with a processor function and optional hooks.
 */
export class DistillationHeartbeatScheduler {
  private readonly workingDirectory: string;
  private readonly runtimeLearning: RuntimeLearning | null;
  private readonly legacy: LegacyState | null;
  private readonly fallbackPlanner: DueWorkPlanner | null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private stopped = false;

  /**
   * Production constructor: delegates all wake logic to RuntimeLearning.
   *
   * @param workingDirectory - Working directory for config resolution.
   * @param runtimeLearning - The RuntimeLearning production module.
   */
  constructor(workingDirectory: string, runtimeLearning: RuntimeLearning);

  /**
   * @deprecated Legacy constructor path for tests. Use
   * `DistillationHeartbeatScheduler.legacy()` instead.
   */
  constructor(
    workingDirectory: string,
    processor: DistillationUnitProcessor,
    cycleCompleteHook?: HeartbeatCycleCompleteHook | null,
    settlementDeadlineWakeHook?: SettlementDeadlineWakeHook | null,
    curatorReviewHook?: CuratorReviewHook | null,
    runtimeLearningWakeHook?: RuntimeLearningWakeHook | null,
    planner?: DueWorkPlanner | null,
  );

  constructor(
    workingDirectory: string = process.cwd(),
    processorOrRuntime: DistillationUnitProcessor | RuntimeLearning = defaultProcessor(),
    cycleCompleteHook: HeartbeatCycleCompleteHook | null = null,
    settlementDeadlineWakeHook: SettlementDeadlineWakeHook | null = null,
    curatorReviewHook: CuratorReviewHook | null = null,
    runtimeLearningWakeHook: RuntimeLearningWakeHook | null = null,
    planner?: DueWorkPlanner | null,
  ) {
    this.workingDirectory = workingDirectory;

    if (isRuntimeLearning(processorOrRuntime)) {
      // Production path
      this.runtimeLearning = processorOrRuntime;
      this.legacy = null;
      this.fallbackPlanner = null;
    } else {
      // Legacy compat path (deprecated)
      this.runtimeLearning = null;
      this.legacy = {
        processor: processorOrRuntime,
        cycleCompleteHook,
        settlementDeadlineWakeHook,
        curatorReviewHook,
        runtimeLearningWakeHook,
      };
      this.fallbackPlanner = planner ?? null;
    }
  }

  /**
   * Legacy factory: create a scheduler with a processor function and optional
   * hooks. Used by tests; production should use the RuntimeLearning constructor.
   *
   * @deprecated Use `new DistillationHeartbeatScheduler(workingDir, runtimeLearning)`.
   */
  static legacy(
    workingDirectory: string = process.cwd(),
    processor: DistillationUnitProcessor = defaultProcessor(),
    cycleCompleteHook: HeartbeatCycleCompleteHook | null = null,
    settlementDeadlineWakeHook: SettlementDeadlineWakeHook | null = null,
    curatorReviewHook: CuratorReviewHook | null = null,
    runtimeLearningWakeHook: RuntimeLearningWakeHook | null = null,
    planner?: DueWorkPlanner | null,
  ): DistillationHeartbeatScheduler {
    return new DistillationHeartbeatScheduler(
      workingDirectory,
      processor,
      cycleCompleteHook,
      settlementDeadlineWakeHook,
      curatorReviewHook,
      runtimeLearningWakeHook,
      planner,
    );
  }

  // -----------------------------------------------------------------------
  // Runtime guard
  // -----------------------------------------------------------------------

  /**
   * Runtime guard: the heartbeat is disabled for inspector role runtimes and
   * when the config master switch is off.
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

  // -----------------------------------------------------------------------
  // Start / Stop
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Run one heartbeat cycle
  // -----------------------------------------------------------------------

  /**
   * Run one heartbeat cycle.
   *
   * Production: delegates all work to `RuntimeLearning.wake()`.
   * Legacy: runs the old session-scanning and hook-based logic.
   */
  async runHeartbeat(reason: HeartbeatReason = 'manual'): Promise<HeartbeatRunResult> {
    if (
      this.running
      || this.stopped
      || !DistillationHeartbeatScheduler.shouldStartForCurrentRuntime(this.workingDirectory)
    ) {
      return emptyWakeResult();
    }

    this.running = true;
    try {
      if (this.runtimeLearning) {
        // --- Production path ---
        // RuntimeLearning.wake() owns the heartbeat record; the scheduler
        // must not write it again (would double-increment runCount).
        const result = await this.runtimeLearning.wake(reason);
        return result;
      }

      // --- Legacy path (deprecated, used by tests) ---
      return await this.legacyRunHeartbeat(reason);
    } catch (error: any) {
      Logger.warning(`[DistillationHeartbeat] cycle failed (${reason}): ${error.message}`);
      return emptyWakeResult();
    } finally {
      this.running = false;
    }
  }

  /**
   * @deprecated Legacy heartbeat logic preserved for test compatibility.
   */
  private async legacyRunHeartbeat(reason: HeartbeatReason): Promise<HeartbeatRunResult> {
    const legacy = this.legacy!;
    const wake = emptyWakeResult();
    wake.ran = true;

    try {
      const config = getDistillationHeartbeatConfig(this.workingDirectory);
      const sessionLogsRoot = resolveSessionLogsRoot(config.logsRoot);

      const isTargetedWake = reason === 'settlement-deadline' || reason === 'operational-retry' || reason === 'curator';
      const shouldScan = !isTargetedWake;

      if (shouldScan && fs.existsSync(sessionLogsRoot) && fs.statSync(sessionLogsRoot).isDirectory()) {
        const files = collectJsonlFilesForHeartbeat(sessionLogsRoot);
        wake.discovery.scanned = true;
        wake.discovery.filesScanned = files.length;

        for (const filePath of files) {
          const result = await processSessionLogAsync(
            filePath,
            config.stateFilePath,
            legacy.processor,
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
      this.recordHeartbeat(reason, wake.unitsProcessed, wake.advancedFiles);

      if (wake.unitsProcessed > 0) {
        Logger.info(
          `[DistillationHeartbeat] extracted ${wake.unitsProcessed} distillation unit(s) across ${wake.advancedFiles} file(s) (${reason})`,
        );
      } else if (wake.discovery.scanned) {
        Logger.info(`[DistillationHeartbeat] no new session log appends (${reason})`);
      } else {
        Logger.info(`[DistillationHeartbeat] skipped session log scan (${reason})`);
      }

      const plan = isTargetedWake ? this.getLegacyPlanner().plan() : null;
      const coordinated = await this.legacyRunRuntimeLearningWakeHook({
        reason,
        discovery: wake.discovery,
        ingestion: wake.ingestion,
        ...(plan ? { dueWork: plan.due } : {}),
      });
      if (coordinated) {
        wake.maturation = coordinated.maturation;
        wake.review = coordinated.review;
        wake.curation = coordinated.curation;
      } else {
        await this.legacyRunSettlementDeadlineWakeHook();
        await this.legacyRunCycleCompleteHook();
        await this.legacyRunCuratorReviewHook();
      }

      return wake;
    } catch (error: any) {
      Logger.warning(`[DistillationHeartbeat] cycle failed (${reason}): ${error.message}`);
      return wake;
    }
  }

  private async legacyRunRuntimeLearningWakeHook(
    context: RuntimeLearningWakeContext,
  ): Promise<RuntimeLearningWakeReport | null> {
    if (!this.legacy?.runtimeLearningWakeHook) return null;
    try {
      return await this.legacy.runtimeLearningWakeHook(context);
    } catch (error: any) {
      Logger.warning(
        `[DistillationHeartbeat] runtime learning coordination failed: ${error?.message ?? error}`,
      );
      return null;
    }
  }

  private async legacyRunCycleCompleteHook(): Promise<void> {
    if (!this.legacy?.cycleCompleteHook) return;
    try {
      await this.legacy.cycleCompleteHook();
    } catch (error: any) {
      Logger.warning(
        `[DistillationHeartbeat] cycle-complete hook failed: ${error?.message ?? error}`,
      );
    }
  }

  private async legacyRunSettlementDeadlineWakeHook(): Promise<void> {
    if (!this.legacy?.settlementDeadlineWakeHook) return;
    try {
      await this.legacy.settlementDeadlineWakeHook();
    } catch (error: any) {
      Logger.warning(
        `[DistillationHeartbeat] settlement-deadline wake failed: ${error?.message ?? error}`,
      );
    }
  }

  private async legacyRunCuratorReviewHook(): Promise<void> {
    if (!this.legacy?.curatorReviewHook) return;
    try {
      await this.legacy.curatorReviewHook();
    } catch (error: any) {
      Logger.warning(
        `[DistillationHeartbeat] curator review failed: ${error?.message ?? error}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Scheduling
  // -----------------------------------------------------------------------

  private scheduleNextRun(): void {
    if (this.stopped) return;

    const config = getDistillationHeartbeatConfig(this.workingDirectory);
    const intervalDelay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, config.intervalHours * 60 * 60 * 1000),
    );

    let nextDelay: number;
    let wakeReason: HeartbeatReason;
    try {
      const plan = this.getActivePlanner().plan();
      if (plan.nextWakeTime !== null) {
        const deadlineDelta = Math.max(0, plan.nextWakeTime - plan.now.getTime());
        if (deadlineDelta < intervalDelay) {
          nextDelay = deadlineDelta;
          wakeReason = plan.nextWakeReason as HeartbeatReason;
        } else {
          nextDelay = intervalDelay;
          wakeReason = 'scheduled';
        }
      } else {
        nextDelay = intervalDelay;
        wakeReason = 'scheduled';
      }
    } catch (error: any) {
      Logger.warning(
        `[DistillationHeartbeat] planner failed: ${error?.message ?? error}; falling back to discovery interval`,
      );
      nextDelay = intervalDelay;
      wakeReason = 'scheduled';
    }

    this.timer = setTimeout(async () => {
      await this.runHeartbeat(wakeReason);
      this.scheduleNextRun();
    }, nextDelay);
  }

  private getActivePlanner(): DueWorkPlanner {
    if (this.runtimeLearning) {
      return this.runtimeLearning.getPlanner();
    }
    return this.getLegacyPlanner();
  }

  private getLegacyPlanner(): DueWorkPlanner {
    if (this.fallbackPlanner) return this.fallbackPlanner;
    const config = getDistillationHeartbeatConfig(this.workingDirectory);
    return new DueWorkPlanner({
      learningEpisodeStorePath: config.learningEpisodeStorePath,
      reviewQueuePath: config.skillEvolutionReviewQueuePath,
      curatorStatePath: config.skillEvolutionCuratorStatePath,
      curatorIntervalMs: config.skillEvolutionCuratorIntervalHours * 60 * 60 * 1000,
    });
  }

  // -----------------------------------------------------------------------
  // Heartbeat record keeping
  // -----------------------------------------------------------------------

  private recordHeartbeat(
    reason: HeartbeatReason,
    unitsProcessed: number,
    advancedFiles: number,
  ): void {
    const config = getDistillationHeartbeatConfig(this.workingDirectory);
    let record: HeartbeatRecord;
    try {
      if (fs.existsSync(config.heartbeatRecordPath)) {
        record = JSON.parse(fs.readFileSync(config.heartbeatRecordPath, 'utf-8')) as HeartbeatRecord;
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
      fs.mkdirSync(path.dirname(config.heartbeatRecordPath), { recursive: true });
      const tmpPath = `${config.heartbeatRecordPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, config.heartbeatRecordPath);
    } catch (error: any) {
      Logger.warning(`[DistillationHeartbeat] failed to record heartbeat: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isRuntimeLearning(value: unknown): value is RuntimeLearning {
  return (
    !!value
    && typeof value === 'object'
    && 'wake' in value
    && 'getPlanner' in value
    && 'getConfig' in value
  );
}

// ---------------------------------------------------------------------------
// Default processor
// ---------------------------------------------------------------------------

function defaultProcessor(): DistillationUnitProcessor {
  return () => {};
}

// ---------------------------------------------------------------------------
// Legacy session-log processing helpers (preserved for test compatibility)
// ---------------------------------------------------------------------------

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
  const state = loadLogCursorState(stateFilePath);
  const cursor = getCursor(state, filePath);
  let extracted;
  try {
    const crossFileContinuity: CrossFileContinuityOptions = {
      orderedFilePaths,
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

function summarizeIngestionResult(result: unknown): { admittedEpisodes: number; contradictionSignals: number } {
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

function resolveSessionLogsRoot(logsRoot: string): string {
  const normalizedRoot = path.resolve(logsRoot);
  return path.basename(normalizedRoot) === 'sessions'
    ? normalizedRoot
    : path.join(normalizedRoot, 'sessions');
}

// ---------------------------------------------------------------------------
// Legacy: loadHeartbeatRecord (preserved for backward compatibility)
// ---------------------------------------------------------------------------

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
