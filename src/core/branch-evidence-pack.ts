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
 * - No savings claims. Character counts in `diagnostics` are a raw packing
 *   audit only; on already-unique realistic input the consolidation is
 *   byte-identity (zero overhead, zero omissions), and any reduction claim
 *   must wait for real pack data.
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
 * - Remote dedup is scoped by ENVELOPE IDENTITY: items only dedup across
 *   branches whose `source`, `status`, and `evidence_verdict` are identical.
 *   The same item under `session_graph` (verdict `none`) and under `skill`
 *   survives in both, so the verdict gate and per-branch status annotations
 *   stay truthful — collapsing across different envelope identities could
 *   silently move evidence into the `none`-gated branch.
 * - A merge therefore only collapses records whose refs are byte-equal, so
 *   eliminating a duplicate can never lose a source ref: every surviving
 *   record still cites its own ref, in its original position.
 *
 * Session grouping (session lane only, bounded and strictly conditional):
 * - Records whose ref parses as `<stream>#<n>`, carry BOTH known
 *   `session_id` and `log_date`, and are ADJACENT IN INPUT ORDER group when
 *   they share the stream base, continue the run's single monotonic
 *   direction (|Δturn| = 1 in the same sign — no 5→6→5 zigzag), agree with
 *   the run's ESTABLISHED `session_id`/`log_date` (unknown metadata never
 *   bridges conflicting epochs), and the run holds fewer than
 *   MAX_SESSION_GROUP_MEMBERS records. Those stable coordinates are the
 *   only proof of "same stream, neighbor turns"; nothing else (text
 *   similarity included) can form a group. Groups are never reordered:
 *   member order is input order, and a group takes the position of its
 *   first member. Members keep every field, so corrections and conflicts
 *   stay individually visible.
 * - Grouping is presentation-only and must never cost retention: if the
 *   grouped serialization exceeds the lane budget, every group is unrolled
 *   back to plain records (which fit) before any tail drop. Wrapper
 *   overhead can therefore never displace a record that fit without
 *   grouping (`session_groups_unrolled` in diagnostics reports it).
 * - Records with unparsable/unknown metadata (opaque refs, `#summary`,
 *   missing `session_id`/`log_date`) are never grouped and never absorbed.
 *
 * Char budgets are HARD:
 * - Every cap loop re-serializes WITH its truncation/count markers already
 *   applied before declaring the lane fits, so marker bytes can never push
 *   a returned lane over budget.
 * - Envelope-only overflow (nothing left to drop, or no droppable array) is
 *   NOT returned oversize: the lane degrades to a bounded, explicit
 *   failure envelope — `truncated: true` + `consolidation_overflow: true`
 *   plus `content_trust`/`status`/`request_id`/`note` preserved fit-checked
 *   in that priority order ("whenever budget allows"). Never blank, never
 *   a fake empty, never a silent drop. (Below ~18 chars no JSON marker
 *   physically exists; the module then returns the smallest explicit
 *   marker `{"truncated":true}` and exceeds the absurd budget on purpose.)
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
 */

/** Lane char budgets, identical to the pre-consolidation projections. */
export const MAX_REMOTE_EVIDENCE_CHARS = 20_000;
export const MAX_SESSION_EVIDENCE_CHARS = 12_000;
export const MAX_KNOWLEDGE_EVIDENCE_CHARS = 8_000;

/** Marker type for an adjacent-turn session group. */
export const SESSION_TURN_GROUP_TYPE = 'session_turn_group';

/**
 * Upper bound on members per session group. Bounding caps the worst-case
 * wrapper overhead per group and the blast radius of any future whole-group
 * operation; larger runs become several contiguous groups.
 */
export const MAX_SESSION_GROUP_MEMBERS = 4;

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

interface SessionRun {
  base: string;
  /** 0 = open (no direction yet), 1 = ascending, -1 = descending. */
  direction: 0 | 1 | -1;
  sessionId: string;
  logDate: string;
  records: Record<string, unknown>[];
  coords: StreamCoords[];
}

/** Consolidate the three projected lanes into one deduplicated evidence pack. */
export function consolidateMemoryEvidencePack(
  input: ConsolidateMemoryEvidencePackInput,
  options: ConsolidateMemoryEvidencePackOptions = {},
): ConsolidateMemoryEvidencePackResult {
  const maxRemoteChars = positiveIntegerOption(options.maxRemoteChars, MAX_REMOTE_EVIDENCE_CHARS);
  const maxSessionChars = positiveIntegerOption(options.maxSessionChars, MAX_SESSION_EVIDENCE_CHARS);
  const maxKnowledgeChars = positiveIntegerOption(options.maxKnowledgeChars, MAX_KNOWLEDGE_EVIDENCE_CHARS);

  // Raw (pre-dedup) lane sizes for the packing audit, measured on the cloned
  // envelope right after the copy, before any consolidation.
  const remoteEnvelope = cloneEnvelope(input?.remoteBranch);
  const remoteCharsIn = laneCharSize(remoteEnvelope);
  let remoteItemsIn = 0;
  let remoteDuplicatesRemoved = 0;
  if (Array.isArray(remoteEnvelope.branches)) {
    const branches = remoteEnvelope.branches.filter(isRecord);
    // Item keys are scoped per envelope identity (source/status/verdict):
    // identical envelopes share a key space, different ones never merge.
    const keySpaces = new Map<string, Map<string, number>>();
    for (const branch of branches) {
      const items = Array.isArray(branch.items) ? branch.items.filter(isRecord) : [];
      remoteItemsIn += items.length;
      const identity = remoteEnvelopeIdentity(branch);
      let itemKeys = keySpaces.get(identity);
      if (!itemKeys) {
        itemKeys = new Map<string, number>();
        keySpaces.set(identity, itemKeys);
      }
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
  const cappedSession = capSessionLane(sessionEnvelope, maxSessionChars);

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
    session_groups_unrolled: cappedSession.unrolledGroups,
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
 * Envelope identity of one remote branch for dedup scoping: source, status,
 * and evidence_verdict. Items from branches with different identities are
 * never merged, so a verdict-`none` copy cannot swallow the same item served
 * under a healthy branch (and vice versa).
 */
function remoteEnvelopeIdentity(branch: Record<string, unknown>): string {
  return [
    typeof branch.source === 'string' ? branch.source : '',
    typeof branch.status === 'string' ? branch.status : '',
    typeof branch.evidence_verdict === 'string' ? branch.evidence_verdict : '',
  ].join('\u0000');
}

/**
 * Exact-duplicate elimination over one lane's item list. `keys` is the
 * lane-scope key map (remote callers pass one map per envelope identity;
 * session and knowledge lanes use their own).
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
 * same stream and neighbor turns. Strict admission rules:
 * - ref parses as `<stream>#<n>` AND the record carries BOTH known
 *   `session_id` and `log_date` (unknown metadata never joins a run, so a
 *   metadata-less record cannot bridge conflicting epochs);
 * - same stream base as the run;
 * - |Δturn| = 1 against the previous member, continuing the run's single
 *   monotonic direction (the first pair sets it; no zigzag 5→6→5→4);
 * - `session_id`/`log_date` equal to the run's ESTABLISHED values;
 * - run still below MAX_SESSION_GROUP_MEMBERS.
 *
 * Runs of ≥2 become groups; everything else stays a plain record in input
 * order. Input order is preserved everywhere.
 */
function groupAdjacentSessionRecords(records: Record<string, unknown>[]): { entries: Record<string, unknown>[]; groupsFormed: number } {
  const entries: Record<string, unknown>[] = [];
  let run: SessionRun | undefined;
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
    const metadata = groupMetadata(record);
    const previous = run ? run.coords[run.coords.length - 1] : undefined;
    let joins = false;
    if (run && coords && metadata && previous
      && coords.base === run.base
      && metadata.sessionId === run.sessionId
      && metadata.logDate === run.logDate
      && run.records.length < MAX_SESSION_GROUP_MEMBERS) {
      const delta = coords.turn - previous.turn;
      joins = delta === 1 && run.direction !== -1
        ? true
        : delta === -1 && run.direction !== 1;
    }
    if (run && joins && coords && metadata && previous) {
      run.direction = coords.turn - previous.turn === 1 ? 1 : -1;
      run.records.push(record);
      run.coords.push(coords);
      continue;
    }
    flush();
    if (coords && metadata) {
      run = {
        base: coords.base,
        direction: 0,
        sessionId: metadata.sessionId,
        logDate: metadata.logDate,
        records: [record],
        coords: [coords],
      };
    } else {
      entries.push(record);
    }
  }
  flush();
  return { entries, groupsFormed };
}

function buildSessionTurnGroup(base: string, members: Record<string, unknown>[], coords: StreamCoords[]): Record<string, unknown> {
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

/** Both provenance fields known (non-empty strings) — required for any group membership. */
function groupMetadata(record: Record<string, unknown>): { sessionId: string; logDate: string } | undefined {
  const sessionId = record.session_id;
  const logDate = record.log_date;
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  if (typeof logDate !== 'string' || !logDate) return undefined;
  return { sessionId, logDate };
}

/** `<stream>#<n>` ref → coordinates; anything else (opaque, `#summary`) → undefined. */
function streamTurnCoords(ref: unknown): StreamCoords | undefined {
  if (typeof ref !== 'string') return undefined;
  const match = ref.match(/^(.+)#([1-9][0-9]*)$/);
  if (!match) return undefined;
  const turn = Number(match[2]);
  return Number.isSafeInteger(turn) ? { base: match[1], turn } : undefined;
}

/**
 * Session-lane cap. Grouping is strictly conditional: when the grouped lane
 * exceeds the budget that the plain records fit, EVERY group is unrolled
 * back to plain records before any tail drop — wrapper overhead can never
 * displace a record that fit without grouping. Overflow beyond that is
 * handled by the shared tail-cap (markers counted inside the fits check)
 * and the bounded overflow envelope.
 */
function capSessionLane(
  envelope: Record<string, unknown>,
  maxChars: number,
): { envelope: Record<string, unknown>; omitted: number; unrolledGroups: number } {
  if (JSON.stringify(envelope).length <= maxChars) return { envelope, omitted: 0, unrolledGroups: 0 };
  const entries = Array.isArray(envelope.records) ? envelope.records : [];
  let unrolledGroups = 0;
  if (entries.some(isSessionGroup)) {
    unrolledGroups = entries.filter(isSessionGroup).length;
    envelope.records = entries.flatMap(entry => (isSessionGroup(entry) ? entry.records.slice() : [entry]));
    if (JSON.stringify(envelope).length <= maxChars) {
      return { envelope, omitted: 0, unrolledGroups };
    }
  }
  const outcome = tailCapArrayLane(envelope, 'records', maxChars);
  if (outcome.overflow) {
    return { envelope: boundedOverflowEnvelope(envelope, maxChars), omitted: outcome.omitted, unrolledGroups };
  }
  return { envelope, omitted: outcome.omitted, unrolledGroups };
}

/**
 * Tail-cap a lane envelope whose items live in a single top-level array
 * (`records` / `entries`). Truncation/count/status markers are applied
 * BEFORE every fits check, so the returned envelope is within budget
 * whenever anything fits at all. `overflow: true` means even the empty
 * array could not save enough and the caller must degrade to the bounded
 * overflow envelope. The envelope is mutated in place (private clone).
 */
function tailCapArrayLane(
  envelope: Record<string, unknown>,
  arrayKey: 'records' | 'entries',
  maxChars: number,
): { omitted: number; overflow: boolean } {
  const items = Array.isArray(envelope[arrayKey]) ? (envelope[arrayKey] as Record<string, unknown>[]) : [];
  let omitted = 0;
  for (;;) {
    envelope.truncated = true;
    if (omitted > 0) envelope.consolidation_omitted = omitted;
    else delete envelope.consolidation_omitted;
    if (arrayKey === 'entries' && omitted > 0) envelope.status = 'truncated';
    if (JSON.stringify(envelope).length <= maxChars) return { omitted, overflow: false };
    if (items.length === 0) return { omitted, overflow: true };
    omitted += countMembersOf(items.pop());
  }
}

/** Knowledge-lane cap: tail drops with in-loop markers, then bounded overflow. */
function capArrayLane(
  envelope: Record<string, unknown>,
  arrayKey: 'records' | 'entries',
  maxChars: number,
): { envelope: Record<string, unknown>; omitted: number } {
  if (JSON.stringify(envelope).length <= maxChars) return { envelope, omitted: 0 };
  const outcome = tailCapArrayLane(envelope, arrayKey, maxChars);
  if (outcome.overflow) {
    return { envelope: boundedOverflowEnvelope(envelope, maxChars), omitted: outcome.omitted };
  }
  return { envelope, omitted: outcome.omitted };
}

/**
 * Cap the remote lane. Truncation/count markers are applied before every
 * fits check (marker bytes can never push the result over budget). Tail
 * items are dropped first (last branch backward) so every branch keeps its
 * source/status/verdict visible as long as possible; only when every items
 * array is empty do tail branches go. Anything still over degrades to the
 * bounded overflow envelope with the consolidated warning text.
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
  let omittedBranches = 0;
  const applyMarkers = () => {
    envelope.truncated = true;
    if (omittedItems > 0) envelope.consolidation_omitted_items = omittedItems;
    else delete envelope.consolidation_omitted_items;
    if (omittedBranches > 0) envelope.consolidation_omitted_branches = omittedBranches;
    else delete envelope.consolidation_omitted_branches;
  };
  for (let index = branches.length - 1; index >= 0; index -= 1) {
    const items = Array.isArray(branches[index].items) ? (branches[index].items as Record<string, unknown>[]) : [];
    while (items.length > 0) {
      applyMarkers();
      if (JSON.stringify(envelope).length <= maxChars) {
        return { envelope, omittedItems, omittedBranches };
      }
      items.pop();
      omittedItems += 1;
    }
  }
  while (branches.length > 0) {
    applyMarkers();
    if (JSON.stringify(envelope).length <= maxChars) {
      return { envelope, omittedItems, omittedBranches };
    }
    branches.pop();
    omittedBranches += 1;
  }
  applyMarkers();
  if (JSON.stringify(envelope).length <= maxChars) {
    return { envelope, omittedItems, omittedBranches };
  }
  return {
    envelope: boundedOverflowEnvelope(
      envelope,
      maxChars,
      'Consolidated remote branch evidence exceeded the lane budget; the branch omitted it for safety.',
    ),
    omittedItems,
    omittedBranches,
  };
}

/**
 * Last-resort bounded lane envelope for ENVELOPE-ONLY overflow (nothing
 * droppable left, or no droppable array at all). Explicit failure markers
 * always come first; `content_trust`, `status`, `request_id`, and the note
 * (bounded to the remaining room) follow in priority order, each added only
 * while the serialized result stays within budget. Never oversize, never
 * blank, never a fake empty.
 */
function boundedOverflowEnvelope(
  envelope: Record<string, unknown>,
  maxChars: number,
  warning?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const addFitting = (key: string, value: unknown): void => {
    const candidate: Record<string, unknown> = { ...out, [key]: value };
    if (JSON.stringify(candidate).length <= maxChars) out[key] = value;
  };
  addFitting('truncated', true);
  addFitting('consolidation_overflow', true);
  if (typeof envelope.content_trust === 'string') addFitting('content_trust', envelope.content_trust);
  if (typeof envelope.status === 'string') addFitting('status', boundedNoteText(envelope.status, 64));
  if (typeof envelope.request_id === 'string') addFitting('request_id', boundedNoteText(envelope.request_id, 256));
  const noteSource = warning !== undefined && warning !== ''
    ? warning
    : (typeof envelope.note === 'string' ? envelope.note : undefined);
  if (noteSource) {
    const room = maxChars - JSON.stringify(out).length - '"note":""'.length;
    if (room > 0) addFitting('note', boundedNoteText(noteSource, room));
  }
  if (Object.keys(out).length === 0) {
    // Physically unrepresentable budget (below the size of any JSON
    // marker): return the smallest explicit failure instead of going silent.
    return { truncated: true };
  }
  return out;
}

function boundedNoteText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 12))}…[truncated]`;
}

function isSessionGroup(entry: unknown): entry is Record<string, unknown> & { records: Record<string, unknown>[] } {
  return isRecord(entry) && entry.type === SESSION_TURN_GROUP_TYPE && Array.isArray(entry.records);
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
    if (isSessionGroup(entry) && Array.isArray(entry.refs)) {
      entry.refs.forEach(addRef);
      for (const member of entry.records.filter(isRecord)) addRecordRefs(member);
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
  if (isSessionGroup(entry)) return entry.records.length;
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
