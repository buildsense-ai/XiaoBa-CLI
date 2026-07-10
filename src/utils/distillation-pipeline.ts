import * as fs from 'fs';
import * as path from 'path';
import {
  CompletedTurn,
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
  loadNeedsReviewQueue,
  NeedsReviewQueueEntry,
  NeedsReviewQueueState,
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

  constructor(options: DistillationPipelineOptions) {
    this.distiller = options.distiller ?? DEFAULT_DISTILLER;
    this.reviewer = options.reviewer ?? DEFAULT_REVIEWER;
    this.outputDir = options.outputDir;
    this.reviewOutcomesPath = options.reviewOutcomesPath;
    this.needsReviewQueuePath = options.needsReviewQueuePath ?? null;
    this.capabilityRegistryPath = options.capabilityRegistryPath ?? null;
    this.reviewerVersion = options.reviewerVersion ?? PROMOTION_REVIEWER_VERSION;
    this.workLogRoot = options.workLogRoot ?? null;
    this.outcomes = loadReviewOutcomes(this.reviewOutcomesPath);
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

        switch (review.decision) {
          case 'promote': {
            // V1 promote path: install the immutable SKILL.md snapshot without
            // mutating the Capability Registry. This preserves existing V1 behavior.
            snapshot = installPromotedCandidate(candidate, review, this.outputDir);
            installations.push(snapshot);
            workLogger.write('install_result', {
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
            assertCanCreateCapability(capabilityRegistry, candidate.capabilityId);
            snapshot = installPromotedCandidate(candidate, review, this.outputDir);
            installations.push(snapshot);
            workLogger.write('install_result', {
              capability_id: candidate.capabilityId,
              snapshot_id: snapshot.snapshotId,
              skill_file_path: snapshot.filePath,
              newly_created: snapshot.newlyCreated,
              skill_name: snapshot.skillName,
            });
            if (this.capabilityRegistryPath) {
              newCapability(capabilityRegistry, buildNewCapabilityInput(candidate, snapshot, review));
              registryMutated = true;
              workLogger.write('registry_new_capability', {
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
              capabilityRegistry,
              buildAppendEvidenceInput(targetCapabilityId, candidate, review),
            );
            registryMutated = true;
            workLogger.write('registry_append_evidence', {
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
            const installCandidate: DistilledKnowledgeCandidate =
              targetCapabilityId === candidate.capabilityId
                ? candidate
                : { ...candidate, capabilityId: targetCapabilityId };
            const installReview: PromotionReviewResult =
              targetCapabilityId === candidate.capabilityId
                ? review
                : { ...review, capabilityId: targetCapabilityId };
            assertCanSupersedeSnapshot(
              capabilityRegistry,
              targetCapabilityId,
              installCandidate,
              installReview,
            );
            snapshot = installPromotedCandidate(installCandidate, installReview, this.outputDir);
            installations.push(snapshot);
            workLogger.write('install_result', {
              capability_id: candidate.capabilityId,
              target_capability_id: targetCapabilityId,
              snapshot_id: snapshot.snapshotId,
              skill_file_path: snapshot.filePath,
              newly_created: snapshot.newlyCreated,
              skill_name: snapshot.skillName,
            });
            if (this.capabilityRegistryPath) {
              supersedeSnapshot(
                capabilityRegistry,
                buildSupersedeSnapshotInput(targetCapabilityId, installCandidate, snapshot, installReview),
              );
              registryMutated = true;
              workLogger.write('registry_supersede_snapshot', {
                capability_id: candidate.capabilityId,
                target_capability_id: targetCapabilityId,
                new_active_snapshot_id: snapshot.snapshotId,
              });
            }
            break;
          }
          case 'needs_review': {
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
            break;
          }
          case 'reject': {
            // V1/V2 reject: write a durable review outcome only.
            break;
          }
          default: {
            // Exhaustiveness check for PromotionDecision. If a new decision is
            // added without a handler, TypeScript will flag the `never` branch.
            const _exhaustive: never = review.decision;
            throw new Error(
              `Unhandled promotion decision "${_exhaustive}" for capability ${candidate.capabilityId}.`,
            );
          }
        }

        if (registryMutated && this.capabilityRegistryPath) {
          saveCapabilityRegistry(this.capabilityRegistryPath, capabilityRegistry);
        }

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
        newOutcomes.push(outcome);
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
