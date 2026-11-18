import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CatscoLogAgentClient } from '../utils/catsco-log-agent-client';
import { getCatscoLogAgentConfig } from '../utils/catsco-log-agent-config';
import { loadCatscoLogAgentState } from '../utils/catsco-log-agent-state';
import { Logger } from '../utils/logger';
import { canonicalKnowledgeSourceAnchor, dailyKnowledgeRef, hashedRecallRef, recallTextHash, type NativeRecallSource } from './native-recall-attribution';

export interface NativeRecallFeedbackEvent {
  event_id: string; trace_id: string; kind: 'native_recall' | 'branch_source';
  outcome: 'completed' | 'failed' | 'cancelled'; occurred_at_ms: number;
  observed: NativeRecallSource[];
  delivered: { ref: string; disclosure: 'metadata' | 'text' }[];
  cited: string[]; retained: string[];
  citation_semantics: 'explicit_ref_match_not_causal_use';
  delivery_semantics: 'submitted_in_model_input' | 'branch_summary_with_refs_not_source_body';
  retained_semantics: 'final_explicit_ref_match_not_semantic_adoption';
  lifecycle: 'turn_local_no_carryover';
}
interface DurableQueue { version: 1; scope: string; revoked?: boolean; events: NativeRecallFeedbackEvent[]; retry_at: number; attempts: number }
interface Capability { scope: string; token: string; base: string }
export interface NativeRecallFeedbackOutboxOptions {
  env?: NodeJS.ProcessEnv; now?: () => number;
  clientFactory?: (base: string) => Pick<CatscoLogAgentClient, 'reportKnowledgeSourceFeedback'>;
}
const busyPaths = new Set<string>();

// A single atomic, metadata-only file survives restart. Identity includes the
// capability and login, so queued claims can never acquire a new credential.
// Every flush rechecks state before sending and after receiving the response.
export interface NativeRecallFeedbackFlushResult {
  /** Event IDs the server actually acknowledged this flush. */
  acknowledged: string[];
}
export class NativeRecallFeedbackOutbox {
  constructor(private readonly workingDirectory: string, private readonly options: NativeRecallFeedbackOutboxOptions = {}) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private config() { return getCatscoLogAgentConfig(this.workingDirectory, this.options.env ?? process.env); }
  private filename(): string { return `${this.config().stateFilePath}.knowledge-feedback.json`; }
  private capability(): Capability | undefined {
    const config = this.config();
    const state = loadCatscoLogAgentState(config.stateFilePath);
    if (!config.enabled || config.memoryEnabled === false || !config.apiBaseUrl || !config.catscoUserToken || state.stateCorrupt
      || !state.deviceId || !state.userId || !state.skillToken || state.skillToken === state.token || state.skillToken === state.memoryWriteToken
      || !(Date.parse(state.skillTokenExpiresAt ?? '') > this.now())) return undefined;
    const scope = recallTextHash(JSON.stringify([config.apiBaseUrl, config.catscoUserToken, state.userId,
      state.deviceId, state.skillTokenId ?? null, state.skillToken]));
    return { scope, token: state.skillToken, base: config.apiBaseUrl };
  }
  private read(): DurableQueue | undefined {
    try {
      const file = this.filename();
      if (fs.statSync(file).size > 8 * 1024 * 1024) return undefined;
      const q = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (q.version !== 1 || !/^[a-f0-9]{64}$/.test(q.scope) || !Array.isArray(q.events) || q.events.length > 512
        || !q.events.every((ev: unknown) => feedbackEvent(ev)) || !Number.isFinite(q.retry_at) || !Number.isInteger(q.attempts)) return undefined;
      return q;
    } catch { return undefined; }
  }
  private write(q: DurableQueue): void {
    const file = this.filename();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(q), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  captureScope(): string | undefined {
    const capability = this.capability(); const q = this.read();
    if (q && (!capability || q.scope !== capability.scope)) {
      // Persist a tombstone instead of moving pending claims across identity.
      this.write({ version: 1, scope: q.scope, revoked: true, events: [], retry_at: 0, attempts: 0 });
    }
    if (!capability || (q?.scope === capability.scope && q.revoked)) return undefined;
    return capability.scope;
  }
  enqueue(records: readonly Record<string, unknown>[], capturedScope?: string): number {
    const scope = this.captureScope();
    if (!scope || !capturedScope || scope !== capturedScope) return 0;
    const existing = this.read();
    const q: DurableQueue = existing?.scope === scope ? existing : { version: 1, scope, events: [], retry_at: 0, attempts: 0 };
    let added = 0;
    // Truthful loss stays truthful but observable: bounded, metadata-only
    // drop counters per enqueue call (no refs/text/event payloads).
    const dropped = { oversize: 0, overflow: 0 };
    for (const record of records) {
      const ev = feedbackEvent(record);
      if (!ev || q.events.some(item => item.event_id === ev.event_id)) continue;
      if (q.events.length >= 512) { dropped.overflow++; continue; }
      // HTTP decoder bounds one envelope at 64KiB, matching the existing API.
      if (Buffer.byteLength(JSON.stringify({ schema_version: 1, events: [ev] })) > 60 * 1024) { dropped.oversize++; continue; }
      q.events.push(ev); added++;
    }
    if (added) this.write(q);
    for (const [reason, count] of Object.entries(dropped)) {
      if (!count) continue;
      try {
        Logger.runtimeEvent('WARN', `native recall source feedback dropped (${reason})`, {
          type: 'native_recall_feedback_drop', payload: { count, reason },
        });
      } catch { /* Observability must never break enqueueing. */ }
    }
    return added;
  }
  async flush(): Promise<NativeRecallFeedbackFlushResult> {
    const result: NativeRecallFeedbackFlushResult = { acknowledged: [] };
    const file = this.filename();
    if (busyPaths.has(file)) return result;
    busyPaths.add(file);
    try {
      const scope = this.captureScope(); const capability = this.capability(); const q = this.read();
      if (!scope || !capability || !q || q.scope !== scope || q.revoked || !q.events.length || q.retry_at > this.now()) return result;
      const batch: NativeRecallFeedbackEvent[] = [];
      for (const event of q.events.slice(0, 64)) {
        if (Buffer.byteLength(JSON.stringify({ schema_version: 1, events: [...batch, event] })) > 60 * 1024) break;
        batch.push(event);
      }
      if (!batch.length || this.captureScope() !== scope) return result;
      try {
        const client = this.options.clientFactory?.(capability.base) ?? new CatscoLogAgentClient(capability.base);
        const response = await client.reportKnowledgeSourceFeedback({ token: capability.token, events: batch, signal: AbortSignal.timeout(5_000) });
        if (this.captureScope() !== scope) return result;
        // Read fresh queue: enqueue may have run during the HTTP request.
        const live = this.read(); if (!live || live.scope !== scope || live.revoked) return result;
        const ids = new Set(response.outcomes.map(item => item.event_id));
        result.acknowledged = live.events.filter(event => ids.has(event.event_id)).map(event => event.event_id);
        live.events = live.events.filter(event => !ids.has(event.event_id)); live.retry_at = 0; live.attempts = 0; this.write(live);
        return result;
      } catch (error: any) {
        if (this.captureScope() !== scope) return result;
        const live = this.read(); if (!live || live.scope !== scope) return result;
        if (error?.status === 401 || error?.status === 403 || error?.payload?.error === 'agent_subject_changed') {
          live.events = []; live.revoked = true;
        } else if (error?.status === 400 || error?.status === 409 || error?.status === 413 || error?.status === 404 && error?.payload?.error === 'not_found') {
          // A rejected whole batch cannot be retried with altered content under
          // the same event IDs. New events remain independently enqueueable.
          const rejected = new Set(batch.map(ev => ev.event_id)); live.events = live.events.filter(ev => !rejected.has(ev.event_id));
        } else {
          live.attempts = Math.min(live.attempts + 1, 12);
          live.retry_at = this.now() + Math.min(60_000, 1_000 * 2 ** live.attempts);
        }
        this.write(live);
        return result;
      }
    } finally { busyPaths.delete(file); }
  }
}

/** Whitelist the complete event without altering subsets or claiming proof. */
export function feedbackEvent(value: unknown): NativeRecallFeedbackEvent | undefined {
  const v = value as any;
  if (!v || typeof v !== 'object' || typeof v.event_id !== 'string' || !v.event_id || v.event_id.length > 128
    || typeof v.trace_id !== 'string' || !v.trace_id.startsWith('recall-') || v.trace_id.length > 128
    || !['native_recall', 'branch_source'].includes(v.kind) || !['completed', 'failed', 'cancelled'].includes(v.outcome)
    || !Number.isSafeInteger(v.occurred_at_ms) || v.occurred_at_ms <= 0
    || v.citation_semantics !== 'explicit_ref_match_not_causal_use' || v.retained_semantics !== 'final_explicit_ref_match_not_semantic_adoption'
    || v.lifecycle !== 'turn_local_no_carryover' || !['submitted_in_model_input', 'branch_summary_with_refs_not_source_body'].includes(v.delivery_semantics)
    || ![v.observed, v.delivered, v.cited, v.retained].every(list => Array.isArray(list) && list.length <= 128) || !v.observed.length) return undefined;
  const observed = new Map<string, NativeRecallSource>();
  for (const source of v.observed) {
    if (!source?.anchor?.revision || !['metadata', 'text'].includes(source.disclosure) || observed.has(source.ref)) return undefined;
    const anchor = canonicalKnowledgeSourceAnchor(source.anchor);
    const ref = anchor.kind === 'knowledge_entry' ? dailyKnowledgeRef(anchor.document_id!, anchor.revision!, anchor.id)
      : hashedRecallRef('source', [anchor, source.ref_content_hash ?? null]);
    if (source.ref !== ref) return undefined;
    observed.set(ref, { ref, anchor, disclosure: source.disclosure,
      ...(source.ref_content_hash ? { ref_content_hash: source.ref_content_hash } : {}),
      ...(source.disclosed_text_hash ? { disclosed_text_hash: source.disclosed_text_hash } : {}),
      ...(source.coverage ? { coverage: source.coverage } : {}), ...(source.role ? { role: source.role } : {}),
      ...(source.truncated ? { truncated: true } : {}), ...(source.redacted ? { redacted: true } : {}),
    });
  }
  const delivered = new Set<string>();
  for (const source of v.delivered) {
    const seen = observed.get(source?.ref);
    if (!seen || delivered.has(source.ref) || !['metadata', 'text'].includes(source.disclosure) || source.disclosure === 'text' && seen.disclosure !== 'text') return undefined;
    delivered.add(source.ref);
  }
  if (![v.cited, v.retained].every(list => new Set(list).size === list.length && list.every((ref: string) => delivered.has(ref)))
    || v.outcome !== 'completed' && v.retained.length) return undefined;
  return { event_id: v.event_id, trace_id: v.trace_id, kind: v.kind, outcome: v.outcome, occurred_at_ms: v.occurred_at_ms,
    observed: [...observed.values()], delivered: v.delivered.map((d: any) => ({ ref: d.ref, disclosure: d.disclosure })),
    cited: [...v.cited], retained: [...v.retained], citation_semantics: v.citation_semantics, delivery_semantics: v.delivery_semantics,
    retained_semantics: v.retained_semantics, lifecycle: v.lifecycle };
}
