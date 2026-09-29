import * as crypto from 'crypto';
import type {
  CatscoBranchResponse,
  CatscoEvidenceVerdict,
  CatscoSessionQueryResult,
} from '../utils/catsco-log-agent-client';
import {
  isSafeCatsLogOpaqueIdentifier,
  isSafeCatsLogSkillHandle,
} from '../utils/catsco-log-agent-client';

const MAX_BRANCHES = 8;
const MAX_BRANCH_ITEMS = 50;
const MAX_TEXT_CHARS = 12_000;
const MAX_BRANCH_RESULT_CHARS = 60_000;

/** Bounded redacted-records projection of one /query/v1/sessions response. */
const MAX_SESSION_RECORDS = 20;
const MAX_SESSION_RECORD_TEXT_CHARS = 2_000;
const MAX_SESSION_TOOL_CALLS = 10;
const MAX_SESSION_RESULT_CHARS = 12_000;

/**
 * Trust label of the device-bound session evidence projection. Mirrors the
 * server's own `content_trust: untrusted_log_data` envelope value: records
 * are redacted server-side, but they are still untrusted evidence text.
 */
export const SESSION_EVIDENCE_TRUST = 'untrusted_log_data';

/**
 * Client-side normalization of the server's per-branch evidence verdict. The
 * wire field is free-form while the field is being rolled out; anything
 * unrecognized (including absent) is `unknown`, and the branch pipeline only
 * ever acts on `none`.
 */
export function normalizeEvidenceVerdict(value: unknown): CatscoEvidenceVerdict {
  return value === 'none' || value === 'weak' || value === 'strong' || value === 'unknown'
    ? value
    : 'unknown';
}

/**
 * Projection of a fused /catsco/agent/branch response into the bounded,
 * untrusted-evidence shape the memory branch consumes (v1.3: the mechanical
 * retrieval stage calls the provider method directly and feeds this projection
 * into the observed-refs tracker and the evidence pack, exactly as the old
 * `catslog_branch` tool result did).
 *
 * The server-side fused fan-out owns multi-source execution, scope fencing,
 * and reranking; the client only enforces trust labeling, ref-safety, and
 * size bounds. The principal is derived from the device token, so the
 * projection never carries principal/UID selectors or bearer values.
 */
export function projectBranchResponse(response: CatscoBranchResponse | unknown): Record<string, unknown> {
  const source = asRecord(response);
  const branches = safeRecords(source?.branches);
  return {
    content_trust: 'untrusted_branch_evidence',
    ...(numberValue(source?.schema_version) !== undefined ? { schema_version: numberValue(source?.schema_version) } : {}),
    ...(textValue(source?.request_id) ? { request_id: safeIdentifier(source.request_id) } : {}),
    ...(textValue(source?.status) ? { status: boundedText(source.status, 64) } : {}),
    branches: branches.slice(0, MAX_BRANCHES).map(projectBranchResult),
    truncated: branches.length > MAX_BRANCHES,
  };
}

function projectBranchResult(branch: Record<string, unknown>): Record<string, unknown> {
  const items = safeRecords(branch.items);
  const verdict = branch.evidence_verdict !== undefined
    ? normalizeEvidenceVerdict(branch.evidence_verdict)
    : undefined;
  return {
    ...(textValue(branch.source) ? { source: boundedText(branch.source, 128) } : {}),
    ...(textValue(branch.status) ? { status: boundedText(branch.status, 64) } : {}),
    ...(verdict !== undefined ? { evidence_verdict: verdict } : {}),
    items: items.slice(0, MAX_BRANCH_ITEMS).map(projectBranchItem),
    ...(nonNegativeInteger(branch.elapsed_ms) !== undefined ? { elapsed_ms: nonNegativeInteger(branch.elapsed_ms) } : {}),
    truncated: branch.truncated === true || items.length > MAX_BRANCH_ITEMS,
  };
}

function projectBranchItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(textValue(item.source) ? { source: boundedText(item.source, 128) } : {}),
    ...(textValue(item.ref) ? { ref: projectSourceRef(item.ref) } : {}),
    ...(textValue(item.kind) ? { kind: boundedText(item.kind, 64) } : {}),
    ...(textValue(item.text) ? { text: boundedText(item.text, MAX_TEXT_CHARS) } : {}),
    ...(finiteNumber(item.score_hint) !== undefined ? { score_hint: finiteNumber(item.score_hint) } : {}),
  };
}

function projectSourceRef(value: unknown): string {
  const ref = boundedText(value, 512);
  if (isSafeSessionRef(ref) || isSafeSkillCitation(ref)) return ref;
  return `catslog:ref:${hashRef(ref)}`;
}

/** Serialize one projection into a bounded JSON string (tool-result shape). */
export function boundToolResultJson(
  value: Record<string, unknown>,
  maxLength: number = MAX_BRANCH_RESULT_CHARS,
): string {
  let result: Record<string, any>;
  try {
    result = sanitizeJSON(JSON.parse(JSON.stringify(value))) as Record<string, any>;
  } catch {
    return JSON.stringify({
      content_trust: typeof value.content_trust === 'string' ? value.content_trust : 'untrusted_branch_evidence',
      truncated: true,
      warning: 'CatsLog returned an unserializable result; the branch omitted it for safety.',
    });
  }
  const arrays: Array<{ owner: Record<string, any>; key: string }> = [];
  if (Array.isArray(result.branches)) {
    arrays.push({ owner: result, key: 'branches' });
    // A branch fan-out nests one items array per returned branch; register
    // each so the pop loop can trim item tails instead of dropping branches.
    for (const branch of result.branches) {
      if (branch && typeof branch === 'object' && !Array.isArray(branch) && Array.isArray(branch.items)) {
        arrays.push({ owner: branch, key: 'items' });
      }
    }
  }
  // Drop tail items from the first non-empty array in the order above until
  // the result fits. Binary-search the minimal pop count instead of
  // re-serializing the whole result once per dropped item.
  const originals = arrays.map(({ owner, key }) => owner[key] as unknown[]);
  const poppable = originals.reduce((sum, list) => sum + list.length, 0);
  const encodeWithPops = (pops: number): string => {
    let remaining = pops;
    for (let i = 0; i < arrays.length && remaining > 0; i++) {
      const remove = Math.min(remaining, originals[i].length);
      arrays[i].owner[arrays[i].key] = originals[i].slice(0, originals[i].length - remove);
      remaining -= remove;
    }
    return JSON.stringify(result);
  };
  let encoded = JSON.stringify(result);
  if (encoded.length > maxLength && poppable > 0) {
    let lo = 1;
    let hi = poppable;
    let minimal = -1;
    while (lo <= hi) {
      const mid = lo + ((hi - lo) >> 1);
      if (encodeWithPops(mid).length <= maxLength) {
        minimal = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (minimal > 0) {
      encoded = encodeWithPops(minimal);
      result.truncated = true;
    }
  }
  if (encoded.length <= maxLength) {
    return encoded;
  }
  return JSON.stringify({
    content_trust: typeof result.content_trust === 'string' ? result.content_trust : 'untrusted_branch_evidence',
    truncated: true,
    warning: 'CatsLog result exceeded the branch evidence budget; narrow the query or request fewer records.',
  });
}

function sanitizeJSON(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[nested data omitted]';
  if (Array.isArray(value)) return value.slice(0, 64).map(item => sanitizeJSON(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/receipt|token|authorization|password|secret|api[_-]?key/i.test(key)) continue;
    result[key] = sanitizeJSON(child, depth + 1);
  }
  return result;
}

/**
 * Projection of one device-bound /catsco/agent/query/v1/sessions response
 * into the bounded, untrusted-evidence shape the memory branch consumes.
 *
 * The server owns scope fencing (the capability binds one principal: shared
 * + own-subject memory scopes) and redaction; this projection only enforces
 * ref-safety, field whitelisting, and size bounds. Tool arguments/results
 * are intentionally absent — they are not part of the server record and
 * must never be re-imported from local files.
 */
export function projectSessionQueryResponse(
  response: CatscoSessionQueryResult | unknown,
  maxLength: number = MAX_SESSION_RESULT_CHARS,
): Record<string, unknown> {
  if (asRecord(response)?.not_modified === true) {
    return { content_trust: SESSION_EVIDENCE_TRUST, not_modified: true, records: [], truncated: false };
  }
  const source = asRecord(response);
  const records = safeRecords(source?.records);
  const projectedRecords = records.slice(0, MAX_SESSION_RECORDS).map(projectSessionRecord);
  const result: Record<string, unknown> = {
    content_trust: SESSION_EVIDENCE_TRUST,
    records: projectedRecords,
    truncated: source?.truncated === true || records.length > MAX_SESSION_RECORDS,
  };
  if (textValue(source?.next_cursor)) result.next_cursor = boundedText(source?.next_cursor, 256);
  // Trim tail records until the serialized projection fits the budget.
  let encoded = JSON.stringify(result);
  while (encoded.length > maxLength && projectedRecords.length > 0) {
    projectedRecords.pop();
    result.truncated = true;
    encoded = JSON.stringify(result);
  }
  return result;
}

function projectSessionRecord(record: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  if (textValue(record.ref)) projected.ref = projectSourceRef(record.ref);
  if (textValue(record.session_type)) projected.session_type = boundedText(record.session_type, 64);
  if (textValue(record.session_id)) projected.session_id = safeIdentifier(record.session_id, 256);
  if (textValue(record.log_date)) projected.log_date = boundedText(record.log_date, 32);
  if (textValue(record.timestamp)) projected.timestamp = boundedText(record.timestamp, 64);
  if (numberValue(record.turn) !== undefined) projected.turn = numberValue(record.turn);
  if (textValue(record.entry_type)) projected.entry_type = boundedText(record.entry_type, 32);
  const user = asRecord(record.user);
  if (user && textValue(user.text)) {
    projected.user = {
      text: boundedText(user.text, MAX_SESSION_RECORD_TEXT_CHARS),
      ...(user.redacted === true ? { redacted: true } : {}),
    };
  }
  const agent = asRecord(record.agent);
  if (agent && textValue(agent.text)) {
    projected.agent = {
      text: boundedText(agent.text, MAX_SESSION_RECORD_TEXT_CHARS),
      ...(agent.redacted === true ? { redacted: true } : {}),
    };
  }
  if (Array.isArray(record.tool_calls)) {
    const toolCalls = record.tool_calls
      .filter(asRecord)
      .slice(0, MAX_SESSION_TOOL_CALLS)
      .map(toolCall => ({
        ...(textValue(toolCall.name) ? { name: boundedText(toolCall.name, 128) } : {}),
        ...(textValue(toolCall.type) ? { type: boundedText(toolCall.type, 32) } : {}),
      }))
      .filter(entry => Object.keys(entry).length > 0);
    if (toolCalls.length > 0) projected.tool_calls = toolCalls;
  }
  return projected;
}

function isSafeSessionRef(value: string): boolean {
  const match = value.match(/^(.+)#(?:[1-9][0-9]*|summary)$/);
  return Boolean(match && isSafeCatsLogOpaqueIdentifier(match[1], 256));
}

function isSafeSkillCitation(value: string): boolean {
  const match = value.match(/^catslog:skill:(.+)@([1-9][0-9]*)$/);
  return Boolean(match && isSafeCatsLogSkillHandle(match[1]) && Number.isSafeInteger(Number(match[2])));
}

function safeIdentifier(value: unknown, maxBytes = 512): string {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '');
  const text = boundedText(raw, maxBytes);
  return isSafeCatsLogOpaqueIdentifier(text, maxBytes) ? text : `catslog:ref:${hashRef(raw)}`;
}

function hashRef(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function safeRecords(value: unknown): Record<string, any>[] {
  return Array.isArray(value) ? value.filter(asRecord) : [];
}

function textValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 32))}\n...[truncated]`;
}
