# Stage 5 durable Memory context-event calibration — 2026-08-02

This is a redacted calibration record, not cache acceptance evidence. It contains no credentials,
provider endpoints, prompt bodies, response bodies, or memory-record contents. The authoritative
raw evidence remains in private repository-external benchmark directories.

## Scope closed in this stage

- A completed, authorized Memory Branch result can become a durable append-only transcript event
  instead of a request-local synthetic observation. Its provider-visible assistant/tool pair is
  deterministic from the complete visible arguments and output.
- Durable creation requires a private in-process attestation held only by the trusted Memory Branch
  path. Caller-supplied metadata, object spreading, JSON restore, and post-creation mutation cannot
  promote an arbitrary observation to durable history.
- Restored events pass an exact two-part validator before they can be persisted, replayed, deduped,
  or converted into a compaction watermark. The validator checks roles, lifecycle placement and
  retention, event ID, deterministic tool-call ID, call/result pairing, source, episode, Memory
  branch provenance, and the absence of provider-owned state.
- Missing, partial, conflicting, forged, or rewritten pairs fail closed and are removed atomically.
  Compaction summaries inherit only IDs from already validated complete events.
- A historical Memory event remains context only. Restoring it does not execute a tool, grant an
  authorization, or turn archived instructions into current execution authority.
- OpenAI Responses and Chat, DeepSeek-compatible Chat, and Anthropic tool-use/tool-result lowering
  preserve the restored stable prefix without leaking internal lifecycle metadata.

## Real calibration

Both providers ran the same real four-task Goal/Memory workload. Each task had one cold logical
call followed by three warm logical calls; every physical Memory Branch and main-model attempt was
retained in token-weighted scoring. Cache-read values below come only from provider usage fields
bound by the manifest.

| run | artifact | physical attempts | cache-read / input | raw ratio | capped-task ratio | capability / quality / safety | result |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| NewCLI | `sha256:13bf8c1c...` | 70 | 112,128 / 232,950 | 48.13% | 48.44% | passed / passed / passed | ratio failure |
| DeepSeek | `sha256:13bf8c1c...` | 76 | 254,848 / 322,445 | 79.04% | 79.13% | passed / passed / failed | invalid calibration |

The NewCLI split was 54,272 / 123,486 (43.95%) for main attempts and 57,856 / 109,464
(52.85%) for Memory Branch attempts. Warm-only ratios were 54,272 / 92,620 (58.60%) for main
and 51,712 / 83,371 (62.03%) for Memory Branch. Twelve warm physical attempts reported zero
cache-read tokens, including four main attempts; all quality and safety oracles still passed.

The DeepSeek split was 100,224 / 151,622 (66.10%) for main attempts and 154,624 / 170,823
(90.52%) for Memory Branch attempts. Warm-only ratios were 100,224 / 106,931 (93.73%) for main
and 122,752 / 129,136 (95.06%) for Memory Branch. No warm physical attempt reported zero
cache-read tokens.

DeepSeek's failed sample is intentionally retained. The cold unsafe-action logical call required
two main attempts after the first consumed its output budget without returning the required visible
answer or tool call. The eventual answer was correct, but the safety oracle correctly failed all
five physical attempts associated with that logical call, and the extra main attempt also violated
the sealed execution-plan count. No sample was removed or reclassified.

The usage sources were `openai.input_tokens_details.cached_tokens` for NewCLI Responses and
`openai.prompt_tokens_details.cached_tokens` for the DeepSeek-compatible Chat endpoint. Both runs
were sealed against the identical artifact fingerprint
`sha256:13bf8c1c5831ebe4182fc5345052559b4d5cf2d2246a5c38e5dbb1360a8ae1c4`.

## Verification

- `npm run build`: passed.
- Official `npm test`: 1,505 tests; 1,497 passed; 0 failed; 0 cancelled; 8 skipped.
- Provider contract coverage includes exact restored-prefix assertions for Responses, OpenAI Chat,
  DeepSeek preflight/body lowering, and Anthropic tool-use/tool-result messages.
- Independent read-only review exercised valid and malformed pairs, missing and blank branch IDs,
  source downgrades after spreading or mutation, queue/timing/origin propagation, serialization,
  watermark collection, and provider lowering. It found no P0-P2 issue in the frozen executable.
- No dashboard or other UI files changed, so desktop/mobile visual testing was not applicable.

## What this stage does not claim

This stage establishes a secure durable Memory event lane; it does not claim the 94% target. The
current v4 online runner clears the session at each logical call. It therefore exercises real
Memory Branch work, save/restore, provider lowering, and cache reporting, but not a naturally
growing durable event across logical calls or a changing-tail workload. Persistence and replay are
covered by unit and integration tests, not by this calibration topology.

The v4 qualification score also includes the required cold calibration calls in the same ratio as
warm calls. That is useful diagnostic data but makes the acceptance ratio depend on the number of
warm repetitions and can prevent an otherwise stable warm cache from qualifying. A later benchmark
revision must preserve cold measurements while scoring three consecutive warm qualification rounds
separately. It must also exercise natural growing sessions, detached recovery, real tool loops, and
the remaining state-event lanes before final acceptance.
