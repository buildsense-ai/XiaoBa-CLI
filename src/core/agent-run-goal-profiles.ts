import type { AgentRunProfileGoalPolicy } from './agent-run-goal-resolver';

export const CODE_INSPECTION_GOAL_PROFILE: AgentRunProfileGoalPolicy = {
  profileId: 'code_inspection.v1',
  runType: 'code_inspection',
  purpose: 'Inspect a bounded repository snapshot with evidence-backed coverage and register only Findings that pass the Finding gate.',
  defaultSkills: ['code-inspection'],
  completionCriteria: [
    'The inspection boundary, snapshot, scope, permissions, exclusions, coverage, and material unknowns are recorded.',
    'The canonical inspection report validates and its human-readable projection is attached.',
    'Every reported Finding passes the Finding gate and is linked to its Evidence Envelope; non-Findings remain observations or unknowns.',
    'The final Goal Check states the stop reason and residual risk.',
  ],
  safetyConstraints: [
    'Do not modify the inspected source during the inspection Run.',
    'Do not claim unreviewed code is defect-free.',
  ],
  fallbackGoal: facts => {
    const repo = textFact(facts, 'repo');
    const snapshot = textFact(facts, 'snapshot');
    const mode = textFact(facts, 'mode');
    if (mode === 'change') {
      return `Determine the impact and regression risk of ${repo} from ${textFact(facts, 'baseSnapshot')} to ${snapshot}; produce a validated inspection report, record coverage and unknowns, and register only Findings that pass the gate.`;
    }
    if (mode === 'focus') {
      return `Inspect ${repo}@${snapshot} for ${textFact(facts, 'topic')} within the authorized evidence boundary; produce a validated report with coverage and unknowns, and register only Findings that pass the gate.`;
    }
    return `Build the minimum evidence-backed understanding of ${repo}@${snapshot}; produce a validated inspection report with coverage, exclusions, unknowns, and residual risk, and register every concrete Finding that passes the gate.`;
  },
};

export const FINDING_REVIEW_GOAL_PROFILE: AgentRunProfileGoalPolicy = {
  profileId: 'finding_review.v1',
  runType: 'finding_review',
  purpose: 'Bring one concrete Finding to the most complete practical Evidence Envelope and recommend exactly one terminal outcome: Issue or Close.',
  defaultSkills: ['build-evidence-envelope-review'],
  completionCriteria: [
    'The authoritative Evidence Envelope covers the Finding claim, expected behavior, evidence, plausible sources, alternatives, counter-evidence, impact boundary, and material unknowns as far as practical.',
    'All unfinished Review Tasks are resolved or a concrete blocker and stop condition are recorded.',
    'The terminal recommendation is exactly one of Issue or Close and is consistent with the Envelope state.',
  ],
  safetyConstraints: [
    'Approval-required work must not execute without authenticated human approval.',
    'The model must not edit authoritative evidence through an uncommitted SubAgent result.',
  ],
  fallbackGoal: facts => `Build the most complete practical Evidence Envelope for ${textFact(facts, 'findingId')}, exhaust plausible bug sources and alternative explanations within the authorized boundary, and recommend exactly one terminal outcome—Issue or Close; otherwise record the concrete blocker, next evidence action, and stop condition.`,
};

function textFact(facts: Readonly<Record<string, unknown>>, field: string): string {
  const value = facts[field];
  if (typeof value !== 'string' || !value.trim()) return `<${field}>`;
  return value.trim();
}
