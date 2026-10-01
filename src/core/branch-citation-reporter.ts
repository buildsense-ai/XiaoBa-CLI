import type { SyntheticObservation } from './synthetic-observation';
import { isCatsLogPoolCitationRef } from '../utils/catsco-log-agent-client';

/**
 * Downstream citation matching for memory-branch injections.
 *
 * After the parent agent's reply for the turn that consumed an injection,
 * the reply text is substring-matched against the injected ref strings.
 * Server pool refs (`ref_<64hex>`) become reportable citations for
 * POST /catsco/agent/branch/citations; local knowledge refs (`kb:` /
 * `file:documents/...`) cannot enter the server's ref_-only column and are
 * returned separately for a local-only observation event.
 *
 * Matching is deliberately plain substring containment: refs are opaque,
 * high-entropy tokens the model can only have copied from the injection.
 */
export interface BranchCitationReport {
  requestId: string;
  refs: string[];
}

export interface BranchCitationMatch {
  reports: BranchCitationReport[];
  knowledgeRefs: string[];
}

const MAX_REPORTED_REFS_PER_REQUEST = 64;
const MAX_KNOWLEDGE_CITED_REFS = 32;
const MAX_REQUEST_ID_CHARS = 256;

export function matchBranchCitations(
  observations: readonly SyntheticObservation[],
  replyText: string | undefined,
): BranchCitationMatch {
  const reports = new Map<string, Set<string>>();
  const knowledgeRefs = new Set<string>();
  const text = typeof replyText === 'string' ? replyText : '';
  if (!text || observations.length === 0) {
    return { reports: [], knowledgeRefs: [] };
  }

  for (const observation of observations) {
    const metadata = observation.metadata;
    if (!metadata) continue;
    const citation = metadata.citation;
    if (citation && typeof citation === 'object' && !Array.isArray(citation)) {
      const requestId = typeof citation.requestId === 'string' ? citation.requestId.trim() : '';
      if (requestId && requestId.length <= MAX_REQUEST_ID_CHARS && !hasControlChar(requestId)) {
        const cited = reports.get(requestId) ?? new Set<string>();
        for (const ref of citation.refs ?? []) {
          if (cited.size >= MAX_REPORTED_REFS_PER_REQUEST) break;
          if (isCatsLogPoolCitationRef(ref) && text.includes(ref)) cited.add(ref);
        }
        if (cited.size > 0) reports.set(requestId, cited);
      }
    }
    for (const ref of Array.isArray(metadata.refs) ? metadata.refs : []) {
      if (knowledgeRefs.size >= MAX_KNOWLEDGE_CITED_REFS) break;
      if (isKnowledgeLaneRef(ref) && text.includes(ref)) knowledgeRefs.add(ref);
    }
  }

  return {
    reports: Array.from(reports.entries())
      .map(([requestId, refs]) => ({ requestId, refs: Array.from(refs) })),
    knowledgeRefs: Array.from(knowledgeRefs),
  };
}

function isKnowledgeLaneRef(ref: unknown): ref is string {
  return typeof ref === 'string' && (ref.startsWith('kb:') || ref.startsWith('file:'));
}

function hasControlChar(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}
