/**
 * Capability Update Guidance (Progressive Trust duplicate avoidance).
 *
 * When the fixed Evidence Bundle already includes a matching Capability in
 * `relatedCurrentSkills` and the evidence supports updating it, the Author must
 * be guided toward `append_evidence` / `replace_current_skill` instead of
 * creating a duplicate `create_current_skill`.
 *
 * This module supplies a bounded, deterministic detection seam. It NEVER
 * invents a semantic routing name, NEVER silently overrides a genuinely
 * different Author proposal, and NEVER heuristically force-commits a merge.
 * It only emits a structurally-detected validation signal that drives a
 * bounded revision contract: the Author picks the correct transition
 * (`append_evidence` or `replace_current_skill`) targeting the existing
 * capability, or proposes a genuinely different routing name.
 *
 * Provider-neutral and bounded: no private log parsing; only the bundle's
 * `relatedCurrentSkills` (recall context) and the Author's envelope are used.
 */

import type {
  EvidenceBundle,
  RelatedCurrentSkill,
  SkillDraft,
  SkillVerifierIssue,
} from './skill-evolution';

/**
 * Structurally detect a duplicate `create_current_skill` proposal against an
 * existing capability in `relatedCurrentSkills`. Returns a `SkillVerifierIssue`
 * (severity error) when:
 *   - the envelope decision is `create_current_skill`;
 *   - the proposed `routingName` exactly matches a `relatedCurrentSkill`'s
 *     `routingName`.
 *
 * Returns `null` in every other case, including a `replace_current_skill` /
 * `append_evidence` draft targeting the existing capability, or a
 * `create_current_skill` draft with a genuinely different routing name.
 */
export function detectDuplicateCapabilityCreation(
  draft: SkillDraft,
  bundle: EvidenceBundle,
): SkillVerifierIssue | null {
  const envelope = draft?.envelope;
  if (!envelope || envelope.decision !== 'create_current_skill') return null;
  const proposedRoutingName = envelope.routingName;
  if (!proposedRoutingName || typeof proposedRoutingName !== 'string') return null;

  const candidates = (bundle.relatedCurrentSkills ?? []) as readonly RelatedCurrentSkill[];
  const match = candidates.find(skill => skill.routingName === proposedRoutingName);
  if (!match) return null;

  return {
    code: 'duplicate-capability-creation',
    message:
      `A Current Skill with routingName "${proposedRoutingName}" already exists `
      + `(handle ${match.handle}); use append_evidence or replace_current_skill targeting that capability instead of create_current_skill. `
      + `If this draft describes a genuinely different capability, propose a different semantic routing name.`,
    severity: 'error',
  };
}