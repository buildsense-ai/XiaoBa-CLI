/**
 * Durable Evidence Review diagnostics (#110).
 *
 * Operator-facing summaries distinguishing local retry, semantic defer,
 * supersession, incomplete coverage, clean completion, and terminal failure.
 */

import type { EvidenceReviewJob, EvidenceReviewDiagnostics } from './evidence-review-types';
import { buildEvidenceReviewDiagnostics } from './evidence-review-job-store';

export type EvidenceReviewOperatorDisposition =
  | 'active_coverage'
  | 'leased'
  | 'local_retry'
  | 'semantic_defer'
  | 'stale_basis_superseded'
  | 'incomplete_coverage'
  | 'completed'
  | 'terminal_integrity_failure'
  | 'drain_settling';

export interface EvidenceReviewOperatorView extends EvidenceReviewDiagnostics {
  operatorDisposition: EvidenceReviewOperatorDisposition;
  summary: string;
}

export function classifyOperatorDisposition(job: EvidenceReviewJob, now = new Date()): EvidenceReviewOperatorDisposition {
  if (job.disposition === 'superseded') return 'stale_basis_superseded';
  if (job.disposition === 'deferred') return 'semantic_defer';
  if (job.disposition === 'completed') return 'completed';
  if (job.disposition === 'terminal_failed') return 'terminal_integrity_failure';

  const quanta = Object.values(job.quanta);
  if (quanta.some(q => q.state === 'leased')) return 'leased';
  if (quanta.some(q => q.state === 'retry_wait')) return 'local_retry';

  const authorReaders = quanta.filter(q => q.kind === 'author_reader');
  const verifierReaders = quanta.filter(q => q.kind === 'verifier_reader');
  const authorDone = authorReaders.every(q => q.state === 'succeeded');
  const verifierDone = verifierReaders.every(q => q.state === 'succeeded');
  if (!authorDone || !verifierDone) return 'incomplete_coverage';

  return 'active_coverage';
}

export function buildOperatorView(job: EvidenceReviewJob, now = new Date()): EvidenceReviewOperatorView {
  const diagnostics = buildEvidenceReviewDiagnostics(job, now);
  const operatorDisposition = classifyOperatorDisposition(job, now);
  const summary = summarizeDisposition(operatorDisposition, diagnostics);
  return { ...diagnostics, operatorDisposition, summary };
}

function summarizeDisposition(
  disposition: EvidenceReviewOperatorDisposition,
  diagnostics: EvidenceReviewDiagnostics,
): string {
  switch (disposition) {
    case 'completed':
      return `Job ${diagnostics.jobId} completed` + (diagnostics.transitionId ? ` as ${diagnostics.transitionId}` : '');
    case 'semantic_defer':
      return `Job ${diagnostics.jobId} deferred semantically; obligations or verifier deferred`;
    case 'stale_basis_superseded':
      return `Job ${diagnostics.jobId} superseded` + (diagnostics.successorJobId ? ` by ${diagnostics.successorJobId}` : '');
    case 'terminal_integrity_failure':
      return `Job ${diagnostics.jobId} terminal: ${diagnostics.terminalReason ?? 'integrity failure'}`;
    case 'local_retry':
      return `Job ${diagnostics.jobId} has ${diagnostics.retryingQuanta} quantum(s) in local provider retry`;
    case 'leased':
      return `Job ${diagnostics.jobId} has ${diagnostics.leasedQuanta} leased quantum(s)`;
    case 'incomplete_coverage':
      return `Job ${diagnostics.jobId} coverage incomplete (author ${diagnostics.authorCoveredShards}/${diagnostics.shardCount}, verifier ${diagnostics.verifierCoveredShards}/${diagnostics.shardCount})`;
    case 'drain_settling':
      return `Job ${diagnostics.jobId} settling during graceful drain`;
    default:
      return `Job ${diagnostics.jobId} active with ${diagnostics.runnableQuanta} runnable quantum(s)`;
  }
}

export function listOperatorViews(
  jobs: readonly EvidenceReviewJob[],
  now = new Date(),
): EvidenceReviewOperatorView[] {
  return [...jobs]
    .sort((a, b) => a.jobId.localeCompare(b.jobId, 'en'))
    .map(job => buildOperatorView(job, now));
}
