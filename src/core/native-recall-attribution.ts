import { createHash, randomUUID } from 'node:crypto';
import type { CatsLogKnowledgeAnchor } from '../utils/catslog-knowledge-types';
import type { Message } from '../types';
import type { ToolResult } from '../types/tool';
import { collectAssistantCitationText } from './branch-citation-reporter';

export interface NativeRecallSource {
  ref: string;
  /** Canonical exact identity envelope; absent for legacy local-only records. */
  anchor?: CatsLogKnowledgeAnchor;
  ref_content_hash?: string;
  disclosure: 'metadata' | 'text';
  /** Hash of the actual disclosed body; no private text is persisted here. */
  disclosed_text_hash?: string;
  coverage?: 'complete' | 'partial' | 'structural_only';
  role?: 'organic' | 'learning' | 'knowledge';
  truncated?: boolean;
  redacted?: boolean;
}
export interface NativeRecallAttribution {
  trace_id: string;
  sources: NativeRecallSource[];
  server_feedback: 'not_connected';
}
const DAILY_REF = /^catslog:knowledge:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
const SOURCE_REF = /^catslog:(?:source|history|document):[a-f0-9]{64}$/;
export function isDailyKnowledgeRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && DAILY_REF.test(value);
}
export function isNativeRecallRef(value: unknown): value is string {
  return isDailyKnowledgeRef(value) || (typeof value === 'string' && SOURCE_REF.test(value));
}
export function dailyKnowledgeRef(document: string, revision: string, entry: string): string {
  return `catslog:knowledge:${document}:${revision}:${entry}`;
}
export function canonicalRecallJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecallJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalRecallJSON(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function recallTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
/** Ref identity normalization only; never rewrite the API's Anchor JSON.
 * Go omitempty elides zero raw coordinates and canonical pins omit sha256:.
 * Graph/learning coordinates remain a separate identity domain.
 * Cross-repo parity: the canonical reference for this normalization (and
 * for feedback ref derivation) is CatsLog internal/knowledge/feedback.go
 * FeedbackRef — keep both sides byte-identical when either changes.
 */
export function canonicalKnowledgeSourceAnchor(anchor: CatsLogKnowledgeAnchor): CatsLogKnowledgeAnchor {
  const normalized = { ...anchor };
  if (normalized.kind === 'session_query' || normalized.kind === 'session_result') {
    if (normalized.byte_offset === undefined) normalized.byte_offset = 0;
    if (normalized.kind === 'session_query' && normalized.byte_length === undefined) normalized.byte_length = 0;
  }
  if (normalized.kind !== 'knowledge_entry' && /^sha256:[a-f0-9]{64}$/.test(normalized.revision ?? '')) {
    normalized.revision = normalized.revision!.slice('sha256:'.length);
  }
  return normalized;
}
export function hashedRecallRef(domain: 'source' | 'history' | 'document', identity: unknown): string {
  const normalized = domain === 'source' && Array.isArray(identity) && identity[0] && typeof identity[0] === 'object'
    ? [canonicalKnowledgeSourceAnchor(identity[0]), ...identity.slice(1)] : identity;
  return `catslog:${domain}:${recallTextHash(canonicalRecallJSON(normalized))}`;
}
function sanitizeSource(source: any): NativeRecallSource | undefined {
  if (!source || !isNativeRecallRef(source.ref) || (source.disclosure !== 'metadata' && source.disclosure !== 'text')) return undefined;
  const anchor = source.anchor && typeof source.anchor === 'object'
    ? canonicalKnowledgeSourceAnchor(source.anchor) : undefined;
  return { ref: source.ref, disclosure: source.disclosure,
    ...(anchor ? { anchor } : {}),
    ...(typeof source.ref_content_hash === 'string' && /^sha256:[a-f0-9]{64}$/.test(source.ref_content_hash)
      ? { ref_content_hash: source.ref_content_hash } : {}),
    ...(typeof source.disclosed_text_hash === 'string' && /^[a-f0-9]{64}$/.test(source.disclosed_text_hash)
      ? { disclosed_text_hash: source.disclosed_text_hash } : {}),
    ...(['complete', 'partial', 'structural_only'].includes(source.coverage) ? { coverage: source.coverage } : {}),
    ...(['organic', 'learning', 'knowledge'].includes(source.role) ? { role: source.role } : {}),
    ...(typeof source.truncated === 'boolean' ? { truncated: source.truncated } : {}),
    ...(typeof source.redacted === 'boolean' ? { redacted: source.redacted } : {}),
  };
}
export function nativeRecallAttribution(sources: NativeRecallSource[]): NativeRecallAttribution {
  const safe = sources.map(sanitizeSource).filter((source): source is NativeRecallSource => source !== undefined);
  const distinct = new Map(safe.map(source => [source.ref, source]));
  return { trace_id: `recall-${randomUUID()}`, sources: [...distinct.values()], server_feedback: 'not_connected' };
}

interface ObservedCall {
  tool_call_id: string;
  attribution: NativeRecallAttribution;
  delivered: Map<string, 'metadata' | 'text'>;
  precedingAssistant: Set<Message>;
  feedbackScope?: string;
}
/** Turn-local ledger. Only runner execution results may register observations;
 * only the actual provider input may mark delivery. A successful read alone
 * never means cited/used. Tool results and recall arguments cannot cite themselves.
 */
export class NativeRecallTracker {
  private calls = new Map<string, ObservedCall>();

  observe(result: ToolResult, precedingMessages: readonly Message[] = [], feedbackScope?: string): void {
    if (result.name !== 'catslog_knowledge_recall' || result.ok !== true || result.errorCode || typeof result.content !== 'string') return;
    try {
      const raw = JSON.parse(result.content).recall_attribution;
      if (!raw || !/^recall-[a-f0-9-]{36}$/.test(raw.trace_id) || !Array.isArray(raw.sources)) return;
      const sources = raw.sources.map(sanitizeSource).filter((source: NativeRecallSource | undefined): source is NativeRecallSource => source !== undefined);
      this.calls.set(result.tool_call_id, {
        tool_call_id: result.tool_call_id,
        attribution: { trace_id: raw.trace_id, sources, server_feedback: 'not_connected' },
        delivered: new Map(),
        feedbackScope,
        precedingAssistant: new Set(precedingMessages.filter(message => message.role === 'assistant')),
      });
    } catch { /* non-recall/malformed results carry no attribution */ }
  }

  deliver(messages: readonly Message[]): void {
    for (const message of messages) {
      if (message.role !== 'tool' || typeof message.content !== 'string') continue;
      const call = this.calls.get(message.tool_call_id || '');
      if (!call) continue;
      // Match parsed fields, not arbitrary substrings in untrusted source text.
      try {
        const attribution = JSON.parse(message.content).recall_attribution;
        if (attribution?.trace_id !== call.attribution.trace_id || !Array.isArray(attribution.sources)) continue;
        const textByRef = new Map<string, string>();
        const body = JSON.parse(message.content);
        for (const item of [...(body.entries || []), ...(body.hits || []), body.source, ...(body.before || []), ...(body.after || [])]) {
          if (item && typeof item.ref === 'string') textByRef.set(item.ref, typeof item.text === 'string' ? item.text : '');
        }
        for (const edge of body.edges || []) {
          if (typeof edge.remote_ref === 'string') textByRef.set(edge.remote_ref, '');
        }
        if (typeof body.ref === 'string' && typeof body.okf === 'string') textByRef.set(body.ref, body.okf);
        for (const record of body.records || []) {
          const { corpus_ref, ...projection } = record;
          if (typeof corpus_ref === 'string') textByRef.set(corpus_ref, canonicalRecallJSON(projection));
        }
        for (const source of call.attribution.sources) {
          if (!attribution.sources.some((item: any) => item?.ref === source.ref)) continue;
          // An envelope without the corresponding item is not disclosure.
          if (!textByRef.has(source.ref)) continue;
          const text = textByRef.get(source.ref)!;
          const disclosure = source.disclosure === 'text' && source.disclosed_text_hash
            && recallTextHash(text) === source.disclosed_text_hash ? 'text' : 'metadata';
          // A later compacted request cannot undo an earlier complete delivery.
          if (call.delivered.get(source.ref) !== 'text') call.delivered.set(source.ref, disclosure);
        }
      } catch { /* clipping/compaction may remove the attribution envelope */ }
    }
  }

  finish(messages: readonly Message[] = [], finalText = '', outcome: 'completed' | 'failed' | 'cancelled' = 'completed'): Record<string, unknown>[] {
    const calls = [...this.calls.values()];
    this.calls.clear();
    return calls.map(call => {
      const resultIndex = messages.findIndex(message => {
        if (message.role !== 'tool' || message.tool_call_id !== call.tool_call_id || typeof message.content !== 'string') return false;
        try { return JSON.parse(message.content).recall_attribution?.trace_id === call.attribution.trace_id; } catch { return false; }
      });
      // Corpus starts after this result. Exclude recall arguments: requesting a
      // read is retrieval intent, not evidence that its contents were used.
      const subsequent = (resultIndex >= 0 ? messages.slice(resultIndex + 1) : messages.filter(message => !call.precedingAssistant.has(message)))
        .map(message => ({
          ...message,
          tool_calls: message.tool_calls?.filter(tool => tool.function.name !== 'catslog_knowledge_recall'),
        }));
      const corpus = collectAssistantCitationText(subsequent, outcome === 'completed' ? finalText : '');
      const delivered = call.attribution.sources.filter(source => call.delivered.has(source.ref));
      const cited = delivered.filter(source => corpus.includes(source.ref)).map(source => source.ref);
      const retained = outcome === 'completed' ? delivered.filter(source => finalText.includes(source.ref)).map(source => source.ref) : [];
      return {
        trace_id: call.attribution.trace_id,
        event_id: `feedback-${randomUUID()}`,
        kind: 'native_recall',
        occurred_at_ms: Date.now(),
        feedback_scope: call.feedbackScope,
        observed: call.attribution.sources,
        delivered: delivered.map(source => ({ ref: source.ref, disclosure: call.delivered.get(source.ref) })),
        cited,
        retained,
        outcome,
        citation_semantics: 'explicit_ref_match_not_causal_use',
        delivery_semantics: 'submitted_in_model_input',
        retained_semantics: 'final_explicit_ref_match_not_semantic_adoption',
        lifecycle: 'turn_local_no_carryover',
        server_feedback: 'not_connected',
      };
    });
  }
}
