import { DistillationUnit } from './distillation-unit';
import {
  extractLearningEpisodes,
  HistoricalEpisodeTargetRef,
  LearningEpisodeStore,
  LearningEpisodeStoreState,
} from './learning-episode';

/**
 * Evidence Ingestion — the durable source-admission stage of Runtime Learning
 * (issues #48, #50).
 *
 * The ingestor owns exactly one caller-facing operation: admitting a newly
 * extracted source range as durable Learning Episodes and Contradiction Signals.
 * It derives episodes from a Distillation Unit, persists them through the
 * Learning Episode Store, and returns what was admitted. It performs NO Branch
 * Promotion Review and commits NO Capability Transition.
 *
 * Log Cursor acknowledgement is the caller's responsibility and must happen
 * only AFTER `ingest` returns: this is the property that decouples source
 * acknowledgement from capability review (issue #50 AC1/AC3). `ingest` throws
 * only on evidence-persistence failure so the caller can leave the Log Cursor
 * at the prior offset for retry (issue #50 AC2). Replay is idempotent because
 * `LearningEpisodeStore.applyExtraction` merges episodes by episode id and
 * contradiction signals by signal id (issue #50 AC5).
 *
 * See ADRs 0016, 0017, and 0021 for the boundary this module enforces.
 */

export interface EvidenceIngestionResult {
  /** Episode ids actually touched by this admission (new or materially updated). */
  readonly admittedEpisodeIds: readonly string[];
  /** Contradiction Signal ids applied by this admission. */
  readonly contradictionSignalIds: readonly string[];
  /** The durable store state after admission. */
  readonly state: LearningEpisodeStoreState;
}

export interface EvidenceIngestorOptions {
  /** Durable Learning Episode store. The ingestor never constructs its own. */
  episodeStore: LearningEpisodeStore;
  /** Effective Settlement Window injected by runtime configuration. */
  settlementWindowMs?: number;
}

export class EvidenceIngestor {
  constructor(private readonly options: EvidenceIngestorOptions) {}

  /**
   * Admit one source range: derive Learning Episodes and Contradiction Signals,
   * durably persist them, and return the admission result. Throws on
   * evidence-persistence failure so the caller leaves the Log Cursor unchanged
   * for retry. Never performs review.
   */
  ingest(
    unit: DistillationUnit,
    options: { historicalTarget?: HistoricalEpisodeTargetRef } = {},
  ): EvidenceIngestionResult {
    const extraction = extractLearningEpisodes(unit, this.options.settlementWindowMs);

    // Pre-admission snapshot for touched-set detection
    const preState = this.options.episodeStore.load();
    const affectedIds = new Set<string>();

    // Episodes from the extraction
    for (const episode of extraction.episodes) {
      affectedIds.add(episode.episodeId);
    }

    // Episodes targeted by contradiction signals (pre-existing predecessors)
    for (const signal of extraction.contradictions) {
      const predecessor = Object.values(preState.episodes).find(episode =>
        episode.sourceFilePath === signal.precedingSourceFilePath
        && episode.runtimeSessionId === signal.runtimeSessionId
        && episode.deliveryTurn === signal.precedingDeliveryTurn,
      );
      if (predecessor) affectedIds.add(predecessor.episodeId);
    }

    // Snapshot affected episodes for diff
    const preSnapshots = new Map<string, string>();
    for (const id of affectedIds) {
      const episode = preState.episodes[id];
      if (episode) {
        preSnapshots.set(id, JSON.stringify(episode));
      }
    }

    // Durably persist episodes + contradiction signals. Throws on I/O failure.
    const state = this.options.episodeStore.applyExtraction(extraction, options);

    // Determine touched episodes: new or materially changed
    const touchedIds: string[] = [];
    for (const id of affectedIds) {
      const after = state.episodes[id];
      if (!after) continue;
      const before = preSnapshots.get(id);
      if (!before) {
        // New episode (didn't exist before)
        touchedIds.push(id);
      } else if (JSON.stringify(after) !== before) {
        // Materially changed
        touchedIds.push(id);
      }
    }

    return {
      admittedEpisodeIds: touchedIds,
      contradictionSignalIds: extraction.contradictions.map(signal => signal.signalId),
      state,
    };
  }
}
