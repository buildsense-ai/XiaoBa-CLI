import * as crypto from 'crypto';
import { DistilledKnowledgeCandidate } from './capability-distiller';
import type { FaithfulRewrite } from './promotion-reviewer';

/**
 * Shared distilled-skill content helpers.
 *
 * These helpers live in their own module so the Promotion Reviewer can compare
 * a candidate's post-rewrite routable description with the Capability
 * Registry without creating a dependency cycle with the skill installer.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
// Public: resolve effective fields
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
// Public: build the routable skill description
// ---------------------------------------------------------------------------

/**
 * Build the skill `description` frontmatter value. The description explicitly
 * marks the skill as a distilled capability so humans and agents can
 * distinguish generated skills from hand-authored ones.
 */
export function buildDistilledSkillDescription(effective: EffectiveFields): string {
  const applicability = normalizeDescriptionPart(effective.applicability)
    .replace(/^Applies when the user raises a similar problem to:\s*/i, '')
    .replace(/^Use when\s*/i, '');
  const action = normalizeDescriptionPart(effective.actionPattern)
    .replace(/^Respond with:\s*/i, '')
    .replace(/^Apply this response pattern:\s*/i, '')
    .replace(/^Use tool\(s\)\s*\[([^\]]+)\]\s*then apply this pattern:\s*/i, 'Use tools [$1], then ');

  return `Distilled capability. When: ${compactDescriptionPart(applicability, 150)} Do: ${compactDescriptionPart(action, 210)}`;
}

/**
 * Compute a deterministic fingerprint for every user-facing guidance field in
 * an active skill. Unlike the routing description, this includes the title,
 * boundaries, and risks so consolidation cannot mistake a materially changed
 * skill for an evidence-only update.
 */
export function computeDistilledSkillGuidanceFingerprint(
  effective: EffectiveFields,
): string {
  const canonical = JSON.stringify({
    title: normalizeDescriptionPart(effective.title),
    applicability: normalizeDescriptionPart(effective.applicability),
    actionPattern: normalizeDescriptionPart(effective.actionPattern),
    boundaries: effective.boundaries.map(normalizeDescriptionPart),
    risks: effective.risks.map(normalizeDescriptionPart),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Internal: description helpers
// ---------------------------------------------------------------------------

function normalizeDescriptionPart(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function compactDescriptionPart(value: string, max: number): string {
  if (value.length <= max) return ensureTerminalPunctuation(value);

  const suffix = ' [source has more]';
  const hardLimit = Math.max(20, max - suffix.length - 1);
  const head = value.slice(0, hardLimit);
  const boundary = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('; '),
    head.lastIndexOf(', '),
  );
  const compacted = boundary >= 40 ? head.slice(0, boundary + 1) : head.trimEnd();
  return `${ensureTerminalPunctuation(compacted)}${suffix}`;
}

function ensureTerminalPunctuation(value: string): string {
  if (!value) return value;
  const cleaned = value.replace(/[,;:，；：]\s*$/, '');
  return /[.!?。！？]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}
