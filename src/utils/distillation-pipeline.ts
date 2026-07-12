import * as fs from 'fs';
import * as path from 'path';
import {
  CompletedTurn,
  DistillationTurn,
  DistillationUnit,
} from './distillation-unit';
import {
  DistilledKnowledgeCandidate,
  distillCapabilityCandidates,
} from './capability-distiller';
import {
  buildPromotionPacket,
  buildRegistryPromotionContext,
  PROMOTION_REVIEWER_VERSION,
  PromotionDecision,
  PromotionPacket,
  PromotionReviewResult,
  reviewPromotionPacket,
  BuildPromotionPacketOptions,
} from './promotion-reviewer';
import {
  appendEvidence,
  AppendEvidenceInput,
  CapabilityRegistryState,
  emptyCapabilityRegistryState,
  getCapability,
  loadCapabilityRegistry,
  makeEvidenceRef,
  newCapability,
  NewCapabilityInput,
  saveCapabilityRegistry,
  supersedeSnapshot,
  SupersedeSnapshotInput,
} from './capability-registry';
import { prefilterCapabilities } from './capability-prefilter';
import { computeDistilledSkillGuidanceFingerprint } from './distilled-skill-content';
import {
  addNeedsReviewEntry,
  computeRegistryStateFingerprint,
  findPendingEntryByCapabilityId,
  findPendingEntryForCandidate,
  listQueueEntries,
  loadNeedsReviewQueue,
  markResolved,
  NeedsReviewQueueEntry,
  NeedsReviewQueueState,
  reevaluateRetryEligibility,
  refreshQueueEntryWithMatchingEvidence,
  renewNeedsReviewEntry,
  saveNeedsReviewQueue,
} from './needs-review-queue';
import {
  GENERATED_DISTILLED_DIR_NAME,
  buildDistilledSkillDescription,
  computeSnapshotId,
  installPromotedCandidate,
  InstalledSkillSnapshot,
  resolveEffectiveFields,
} from './distilled-skill-installer';
import {
  LearningEpisode,
  LearningEpisodeStore,
  buildLearningEpisodeCandidate,
  extractLearningEpisodes,
} from './learning-episode';
import {
  BoundedSourceEvidence,
  EvidenceBundle,
  SkillEvolutionQueueReviewResult,
  SkillEvolutionResult,
  SkillEvolutionRuntime,
} from './skill-evolution';
import { SkillUsageCurator } from './skill-usage-curator';

/**
 * Distillation Pipeline (issue #6).
 *
 * The integration seam that wires the first-version `kind=capability` pipeline:
 * a Distillation Unit is distilled into capability candidates, each candidate
 * is packaged into a Promotion Packet, reviewed, and — when promoted —
 * installed as an immutable `SKILL.md` snapshot.
 *
 * The pipeline is the processor the Distillation Heartbeat drives. It owns
 * the runtime-visible state transitions (distill → review → install) while the
 * model-facing distiller and reviewer behavior stays injectable so tests can
 * control it via fixtures.
 *
 * Durable state:
 *  - Promoted candidates become immutable `SKILL.md` files.
 *  - Every review outcome (promote / needs_review / reject) is appended to a
 *    durable review-outcomes log so rejected and retryable/needs-review paths
 *    leave runtime-visible state too.
 *
 * First-version scope (Occam's razor):
 * - Only `kind=capability`. The schema leaves room for future knowledge kinds
 *   but this pipeline does not implement them.
 * - No merge, overwrite, supersede, update, or retirement. Each promote creates
 *   an immutable snapshot.
 * - The default distiller/reviewer are the deterministic implementations from
 *   issues #3/#4. Tests inject controlled fixtures to exercise state transitions
 *   without relying on prompt internals.
 *
 * See CONTEXT.md → "Distillation Heartbeat", "Capability Candidate",
 *   "Promotion Reviewer", "Auto-Installed Skill", "Traceability Contract".
 * See docs/issues/heartbeat-log-distillation/06-end-to-end-heartbeat-promotion.md
 */

// ---------------------------------------------------------------------------
// Public: injectable model-facing behavior
// ---------------------------------------------------------------------------

/**
 * Distiller function: receives one Distillation Unit and emits zero or more
 * structured capability candidates. The default implementation is the
 * deterministic heuristic distiller from issue #3. Tests inject controlled
 * fixtures to simulate model-facing distiller behavior.
 */
export type DistillerFn = (unit: DistillationUnit) => DistilledKnowledgeCandidate[];

/**
 * Reviewer function: receives a Promotion Packet and returns a structured
 * review decision. The default implementation is the deterministic reviewer
 * from issue #4. Tests inject controlled fixtures to simulate model-facing
 * reviewer behavior.
 */
export type ReviewerFn = (packet: PromotionPacket) => PromotionReviewResult;

export const DEFAULT_DISTILLER: DistillerFn = distillCapabilityCandidates;
export const DEFAULT_REVIEWER: ReviewerFn = reviewPromotionPacket;

// ---------------------------------------------------------------------------
// Public: durable review-outcome state
// ---------------------------------------------------------------------------

/**
 * One durable review-outcome entry. Promoted, rejected, and needs-review paths
 * all leave this record so the runtime can audit every promotion decision.
 */
export interface ReviewOutcomeEntry {
  /** Stable capability identity echoed from the candidate. */
  capabilityId: string;
  /** Final reviewer decision. */
  decision: PromotionDecision;
  /** Human-readable rationale for the decision. */
  rationale: string;
  /** ISO timestamp of the review. */
  reviewedAt: string;
  /** Snapshot id when promoted (absent otherwise). */
  snapshotId?: string;
  /** Installed SKILL.md path when promoted (absent otherwise). */
  skillFilePath?: string;
  /** V2 consolidation target capability id (absent when not registry-backed). */
  targetCapabilityId?: string;
  /** Distillation Unit source identity. */
  sourceUnit: {
    filePath: string;
    byteRange: { start: number; end: number };
  };
}

export interface ReviewOutcomeLog {
  schemaVersion: 1;
  outcomes: ReviewOutcomeEntry[];
}

// ---------------------------------------------------------------------------
// Public: pipeline run result (runtime-visible)
// ---------------------------------------------------------------------------

export interface PipelineUnitResult {
  /** Candidates distilled from this unit. */
  candidates: DistilledKnowledgeCandidate[];
  /** Review results keyed by capabilityId. */
  reviews: PromotionReviewResult[];
  /** Snapshots installed this run (promote only). */
  installations: InstalledSkillSnapshot[];
  /** Durable review-outcome entries written this run. */
  outcomes: ReviewOutcomeEntry[];
  /** Needs-review queue entries written this run. */
  needsReviewEntries: NeedsReviewQueueEntry[];
}

export interface V3PipelineUnitResult {
  candidates: DistilledKnowledgeCandidate[];
  evolutions: SkillEvolutionResult[];
  episodes?: LearningEpisode[];
}

/**
 * Result of re-reviewing eligible Needs Review Queue entries during a heartbeat
 * (issue #29).
 */
export interface QueueReviewResult {
  /** Queue entries that were re-reviewed this cycle (resolved + renewed). */
  reviewed: NeedsReviewQueueEntry[];
  /** Queue entries resolved by a non-`needs_review` decision. */
  resolved: NeedsReviewQueueEntry[];
  /** Queue entries renewed as `needs_review` and returned to pending. */
  renewed: NeedsReviewQueueEntry[];
  /** Snapshots installed this cycle (resolvable decisions only). */
  installations: InstalledSkillSnapshot[];
  /** Durable review-outcome entries written this cycle. */
  outcomes: ReviewOutcomeEntry[];
}

export interface QueueReviewResultV3 {
  reviewed: number;
  deferredReviewed: number;
  operationalReviewed: number;
  operationalRetried: number;
  deferredRetried: number;
}

function emptyQueueReviewResult(): QueueReviewResult {
  return { reviewed: [], resolved: [], renewed: [], installations: [], outcomes: [] };
}

export interface DistillationPipelineOptions {
  /**
   * Injectable distiller. Defaults to the deterministic heuristic distiller.
   * Tests pass controlled fixtures to simulate model-facing distiller behavior.
   */
  distiller?: DistillerFn;
  /**
   * Injectable reviewer. Defaults to the deterministic reviewer.
   * Tests pass controlled fixtures to simulate model-facing reviewer behavior.
   */
  reviewer?: ReviewerFn;
  /**
   * Root directory for generated distilled skills. Typically
   * `<skillsRoot>/generated-distilled`. Required.
   */
  outputDir: string;
  /**
   * Path to the durable review-outcomes log JSON file. Required. Every
   * review decision (promote / needs_review / reject) is appended here.
   */
  reviewOutcomesPath: string;
  /**
   * Optional path to the durable needs-review queue state file. When provided,
   * every `needs_review` decision is enqueued without mutating the Capability
   * Registry.
   */
  needsReviewQueuePath?: string;
  /**
   * Optional path to the Capability Registry current-state file. The pipeline
   * reads this file to compute matched capability IDs and registry-state
   * fingerprints for needs-review queue entries.
   */
  capabilityRegistryPath?: string;
  /**
   * Reviewer version used for needs-review retry gating. Defaults to the
   * deterministic reviewer version exported by promotion-reviewer.
   */
  reviewerVersion?: string;
  /**
   * Optional root for branch-style per-unit work logs. Runtime startup passes
   * `<runtime>/logs/branches/distillation`; tests may omit it to avoid writing
   * audit logs for pure unit tests.
   */
  workLogRoot?: string;
  /** Optional V3 Branch Promotion Reviewer / transition writer. */
  skillEvolution?: SkillEvolutionRuntime;
  /** Optional durable V3 Learning Episode store. */
  learningEpisodeStorePath?: string;
  /** Test/runtime hook for supplying applicable Referenced Skills to V3. */
  v3EvidenceBundleBuilder?: (
    unit: DistillationUnit,
    candidate: DistilledKnowledgeCandidate,
  ) => EvidenceBundle;
  /** Effective V3 Settlement Window injected by runtime configuration. */
  learningEpisodeSettlementWindowMs?: number;
  /** Optional V3 generated-skill usage outcome recorder. */
  skillUsageCurator?: SkillUsageCurator;
}

// ---------------------------------------------------------------------------
// DistillationPipeline
// ---------------------------------------------------------------------------

/**
 * Wires the first-version `kind=capability` pipeline and records durable state
 * for every review decision.
 *
 * One instance is reused across heartbeat cycles. The durable review-outcomes
 * log is loaded once on construction and appended to on each `processUnit`.
 */
export class DistillationPipeline {
  private readonly distiller: DistillerFn;
  private readonly reviewer: ReviewerFn;
  private readonly outputDir: string;
  private readonly reviewOutcomesPath: string;
  private readonly needsReviewQueuePath: string | null;
  private readonly capabilityRegistryPath: string | null;
  private readonly reviewerVersion: string;
  private readonly workLogRoot: string | null;
  private readonly outcomes: ReviewOutcomeEntry[];
  private readonly skillEvolution: SkillEvolutionRuntime | null;
  private readonly v3EvidenceBundleBuilder: DistillationPipelineOptions['v3EvidenceBundleBuilder'];
  private readonly learningEpisodeStore: LearningEpisodeStore | null;
  private readonly learningEpisodeSettlementWindowMs: number | undefined;
  private readonly skillUsageCurator: SkillUsageCurator | null;

  constructor(options: DistillationPipelineOptions) {
    this.distiller = options.distiller ?? DEFAULT_DISTILLER;
    this.reviewer = options.reviewer ?? DEFAULT_REVIEWER;
    this.outputDir = options.outputDir;
    this.reviewOutcomesPath = options.reviewOutcomesPath;
    this.needsReviewQueuePath = options.needsReviewQueuePath ?? null;
    this.capabilityRegistryPath = options.capabilityRegistryPath ?? null;
    this.reviewerVersion = options.reviewerVersion ?? PROMOTION_REVIEWER_VERSION;
    this.workLogRoot = options.workLogRoot ?? null;
    this.skillEvolution = options.skillEvolution ?? null;
    this.v3EvidenceBundleBuilder = options.v3EvidenceBundleBuilder;
    this.learningEpisodeStore = options.learningEpisodeStorePath
      ? new LearningEpisodeStore(options.learningEpisodeStorePath)
      : null;
    this.learningEpisodeSettlementWindowMs = options.learningEpisodeSettlementWindowMs;
    this.skillUsageCurator = options.skillUsageCurator ?? null;
    this.outcomes = loadReviewOutcomes(this.reviewOutcomesPath);
  }

  /**
   * Async runtime seam for V3. The legacy synchronous processor remains
   * unchanged; when a V3 runtime is supplied, heartbeat callers use this
   * method so the cursor waits for the isolated Author/Verifier commit.
   */
  async processUnitAsync(unit: DistillationUnit): Promise<PipelineUnitResult | V3PipelineUnitResult> {
    if (!this.skillEvolution) return this.processUnit(unit);
    if (this.learningEpisodeStore) {
      const extraction = extractLearningEpisodes(unit, this.learningEpisodeSettlementWindowMs);
      const extractedState = this.learningEpisodeStore.applyExtraction(extraction);
      for (const episode of Object.values(extractedState.episodes)) {
        this.skillUsageCurator?.observeEpisode(episode);
      }
      return this.processSettledLearningEpisodes(new Date(), unit);
    }

    // V3 without an Episode store is retained as an injectable compatibility
    // seam for isolated tests and migration callers. Runtime V3 always passes
    // the durable store, so candidate admission above is episode-backed.
    const candidates = this.distiller(unit);
    const reviewInputs: Array<{ candidate: DistilledKnowledgeCandidate; bundle: EvidenceBundle }> = [];
    for (const candidate of candidates) {
      const bundle = this.v3EvidenceBundleBuilder?.(unit, candidate)
        ?? buildV3EvidenceBundle(unit, candidate, this.skillEvolution);
      reviewInputs.push({ candidate, bundle });
    }

    const reviewerConcurrency = Math.max(
      1,
      Math.floor(this.skillEvolution.getEffectiveConfig().reviewerConcurrency),
    );
    const evolutions = await mapWithConcurrency(
      reviewInputs,
      reviewerConcurrency,
      input => this.skillEvolution!.reviewAndApply(input.bundle),
    );
    return { candidates, evolutions };
  }

  /**
   * Settle durable episodes and admit each newly settled episode into the V3
   * Author/Verifier seam. This method is also used by the scheduler's deadline
   * wake, so it must not depend on a newly appended session log.
   */
  async processSettledLearningEpisodes(
    now: Date = new Date(),
    unit?: DistillationUnit,
  ): Promise<V3PipelineUnitResult> {
    if (!this.skillEvolution || !this.learningEpisodeStore) {
      return { candidates: [], evolutions: [] };
    }

    const settledState = this.learningEpisodeStore.settle({ now });
    for (const episode of Object.values(settledState.episodes)) {
      this.skillUsageCurator?.observeEpisode(episode);
    }
    const episodes = Object.values(settledState.episodes);
    const reviewInputs: Array<{ candidate: DistilledKnowledgeCandidate; bundle: EvidenceBundle }> = [];
    for (const episode of episodes) {
      if (episode.status !== 'eligible' || this.hasReviewedLearningEpisode(episode)) continue;
      const candidate = buildLearningEpisodeCandidate(episode, unit);
      const bundle = this.v3EvidenceBundleBuilder?.(unit ?? emptyUnitForEpisode(episode), candidate)
        ?? buildLearningEpisodeEvidenceBundle(episode, candidate, this.skillEvolution);
      reviewInputs.push({ candidate, bundle });
    }

    const reviewerConcurrency = Math.max(
      1,
      Math.floor(this.skillEvolution.getEffectiveConfig().reviewerConcurrency),
    );
    const evolutions = await mapWithConcurrency(
      reviewInputs,
      reviewerConcurrency,
      input => this.skillEvolution!.reviewAndApply(input.bundle),
    );
    return { candidates: reviewInputs.map(input => input.candidate), evolutions, episodes };
  }

  private hasReviewedLearningEpisode(episode: LearningEpisode): boolean {
    const bundleId = learningEpisodeBundleId(episode);
    return this.skillEvolution!.getAudit().some(entry => entry.bundleId === bundleId)
      || this.skillEvolution!.getQueuedReviewKind(bundleId) !== undefined;
  }

  /**
   * Process one Distillation Unit through the full pipeline.
   *
   * Runtime-visible behavior:
   *  1. Distill capability candidates from the unit.
   *  2. Build a Promotion Packet for each candidate.
   *  3. Review each packet.
   *  4. Install promoted candidates as immutable SKILL.md snapshots.
   *  5. Append a durable review-outcome entry for every decision.
   */
  processUnit(unit: DistillationUnit): PipelineUnitResult {
    const workLogger = new DistillationWorkLogger(this.workLogRoot, unit);
    workLogger.write('start', {
      source_file_path: unit.filePath,
      byte_range: unit.byteRange,
      new_turns: unit.newTurns.map(turn => turn.turn),
      continuity_turn_count: unit.continuityTurns.length,
      generated_at: unit.generatedAt,
    });

    const reviews: PromotionReviewResult[] = [];
    const installations: InstalledSkillSnapshot[] = [];
    const newOutcomes: ReviewOutcomeEntry[] = [];
    const needsReviewEntries: NeedsReviewQueueEntry[] = [];
    let candidates: DistilledKnowledgeCandidate[] = [];
    const needsReviewQueue = this.needsReviewQueuePath
      ? loadNeedsReviewQueue(this.needsReviewQueuePath)
      : null;
    const capabilityRegistry = this.loadCurrentCapabilityRegistry();

    try {
      candidates = this.distiller(unit);
      workLogger.write('distiller_output', {
        candidate_count: candidates.length,
        candidates: candidates.map(summarizeCandidateForLog),
      });

      for (const candidate of candidates) {
        // A new occurrence can add material evidence to an already-pending
        // review. Detect that before performing an independent review of the
        // new candidate: the durable queue entry, not this occurrence, owns
        // the next consolidation decision. This also makes the matching-
        // evidence trigger independent of what a fresh reviewer would decide.
        const existing = needsReviewQueue
          ? findPendingEntryForCandidate(needsReviewQueue, candidate)
          : undefined;
        if (existing) {
          const previousEvidenceFingerprint = existing.evidenceFingerprint;
          const refreshed = refreshQueueEntryWithMatchingEvidence(
            needsReviewQueue!,
            existing.entryId,
            {
              newCandidate: candidate,
              reason: 'Newly distilled matching evidence refreshed the queued review material.',
              updatedAt: candidate.generatedAt,
            },
          );
          if (refreshed.evidenceFingerprint !== previousEvidenceFingerprint) {
            needsReviewEntries.push(refreshed);
            workLogger.write('needs_review_queue_refresh', {
              capability_id: candidate.capabilityId,
              entry_id: refreshed.entryId,
              evidence_fingerprint: refreshed.evidenceFingerprint,
            });
          } else {
            workLogger.write('needs_review_queue_duplicate_evidence', {
              capability_id: candidate.capabilityId,
              entry_id: refreshed.entryId,
            });
          }
          continue;
        }

        // A stable capability identity with no new provenance is a duplicate
        // occurrence, not a fresh review candidate. `findPendingEntryForCandidate`
        // intentionally returns no refresh target in this case so the queue
        // remains evidence-gated; skip it rather than creating another review
        // outcome for the same source evidence.
        const duplicate = needsReviewQueue
          ? findPendingEntryByCapabilityId(needsReviewQueue, candidate.capabilityId)
          : undefined;
        if (duplicate) {
          workLogger.write('needs_review_queue_duplicate_evidence', {
            capability_id: candidate.capabilityId,
            entry_id: duplicate.entryId,
          });
          continue;
        }

        const packetOptions: BuildPromotionPacketOptions = {};
        if (this.capabilityRegistryPath) {
          packetOptions.registryContext = buildRegistryPromotionContext(
            candidate,
            capabilityRegistry,
            this.outputDir,
          );
        }
        const packet = buildPromotionPacket(candidate, packetOptions);
        workLogger.write('promotion_packet', {
          capability_id: candidate.capabilityId,
          recommendation: packet.recommendation,
          provenance_ref_count: packet.provenance.length,
          reviewer_risks: packet.reviewRisks,
          solved_loop: packet.solvedLoopEvidence,
        });

        const review = this.reviewer(packet);
        reviews.push(review);
        workLogger.write('review_result', {
          capability_id: candidate.capabilityId,
          decision: review.decision,
          rationale: review.rationale,
          review_risks: review.reviewRisks,
          rewrite: review.rewrite,
          reviewed_at: review.reviewedAt,
        });

        let snapshot: InstalledSkillSnapshot | null = null;
        let registryMutated = false;

        if (review.decision === 'needs_review') {
          requireStatePath(this.needsReviewQueuePath, review.decision, 'Needs Review Queue');
          const queue = needsReviewQueue!;
          const prefilterResult = prefilterCapabilities(candidate, capabilityRegistry);
          const entry = addNeedsReviewEntry(queue, {
            packet,
            review,
            matchedCapabilityIds: prefilterResult.matches.map(match => match.capabilityId),
            registry: capabilityRegistry,
            reviewerVersion: this.reviewerVersion,
            createdAt: review.reviewedAt,
          });
          needsReviewEntries.push(entry);
          workLogger.write('needs_review_queue_entry', {
            capability_id: candidate.capabilityId,
            entry_id: entry.entryId,
            matched_capability_ids: entry.matchedCapabilityIds,
            evidence_fingerprint: entry.evidenceFingerprint,
            registry_state_fingerprint: entry.registryStateFingerprint,
            reviewer_version: entry.reviewerVersion,
          });
        } else {
          const applied = this.applyResolvableDecision(
            candidate,
            review,
            capabilityRegistry,
            installations,
            workLogger,
          );
          snapshot = applied.snapshot;
          registryMutated = applied.registryMutated;
        }

        if (registryMutated && this.capabilityRegistryPath) {
          saveCapabilityRegistry(this.capabilityRegistryPath, capabilityRegistry);
        }

        newOutcomes.push(buildReviewOutcome(candidate, review, snapshot));
      }

      const nextOutcomes = [...this.outcomes, ...newOutcomes];
      if (needsReviewQueue && this.needsReviewQueuePath) {
        saveNeedsReviewQueue(this.needsReviewQueuePath, needsReviewQueue);
      }
      persistReviewOutcomes(this.reviewOutcomesPath, nextOutcomes);
      this.outcomes.push(...newOutcomes);

      workLogger.write('run_result', {
        candidate_count: candidates.length,
        review_counts: countReviewDecisions(reviews),
        installation_count: installations.length,
        outcome_count: newOutcomes.length,
        needs_review_queue_entry_count: needsReviewEntries.length,
      });

      return {
        candidates,
        reviews,
        installations,
        outcomes: newOutcomes,
        needsReviewEntries,
      };
    } catch (error: any) {
      workLogger.write('failed', {
        message: String(error?.message || error || 'unknown error'),
        name: error?.name,
        candidate_count: candidates.length,
        review_count: reviews.length,
        installation_count: installations.length,
        needs_review_queue_entry_count: needsReviewEntries.length,
      });
      throw error;
    } finally {
      workLogger.write('transcript', {
        unit: {
          source_file_path: unit.filePath,
          byte_range: unit.byteRange,
          new_turns: unit.newTurns.map(turn => turn.turn),
          continuity_turn_count: unit.continuityTurns.length,
          generated_at: unit.generatedAt,
        },
        candidates: candidates.map(summarizeCandidateForLog),
        reviews,
        installations,
        outcomes: newOutcomes,
        needs_review_entries: needsReviewEntries,
      });
    }
  }

  /** All durable review outcomes recorded so far (promote / needs_review / reject). */
  getReviewOutcomes(): ReviewOutcomeEntry[] {
    return [...this.outcomes];
  }

  /**
   * Re-review eligible Needs Review Queue entries during a heartbeat (issue #29).
   *
   * Loads the durable queue and the current Capability Registry, re-evaluates
   * each pending/retry-eligible entry's retry eligibility against the current
   * reviewer version and the per-entry relevant registry-state fingerprint,
   * and consumes every eligible entry through the same consolidation reviewer
   * used for new candidates.
   *
   * A non-`needs_review` decision applies its normal Registry / snapshot /
   * outcome transition and resolves the queue entry. A renewed `needs_review`
   * decision updates the rationale/questions, pins the stored reviewer version
   * and registry-state fingerprint to the current values, and returns the entry
   * to `pending` so it is not retried again until another meaningful change.
   *
   * Returns an empty result when no needs-review queue path is configured.
   */
  reviewEligibleQueueEntries(): QueueReviewResult {
    if (!this.needsReviewQueuePath) return emptyQueueReviewResult();

    const queue = loadNeedsReviewQueue(this.needsReviewQueuePath);
    const registry = this.loadCurrentCapabilityRegistry();
    const now = new Date().toISOString();

    const reviewed: NeedsReviewQueueEntry[] = [];
    const resolved: NeedsReviewQueueEntry[] = [];
    const renewed: NeedsReviewQueueEntry[] = [];
    const installations: InstalledSkillSnapshot[] = [];
    const newOutcomes: ReviewOutcomeEntry[] = [];

    // Re-evaluate eligibility for pending entries only. An entry already
    // marked `retry_eligible` with `eligible: true` (via an explicit runtime
    // command or matching-evidence refresh) is consumed directly below without
    // being reset by fingerprint re-evaluation. This preserves the explicit
    // retry trigger as an independent eligibility gate.
    for (const entryId of Object.keys(queue.entries)) {
      const entry = queue.entries[entryId];
      if (!entry || entry.status !== 'pending') continue;

      entry.matchedCapabilityIds = prefilterCapabilities(
        entry.candidatePayload,
        registry,
      ).matches.map(match => match.capabilityId);

      const currentRegistryFingerprint = computeRegistryStateFingerprint(
        registry,
        entry.matchedCapabilityIds,
      );
      reevaluateRetryEligibility(queue, entryId, {
        // The evidence fingerprint is unchanged here; the matching-evidence
        // trigger is applied at distillation time via
        // `refreshQueueEntryWithMatchingEvidence`.
        evidenceFingerprint: entry.evidenceFingerprint,
        registryStateFingerprint: currentRegistryFingerprint,
        reviewerVersion: this.reviewerVersion,
        checkedAt: now,
      });
    }

    // Consume every eligible entry through the consolidation reviewer. Snapshot
    // the eligible list before re-reviewing so mutations during the loop do not
    // change which entries are processed this cycle.
    const eligible = listQueueEntries(queue).filter(
      e => e.status === 'retry_eligible' && e.retryEligibility.eligible,
    );

    for (const entry of eligible) {
      const candidate = entry.candidatePayload;
      const packetOptions: BuildPromotionPacketOptions = {};
      if (this.capabilityRegistryPath) {
        packetOptions.registryContext = buildRegistryPromotionContext(
          candidate,
          registry,
          this.outputDir,
        );
      }
      const packet = buildPromotionPacket(candidate, packetOptions);
      const review = this.reviewer(packet);
      reviewed.push(entry);

      let snapshot: InstalledSkillSnapshot | null = null;
      let registryMutated = false;

      if (review.decision === 'needs_review') {
        const currentRegistryFingerprint = computeRegistryStateFingerprint(
          registry,
          entry.matchedCapabilityIds,
        );
        const renewedEntry = renewNeedsReviewEntry(queue, entry.entryId, {
          review,
          reviewerVersion: this.reviewerVersion,
          registryStateFingerprint: currentRegistryFingerprint,
          updatedAt: review.reviewedAt,
        });
        renewed.push(renewedEntry);
      } else {
        const applied = this.applyResolvableDecision(
          candidate,
          review,
          registry,
          installations,
          null,
        );
        snapshot = applied.snapshot;
        registryMutated = applied.registryMutated;
        const resolvedEntry = markResolved(queue, entry.entryId, review.reviewedAt);
        resolved.push(resolvedEntry);
      }

      if (registryMutated && this.capabilityRegistryPath) {
        saveCapabilityRegistry(this.capabilityRegistryPath, registry);
      }

      newOutcomes.push(buildReviewOutcome(candidate, review, snapshot));
    }

    if (this.needsReviewQueuePath) {
      saveNeedsReviewQueue(this.needsReviewQueuePath, queue);
    }
    if (newOutcomes.length > 0) {
      const nextOutcomes = [...this.outcomes, ...newOutcomes];
      persistReviewOutcomes(this.reviewOutcomesPath, nextOutcomes);
      this.outcomes.push(...newOutcomes);
    }

    return { reviewed, resolved, renewed, installations, outcomes: newOutcomes };
  }

  /**
   * Re-review due V3 semantic defers and operational failure queue entries.
   *
   * This runs after the heartbeat's distillation pass so newly refreshed
   * registries and version settings can promote or refresh queued candidates.
   */
  async reviewSkillEvolutionQueueEntries(): Promise<QueueReviewResultV3> {
    if (!this.skillEvolution) {
      return {
        reviewed: 0,
        deferredReviewed: 0,
        operationalReviewed: 0,
        operationalRetried: 0,
        deferredRetried: 0,
      };
    }
    return this.skillEvolution.reviewDueQueueEntries();
  }

  /**
   * Apply a resolvable (non-`needs_review`) review decision to the Capability
   * Registry and installed-skill store. Shared by the new-candidate path
   * (`processUnit`) and the queue re-review path (`reviewEligibleQueueEntries`).
   *
   * Handles `promote`, `new_capability`, `append_evidence`, `supersede_snapshot`,
   * and `reject`. Throws for `needs_review` (the caller owns enqueue/renew).
   */
  private applyResolvableDecision(
    candidate: DistilledKnowledgeCandidate,
    review: PromotionReviewResult,
    registry: CapabilityRegistryState,
    installations: InstalledSkillSnapshot[],
    workLogger: DistillationWorkLogger | null,
  ): { snapshot: InstalledSkillSnapshot | null; registryMutated: boolean } {
    let snapshot: InstalledSkillSnapshot | null = null;
    let registryMutated = false;

    switch (review.decision) {
      case 'promote': {
        // V1 promote path: install the immutable SKILL.md snapshot without
        // mutating the Capability Registry. This preserves existing V1 behavior.
        snapshot = installPromotedCandidate(candidate, review, this.outputDir);
        installations.push(snapshot);
        workLogger?.write('install_result', {
          capability_id: candidate.capabilityId,
          snapshot_id: snapshot.snapshotId,
          skill_file_path: snapshot.filePath,
          newly_created: snapshot.newlyCreated,
          skill_name: snapshot.skillName,
        });
        break;
      }
      case 'new_capability': {
        // V2 new capability: install the initial Active Snapshot and create
        // a registry entry that points to it.
        requireStatePath(this.capabilityRegistryPath, review.decision, 'Capability Registry');
        assertCanCreateCapability(registry, candidate.capabilityId);
        snapshot = installPromotedCandidate(candidate, review, this.outputDir);
        installations.push(snapshot);
        workLogger?.write('install_result', {
          capability_id: candidate.capabilityId,
          snapshot_id: snapshot.snapshotId,
          skill_file_path: snapshot.filePath,
          newly_created: snapshot.newlyCreated,
          skill_name: snapshot.skillName,
        });
        if (this.capabilityRegistryPath) {
          newCapability(registry, buildNewCapabilityInput(candidate, snapshot, review));
          registryMutated = true;
          workLogger?.write('registry_new_capability', {
            capability_id: candidate.capabilityId,
            active_snapshot_id: snapshot.snapshotId,
          });
        }
        break;
      }
      case 'append_evidence': {
        // V2 evidence append: update registry evidence refs without
        // changing the Active Snapshot or installing a new skill-list entry.
        requireStatePath(this.capabilityRegistryPath, review.decision, 'Capability Registry');
        const targetCapabilityId = review.targetCapabilityId ?? candidate.capabilityId;
        appendEvidence(
          registry,
          buildAppendEvidenceInput(targetCapabilityId, candidate, review),
        );
        registryMutated = true;
        workLogger?.write('registry_append_evidence', {
          capability_id: candidate.capabilityId,
          target_capability_id: targetCapabilityId,
        });
        break;
      }
      case 'supersede_snapshot': {
        // V2 supersede: install the new Active Snapshot and update the
        // registry to select it, preserving the prior active snapshot.
        requireStatePath(this.capabilityRegistryPath, review.decision, 'Capability Registry');
        const targetCapabilityId = review.targetCapabilityId ?? candidate.capabilityId;
        // Install the new immutable snapshot under the registry capability
        // identity so the Active Snapshot path is stable across supersede
        // transitions even when the candidate's per-occurrence capabilityId
        // differs from the matched registry entry. The install review must
        // carry the same target identity so the installer's capabilityId
        // assertion holds and the snapshot id is computed consistently.
        const installCandidate: DistilledKnowledgeCandidate =
          targetCapabilityId === candidate.capabilityId
            ? candidate
            : { ...candidate, capabilityId: targetCapabilityId };
        const installReview: PromotionReviewResult =
          targetCapabilityId === candidate.capabilityId
            ? review
            : { ...review, capabilityId: targetCapabilityId };
        assertCanSupersedeSnapshot(
          registry,
          targetCapabilityId,
          installCandidate,
          installReview,
        );
        snapshot = installPromotedCandidate(installCandidate, installReview, this.outputDir);
        installations.push(snapshot);
        workLogger?.write('install_result', {
          capability_id: candidate.capabilityId,
          target_capability_id: targetCapabilityId,
          snapshot_id: snapshot.snapshotId,
          skill_file_path: snapshot.filePath,
          newly_created: snapshot.newlyCreated,
          skill_name: snapshot.skillName,
        });
        if (this.capabilityRegistryPath) {
          supersedeSnapshot(
            registry,
            buildSupersedeSnapshotInput(targetCapabilityId, installCandidate, snapshot, installReview),
          );
          registryMutated = true;
          workLogger?.write('registry_supersede_snapshot', {
            capability_id: candidate.capabilityId,
            target_capability_id: targetCapabilityId,
            new_active_snapshot_id: snapshot.snapshotId,
          });
        }
        break;
      }
      case 'reject': {
        // V1/V2 reject: write a durable review outcome only.
        break;
      }
      case 'needs_review': {
        throw new Error(
          `applyResolvableDecision does not handle "needs_review"; the caller must enqueue or renew.`,
        );
      }
      default: {
        // Exhaustiveness check for PromotionDecision.
        const _exhaustive: never = review.decision;
        throw new Error(
          `Unhandled promotion decision "${_exhaustive}" for capability ${candidate.capabilityId}.`,
        );
      }
    }

    return { snapshot, registryMutated };
  }

  private loadCurrentCapabilityRegistry(): CapabilityRegistryState {
    if (!this.capabilityRegistryPath) {
      return emptyCapabilityRegistryState();
    }
    return loadCapabilityRegistry(this.capabilityRegistryPath);
  }
}

// ---------------------------------------------------------------------------
// Durable review-outcomes log helpers
// ---------------------------------------------------------------------------

/**
 * Load durable review-outcome entries from disk. Public so tests and the
 * runtime can audit review outcomes without instantiating a pipeline.
 */
export function loadReviewOutcomesSync(reviewOutcomesPath: string): ReviewOutcomeEntry[] {
  return loadReviewOutcomes(reviewOutcomesPath);
}

function loadReviewOutcomes(reviewOutcomesPath: string): ReviewOutcomeEntry[] {
  if (!fs.existsSync(reviewOutcomesPath)) return [];
  const parsed = JSON.parse(
    fs.readFileSync(reviewOutcomesPath, 'utf-8'),
  ) as Partial<ReviewOutcomeLog>;
  if (!Array.isArray(parsed.outcomes)) {
    throw new Error(`Review outcomes log is malformed: ${reviewOutcomesPath}`);
  }
  return parsed.outcomes;
}

/**
 * Build a durable review-outcome entry from a candidate, review result, and
 * optional installed snapshot. Shared by the new-candidate and queue re-review
 * paths so every decision records the same outcome shape.
 */
function buildReviewOutcome(
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
  snapshot: InstalledSkillSnapshot | null,
): ReviewOutcomeEntry {
  const outcome: ReviewOutcomeEntry = {
    capabilityId: candidate.capabilityId,
    decision: review.decision,
    rationale: review.rationale,
    reviewedAt: review.reviewedAt,
    sourceUnit: candidate.sourceUnit,
  };
  if (review.targetCapabilityId) {
    outcome.targetCapabilityId = review.targetCapabilityId;
  }
  if (snapshot) {
    outcome.snapshotId = snapshot.snapshotId;
    outcome.skillFilePath = snapshot.filePath;
  }
  return outcome;
}

function persistReviewOutcomes(
  reviewOutcomesPath: string,
  outcomes: ReviewOutcomeEntry[],
): void {
  fs.mkdirSync(path.dirname(reviewOutcomesPath), { recursive: true });
  const payload: ReviewOutcomeLog = { schemaVersion: 1, outcomes };
  const tmpPath = `${reviewOutcomesPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmpPath, reviewOutcomesPath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only; preserve the original error.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Convenience: default output directory under a skills root
// ---------------------------------------------------------------------------

/**
 * Resolve the default generated-distilled output directory under a skills root.
 */
export function defaultDistilledOutputDir(skillsRoot: string): string {
  return path.join(skillsRoot, GENERATED_DISTILLED_DIR_NAME);
}

/** Build the fixed V3 bundle for a settled episode without a new log unit. */
export function buildLearningEpisodeEvidenceBundle(
  episode: LearningEpisode,
  candidate: DistilledKnowledgeCandidate,
  skillEvolution: SkillEvolutionRuntime,
): EvidenceBundle {
  const completionEvidence = episode.completionEvidence
    .filter(evidence => evidence.kind !== 'contradiction')
    .map(evidence => ({
      ref: evidence.ref,
      sourceFilePath: evidence.sourceFilePath,
      turn: evidence.turn,
    }));
  const settlementEvidence = [{
    ref: `${episode.sourceFilePath}#episode-${episode.episodeId}:settled-${episode.settlementDeadline}`,
    sourceFilePath: episode.sourceFilePath,
    turn: episode.deliveryTurn,
  }];
  return {
    bundleId: learningEpisodeBundleId(episode),
    episode: candidate,
    completionEvidence,
    settlementEvidence,
    boundedContinuity: [],
    referencedSkills: skillEvolution.getReferencedSkillSnapshots(),
    relatedCurrentSkills: Object.values(skillEvolution.getRegistry().capabilities).map(record => ({
      handle: record.handle,
      revision: record.revision,
      routingName: record.routingName,
      description: record.description,
      guidanceHash: record.guidanceHash,
    })),
  };
}

export function buildV3EvidenceBundle(
  unit: DistillationUnit,
  candidate: DistilledKnowledgeCandidate,
  skillEvolution: SkillEvolutionRuntime,
): EvidenceBundle {
  const turns = [...unit.continuityTurns, ...unit.newTurns];
  const sourceEvidence: BoundedSourceEvidence[] = candidate.provenance.flatMap(ref => {
    const sourceTurn = turns.find(turn =>
      turn.turn === ref.turn
      && turnSourceFilePath(turn, unit.filePath) === ref.filePath,
    );
    if (!sourceTurn) return [];
    return [{
      ref: `${ref.filePath}#${ref.turn}:${ref.role}:${ref.unitByteRange.start}-${ref.unitByteRange.end}`,
      sourceFilePath: ref.filePath,
      turn: ref.turn,
      byteRange: ref.unitByteRange,
      role: ref.role,
      content: JSON.stringify(sourceTurn),
    }];
  });
  const completionEvidence = sourceEvidence.filter(ref => ref.role === 'problem-action');
  const settlementEvidence = sourceEvidence.filter(ref => ref.role === 'verification');
  return {
    bundleId: `v3:${unit.filePath}:${unit.byteRange.start}:${unit.byteRange.end}:${candidate.capabilityId}`,
    episode: candidate,
    completionEvidence,
    settlementEvidence,
    boundedContinuity: unit.continuityTurns,
    referencedSkills: skillEvolution.getReferencedSkillSnapshots(),
    relatedCurrentSkills: Object.values(skillEvolution.getRegistry().capabilities).map(record => ({
      handle: record.handle,
      revision: record.revision,
      routingName: record.routingName,
      description: record.description,
      guidanceHash: record.guidanceHash,
    })),
    sourceEvidence,
  };
}

function learningEpisodeBundleId(episode: LearningEpisode): string {
  return `v3:learning-episode:${episode.episodeId}`;
}

function emptyUnitForEpisode(episode: LearningEpisode): DistillationUnit {
  return {
    filePath: episode.sourceFilePath,
    newTurns: [],
    continuityTurns: [],
    byteRange: { start: 0, end: 0 },
    generatedAt: episode.settlementDeadline,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }));

  return results;
}

function turnSourceFilePath(turn: CompletedTurn, fallback: string): string {
  const origin = (turn as DistillationTurn).origin?.filePath;
  return typeof origin === 'string' && origin.trim() ? origin : fallback;
}

// ---------------------------------------------------------------------------
// Branch-style distillation work logging
// ---------------------------------------------------------------------------

class DistillationWorkLogger {
  private readonly filePath: string | null;
  private readonly branchId: string;

  constructor(workLogRoot: string | null, unit: DistillationUnit) {
    this.branchId = buildDistillationBranchId(unit);
    if (!workLogRoot) {
      this.filePath = null;
      return;
    }

    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const dir = path.join(workLogRoot, dateStr);
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `${this.branchId}.jsonl`);
  }

  write(eventType: string, payload: Record<string, unknown> = {}): void {
    if (!this.filePath) return;
    const entry = {
      entry_type: 'branch',
      branch_type: 'distillation',
      branch_id: this.branchId,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    } catch {
      // Work logs are audit-only. Never fail the distillation pipeline because
      // branch-style logging could not be written.
    }
  }
}

function buildDistillationBranchId(unit: DistillationUnit): string {
  const raw = `${unit.filePath}:${unit.byteRange.start}:${unit.byteRange.end}:${unit.generatedAt}`;
  const hash = Buffer.from(raw).toString('base64url').slice(0, 18);
  return `distillation-${Date.now().toString(36)}-${hash}`;
}

function summarizeCandidateForLog(candidate: DistilledKnowledgeCandidate): Record<string, unknown> {
  return {
    kind: candidate.kind,
    capability_id: candidate.capabilityId,
    title: candidate.title,
    applicability: candidate.applicability,
    action_pattern: candidate.actionPattern,
    boundaries: candidate.boundaries,
    risks: candidate.risks,
    solved_loop: candidate.solvedLoop,
    provenance: candidate.provenance,
    source_unit: candidate.sourceUnit,
    generated_at: candidate.generatedAt,
  };
}

function countReviewDecisions(reviews: PromotionReviewResult[]): Record<PromotionDecision, number> {
  return reviews.reduce<Record<PromotionDecision, number>>((counts, review) => {
    counts[review.decision] += 1;
    return counts;
  }, {
    promote: 0,
    needs_review: 0,
    reject: 0,
    new_capability: 0,
    append_evidence: 0,
    supersede_snapshot: 0,
  });
}

// ---------------------------------------------------------------------------
// V2 Capability Registry transition helpers
// ---------------------------------------------------------------------------

function assertCanCreateCapability(
  registry: CapabilityRegistryState,
  capabilityId: string,
): void {
  if (getCapability(registry, capabilityId)) {
    throw new Error(
      `Cannot create capability "${capabilityId}": a registry entry with this capabilityId already exists.`,
    );
  }
}

function assertCanSupersedeSnapshot(
  registry: CapabilityRegistryState,
  targetCapabilityId: string,
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
): void {
  const entry = getCapability(registry, targetCapabilityId);
  if (!entry) {
    throw new Error(
      `Cannot supersede snapshot for capability "${targetCapabilityId}": no such registry entry.`,
    );
  }

  const effective = resolveEffectiveFields(candidate, review.rewrite);
  const newActiveSnapshotId = computeSnapshotId(candidate, effective, review);
  if (newActiveSnapshotId === entry.activeSnapshotId) {
    throw new Error(
      `Cannot supersede snapshot for capability "${targetCapabilityId}": newActiveSnapshotId is already the active snapshot.`,
    );
  }
}

function buildNewCapabilityInput(
  candidate: DistilledKnowledgeCandidate,
  snapshot: InstalledSkillSnapshot,
  review: PromotionReviewResult,
): NewCapabilityInput {
  return {
    capabilityId: candidate.capabilityId,
    activeSnapshotId: snapshot.snapshotId,
    routingDescription: buildRoutingDescription(candidate, review),
    guidanceFingerprint: buildGuidanceFingerprint(candidate, review),
    evidenceRefs: candidate.provenance.map(ref =>
      makeEvidenceRef(ref.filePath, ref.turn, ref.unitByteRange, review.reviewedAt),
    ),
    relatedSnapshotIds: [snapshot.snapshotId],
    createdAt: review.reviewedAt,
    sourceReview: {
      decision: review.decision,
      reviewedAt: review.reviewedAt,
      sourceUnit: candidate.sourceUnit,
    },
  };
}

function buildAppendEvidenceInput(
  targetCapabilityId: string,
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
): AppendEvidenceInput {
  return {
    capabilityId: targetCapabilityId,
    evidenceRefs: candidate.provenance.map(ref =>
      makeEvidenceRef(ref.filePath, ref.turn, ref.unitByteRange, review.reviewedAt),
    ),
    appendedAt: review.reviewedAt,
  };
}

function buildSupersedeSnapshotInput(
  targetCapabilityId: string,
  candidate: DistilledKnowledgeCandidate,
  snapshot: InstalledSkillSnapshot,
  review: PromotionReviewResult,
): SupersedeSnapshotInput {
  return {
    capabilityId: targetCapabilityId,
    newActiveSnapshotId: snapshot.snapshotId,
    supersededAt: review.reviewedAt,
    routingDescription: buildRoutingDescription(candidate, review),
    guidanceFingerprint: buildGuidanceFingerprint(candidate, review),
  };
}

/**
 * Build a concise routable When/Do summary for the Capability Registry entry.
 *
 * The routing description should match the active skill's description so the
 * prefilter and skill selection use consistent language. We derive it from the
 * candidate title and the core action pattern.
 */
function buildRoutingDescription(
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
): string {
  return buildDistilledSkillDescription(
    resolveEffectiveFields(candidate, review.rewrite),
  );
}

function buildGuidanceFingerprint(
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
): string {
  return computeDistilledSkillGuidanceFingerprint(
    resolveEffectiveFields(candidate, review.rewrite),
  );
}

function requireStatePath(
  statePath: string | null,
  decision: PromotionDecision,
  stateName: string,
): asserts statePath is string {
  if (!statePath) {
    throw new Error(`${decision} requires a configured ${stateName} path.`);
  }
}
