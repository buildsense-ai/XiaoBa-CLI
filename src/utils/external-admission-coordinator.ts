/**
 * External Admission Coordinator — issue #93.
 *
 * The single Runtime-owned writer that durably admits stable pages produced
 * by External Source Work Lanes. Provider reads may overlap (bounded by the
 * future async reader pool from #92), but Episode, Capsule, provenance, and
 * cursor acknowledgement settle through this coordinator in fair, page-sized
 * turns among ready lanes.
 *
 * ## Responsibilities
 *
 * - **Single-writer serialization**: all external Episode, Capsule, provenance,
 *   and cursor mutations pass through one observable coordinator. Durable
 *   page commits never overlap.
 * - **Work-conserving round-robin**: ready providers receive one page per
 *   provider per round. A durable `nextProvider` marker prevents a stable
 *   provider ordering from starving later providers across wakes, quota
 *   exhaustion, restart, and provider set reorder.
 * - **Backfill arbitration**: explicit same-provider backfill receives the
 *   next page turn after the active commit, then alternates with continuous
 *   pages while both remain ready. Different providers may overlap
 *   independently.
 * - **Deadline drain**: when a deadline arrives, no Ready page starts
 *   committing; only the single page already Committing may settle.
 * - **Crash replay**: a crash or failure before cursor acknowledgement leaves
 *   the page replayable and idempotent — the commit function handles
 *   deduplication.
 *
 * ## Commit order
 *
 * The commit function injected at construction time is called exactly once
 * per page and is responsible for preserving the established durable order:
 *
 *   normalize stable event
 *   → ingest Learning Episode
 *   → persist redacted Evidence Capsule
 *   → persist external provenance
 *   → acknowledge provider cursor last
 *
 * The coordinator itself does not perform these writes; it delegates to the
 * injected commit function so RuntimeLearning retains ownership of its
 * stores. The coordinator's job is ordering, fairness, and serialization.
 *
 * ## Binding to the future bounded async reader pool (#92)
 *
 * When #92 lands, the async reader pool will produce `ExternalEvidencePage`
 * objects as xURL processes complete. The pool will call
 * `coordinator.admitPage(page)` for each ready page. The coordinator commits
 * pages serially using the same injected commit function, maintaining the
 * round-robin and backfill arbitration guarantees. No changes to the
 * coordinator's public seam are required — the pool is a producer, the
 * coordinator is the single consumer/writer.
 *
 * In the current pre-#92 synchronous model, `runDiscovery()` calls
 * `coordinator.selectNextProvider()` and `coordinator.admitPage()` in-line.
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  SessionLogSourceIdentity,
  SessionLogSourceResource,
  SessionLogSourceReadResult,
  SourceEventIdentity,
} from './session-log-source';
import type { DistillationUnit } from './distillation-unit';
import {
  EXTERNAL_ADMISSION_LANES,
  type ExternalAdmissionLane,
} from './external-source-work';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const EXTERNAL_ADMISSION_COORDINATOR_SCHEMA_VERSION = 1;

export type { ExternalAdmissionLane } from './external-source-work';

/**
 * A bounded, replayable batch of stable source events offered by one
 * External Source Work Lane for admission. It may be canceled or discarded
 * before commit begins; once commit starts, its Episode, Capsule, provenance,
 * and final cursor acknowledgement settle as one ordered admission.
 */
export interface ExternalEvidencePage {
  /** Normalized provider identifier (opaque to XiaoBa). */
  readonly providerId: string;
  /** Source lane identifier. */
  readonly sourceId: string;
  /** Full source identity for provenance. */
  readonly identity: SessionLogSourceIdentity;
  /** The resource this page was read from. */
  readonly resource: SessionLogSourceResource;
  /** Stable distillation units derived from the read. */
  readonly distillationUnits: readonly DistillationUnit[];
  /** Event identities for provenance and deduplication. */
  readonly eventIdentities: readonly SourceEventIdentity[];
  /** The raw read result, used for cursor acknowledgement. */
  readonly readResult: SessionLogSourceReadResult;
  /** Which lane produced this page. */
  readonly lane: ExternalAdmissionLane;
}

/**
 * Result of committing one page through the coordinator.
 */
export interface ExternalAdmissionCommitResult {
  readonly admittedEpisodes: number;
  readonly contradictionSignals: number;
  /** Exact episode ids admitted by this page commit. */
  readonly admittedEpisodeIds?: readonly string[];
  /** True when the full commit sequence (including any lane-owned ack) succeeded. */
  readonly acknowledged: boolean;
  /** Present when the commit failed before acknowledgement. */
  readonly error?: Error;
}

/**
 * The commit function injected by RuntimeLearning. It is called exactly once
 * per page, serially, and is responsible for the established durable order:
 *
 *   Learning Episode → Evidence Capsule → provenance → cursor acknowledgement
 *
 * The function must be idempotent: a replay of the same page after a crash
 * before cursor ack must not produce duplicate Episodes or Capsules.
 */
export type ExternalAdmissionCommitFn = (
  page: ExternalEvidencePage,
) => ExternalAdmissionCommitResult;

/**
 * Durable per-provider alternation state for backfill vs continuous.
 */
export interface ProviderTurnState {
  /** Which lane was last served for this provider. */
  readonly lastLaneServed: ExternalAdmissionLane | null;
  /** Source that last consumed this provider's durable turn. */
  readonly lastSourceServed?: string | null;
  /** Whether a backfill has requested the next turn. */
  readonly backfillPending: boolean;
}

/**
 * Durable coordinator state persisted across wakes, restarts, and quota
 * exhaustion.
 */
export interface ExternalAdmissionCoordinatorState {
  readonly schemaVersion: number;
  /** The next provider to serve in round-robin order. */
  readonly nextProvider: string | null;
  /** Per-provider alternation state for backfill vs continuous. */
  readonly providerTurns: Record<string, ProviderTurnState>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyState(): ExternalAdmissionCoordinatorState {
  return {
    schemaVersion: EXTERNAL_ADMISSION_COORDINATOR_SCHEMA_VERSION,
    nextProvider: null,
    providerTurns: {},
  };
}

function validateState(raw: unknown): ExternalAdmissionCoordinatorState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyState();
  }
  const candidate = raw as Partial<ExternalAdmissionCoordinatorState>;
  if (candidate.schemaVersion !== EXTERNAL_ADMISSION_COORDINATOR_SCHEMA_VERSION) {
    return emptyState();
  }
  const nextProvider
    = typeof candidate.nextProvider === 'string' ? candidate.nextProvider : null;
  const providerTurns: Record<string, ProviderTurnState> = {};
  if (candidate.providerTurns && typeof candidate.providerTurns === 'object'
    && !Array.isArray(candidate.providerTurns)) {
    for (const [provider, turn] of Object.entries(candidate.providerTurns)) {
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) continue;
      const t = turn as Partial<ProviderTurnState>;
      const lastLaneServed
        = t.lastLaneServed === 'continuous'
          || t.lastLaneServed === 'catch-up'
          || t.lastLaneServed === 'backfill'
          ? t.lastLaneServed
          : null;
      providerTurns[provider] = {
        lastLaneServed,
        lastSourceServed: typeof t.lastSourceServed === 'string' ? t.lastSourceServed : null,
        backfillPending: t.backfillPending === true,
      };
    }
  }
  return {
    schemaVersion: EXTERNAL_ADMISSION_COORDINATOR_SCHEMA_VERSION,
    nextProvider,
    providerTurns,
  };
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface ExternalAdmissionCoordinatorOptions {
  /** Durable state file path for the next-provider marker and turn state. */
  readonly stateFilePath: string;
  /** Injected commit function (single-writer boundary). */
  readonly commitFn: ExternalAdmissionCommitFn;
  /** Optional clock for timestamps (tests inject deterministic clocks). */
  readonly clock?: () => Date;
  /** Optional max pages per round (quota enforcement). */
  readonly maxPagesPerRound?: number;
}

/**
 * The single External Admission Coordinator.
 *
 * All external Episode, Capsule, provenance, and cursor mutations pass
 * through this coordinator. Provider reads may overlap, but durable page
 * commits never overlap.
 */
export class ExternalAdmissionCoordinator {
  private readonly stateFilePath: string;
  private readonly commitFn: ExternalAdmissionCommitFn;
  private readonly clock: () => Date;
  private readonly maxPagesPerRound: number;

  private state: ExternalAdmissionCoordinatorState;
  /** The single page currently Committing (for deadline drain). */
  private committingPage: ExternalEvidencePage | null = null;
  /** When true, no new Ready page may start committing. */
  private deadlineReached = false;

  constructor(options: ExternalAdmissionCoordinatorOptions) {
    this.stateFilePath = options.stateFilePath;
    this.commitFn = options.commitFn;
    this.clock = options.clock ?? (() => new Date());
    this.maxPagesPerRound = options.maxPagesPerRound ?? Infinity;
    this.state = this.loadState();
  }

  // -------------------------------------------------------------------------
  // Round-robin provider selection
  // -------------------------------------------------------------------------

  /**
   * Select the next provider to serve from the ready set, using the durable
   * `nextProvider` marker. Returns `null` when no providers are ready.
   *
   * The selection is work-conserving: if `nextProvider` is absent from the
   * ready set, the first ready provider after it (in sorted order) is
   * returned, so a slow or absent provider never blocks ready work.
   */
  selectNextProvider(readyProviders: readonly string[]): string | null {
    if (readyProviders.length === 0) return null;
    const sorted = [...new Set(readyProviders)].sort();
    if (sorted.length === 1) return sorted[0]!;

    const marker = this.state.nextProvider;
    if (!marker) return sorted[0]!;

    // Find the marker in the sorted set; if absent, wrap to the first provider
    const markerIndex = sorted.indexOf(marker);
    if (markerIndex < 0) {
      // Marker is absent from the ready set — find the first provider after
      // the marker alphabetically, or wrap to the first.
      const after = sorted.filter(p => p > marker);
      return (after[0] ?? sorted[0])!;
    }

    // Return the marker itself (it's ready and it's its turn)
    return sorted[markerIndex]!;
  }

  /** Select the next ready source within one provider after its durable marker. */
  selectNextSource(providerId: string, readySourceIds: readonly string[]): string | null {
    const sorted = [...new Set(readySourceIds)].sort();
    if (sorted.length === 0) return null;
    const marker = this.state.providerTurns[providerId]?.lastSourceServed;
    if (!marker) return sorted[0]!;
    const markerIndex = sorted.indexOf(marker);
    if (markerIndex >= 0) return sorted[(markerIndex + 1) % sorted.length]!;
    return sorted.find(sourceId => sourceId > marker) ?? sorted[0]!;
  }

  /**
   * Advance the `nextProvider` marker after serving `servedProvider`.
   * The marker moves to the next provider in sorted order after the served
   * one, wrapping around. If the served provider is the last, it wraps to
   * the first.
   */
  advanceNextProvider(
    allKnownProviders: readonly string[],
    servedProvider: string,
  ): void {
    const sorted = [...new Set(allKnownProviders)].sort();
    if (sorted.length === 0) return;
    const index = sorted.indexOf(servedProvider);
    if (index < 0) {
      // Served provider is not in the known set — default to first
      this.state = { ...this.state, nextProvider: sorted[0]! };
      return;
    }
    const nextIndex = (index + 1) % sorted.length;
    this.state = { ...this.state, nextProvider: sorted[nextIndex]! };
  }

  /**
   * Persist completion of a non-page catch-up quantum through the same
   * provider/source/lane continuation used by page admission.
   */
  completeCatchUpQuantum(
    allKnownProviders: readonly string[],
    providerId: string,
    sourceId: string,
  ): void {
    this.updateProviderTurn(providerId, turn => ({
      ...turn,
      lastLaneServed: 'catch-up',
      lastSourceServed: sourceId,
    }));
    this.advanceNextProvider(allKnownProviders, providerId);
    this.saveState();
  }

  // -------------------------------------------------------------------------
  // Backfill arbitration
  // -------------------------------------------------------------------------

  /**
   * Mark that a backfill has requested the next turn for `providerId`.
   * The backfill will receive the next page turn for this provider, then
   * alternate with continuous pages while both remain ready.
   */
  markBackfillPending(providerId: string): void {
    this.updateProviderTurn(providerId, turn => ({
      ...turn,
      backfillPending: true,
    }));
    this.saveState();
  }

  /**
   * Clear the backfill-pending flag after the backfill has been served or
   * canceled.
   */
  clearBackfillPending(providerId: string): void {
    this.updateProviderTurn(providerId, turn => ({
      ...turn,
      backfillPending: false,
    }));
    this.saveState();
  }

  /**
   * Determine which ready lane should receive the next page turn for
   * `providerId`.
   *
   * Rules:
   * - A pending explicit backfill receives the next turn once it is ready.
   * - After that forced turn, every ready lane rotates after the last served
   *   lane in deterministic continuous → catch-up → backfill order.
   * - Empty lanes donate their turn immediately.
   */
  selectNextLane(
    providerId: string,
    readyLanes?: readonly ExternalAdmissionLane[],
  ): ExternalAdmissionLane | null {
    const turn = this.state.providerTurns[providerId];
    const ready = new Set(
      readyLanes ?? (turn?.backfillPending ? ['continuous', 'backfill'] : ['continuous']),
    );
    if (ready.size === 0) return null;
    if (turn?.backfillPending && ready.has('backfill')) return 'backfill';

    const lastIndex = turn?.lastLaneServed
      ? EXTERNAL_ADMISSION_LANES.indexOf(turn.lastLaneServed)
      : -1;
    for (let offset = 1; offset <= EXTERNAL_ADMISSION_LANES.length; offset++) {
      const lane = EXTERNAL_ADMISSION_LANES[
        (lastIndex + offset) % EXTERNAL_ADMISSION_LANES.length
      ]!;
      if (ready.has(lane)) return lane;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Page admission (single-writer serialization)
  // -------------------------------------------------------------------------

  /**
   * Commit a single ready page through the injected commit function.
   * This is the single-writer boundary: only one page commits at a time.
   *
   * After a successful commit, the round-robin marker advances and the
   * per-provider alternation state is updated. State is persisted to disk.
   *
   * If the deadline has been reached, the page is rejected without
   * committing (deadline drain semantics).
   *
   * @param page The ready page to commit.
   * @param knownProviders The full set of known providers for round-robin
   *   marker advancement. When omitted, only the page's own provider is
   *   used, which means the marker wraps to the same provider. Pass the full
   *   set to maintain cross-provider fairness.
   */
  admitPage(
    page: ExternalEvidencePage,
    knownProviders?: readonly string[],
  ): ExternalAdmissionCommitResult {
    if (this.deadlineReached && !this.committingPage) {
      return {
        admittedEpisodes: 0,
        contradictionSignals: 0,
        acknowledged: false,
        error: new Error('admission deadline reached; no new page may start committing'),
      };
    }

    // Mark the page as Committing for deadline drain support
    this.committingPage = page;
    try {
      const result = this.commitFn(page);

      if (result.acknowledged) {
        this.finalizeAcknowledgedPage(page, knownProviders);
      }

      return result;
    } finally {
      this.committingPage = null;
    }
  }

  /**
   * Commit multiple ready pages in round-robin order, respecting the
   * maxPagesPerRound quota. Pages are grouped by provider and served one
   * per provider per round, cycling through ready providers until the quota
   * is hit or all pages are committed.
   *
   * This is the batch admission path used by `runDiscovery` when multiple
   * providers have ready pages.
   */
  admitPages(
    pages: readonly ExternalEvidencePage[],
    readyProviders: readonly string[],
  ): ExternalAdmissionCommitResult[] {
    const results: ExternalAdmissionCommitResult[] = [];
    if (pages.length === 0) return results;

    // Group pages by provider and lane. Provider turns remain page-sized, and
    // each provider's durable lane continuation chooses its page for the turn.
    const pagesByProvider = new Map<string, Map<ExternalAdmissionLane, ExternalEvidencePage[]>>();
    for (const page of pages) {
      const byLane = pagesByProvider.get(page.providerId) ?? new Map();
      const list = byLane.get(page.lane) ?? [];
      list.push(page);
      byLane.set(page.lane, list);
      pagesByProvider.set(page.providerId, byLane);
    }

    const sortedProviders = [...new Set([
      ...readyProviders,
      ...pages.map(page => page.providerId),
    ])].sort();
    let committed = 0;

    // Round-robin: serve one page per provider per round
    while (committed < this.maxPagesPerRound) {
      const activeProviders = sortedProviders.filter(provider => {
        const byLane = pagesByProvider.get(provider);
        return byLane && [...byLane.values()].some(queue => queue.length > 0);
      });
      if (activeProviders.length === 0) break;
      const firstProvider = this.selectNextProvider(activeProviders);
      if (!firstProvider) break;
      const firstIndex = activeProviders.indexOf(firstProvider);
      const providersThisRound = [
        ...activeProviders.slice(firstIndex),
        ...activeProviders.slice(0, firstIndex),
      ];

      for (const provider of providersThisRound) {
        if (committed >= this.maxPagesPerRound) break;
        if (this.deadlineReached) break;

        const byLane = pagesByProvider.get(provider);
        if (!byLane) continue;
        const readyLanes = EXTERNAL_ADMISSION_LANES.filter(
          lane => (byLane.get(lane)?.length ?? 0) > 0,
        );
        const lane = this.selectNextLane(provider, readyLanes);
        if (!lane) continue;
        const queue = byLane.get(lane)!;

        const page = queue.shift()!;
        const result = this.admitPage(page, sortedProviders);
        results.push(result);
        committed++;
      }
      if (this.deadlineReached) break;
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Deadline drain
  // -------------------------------------------------------------------------

  /**
   * Mark that the global deadline has been reached. No new Ready page may
   * start committing after this call. Only the single page already
   * Committing (if any) may settle.
   */
  setDeadlineReached(): void {
    this.deadlineReached = true;
  }

  /**
   * Clear the deadline flag (used after a drain completes or for testing).
   */
  clearDeadlineReached(): void {
    this.deadlineReached = false;
  }

  /**
   * Mark a page as currently Committing. This is used to track the in-progress
   * commit for deadline drain semantics.
   */
  markCommitting(page: ExternalEvidencePage): void {
    this.committingPage = page;
  }

  /**
   * Settle the currently Committing page by running it through the commit
   * function. This is allowed even after the deadline is reached, because
   * only the single in-progress commit may drain.
   *
   * @param knownProviders The full set of known providers for round-robin
   *   marker advancement.
   */
  settleCommitting(knownProviders?: readonly string[]): ExternalAdmissionCommitResult {
    const page = this.committingPage;
    if (!page) {
      return {
        admittedEpisodes: 0,
        contradictionSignals: 0,
        acknowledged: false,
        error: new Error('no page is currently committing'),
      };
    }
    try {
      const result = this.commitFn(page);
      if (result.acknowledged) {
        this.finalizeAcknowledgedPage(page, knownProviders);
      }
      return result;
    } finally {
      this.committingPage = null;
    }
  }

  // -------------------------------------------------------------------------
  // State persistence
  // -------------------------------------------------------------------------

  /**
   * Persist the current state (nextProvider marker and provider turns) to
   * disk so it survives across wakes, quota exhaustion, and restarts.
   */
  saveState(): void {
    const dir = path.dirname(this.stateFilePath);
    const payload: ExternalAdmissionCoordinatorState = this.state;
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, this.stateFilePath);
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Stale temp files are safe; the original write succeeded or failed.
      }
    }
  }

  /**
   * Load durable state from disk. Corrupt or missing state defaults to empty.
   */
  private loadState(): ExternalAdmissionCoordinatorState {
    try {
      if (!fs.existsSync(this.stateFilePath)) return emptyState();
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      return validateState(JSON.parse(raw));
    } catch {
      // Corrupt state file — fail closed with empty state
      return emptyState();
    }
  }

  // -------------------------------------------------------------------------
  // Test accessors (public seam for deterministic tests)
  // -------------------------------------------------------------------------

  /**
   * Replace the coordinator's in-memory state. Used only by tests to set up
   * specific round-robin or alternation scenarios.
   */
  setStateForTesting(state: ExternalAdmissionCoordinatorState): void {
    this.state = validateState(state);
  }

  /**
   * Read the current in-memory state. Used by tests to verify durable
   * marker and turn state.
   */
  getStateForTesting(): ExternalAdmissionCoordinatorState {
    return { ...this.state, providerTurns: { ...this.state.providerTurns } };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private finalizeAcknowledgedPage(
    page: ExternalEvidencePage,
    knownProviders?: readonly string[],
  ): void {
    this.updateProviderTurn(page.providerId, turn => ({
      lastLaneServed: page.lane,
      lastSourceServed: page.sourceId,
      backfillPending: page.lane === 'backfill' ? false : turn.backfillPending,
    }));
    this.advanceNextProvider(knownProviders ?? [page.providerId], page.providerId);
    this.saveState();
  }

  private updateProviderTurn(
    providerId: string,
    update: (turn: ProviderTurnState) => ProviderTurnState,
  ): void {
    const current: ProviderTurnState = this.state.providerTurns[providerId] ?? {
      lastLaneServed: null,
      lastSourceServed: null,
      backfillPending: false,
    };
    const next = update(current);
    this.state = {
      ...this.state,
      providerTurns: {
        ...this.state.providerTurns,
        [providerId]: next,
      },
    };
  }
}
