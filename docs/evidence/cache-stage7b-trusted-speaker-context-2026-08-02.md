# Cache Goal Stage 7B: trusted speaker context

Date: 2026-08-02

Branch: `agent/cache-trusted-speaker-context`

Base: `agent/cache-runtime-context-events` (`5311b3a7`)

## Scope

This stage closes the model-visible identity boundary before further cache
optimization. It does not change provider cache accounting or claim progress
toward the 94% qualification threshold.

Covered paths:

- live CatsCompany P2P and group turns;
- string and multimodal content-block inputs;
- incremental native-group history hydration;
- full cloud session restore on a new device;
- human, other-Agent, and current-Agent role projection;
- busy-turn queue merging and native-group activation;
- cache benchmark capability attestation and the production-shaped participant fixture.

## Invariants

- A friendly name is model-visible only after it is bound to the authoritative
  transport `from_uid`/sender and trusted topic scope.
- Live messages additionally require `server_canonical_message` permissions and
  a canonical envelope bound to transport sender, topic ID/type, and the
  connected Agent ID.
- Every model-visible participant prefix contains a stable normalized ID.
- Other Agents are explicit user-role participants. Live messages use the
  optional server-canonical actor kind; agent-context history uses the
  server-assigned `other_agent_message` role.
- Only a record whose `from_uid` is the current Agent and whose reason is
  `current_agent_message` may become provider `assistant` history (P2P keeps
  the documented legacy missing-reason compatibility).
- A record whose top-level topic or Agent scope conflicts with the authenticated
  request/page is omitted rather than merely relabeled. Both `agent_id` and
  `agent_uid` must independently match.
- Labels are NFC-normalized, single-line, delimiter-safe, stripped of bidi and
  invisible controls, and capped at 80 Unicode code points.
- Queue wrappers never reinsert the raw sender label after the message has been
  normalized.
- Header-shaped content in a user body is escaped across plain strings, every
  rich text block, queues, and cloud restore; the trusted header is always a
  separate first rich block. Detection uses an NFKC/default-ignorable visual
  skeleton across every C0/C1 and Unicode line boundary; suspicious body lines
  are explicitly quoted and their opening bracket is neutralized.
- Stable IDs that require sanitization or truncation retain a SHA-256-derived
  suffix so distinct source IDs do not collapse to the same model-visible ID.
- Native Feishu group activation requires the server-materialized binding and
  trigger record, a top-level structured mention of the connected Agent, and
  the canonical envelope checks above. The repository publisher cannot place
  `mentions` in that top-level transport field through arbitrary metadata.
- Missing/legacy optional identity metadata degrades to a stable transport UID;
  explicit authority conflicts fail closed.

Canonical model-visible forms:

```text
[发言人: Alice; id=usr7]
[其他 Agent: Saturday; id=usr43]
```

## Verification

- `npm run build`: passed.
- Focused identity/history/content/activation/queue/cache benchmark tests:
  170 passed, 0 failed.
- Cloud restore security cases passed, including a page with mixed valid,
  cross-topic, cross-Agent, and forged-assistant records.
- Full runtime suite: 1,555 tests; 1,547 passed, 0 failed, 0 cancelled, 8 skipped.
- Compiled Dashboard launched against an isolated data root; `/` and
  `/api/status` both returned HTTP 200.
- Independent code, test, and security reviews reported no P0/P1/P2 blockers.
- No Dashboard or other UI source changed, so desktop/mobile visual interaction
  testing was not applicable to this stage.

## Security cases

The focused suite exercises:

- sender/actor mismatch, missing/forged permissions, and topic mismatch;
- unknown transport sender rejection;
- CR/LF, C0/C1, U+2028/U+2029, bidi, zero-width, bracket, semicolon, and equals
  delimiter injection;
- Unicode NFC and 80/81-code-point boundaries;
- same-name users with different stable IDs;
- human/other-Agent/current-Agent separation;
- per-record topic/Agent rejection on both incremental and full restore paths;
- conflicting `agent_id`/`agent_uid` pairs and cross-scope low/duplicate
  sequences that previously could terminate pagination or occupy a valid ID;
- participant-to-assistant role promotion attempts;
- string/content-block parity, forged body headers, and attachment preservation;
- raw sender re-injection through multi-message queue wrappers.
- external activation mismatches for actor, topic, Agent, permissions, native
  binding, and missing/wrong top-level structured mentions;
- benchmark self-attestation attempts without typed durable provenance, plus
  duplicate durable record IDs even when another otherwise-valid participant
  frame is present.

## Residual migration boundary

Legacy local CatsCompany session files predate internal framing provenance, so
an already-persisted string that resembles a participant header cannot be
cryptographically distinguished from a formerly trusted label. New live turns,
incremental history, and cloud restore are protected at ingestion. A later
session-lifecycle migration must add durable internal provenance before it can
rewrite old local files without corrupting valid historical labels.

## Deferred boundary

Authorized device/runtime display labels are a separate model-visible input
surface. Stage 7B deliberately does not expand into that surface; the next
stage must apply equivalent single-line and scope-bound handling to runtime
context without weakening the Stage 6 authorization checks.
