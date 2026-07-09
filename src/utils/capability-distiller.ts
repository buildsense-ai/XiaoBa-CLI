import * as crypto from 'crypto';
import {
  CompletedTurn,
  DistillationUnit,
} from './distillation-unit';

/**
 * Capability Candidate Distiller (issue #3).
 *
 * Receives one Distillation Unit and emits zero or more structured
 * `kind=capability` Distilled Knowledge Candidates by detecting Solved
 * Loops: a task episode where the user problem, agent action, verification
 * or user acceptance, and absence of immediate correction provide enough
 * evidence that a problem-handling pattern worked.
 *
 * First-version scope (Occam's razor):
 * - Deterministic only. No model calls, no Markdown rendering, no
 *   promotion/review/install, no merge/update/retire, no scheduler changes.
 * - Output is structured JSON suitable for later Promotion Reviewer input
 *   without Markdown parsing.
 * - The candidate schema names the broader envelope "Distilled Knowledge
 *   Candidate" and constrains `kind` to `capability` while leaving room for
 *   future knowledge kinds (facts, preferences, decisions, workflows,
 *   anti-patterns).
 *
 * See CONTEXT.md -> "Capability", "Capability Candidate", "Distilled Knowledge
 * Candidate", "Solved Loop", "Capability Provenance".
 * See docs/issues/heartbeat-log-distillation/03-capability-candidate-distiller.md.
 */

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

/**
 * Knowledge kind of a Distilled Knowledge Candidate.
 *
 * First version only supports `capability`. The union is intentionally
 * exhaustive-looking so later kinds (fact, preference, decision, workflow,
 * anti-pattern) can be added without reshaping the envelope.
 */
export type DistilledKnowledgeKind = 'capability';

export interface CapabilityProvenanceRef {
  /** Session log file path that holds the evidence turn. */
  filePath: string;
  /** Turn number within the source session log file. */
  turn: number;
  /** Role this source turn plays in the solved loop. */
  role: 'problem-action' | 'verification';
  /** Byte range of the Distillation Unit that sourced this evidence. */
  unitByteRange: { start: number; end: number };
}

export interface SolvedLoopEvidence {
  /** The user problem or request that opened the loop. */
  problem: string;
  /** The agent action that addressed the problem. */
  action: string;
  /** The verification or user-acceptance signal that closed the loop. */
  verification: string;
  /** Why the distiller concluded there was no immediate correction. */
  noCorrection: string;
}

export interface DistilledKnowledgeCandidate {
  /** Schema version for forward compatibility. */
  schemaVersion: 1;
  /** Knowledge kind. First version only supports `capability`. */
  kind: DistilledKnowledgeKind;
  /** Stable capability identity for later promotion/install. */
  capabilityId: string;
  /** Short human-readable title. */
  title: string;
  /** Situations where this capability applies. */
  applicability: string;
  /** The reusable action pattern that worked. */
  actionPattern: string;
  /** Boundary conditions where the pattern should not apply or needs care. */
  boundaries: string[];
  /** Risks of applying the pattern. */
  risks: string[];
  /** Solved-loop evidence backing this candidate. */
  solvedLoop: SolvedLoopEvidence;
  /** Capability Provenance refs to source turns. */
  provenance: CapabilityProvenanceRef[];
  /** ISO timestamp of candidate creation. */
  generatedAt: string;
  /** Identity of the source Distillation Unit. */
  sourceUnit: {
    filePath: string;
    byteRange: { start: number; end: number };
    generatedAt: string;
  };
}

// ---------------------------------------------------------------------------
// Heuristic constants
// ---------------------------------------------------------------------------

/** Minimum substantive user problem text length to seed a solved loop. */
const MIN_PROBLEM_TEXT_LEN = 8;
/** Minimum substantive assistant text length when no tool calls are present. */
const MIN_ACTION_TEXT_LEN = 20;
/** Maximum text snippet length carried into candidate fields. */
const MAX_SNIPPET_LEN = 160;

// Positive user-acceptance markers (case-insensitive, word-ish boundary).
const POSITIVE_ACCEPTANCE_MARKERS: readonly string[] = [
  'thanks',
  'thank you',
  'thx',
  'works',
  'worked',
  'working',
  'work',
  'great',
  'perfect',
  'awesome',
  'excellent',
  'exactly',
  'correct',
  'right',
  'got it',
  'that did it',
  'that fixed',
  'fixed',
  'solved',
  'confirmed',
  'verified',
  'done',
  'yes',
  'yep',
  'yup',
];

// Correction markers (case-insensitive). Their presence in the verification
// turn's user text disqualifies the loop: the user immediately corrected
// the agent, so the pattern did not actually work.
const CORRECTION_MARKERS: readonly string[] = [
  'no,',
  'nope',
  'not that',
  'not what',
  'not the',
  'wrong',
  'incorrect',
  "isn't right",
  "doesn't work",
  "doesn't fix",
  "didn't work",
  "didn't fix",
  'not working',
  'still broken',
  'still failing',
  'actually,',
  'instead of',
  'but that',
  'but it',
  'failed',
  'error',
];

const POSITIVE_ACCEPTANCE_REGEXES = POSITIVE_ACCEPTANCE_MARKERS.map(marker =>
  buildMarkerRegex(marker),
);
const CORRECTION_REGEXES = CORRECTION_MARKERS.map(marker =>
  buildMarkerRegex(marker),
);

// ---------------------------------------------------------------------------
// Public distiller entry point
// ---------------------------------------------------------------------------

/**
 * Distill structured `kind=capability` Distilled Knowledge Candidates from a
 * single Distillation Unit.
 *
 * The distiller scans the combined continuity + new turn sequence for adjacent
 * turn pairs that form a Solved Loop. At least one side of the pair must be
 * newly appended, so continuity-only loops are not re-distilled on every
 * heartbeat while cross-boundary loops can close when acceptance arrives.
 *
 * @returns Zero or more structured candidates. Empty for unsupported raw
 *          summaries, ambiguous unfinished work, or sessions still in progress.
 */
export function distillCapabilityCandidates(unit: DistillationUnit): DistilledKnowledgeCandidate[] {
  const candidates: DistilledKnowledgeCandidate[] = [];

  const indexed = indexTurns(unit);

  // Walk adjacent turn pairs. A solved loop is (problem turn, verification
  // turn). At least one turn must be new so continuity-only loops are not
  // re-emitted on each heartbeat.
  for (let i = 0; i < indexed.length - 1; i++) {
    const current = indexed[i];
    const next = indexed[i + 1];
    if (!current.isNew && !next.isNew) continue;

    const evidence = detectSolvedLoop(current.turn, next.turn);
    if (!evidence) continue;

    candidates.push(buildCandidate(unit, current.turn, next.turn, evidence));
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Solved-loop detection
// ---------------------------------------------------------------------------

interface IndexedTurn {
  turn: CompletedTurn;
  isNew: boolean;
}

function indexTurns(unit: DistillationUnit): IndexedTurn[] {
  return [
    ...unit.continuityTurns.map(turn => ({ turn, isNew: false })),
    ...unit.newTurns.map(turn => ({ turn, isNew: true })),
  ];
}

/**
 * Decide whether an adjacent (problem, verification) turn pair forms a Solved
 * Loop with strong enough evidence, and return the structured evidence when
 * it does.
 *
 * A loop qualifies when:
 *  - the problem turn carries a substantive user problem/request, and the
 *    assistant took a real action (tool calls or substantive text);
 *  - the verification turn shows explicit positive user acceptance; and
 *  - the verification turn does not contain immediate-correction markers.
 *
 * Ambiguous unfinished work (no follow-up turn) and unsupported raw summaries
 * (no problem/action structure, or only trivial chatter) produce `null`.
 */
function detectSolvedLoop(
  problemTurn: CompletedTurn,
  verificationTurn: CompletedTurn,
): SolvedLoopEvidence | null {
  const problemText = cleanText(problemTurn.user.text);
  if (problemText.length < MIN_PROBLEM_TEXT_LEN) return null;

  const assistantText = cleanText(problemTurn.assistant.text);
  const toolNames = problemTurn.assistant.tool_calls.map(tc => tc.name).filter(Boolean);
  const hasAction = toolNames.length > 0 || assistantText.length >= MIN_ACTION_TEXT_LEN;
  if (!hasAction) return null;

  const verificationText = cleanText(verificationTurn.user.text);
  if (!hasPositiveAcceptance(verificationText)) return null;
  if (hasCorrectionMarker(verificationText)) return null;

  return {
    problem: snippet(problemText),
    action: describeAction(toolNames, assistantText),
    verification: snippet(verificationText),
    noCorrection:
      'Verification turn contained positive acceptance and no immediate-correction markers.',
  };
}

function hasPositiveAcceptance(text: string): boolean {
  return POSITIVE_ACCEPTANCE_REGEXES.some(regex => regex.test(text));
}

function hasCorrectionMarker(text: string): boolean {
  return CORRECTION_REGEXES.some(regex => regex.test(text));
}

function buildMarkerRegex(marker: string): RegExp {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
}

// ---------------------------------------------------------------------------
// Candidate construction
// ---------------------------------------------------------------------------

function buildCandidate(
  unit: DistillationUnit,
  problemTurn: CompletedTurn,
  verificationTurn: CompletedTurn,
  evidence: SolvedLoopEvidence,
): DistilledKnowledgeCandidate {
  const toolNames = uniqueToolNames(problemTurn.assistant.tool_calls.map(tc => tc.name));
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: stableCapabilityId(unit, problemTurn),
    title: buildTitle(evidence.problem),
    applicability: `Applies when the user raises a similar problem to: ${snippet(evidence.problem, 120)}`,
    actionPattern: buildActionPattern(toolNames, evidence.action),
    boundaries: [
      'Only applies when the new situation matches the original problem shape; verify applicability before reuse.',
      'Do not apply when the user is still correcting or iterating on the request.',
    ],
    risks: [
      'Distilled from a single solved loop; the pattern may not generalize.',
      'Source logs may contain context not captured in this candidate.',
      'Apply the Promotion Reviewer before installing as an active skill.',
    ],
    solvedLoop: evidence,
    provenance: buildProvenance(unit, problemTurn, verificationTurn),
    generatedAt: new Date().toISOString(),
    sourceUnit: {
      filePath: unit.filePath,
      byteRange: unit.byteRange,
      generatedAt: unit.generatedAt,
    },
  };
}

function buildProvenance(
  unit: DistillationUnit,
  problemTurn: CompletedTurn,
  verificationTurn: CompletedTurn,
): CapabilityProvenanceRef[] {
  return [
    {
      filePath: unit.filePath,
      turn: problemTurn.turn,
      role: 'problem-action',
      unitByteRange: unit.byteRange,
    },
    {
      filePath: unit.filePath,
      turn: verificationTurn.turn,
      role: 'verification',
      unitByteRange: unit.byteRange,
    },
  ];
}

function buildTitle(problem: string): string {
  const head = problem.split(/[.!?\n]/)[0].trim() || problem;
  return `Capability: ${compactForMetadata(head, 96)}`;
}

function buildActionPattern(toolNames: string[], action: string): string {
  if (toolNames.length > 0) {
    const tools = toolNames.slice(0, 5).join(', ');
    return `Use tool(s) [${tools}] then apply this pattern: ${compactForMetadata(action, 260)}`;
  }
  return `Apply this response pattern: ${compactForMetadata(action, 280)}`;
}

function describeAction(toolNames: string[], assistantText: string): string {
  if (toolNames.length > 0) {
    return `Used tools [${toolNames.slice(0, 5).join(', ')}]${assistantText ? ` and said: ${snippet(assistantText, 100)}` : ''}`;
  }
  return snippet(assistantText);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanText(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function uniqueToolNames(toolNames: string[]): string[] {
  return [...new Set(toolNames.map(name => name.trim()).filter(Boolean))];
}

function snippet(text: string, max: number = MAX_SNIPPET_LEN): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '...';
}

function compactForMetadata(text: string, max: number): string {
  const cleaned = cleanText(text);
  if (cleaned.length <= max) return cleaned;

  const hardLimit = Math.max(20, max - 16);
  const head = cleaned.slice(0, hardLimit);
  const boundary = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('; '),
    head.lastIndexOf(', '),
  );
  const compacted = boundary >= 40 ? head.slice(0, boundary + 1) : head.trimEnd();
  return `${compacted} [source has more]`;
}

function stableCapabilityId(unit: DistillationUnit, problemTurn: CompletedTurn): string {
  const raw = `${unit.filePath}|turn-${problemTurn.turn}|${cleanText(problemTurn.user.text)}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return `cap-${hash.slice(0, 16)}`;
}
