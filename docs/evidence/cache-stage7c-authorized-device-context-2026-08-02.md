# Cache Goal Stage 7C: authorized device context

Date: 2026-08-02

Branch: `agent/cache-authorized-device-context`

Base: `agent/cache-trusted-speaker-context` (`ddface00`)

## Scope

This stage makes authorized-device context cache-stable without weakening the
runtime authorization boundary. It does not claim that either real provider has
reached the final 94% cache-read threshold.

Covered paths:

- canonical device grants, selection, routes, and execution scope parsing;
- model-visible authorized-device projection and typed capability witness;
- live parent turns, busy queues, pending input, subagents, and tool dispatch;
- authority-only controls, session restore, restart, and concurrent writers;
- production-shaped online benchmark attestation with a real remote transport.

## Invariants

- Raw device IDs, grant IDs, installation IDs, body IDs, and user-controlled
  labels are not injected into provider context. Stable HMAC-derived aliases are
  used instead.
- The model sees only operations that survive canonical scope, grant, selection,
  expiry, transport, and route checks. Explicit empty or invalid selection is
  deny-all; omission remains semantically distinct.
- A model-visible authorized-device witness is accepted only when the same real
  turn has a compatible remote transport and matching target-bearing tool schema.
- Tool dispatch re-reads the shared live lease. Revocation after prompt creation
  therefore blocks execution even when an older context object still contains a
  copied grant.
- Authority is isolated by session and canonical participant scope. Group
  participants cannot overwrite one another's pending grants.
- Pre-session authority is represented by a connector-level live
  `DeviceAuthorityState`, persisted immediately, then transferred into the new
  `AgentSession` without replaying the same revision.
- Grant-base plus newer selection-only deltas are applied in order in both
  connector/session transfer and pending-input queue paths.
- Versioned floors survive restart. Lower revisions, equal-revision conflicts,
  partial transactions, missing/corrupt state, persistence failure, and stale
  cross-process writers fail closed.
- Pending connector leases are bounded by a 24-hour TTL and 4,096 canonical
  scopes. Eviction occurs only after a durable revoked floor is confirmed; on
  persistence failure the in-memory revoke is retained.
- A newer authority-only revoke received while an older message is restoring a
  cloud session is applied before that older turn can run.

## Verification

- `npm run build`: passed.
- Focused authority, connector-flow, and pending-input tests: 91 passed, 0 failed.
- Official runtime suite (independently repeated): 1,621 tests; 1,613 passed,
  0 failed, 0 cancelled, 8 skipped.
- `git diff --cached --check`: passed.
- Compiled Dashboard launched against an isolated data root; `/`, `/api/status`,
  and `/readiness` returned HTTP 200, then the process exited cleanly.
- Independent code and security reviews found no residual P0/P1/P2 issue; the
  independent test review used the same frozen staged tree.
- Staged secret scans found no benchmark credentials or provider endpoints.
- No Dashboard or other UI source changed, so desktop/mobile visual interaction
  testing was not applicable to this stage.

## Security and capability cases

The test matrix includes:

- empty revoke, unavailable selection, explicit empty operations, malformed
  selection, stale replay, equal-revision conflict, and delayed full snapshots;
- authority-only active grants followed by grant-omitting text;
- denied selection retaining a grant base for a later selection-only activation;
- delegated grants when the speaker-owned selection is unavailable;
- two group participants with independent pre-session authority;
- cloud-restore revoke races and restore failure;
- connector lease adoption by a real `AgentSession`;
- queue-carried older grant base plus newer selection delta and restart replay;
- cross-process durable-floor compare-and-tombstone and stale live-lease clearing;
- transaction failure before the pending marker, corrupted/missing markers, and
  persistence failure during revoke/TTL eviction;
- per-operation expiry, remote transport gating, dispatch-time revalidation,
  subagent lease sharing, and runtime context refresh;
- benchmark attempts to self-attest device capability without real transport,
  compatible target schema, or provider-reported cache-read usage.

## Next stage

Run the production-shaped benchmark against the two configured test providers,
using provider-returned cache-read usage as the only cache-hit numerator. Record
three consecutive token-weighted rounds per provider, identify remaining prefix
churn, and iterate without relaxing any invariant above.
