import type { SyntheticObservation } from './synthetic-observation';
import type { Message } from '../types';
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
      if (isKnowledgeLaneRef(ref) && knowledgeRefAppearsIn(ref, text)) knowledgeRefs.add(ref);
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

/**
 * Knowledge refs surface in two spellings: the literal `kb:`/`file:` ref, or
 * the bare identifier embedded in a filesystem path — reading
 * `knowledge/documents/KB-<uuid>.md` via read_file is a citation of
 * `kb:KB-<uuid>` even though the ref prefix never appears. Matching the bare
 * KB-ID is safe because the UUID is unforgeable context; `file:` refs match
 * on the documents-relative path or its basename.
 */
function knowledgeRefAppearsIn(ref: string, corpus: string): boolean {
  if (corpus.includes(ref)) return true;
  if (ref.startsWith('kb:')) {
    return corpus.includes(ref.slice(3));
  }
  if (ref.startsWith('file:documents/')) {
    const rel = ref.slice('file:'.length);
    return corpus.includes(rel) || corpus.includes(rel.split('/').pop()!);
  }
  return false;
}

const MAX_CITATION_CORPUS_CHARS = 256 * 1024;

/**
 * The citation corpus for a turn: every assistant-authored surface, not just
 * the final reply. Assistant text blocks and tool_call arguments both carry
 * model intent — reading an injected KB document by path or quoting a pool
 * ref inside a tool call is a citation even when the final answer narrates
 * the source without printing the ref literally. Tool results and injected
 * user-role observations are excluded: refs appearing there are the
 * injection's own evidence, not the model's use of it.
 */
export function collectAssistantCitationText(
  newMessages: readonly Message[] | undefined,
  replyText: string | undefined,
): string {
  const parts: string[] = [];
  let size = 0;
  const push = (chunk: string | undefined) => {
    if (!chunk || size >= MAX_CITATION_CORPUS_CHARS) return;
    parts.push(chunk);
    size += chunk.length;
  };
  if (Array.isArray(newMessages)) {
    for (const message of newMessages) {
      if (!message || message.role !== 'assistant') continue;
      if (typeof message.content === 'string') {
        push(message.content);
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
            push((block as { text: string }).text);
          }
        }
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          push(call?.function?.arguments);
        }
      }
    }
  }
  push(replyText);
  return parts.join('\n');
}

function hasControlChar(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}
