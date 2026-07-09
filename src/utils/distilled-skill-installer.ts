import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  CapabilityProvenanceRef,
  DistilledKnowledgeCandidate,
} from './capability-distiller';
import {
  FaithfulRewrite,
  PromotionDecision,
  PromotionReviewResult,
} from './promotion-reviewer';

/**
 * Distilled Skill Installer (issue #5).
 *
 * A deterministic installer that renders promoted capability candidates into
 * immutable single-file `SKILL.md` snapshots under `skills/generated-distilled/`.
 *
 * The installer owns Markdown rendering. It does **not** call a model, does
 * **not** merge/update/supersede/retire prior snapshots, and does **not** embed
 * raw logs in the skill body. Each install creates an immutable snapshot with
 * a stable `capability_id` and an immutable `snapshot_id`.
 *
 * Generated skills stay compatible with the current skill discovery/loading
 * path: the frontmatter carries the `name` and `description` fields expected by
 * `SkillParser`, and the file is placed in a `<dir>/SKILL.md` layout that
 * `PathResolver.findSkillFiles` discovers recursively.
 *
 * See docs/issues/heartbeat-log-distillation/05-install-traceable-distilled-skills.md
 * See docs/prd/runtime-heartbeat-log-distillation.md
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of installing a promoted candidate as an immutable skill snapshot.
 */
export interface InstalledSkillSnapshot {
  /** Stable capability identity echoed from the candidate. */
  capabilityId: string;
  /** Immutable snapshot identity derived from the installed content. */
  snapshotId: string;
  /** Absolute path to the generated `SKILL.md` file. */
  filePath: string;
  /** Directory containing the generated `SKILL.md`. */
  directory: string;
  /** `true` when a new file was written; `false` when the snapshot already existed. */
  newlyCreated: boolean;
  /** Skill name used in the generated frontmatter. */
  skillName: string;
}

/**
 * Effective field values after applying a Faithful Rewrite (if any).
 *
 * The installer resolves rewrite overrides so the rendered Markdown reflects
 * the final reviewed content, not the pre-rewrite candidate.
 */
export interface EffectiveFields {
  title: string;
  applicability: string;
  actionPattern: string;
  boundaries: string[];
  risks: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_FILE_NAME = 'SKILL.md';
/** Default sub-directory under the skills root for generated distilled skills. */
export const GENERATED_DISTILLED_DIR_NAME = 'generated-distilled';
/** Hex length used for the immutable snapshot_id. */
const SNAPSHOT_ID_HEX_LEN = 16;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------
// Public: install a promoted candidate
// ---------------------------------------------------------------------------

/**
 * Install a promoted capability candidate as an immutable `SKILL.md` snapshot.
 *
 * The installer is deterministic: the same candidate + review result always
 * renders the same Markdown and the same `snapshot_id`. If a snapshot with
 * that `snapshot_id` already exists on disk, the installer skips the write
 * (idempotent) and never overwrites the existing file.
 *
 * @param candidate  The distilled knowledge candidate to install.
 * @param review     The promotion review result; must have a decision that
 *                   creates an immutable snapshot (`promote`, `new_capability`,
 *                   or `supersede_snapshot`).
 * @param outputDir  Root directory for generated distilled skills (typically
 *                   `<skillsRoot>/generated-distilled`).
 * @returns Metadata about the installed (or pre-existing) snapshot.
 * @throws When the review decision is not `promote`, `new_capability`, or `supersede_snapshot`.
 */
export function installPromotedCandidate(
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
  outputDir: string,
): InstalledSkillSnapshot {
  assertPromotedCandidate(candidate, review, 'install');
  assertSafeCapabilityId(candidate.capabilityId);

  const effective = resolveEffectiveFields(candidate, review.rewrite);
  const snapshotId = computeSnapshotId(candidate, effective, review);
  const skillName = buildSkillName(snapshotId);
  const rootDir = normalizeOutputDir(outputDir);
  const directory = path.join(rootDir, candidate.capabilityId, snapshotId);
  const filePath = path.join(directory, SKILL_FILE_NAME);

  // Immutability: if the snapshot already exists, do not overwrite.
  if (fs.existsSync(filePath)) {
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`Cannot install candidate ${candidate.capabilityId}: snapshot path exists but is not a file: ${filePath}`);
    }
    return {
      capabilityId: candidate.capabilityId,
      snapshotId,
      filePath,
      directory,
      newlyCreated: false,
      skillName,
    };
  }

  const markdown = renderSkillMarkdown(skillName, candidate, review, effective, snapshotId);

  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(filePath, markdown, { encoding: 'utf-8', flag: 'wx' });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Cannot install candidate ${candidate.capabilityId}: snapshot path exists but is not a file: ${filePath}`);
    }
    return {
      capabilityId: candidate.capabilityId,
      snapshotId,
      filePath,
      directory,
      newlyCreated: false,
      skillName,
    };
  }

  return {
    capabilityId: candidate.capabilityId,
    snapshotId,
    filePath,
    directory,
    newlyCreated: true,
    skillName,
  };
}

// ---------------------------------------------------------------------------
// Public: render (pure function, no file I/O)
// ---------------------------------------------------------------------------

/**
 * Deterministically render the `SKILL.md` Markdown for a promoted candidate.
 *
 * This is a pure function: the same inputs always produce the same string. It
 * does not touch the filesystem. Exposed for testing and for callers that need
 * the rendered content without writing a file.
 *
 * @param candidate  The distilled knowledge candidate.
 * @param review     The promotion review result (`decision` must be one of
 *                   `promote`, `new_capability`, or `supersede_snapshot`).
 * @returns The full `SKILL.md` content (frontmatter + body).
 */
export function renderDistilledSkillMarkdown(
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
): string {
  assertPromotedCandidate(candidate, review, 'render skill for');
  const effective = resolveEffectiveFields(candidate, review.rewrite);
  const snapshotId = computeSnapshotId(candidate, effective, review);
  const skillName = buildSkillName(snapshotId);
  return renderSkillMarkdown(skillName, candidate, review, effective, snapshotId);
}

// ---------------------------------------------------------------------------
// Public: compute snapshot_id without writing
// ---------------------------------------------------------------------------

/**
 * Compute the immutable `snapshot_id` for a promoted candidate without
 * writing any files. The snapshot_id is deterministic from the candidate's
 * stable capability identity, the effective (post-rewrite) content, and the
 * review decision.
 */
export function computeSnapshotId(
  candidate: DistilledKnowledgeCandidate,
  effective: EffectiveFields,
  review: PromotionReviewResult,
): string {
  const content = stableStringify({
    schemaVersion: candidate.schemaVersion,
    kind: candidate.kind,
    capabilityId: candidate.capabilityId,
    effective,
    sourceUnit: candidate.sourceUnit,
    provenance: candidate.provenance,
    review: {
      decision: review.decision,
      rationale: review.rationale,
      reviewedAt: review.reviewedAt,
    },
  });
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, SNAPSHOT_ID_HEX_LEN);
}

const INSTALL_DECISIONS = new Set<PromotionDecision>([
  'promote',
  'new_capability',
  'supersede_snapshot',
]);

function assertPromotedCandidate(
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
  action: string,
): void {
  if (!INSTALL_DECISIONS.has(review.decision)) {
    throw new Error(
      `Cannot ${action} candidate ${candidate.capabilityId}: review decision is "${review.decision}", expected one of ${[...INSTALL_DECISIONS].join(', ')}.`,
    );
  }
  if (review.capabilityId !== candidate.capabilityId) {
    throw new Error(
      `Cannot ${action} candidate ${candidate.capabilityId}: review capabilityId "${review.capabilityId}" does not match candidate capabilityId.`,
    );
  }
}

function assertSafeCapabilityId(capabilityId: string): void {
  if (!SAFE_PATH_SEGMENT.test(capabilityId)) {
    throw new Error(
      `Cannot install candidate ${capabilityId}: capability_id must be a safe path segment containing only letters, numbers, dots, underscores, or hyphens.`,
    );
  }
}

function normalizeOutputDir(outputDir: string): string {
  const trimmed = outputDir.trim();
  if (!trimmed) {
    throw new Error('Cannot install promoted candidate: outputDir is required.');
  }
  return path.resolve(trimmed);
}

// ---------------------------------------------------------------------------
// Internal: effective fields (apply Faithful Rewrite)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective field values by applying the reviewer's Faithful
 * Rewrite overrides on top of the candidate's original fields.
 */
export function resolveEffectiveFields(
  candidate: DistilledKnowledgeCandidate,
  rewrite: FaithfulRewrite | null,
): EffectiveFields {
  return {
    title: rewrite?.title ?? candidate.title,
    applicability: rewrite?.applicability ?? candidate.applicability,
    actionPattern: rewrite?.actionPattern ?? candidate.actionPattern,
    boundaries: rewrite?.boundaries ?? candidate.boundaries,
    risks: rewrite?.risks ?? candidate.risks,
  };
}

// ---------------------------------------------------------------------------
// Internal: skill name
// ---------------------------------------------------------------------------

function buildSkillName(snapshotId: string): string {
  return `distilled-${snapshotId}`;
}

// ---------------------------------------------------------------------------
// Internal: Markdown rendering
// ---------------------------------------------------------------------------

function renderSkillMarkdown(
  skillName: string,
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
  effective: EffectiveFields,
  snapshotId: string,
): string {
  const frontmatter = renderFrontmatter(skillName, candidate, review, effective, snapshotId);
  const body = renderBody(candidate, review, effective, snapshotId);
  return `${frontmatter}\n${body}`;
}

// ---------------------------------------------------------------------------
// Internal: frontmatter
// ---------------------------------------------------------------------------

function renderFrontmatter(
  skillName: string,
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
  effective: EffectiveFields,
  snapshotId: string,
): string {
  const lines: string[] = ['---'];

  // Skill discovery fields (consumed by SkillParser).
  lines.push(`name: ${yamlString(skillName)}`);
  lines.push(`description: ${yamlString(buildDescription(effective))}`);
  lines.push(`user-invocable: true`);

  // Distilled capability identity.
  lines.push(`capability_id: ${yamlString(candidate.capabilityId)}`);
  lines.push(`snapshot_id: ${yamlString(snapshotId)}`);
  lines.push(`distilled: true`);
  lines.push(`kind: ${yamlString(candidate.kind)}`);
  lines.push(`schema_version: ${candidate.schemaVersion}`);

  // Generation time — sourced from the review result so rendering is
  // deterministic (no `new Date()` inside the renderer).
  lines.push(`generated_at: ${yamlString(review.reviewedAt)}`);

  // Source runtime metadata.
  lines.push(`source_file_path: ${yamlString(candidate.sourceUnit.filePath)}`);
  lines.push(`source_byte_range_start: ${candidate.sourceUnit.byteRange.start}`);
  lines.push(`source_byte_range_end: ${candidate.sourceUnit.byteRange.end}`);
  lines.push(`source_unit_generated_at: ${yamlString(candidate.sourceUnit.generatedAt)}`);

  // Review metadata.
  lines.push(`review_decision: ${yamlString(review.decision)}`);
  lines.push(`review_reviewed_at: ${yamlString(review.reviewedAt)}`);
  lines.push(`review_rationale: ${yamlString(review.rationale)}`);

  lines.push('---');
  return lines.join('\n');
}

/**
 * Build the skill `description` frontmatter value. The description explicitly
 * marks the skill as a distilled capability so humans and agents can
 * distinguish generated skills from hand-authored ones.
 */
function buildDescription(effective: EffectiveFields): string {
  const applicability = normalizeDescriptionPart(effective.applicability)
    .replace(/^Applies when the user raises a similar problem to:\s*/i, '')
    .replace(/^Use when\s*/i, '');
  const action = normalizeDescriptionPart(effective.actionPattern)
    .replace(/^Respond with:\s*/i, '')
    .replace(/^Apply this response pattern:\s*/i, '')
    .replace(/^Use tool\(s\)\s*\[([^\]]+)\]\s*then apply this pattern:\s*/i, 'Use tools [$1], then ');

  return `Distilled capability. When: ${compactDescriptionPart(applicability, 150)} Do: ${compactDescriptionPart(action, 210)}`;
}

function normalizeDescriptionPart(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function compactDescriptionPart(value: string, max: number): string {
  if (value.length <= max) return ensureTerminalPunctuation(value);

  const hardLimit = Math.max(20, max - 16);
  const head = value.slice(0, hardLimit);
  const boundary = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('; '),
    head.lastIndexOf(', '),
  );
  const compacted = boundary >= 40 ? head.slice(0, boundary + 1) : head.trimEnd();
  return `${ensureTerminalPunctuation(compacted)} [source has more]`;
}

function ensureTerminalPunctuation(value: string): string {
  if (!value) return value;
  return /[.!?。！？]$/.test(value) ? value : `${value}.`;
}

// ---------------------------------------------------------------------------
// Internal: body
// ---------------------------------------------------------------------------

function renderBody(
  candidate: DistilledKnowledgeCandidate,
  review: PromotionReviewResult,
  effective: EffectiveFields,
  snapshotId: string,
): string {
  const sections: string[] = [];

  // Title heading.
  sections.push(`# ${effective.title}`);
  sections.push('');

  // Capability Guidance.
  sections.push('## Capability Guidance');
  sections.push('');
  sections.push('**Applicability**');
  sections.push('');
  sections.push(effective.applicability);
  sections.push('');
  sections.push('**Action Pattern**');
  sections.push('');
  sections.push(effective.actionPattern);
  sections.push('');

  // Boundaries.
  sections.push('## Boundaries');
  sections.push('');
  for (const boundary of effective.boundaries) {
    sections.push(`- ${boundary}`);
  }
  if (effective.boundaries.length === 0) {
    sections.push('- No specific boundaries were recorded for this capability.');
  }
  sections.push('');

  // Risks.
  sections.push('## Risks');
  sections.push('');
  for (const risk of effective.risks) {
    sections.push(`- ${risk}`);
  }
  if (effective.risks.length === 0) {
    sections.push('- No specific risks were recorded for this capability.');
  }
  sections.push('');

  // Traceability Contract.
  sections.push('## Traceability Contract');
  sections.push('');
  sections.push(
    'This skill is a distilled capability snapshot generated from a single solved loop in session logs. ' +
      'Trust the guidance when the current situation clearly matches the applicability above. ' +
      'When the situation is high-risk, ambiguous, or conflicts with a listed boundary, consult the Provenance Refs below and verify against the source logs before applying the pattern.',
  );
  sections.push('');
  sections.push(`- **Capability ID:** \`${candidate.capabilityId}\``);
  sections.push(`- **Snapshot ID:** \`${snapshotId}\``);
  sections.push(`- **Source log:** \`${candidate.sourceUnit.filePath}\``);
  sections.push(
    `- **Source byte range:** ${candidate.sourceUnit.byteRange.start}\u2013${candidate.sourceUnit.byteRange.end}`,
  );
  sections.push(`- **Review decision:** ${review.decision} (reviewed ${review.reviewedAt})`);
  sections.push('');
  sections.push(
    'Do not embed or quote raw log content from the source session in this skill. Use the Provenance Refs to locate source turns when verification is needed.',
  );
  sections.push('');

  // Provenance Refs.
  sections.push('## Provenance Refs');
  sections.push('');
  for (const ref of candidate.provenance) {
    sections.push(renderProvenanceRef(ref));
  }
  if (candidate.provenance.length === 0) {
    sections.push('- No provenance refs were recorded for this capability.');
  }
  sections.push('');

  return sections.join('\n');
}

function renderProvenanceRef(ref: CapabilityProvenanceRef): string {
  return `- \`${ref.filePath}\` turn ${ref.turn} (${ref.role}) \u2014 byte range ${ref.unitByteRange.start}\u2013${ref.unitByteRange.end}`;
}

// ---------------------------------------------------------------------------
// Internal: YAML helpers
// ---------------------------------------------------------------------------

/**
 * Render a string as a double-quoted YAML scalar, escaping backslashes and
 * double quotes. This keeps the frontmatter safe for `gray-matter` parsing
 * even when field values contain colons, newlines, or other YAML-sensitive
 * characters.
 */
function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, char =>
      `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
    );
  return `"${escaped}"`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
