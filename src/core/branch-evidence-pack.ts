/**
 * Mechanical evidence-pack consolidation for the memory-search branch.
 *
 * A pure, deterministic post-processing step between the lane projections
 * (`catslog-branch-evidence.ts` / `catslog-knowledge-lane.ts`) and the
 * evidence-pack message: it eliminates EXACT duplicates, groups adjacent
 * session records that provably belong to the same stream, and re-enforces
 * the per-lane character budgets — nothing else. It is intentionally unable
 * to change retrieval, schema, auth, or model behavior, and it performs no
 * inference: what to drop is decided only by byte-exact identity and stable
 * coordinate adjacency.
 *
 * Non-goals (deliberate, do not "fix" here):
 * - No fuzzy/synonym dedup. Two items merge only when their projected
 *   content is byte-identical modulo the `ref` field itself.
 * - No graph↔KB↔session lineage inference from matching words. Identical
 *   facts from different lanes or different sources stay separate evidence.
 * - No ranking. `score_hint` gaps are rank-position noise synthesized by the
 *   server, not confidence; they are never used to order, merge, or drop.
 *   (Two items differing only in `score_hint` are NOT exact duplicates and
 *   both survive.)
 * - No recency pruning. `updated_at` never decides survival; an older fact
 *   is never dropped in favor of a newer KB document.
 * - No token-savings claims. Character counts in `diagnostics` are a raw
 *   packing audit only.
 *
 * Provenance-sensitivity of the exact-duplicate key:
 * - The key is the record's `ref` (or the empty string when absent) plus the
 *   canonical (sorted-key) JSON of the record MINUS its `ref` field. Speaker
 *   (`user` vs `agent` fields), `turn`, `log_date`, `timestamp`, `revision`,
 *   `updated_at`, `score_hint`, and `source` are all part of the compared
 *   content, so any difference in them prevents a merge. Refs are IN the
 *   key: for a remote branch item the `ref` suffix is frequently the only
 *   turn provenance there is, so `stream-x#12` and `stream-x#13` with
 *   identical text never merge, and two records that differ only in ref
 *   form stay separate with both refs cited.
 * - A merge therefore only collapses records whose refs are byte-equal, so
 *   eliminating a duplicate can never lose a source ref: every surviving
 *   record still cites its own ref, in its original position.
 *
 * Session grouping (session lane only):
 * - Records whose ref parses as `<stream>#<n>` are grouped when they are
 *   ADJACENT IN INPUT ORDER, share the same stream base, have turn numbers
 *   differing by exactly 1, and agree on `session_id` / `log_date` whenever
 *   both sides carry those fields. Those stable coordinates are the only
 *   proof of "same stream, neighbor turns"; nothing else (text similarity
 *   included) can form a group. Groups are never reordered: member order is
 *   input order, and a group takes the position of its first member.
 * - Members keep every field — role texts, dates, tool calls, corrections,
 *   conflicts — so contradictory turns remain individually visible.
 * - Opaque refs (`catslog:ref:<hash>`, `#summary`, unparsed shapes) are never
 *   grouped. Single records are never wrapped: the common one-record shape
 *   is unchanged.
 *
 * Audit vs presentation:
 * - `presentedRefs` lists exactly the refs visible in the FINAL pack (after
 *   char-cap tail drops), in pack order. Refs on omitted records/groups are
 *   absent from both the pack and `presentedRefs`, so the coordinator can
 *   feed `{ refs: presentedRefs }` straight into the observed-refs tracker
 *   without registering anything the model cannot cite. No ref is ever
 *   invented here.
 * - Depth note: the tracker's MAX_WALK_DEPTH=6 reaches session group `refs`
 *   (flat, ≤5 container levels from a lane root) but cannot reach deeper
 *   nested positions when the whole pack is fed as one tool result. That is
 *   why groups carry a FLAT `refs` array AND `presentedRefs` is exported
 *   for tracker-only input. Both are derived from the final pack only.
 *
 * Status survival:
 * - Lane envelopes are copied, never reconstructed: `status`, failure
 *   `note`s, `content_trust`, `request_id`, `evidence_verdict`, `truncated`,
 *   `next_cursor`, and any unrecognized fields pass through untouched.
 *   Consolidation only ever replaces the `branches`/`records`/`entries`
 *   arrays. An upstream `truncated: true` survives even when dedup frees
 *   enough space that re-fetching would fit — dropped data stays dropped.
 * - If consolidation itself must tail-drop to fit a lane budget, it sets
 *   `truncated: true` plus a visible `consolidation_omitted*` count on that
 *   lane. Distinctive evidence is never silently dropped to shrink the pack:
 *   shrinking comes from exact duplicates, and any residual overflow is a
 *   loud, counted omission.
 */

/** Lane char budgets, identical to the pre-consolidation projections. */
export const MAX_REMOTE_EVIDENCE_CHARS = 20_000;
export const MAX_SESSION_EVIDENCE_CHARS = 12_000;
export const MAX_KNOWLEDGE_EVIDENCE_CHARS = 8_000;

/** Marker type for an adjacent-turn session group. */
export const SESSION_TURN_GROUP_TYPE = 'session_turn_group';

export interface ConsolidateMemoryEvidencePackInput {
  /** Projected `/catsco/agent/branch` envelope (`remote_branch` lane). */
  remoteBranch: Record<string, unknown>;
  /** Projected `/query/v1/sessions` envelope (`session_records` lane). */
  sessionRecords: Record<string, unknown>;
  /** Projected local distilled-KB lane (`local_knowledge`). */
  localKnowledge: Record<string, unknown>;
}

export interface ConsolidateMemoryEvidencePackOptions {
  /** Serialization budget for the consolidated remote lane. Default 20_000. */
  maxRemoteChars?: number;
  /** Serialization budget for the consolidated session lane. Default 12_000. */
  maxSessionChars?: number;
  /** Serialization budget for the consolidated knowledge lane. Default 8_000. */
  maxKnowledgeChars?: number;
}

export interface ConsolidateMemoryEvidencePackResult {
  /** Pack with top-level `remote_branch` / `session_records` / `local_knowledge`. */
  evidencePack: Record<string, unknown>;
  /** Refs actually visible in the final pack (tracker-only feed, pack order). */
  presentedRefs: string[];
  /** Raw consolidation audit: counts, char sizes, truncation flags. */
  diagnostics: Record<string, number | boolean | string>;
}

interface StreamCoords {
  base: string;
  turn: number;
}

/** Consolidate the three projected lanes into one deduplicated evidence pack. */
export function consolidateMemoryEvidencePack(
  input: ConsolidateMemoryEvidencePackInput,
  options: ConsolidateMemoryEvidencePackOptions = {},
): ConsolidateMemoryEvidencePackResult {
  const maxRemoteChars = positiveIntegerOption(options.maxRemoteChars, MAX_REMOTE_EVIDENCE_CHARS);
  const maxSessionChars = positiveIntegerOption(options.maxSessionChars, MAX_SESSION_EVIDENCE_CHARS);
  const maxKnowledgeChars = positiveIntegerOption(options.maxKnowledgeChars, MAX_KNOWLEDGE_EVIDENCE_CHARS);

  // Remote lane: dedup branch items across the whole fan-out, then cap.
  // Every branch envelope survives (source/status/verdict/truncated), even
  // when all of its items duplicated elsewhere.
  // Raw (pre-dedup) lane sizes for the packing audit. Measured on the
  // cloned envelope right after the copy, before any consolidation.
  const remoteEnvelope = cloneEnvelope(input?.remoteBranch);
  const remoteCharsIn = laneCharSize(remoteEnvelope);
  let remoteItemsIn = 0;
  let remoteDuplicatesRemoved = 0;
  if (Array.isArray(remoteEnvelope.branches)) {
    const branches = remoteEnvelope.branches.filter(isRecord);
    const itemKeys = new Map<string, number>();
    for (const branch of branches) {
      const items = Array.isArray(branch.items) ? branch.items.filter(isRecord) : [];
      remoteItemsIn += items.length;
      const deduped = dedupByIdentity(items, itemKeys);
      remoteDuplicatesRemoved += deduped.duplicatesRemoved;
      branch.items = deduped.kept;
    }
    remoteEnvelope.branches = branches;
  }
  const cappedRemote = capRemoteLane(remoteEnvelope, maxRemoteChars);

  // Session lane: dedup, then group input-adjacent same-stream neighbor turns.
  const sessionEnvelope = cloneEnvelope(input?.sessionRecords);
  const sessionCharsIn = laneCharSize(sessionEnvelope);
  let sessionRecordsIn = 0;
  let sessionDuplicatesRemoved = 0;
  let sessionGroupsFormed = 0;
  if (Array.isArray(sessionEnvelope.records)) {
    const rawRecords = sessionEnvelope.records.filter(isRecord);
    sessionRecordsIn = rawRecords.length;
    const deduped = dedupByIdentity(rawRecords, new Map());
    sessionDuplicatesRemoved = deduped.duplicatesRemoved;
    const grouped = groupAdjacentSessionRecords(deduped.kept);
    sessionGroupsFormed = grouped.groupsFormed;
    sessionEnvelope.records = grouped.entries;
  }
  const cappedSession = capArrayLane(sessionEnvelope, 'records', maxSessionChars);

  // Knowledge lane: dedup only — KB entries carry no turn coordinates to group.
  const knowledgeEnvelope = cloneEnvelope(input?.localKnowledge);
  const knowledgeCharsIn = laneCharSize(knowledgeEnvelope);
  let knowledgeEntriesIn = 0;
  let knowledgeDuplicatesRemoved = 0;
  if (Array.isArray(knowledgeEnvelope.entries)) {
    const rawEntries = knowledgeEnvelope.entries.filter(isRecord);
    knowledgeEntriesIn = rawEntries.length;
    const deduped = dedupByIdentity(rawEntries, new Map());
    knowledgeDuplicatesRemoved = deduped.duplicatesRemoved;
    knowledgeEnvelope.entries = deduped.kept;
  }
  const cappedKnowledge = capArrayLane(knowledgeEnvelope, 'entries', maxKnowledgeChars);

  const evidencePack: Record<string, unknown> = {
    content_trust: 'untrusted_branch_evidence',
    remote_branch: cappedRemote.envelope,
    session_records: cappedSession.envelope,
    local_knowledge: cappedKnowledge.envelope,
  };
  const presentedRefs = collectPresentedRefs(evidencePack);

  const diagnostics: Record<string, number | boolean | string> = {
    consolidated: true,
    remote_chars_in: remoteCharsIn,
    remote_chars_out: JSON.stringify(cappedRemote.envelope).length,
    remote_items_in: remoteItemsIn,
    remote_items_out: countLaneItems(cappedRemote.envelope),
    remote_duplicates_removed: remoteDuplicatesRemoved,
    remote_omitted_items: cappedRemote.omittedItems,
    remote_omitted_branches: cappedRemote.omittedBranches,
    remote_truncated: cappedRemote.envelope.truncated === true,
    session_chars_in: sessionCharsIn,
    session_chars_out: JSON.stringify(cappedSession.envelope).length,
    session_records_in: sessionRecordsIn,
    session_records_out: countSessionMembers(cappedSession.envelope),
    session_duplicates_removed: sessionDuplicatesRemoved,
    session_groups_formed: sessionGroupsFormed,
    session_groups_presented: countSessionGroups(cappedSession.envelope),
    session_omitted_records: cappedSession.omitted,
    session_truncated: cappedSession.envelope.truncated === true,
    knowledge_chars_in: knowledgeCharsIn,
    knowledge_chars_out: JSON.stringify(cappedKnowledge.envelope).length,
    knowledge_entries_in: knowledgeEntriesIn,
    knowledge_entries_out: countLaneEntries(cappedKnowledge.envelope),
    knowledge_duplicates_removed: knowledgeDuplicatesRemoved,
    knowledge_omitted_entries: cappedKnowledge.omitted,
    knowledge_truncated: cappedKnowledge.envelope.truncated === true,
    refs_presented: presentedRefs.length,
  };

  return { evidencePack, presentedRefs, diagnostics };
}

/**
 * Exact-duplicate elimination over one lane's item list, sharing `keys`
 * across callers that belong to the same lane (remote branches dedup across
 * the whole fan-out; lanes never share a key space).
 *
 * Key = `ref` (or '' when absent) + canonical JSON of the record minus
 * `ref`. Refs are part of the key, so a merge only ever collapses records
 * whose refs are byte-equal — no source ref can be lost by dedup. The first
 * occurrence keeps its position. Returns the kept list (fresh clones, input
 * order) and an audit counter.
 */
function dedupByIdentity(
  records: Record<string, unknown>[],
  keys: Map<string, number>,
): { kept: Record<string, unknown>[]; duplicatesRemoved: number } {
  const kept: Record<string, unknown>[] = [];
  let duplicatesRemoved = 0;
  for (const record of records) {
    const clone = cloneJson(record);
    const ref = typeof clone.ref === 'string' ? clone.ref : undefined;
    const withoutRef: Record<string, unknown> = { ...clone };
    delete withoutRef.ref;
    const key = `${ref ?? ''}\u0000${stableStringify(withoutRef)}`;
    const existingIndex = keys.get(key);
    if (existingIndex === undefined) {
      keys.set(key, kept.length);
      kept.push(clone);
      continue;
    }
    duplicatesRemoved += 1;
  }
  return { kept, duplicatesRemoved };
}

/**
 * Group input-adjacent session records whose stable coordinates prove the
 * same stream and neighbor turns: identical ref base, |Δturn| = 1 between
 * consecutive input positions, and matching `session_id` / `log_date`
 * whenever both records carry the field. Runs of ≥2 become groups; runs of
 * 1 stay plain records. Input order is preserved everywhere.
 */
function groupAdjacentSessionRecords(records: Record<string, unknown>[]): { entries: Record<string, unknown>[]; groupsFormed: number } {
  const entries: Record<string, unknown>[] = [];
  let run: { base: string; records: Record<string, unknown>[]; coords: StreamCoords[] } | undefined;
  let groupsFormed = 0;

  const flush = () => {
    if (!run) return;
    if (run.records.length >= 2) {
      entries.push(buildSessionTurnGroup(run.base, run.records, run.coords));
      groupsFormed += 1;
    } else {
      entries.push(run.records[0]);
    }
    run = undefined;
  };

  for (const record of records) {
    const coords = streamTurnCoords(record.ref);
    const previous = run ? run.coords[run.coords.length - 1] : undefined;
    const previousRecord = run ? run.records[run.records.length - 1] : undefined;
    if (
      run
      && coords
      && previous
      && previousRecord
      && coords.base === run.base
      && Math.abs(coords.turn - previous.turn) === 1
      && agreesWhenBothPresent(record, previousRecord, 'session_id')
      && agreesWhenBothPresent(record, previousRecord, 'log_date')
    ) {
      run.records.push(record);
      run.coords.push(coords);
      continue;
    }
    flush();
    if (coords) {
      run = { base: coords.base, records: [record], coords: [coords] };
    } else {
      entries.push(record);
    }
  }
  flush();
  return { entries, groupsFormed };
}

function buildSessionTurnGroup(base: string, members: Record<string, unknown>[], coords: StreamCoords[]): SessionGroup {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const ref = member.ref;
    if (typeof ref === 'string' && ref && !seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return {
    type: SESSION_TURN_GROUP_TYPE,
    stream: base,
    count: members.length,
    turns: coords.map(coordinate => coordinate.turn),
    refs,
    records: members,
  };
}

/** `<stream>#<n>` ref → coordinates; anything else (opaque, `#summary`) → undefined. */
function streamTurnCoords(ref: unknown): StreamCoords | undefined {
  if (typeof ref !== 'string') return undefined;
  const match = ref.match(/^(.+)#([1-9][0-9]*)$/);
  if (!match) return undefined;
  const turn = Number(match[2]);
  return Number.isSafeInteger(turn) ? { base: match[1], turn } : undefined;
}

function agreesWhenBothPresent(a: Record<string, unknown>, b: Record<string, unknown>, field: string): boolean {
  const left = a[field];
  const right = b[field];
  return left === undefined || right === undefined || left === right;
}

/**
 * Cap a lane envelope whose items live in a single top-level array
 * (`records` / `entries`) by popping tail entries — the same visible-
 * omission pattern as the upstream projections. `omitted` counts member
 * records (a dropped group counts all its members). The envelope is mutated
 * in place (it is already a private clone).
 */
function capArrayLane(
  envelope: Record<string, unknown>,
  arrayKey: 'records' | 'entries',
  maxChars: number,
): { envelope: Record<string, unknown>; omitted: number } {
  const items = Array.isArray(envelope[arrayKey]) ? (envelope[arrayKey] as Record<string, unknown>[]) : [];
  let omitted = 0;
  while (JSON.stringify(envelope).length > maxChars && items.length > 0) {
    omitted += countMembersOf(items.pop());
  }
  if (omitted > 0) {
    envelope.truncated = true;
    envelope.consolidation_omitted = omitted;
    if (arrayKey === 'entries') envelope.status = 'truncated';
  }
  return { envelope, omitted };
}

/**
 * Cap the remote lane without sacrificing branch envelopes: tail items are
 * dropped first (last branch backward) so every branch keeps its
 * source/status/verdict visible as long as possible; only when every items
 * array is empty do tail branches go. A still-overflowing lane degrades to
 * the same bounded warning-payload shape the upstream projection uses.
 */
function capRemoteLane(
  envelope: Record<string, unknown>,
  maxChars: number,
): { envelope: Record<string, unknown>; omittedItems: number; omittedBranches: number } {
  if (JSON.stringify(envelope).length <= maxChars) {
    return { envelope, omittedItems: 0, omittedBranches: 0 };
  }
  const branches = Array.isArray(envelope.branches) ? envelope.branches.filter(isRecord) : [];
  let omittedItems = 0;
  for (let index = branches.length - 1; index >= 0; index -= 1) {
    const items = Array.isArray(branches[index].items) ? (branches[index].items as Record<string, unknown>[]) : [];
    while (JSON.stringify(envelope).length > maxChars && items.length > 0) {
      items.pop();
      omittedItems += 1;
    }
  }
  let omittedBranches = 0;
  while (JSON.stringify(envelope).length > maxChars && branches.length > 0) {
    branches.pop();
    omittedBranches += 1;
  }
  if (JSON.stringify(envelope).length > maxChars) {
    const replacement: Record<string, unknown> = {
      content_trust: typeof envelope.content_trust === 'string'
        ? envelope.content_trust
        : 'untrusted_branch_evidence',
      truncated: true,
      consolidation_omitted_items: omittedItems,
      consolidation_omitted_branches: omittedBranches,
      warning: 'Consolidated remote branch evidence exceeded the lane budget; the branch omitted it for safety.',
    };
    return { envelope: replacement, omittedItems, omittedBranches };
  }
  if (omittedItems > 0) {
    envelope.truncated = true;
    envelope.consolidation_omitted_items = omittedItems;
  }
  if (omittedBranches > 0) {
    envelope.truncated = true;
    envelope.consolidation_omitted_branches = omittedBranches;
  }
  return { envelope, omittedItems, omittedBranches };
}

/**
 * Walk the FINAL pack and collect every ref it actually presents, in pack
 * order, deduped. Known positions only — no deep guessing, no invention:
 * remote items and session/knowledge records (`ref`), session groups (flat
 * `refs`, which mirrors the member refs).
 */
function collectPresentedRefs(pack: Record<string, unknown>): string[] {
  const presented: string[] = [];
  const seen = new Set<string>();
  const addRef = (value: unknown) => {
    if (typeof value !== 'string' || !value || seen.has(value)) return;
    seen.add(value);
    presented.push(value);
  };
  const addRecordRefs = (record: Record<string, unknown>) => {
    addRef(record.ref);
  };

  const remote = isRecord(pack.remote_branch) ? pack.remote_branch : {};
  for (const branch of (Array.isArray(remote.branches) ? remote.branches : []).filter(isRecord)) {
    for (const item of (Array.isArray(branch.items) ? branch.items : []).filter(isRecord)) addRecordRefs(item);
  }
  const session = isRecord(pack.session_records) ? pack.session_records : {};
  for (const entry of (Array.isArray(session.records) ? session.records : []).filter(isRecord)) {
    if (entry.type === SESSION_TURN_GROUP_TYPE && Array.isArray(entry.refs)) {
      entry.refs.forEach(addRef);
      for (const member of (Array.isArray(entry.records) ? entry.records : []).filter(isRecord)) addRecordRefs(member);
    } else {
      addRecordRefs(entry);
    }
  }
  const knowledge = isRecord(pack.local_knowledge) ? pack.local_knowledge : {};
  for (const entry of (Array.isArray(knowledge.entries) ? knowledge.entries : []).filter(isRecord)) addRecordRefs(entry);
  return presented;
}

/** Canonical JSON with recursively sorted object keys; arrays keep order. Deterministic. */
function stableStringify(value: unknown, depth = 0): string {
  if (depth > 32) return '"[depth]"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item, depth + 1)).join(',')}]`;
  const keys = Object.keys(value).sort();
  const entries = keys.map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key], depth + 1)}`);
  return `{${entries.join(',')}}`;
}

/** Deep clone through JSON: the pack is JSON-bound anyway, and this guarantees zero input mutation. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function cloneEnvelope(lane: unknown): Record<string, unknown> {
  return isRecord(lane) ? cloneJson(lane) : {};
}

/** Serialization size of one lane envelope, in UTF-16 code units (JSON-bound budget semantics). */
function laneCharSize(envelope: Record<string, unknown>): number {
  return JSON.stringify(envelope).length;
}

/** Member-record count of one session-lane entry (a group counts all its members). */
function countMembersOf(entry: unknown): number {
  if (!isRecord(entry)) return 0;
  if (entry.type === SESSION_TURN_GROUP_TYPE && Array.isArray(entry.records)) return entry.records.length;
  return 1;
}

function countSessionMembers(envelope: Record<string, unknown>): number {
  return (Array.isArray(envelope.records) ? envelope.records : [])
    .reduce((sum, entry) => sum + countMembersOf(entry), 0);
}

function countSessionGroups(envelope: Record<string, unknown>): number {
  return (Array.isArray(envelope.records) ? envelope.records : [])
    .filter(entry => isRecord(entry) && entry.type === SESSION_TURN_GROUP_TYPE).length;
}

function countLaneItems(envelope: Record<string, unknown>): number {
  return (Array.isArray(envelope.branches) ? envelope.branches : [])
    .filter(isRecord)
    .reduce((sum, branch) => sum + (Array.isArray(branch.items) ? branch.items.length : 0), 0);
}

function countLaneEntries(envelope: Record<string, unknown>): number {
  return Array.isArray(envelope.entries) ? envelope.entries.length : 0;
}

function positiveIntegerOption(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface SessionGroup extends Record<string, unknown> {
  type: typeof SESSION_TURN_GROUP_TYPE;
  stream: string;
  count: number;
  turns: number[];
  refs: string[];
  records: Record<string, unknown>[];
}
