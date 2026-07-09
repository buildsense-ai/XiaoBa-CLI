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
  PromotionDecision,
  PromotionPacket,
  PromotionReviewResult,
  reviewPromotionPacket,
} from './promotion-reviewer';
import {
  GENERATED_DISTILLED_DIR_NAME,
  installPromotedCandidate,
  InstalledSkillSnapshot,
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
  private readonly outcomes: ReviewOutcomeEntry[];

  constructor(options: DistillationPipelineOptions) {
    this.distiller = options.distiller ?? DEFAULT_DISTILLER;
    this.reviewer = options.reviewer ?? DEFAULT_REVIEWER;
    this.outputDir = options.outputDir;
    this.reviewOutcomesPath = options.reviewOutcomesPath;
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
    const candidates = this.distiller(unit);
    const reviews: PromotionReviewResult[] = [];
    const installations: InstalledSkillSnapshot[] = [];
    const newOutcomes: ReviewOutcomeEntry[] = [];

    for (const candidate of candidates) {
      const packet = buildPromotionPacket(candidate);
      const review = this.reviewer(packet);
      reviews.push(review);

      let snapshot: InstalledSkillSnapshot | null = null;
      if (review.decision === 'promote') {
        snapshot = installPromotedCandidate(candidate, review, this.outputDir);
        installations.push(snapshot);
      }

      const outcome: ReviewOutcomeEntry = {
        capabilityId: candidate.capabilityId,
        decision: review.decision,
        rationale: review.rationale,
        reviewedAt: review.reviewedAt,
        sourceUnit: candidate.sourceUnit,
      };
      if (snapshot) {
        outcome.snapshotId = snapshot.snapshotId;
        outcome.skillFilePath = snapshot.filePath;
      }
      newOutcomes.push(outcome);
    }

    const nextOutcomes = [...this.outcomes, ...newOutcomes];
    persistReviewOutcomes(this.reviewOutcomesPath, nextOutcomes);
    this.outcomes.push(...newOutcomes);

    return {
      candidates,
      reviews,
      installations,
      outcomes: newOutcomes,
    };
  }

  /** All durable review outcomes recorded so far (promote / needs_review / reject). */
  getReviewOutcomes(): ReviewOutcomeEntry[] {
    return [...this.outcomes];
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
