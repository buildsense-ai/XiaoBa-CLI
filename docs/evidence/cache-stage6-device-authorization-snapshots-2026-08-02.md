# Stage 6 device authorization snapshots and remote routing — 2026-08-02

This is a redacted capability and security record. It contains no credentials, provider endpoints,
prompt bodies, response bodies, device identifiers from a live account, or private CatsCo traffic.
This stage does not claim progress toward the 94% cache acceptance threshold.

## Scope closed in this stage

- Canonical CatsCo `device_grants` is represented as a complete, scope-bound snapshot. Presence is
  significant: empty, revoked, all-invalid, and malformed containers clear prior device authority.
  A missing field remains backward-compatible and does not invent an update.
- Pending messages atomically replace device grants instead of unioning them. Higher revisions win,
  delayed lower revisions cannot restore old permissions, semantically identical equal revisions are
  idempotent across grant/operation ordering, and true equal-revision conflicts fail closed.
- When a versioned snapshot is followed by an unversioned snapshot, ordering cannot be proven, so
  authority is cleared rather than retaining a potentially broader grant. Local file grants remain a
  separate additive capability and are not affected by device-authority replacement.
- Runtime target routes are discovery hints only. Named participants and `speaker_default` must also
  resolve an active, unexpired, server-canonical grant bound to the current session, topic, actor,
  agent, owner, device, and requested operation. Dispatch repeats the authorization and validates the
  exact tool/operation pair, preventing a resolved route from being forged or mutated later.
- Group capability is preserved: a different participant's device remains usable only through the
  existing server-canonical `channel_identity_link` delegation path. Ordinary cross-user grants and
  Thin RPC envelopes are rejected.
- Thin Tool RPC now uses a distinct `thin_tool_rpc_authority_v1` capability. The source exposes the
  strict transport only after server negotiation, and the target advertises the same capability in
  device registration. Without that end-to-end contract, routing falls back to negotiated Device RPC
  or fails before remote execution.
- Authority-v1 requests and results bind protocol version, grant, session/topic, actor/owner, identity
  source, agent, device, operation, and tool. Missing, stripped, expired, mismatched, unsupported, or
  overlong envelopes are rejected at the receiver before tool execution and at the source before a
  result is accepted.
- The receiver keeps a bounded replay cache with in-flight protection and a five-minute tombstone.
  Concurrent or repeated delivery of the
  same request ID and canonical envelope reuses one execution; a conflicting envelope is rejected,
  and cache saturation fails closed without evicting an unexpired request that could then run twice.

## Compatibility behavior

- Legacy servers advertising only `thin_tool_rpc` do not receive authority-v1 Thin requests. If they
  advertise `device_rpc`, the already validated route uses that transport; otherwise the request is
  reported unavailable before a remote side effect.
- A legacy source sent to a new receiver, or a server that strips authority-v1 fields, is rejected
  before local file or shell tools execute.
- The new-source/old-target ambiguous-success case is excluded by the authority-v1 server contract:
  the feature means the server routes only to a target that advertised the same device capability.
- Existing first-party Cats messages with a canonical grants array keep their full supported
  operations. The fail-closed cases are limited to contradictory, malformed, stale, or unverifiably
  ordered authority.

## Verification

- `npm run build`: passed.
- Official `npm test`: 1,524 tests; 1,516 passed; 0 failed; 0 cancelled; 8 skipped.
- Coverage includes explicit empty and malformed revocation, atomic downscope, expired replacement,
  delayed and unversioned ordering, equal-revision idempotence/conflict, group delegation, route and
  dispatch revalidation, old/new/stripped Thin protocol cases, Device RPC fallback, complete result
  binding, concurrent/replayed/conflicting request IDs, and a long execution crossing its original
  request expiry without losing the in-flight replay tombstone.
- The compiled application was started with an isolated data directory. The Dashboard root and
  `/api/status` both returned HTTP 200, after which the process stopped normally and the temporary
  directory was removed.
- Independent read-only snapshot review approved the final snapshot/queue implementation with no
  residual P0-P2 finding. Independent route/RPC review identified cross-user receiver validation,
  mixed-version execution ambiguity, and replay lifecycle gaps; after correction and re-testing, it
  also approved the final implementation with no residual P0-P2 finding.
- No dashboard or other UI files changed, so desktop/mobile visual and interaction testing was not
  applicable.
- `git diff --check` and a repository-diff secret scan are required again immediately before commit.

## Cache relevance and remaining work

This stage secures a core capability that future cache benchmarks must exercise, but it intentionally
does not reshape provider-visible prompts or use provider cache-read usage as evidence. Later benchmark
stages must vary device authorization, participant targeting, revocation, fallback transport, and
session recovery while preserving a stable cacheable prefix. Cold diagnostics must remain separate
from three consecutive warm qualification rounds.
