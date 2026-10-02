import type { CatscoBranchResponse } from '../utils/catsco-log-agent-client';
import { normalizeEvidenceVerdict } from './catslog-branch-evidence';

/**
 * One gate input bundle: the fused /catsco/agent/branch response, the
 * device-bound session-query records, and the local distilled-knowledge
 * entries. All three lanes are independent evidence surfaces; the gate is a
 * pure function over exactly these values and inspects nothing else — no
 * lane truncation flags, no timestamps, no error strings.
 */
export interface MemoryEvidenceGateInput {
  /** Fused branch fan-out response (undefined when the lane never ran). */
  remoteResponse?: CatscoBranchResponse;
  /** Raw session-query records (empty when the lane failed or hit nothing). */
  sessionRecords: readonly unknown[];
  /** Local distilled-knowledge entries (empty when the lane hit nothing). */
  knowledgeEntries: readonly unknown[];
}

/**
 * Whether the mechanical retrieval surfaced any evidence worth one refine
 * inference — the pure core of the memory branch's verdict gate.
 *
 * Semantics (ADR 0019 envelope + ADR 0020 evidence_verdict contract):
 *
 * - `session_graph` carrying an explicit `evidence_verdict: 'none'` means
 *   the server's rerank judged THIS candidate pool not useful for the
 *   query. Items remaining in that branch are the judged-and-rejected
 *   pool, so they do NOT count as usable evidence — `none` is the only
 *   verdict on which the consumer may skip its downstream compose step.
 * - The semantic `none` is scoped: it says nothing about the other lanes.
 *   Other remote branches (skill, agent_memory, …), raw session-query
 *   records, and local KB entries stay independent evidence — `none` does
 *   not mean "no history exists".
 * - An absent, unrecognized, or `unknown` verdict means no judgment
 *   survived; the branch's items then count as usable exactly as before
 *   (unknown proceeds like weak/strong). Only a normalized `none` on the
 *   `session_graph` branch suppresses that branch's items.
 *
 * The gate is deliberately conservative toward "refine runs": every
 * malformed wire shape (missing branches array, non-object branch entries,
 * non-array items, junk verdict values) degrades to the pre-verdict
 * behavior — items count, records count, entries count. It never throws on
 * hostile input and never reads past array/record boundaries.
 */
export function hasUsableMemoryEvidence(input: MemoryEvidenceGateInput): boolean {
  const branches = input.remoteResponse?.branches;
  if (Array.isArray(branches)) {
    for (const branch of branches) {
      // A branch entry that is not an object carries no interpretable
      // verdict or items; skipping it cannot suppress evidence elsewhere.
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) continue;
      if (branch.source === 'session_graph' && normalizeEvidenceVerdict(branch.evidence_verdict) === 'none') {
        // This pool was explicitly judged not useful: its leftover items
        // are rejected candidates, not usable evidence.
        continue;
      }
      if (Array.isArray(branch.items) && branch.items.length > 0) return true;
    }
  }
  // Session records and KB entries are independent of the remote verdict:
  // session_graph `none` only condemns its own reranked pool. Empty arrays
  // here (failed/truncated lanes included) simply contribute nothing — the
  // gate never guesses at lanes it was not handed.
  return input.sessionRecords.length > 0 || input.knowledgeEntries.length > 0;
}
