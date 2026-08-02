# XiaoBa context, cache, and recovery architecture

This document is the working contract for context construction, provider lowering, prompt-cache
behavior, compaction, and model-call recovery. It describes the code after the cache/reliability
workstream based on `origin/main` at `b38f2f46`.

## Plain-language model

XiaoBa should keep the beginning of a model request stable, put frequently changing information at
the end, and never replay provider-private state across a model or API boundary. A model call is
prepared in four layers:

```text
durable transcript
  -> typed session / episode / call context
  -> structural preflight and provider-state scoping
  -> OpenAI Responses, Chat Completions, or Anthropic wire format
  -> one exact attempt record in Cache Trace / Turn Errors
```

Cache Trace is a development sidecar. It observes exact provider attempts but does not participate
in request construction, retry decisions, or session persistence. Turning it off must not alter the
wire request.

## Context lifecycle contract

`Message.__context` is internal metadata and is removed by provider serializers. It carries three
orthogonal facts:

- `lifecycle`: when the information may be reused (`session`, `episode`, or `call`);
- `cacheScope`: whether it belongs to the stable prefix, one cache epoch, or only this request
  (`stable`, `epoch`, or `volatile`);
- `persistence`: whether it is stored in the durable transcript or rebuilt transiently.

| Context source | Lifecycle | Cache scope | Persistence | Placement / reason |
|---|---|---|---|---|
| Core system prompt and stable tool schemas | session | stable | durable or rebuilt | Earliest prefix; changing these should intentionally invalidate the cache |
| Runtime-observation rules and Skills list | session | stable | transient | Stable session policy before per-turn state |
| Current execution identity, Goal, plan status, runtime feedback, subagent state | episode | epoch | transient | Same throughout one user-turn episode; changes on the next episode |
| Pending-user-input boundary | episode | epoch | transient | Prevents queued user text from being confused with durable history |
| Current directory, shell, branch, and request-only hints | call | volatile | transient | Last possible position; never summarized or persisted |
| Compaction instruction | call | volatile | transient | One-off model request with cache bypass |
| Compaction summary / boundary | session or episode | epoch | durable | Explicit durable replacement for old history; starts a new cache epoch |
| Pruned tool-result placeholder | episode | epoch | durable | Preserves tool ID, hash, head/tail, and retrieval instructions |

An internal field alone is not a provider instruction. Each provider cache policy resolves these
annotations into its own wire dialect. Legacy prefix tags remain only as a compatibility fallback.

## Provider-specific behavior

| Path | Stable prefix policy | Provider-private replay | Usage normalization |
|---|---|---|---|
| OpenAI Responses | Stable system text and canonicalized, sorted tools; official OpenAI gets a stable `prompt_cache_key` and supported GPT-5.6 models get an explicit breakpoint | Opaque response items are replayed only when endpoint, model, and API type match | `input_tokens_details.cached_tokens` |
| OpenAI Chat Completions | Leading stable system messages and canonicalized, sorted tools; compatible endpoints rely on their own automatic prefix cache | `reasoning_content` is replayed only inside the exact provider-state scope | OpenAI nested cached tokens plus DeepSeek `prompt_cache_hit_tokens` |
| Anthropic Messages | On canonical Anthropic, markers are placed after stable tools, stable system text, and the latest growing conversation boundary | Signed thinking/tool blocks are replayed only inside the exact provider-state scope | `cache_read_input_tokens` and `cache_creation_input_tokens` |
| DeepSeek Responses / Chat | Automatic exact-prefix disk cache; no OpenAI-only marker is sent | Thinking tool exchanges preserve `reasoning_content`; evidence-driven recovery retries once with the alternate replay dialect when a 400 explicitly identifies it | Responses nested cached tokens; Chat top-level cache-hit tokens |

DeepSeek's cache is automatic and best-effort. Its documented cache units explain why two requests
with different suffixes may establish a common prefix only for a third request. See the
[DeepSeek context-caching guide](https://api-docs.deepseek.com/guides/kv_cache/). OpenAI similarly
requires an exact shared prefix and recommends putting static content first; see
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). Anthropic's
breakpoints have their own ordering and lifetime rules; see
[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

### Cache bypass

Checkpoint generation and other one-off summarization calls set `cacheMode: 'bypass'`. This removes
explicit markers and routing keys for that request and is visible as a distinct Cache Trace
strategy. A one-off summary should not create a paid cache entry that no later normal turn can
reuse.

## Structural legality and the former 400 failure

Before every provider attempt, preflight enforces legal tool-call adjacency and repairs only the
minimum malformed historical exchange. Provider-private blocks carry a fingerprint of API type,
normalized endpoint, and model. Switching model, endpoint, Responses/Chat, or Anthropic/OpenAI
therefore drops only the incompatible opaque state while retaining visible conversation content.

For DeepSeek thinking tool calls, the first assistant tool-call response may include private
`reasoning_content`. The matching tool result and private state must be replayed together. If an
endpoint explicitly rejects the chosen dialect, XiaoBa can perform one evidence-driven replay
repair; a generic 400 is not blindly retried as if it were transient.

Local synthetic observations are not fabricated DeepSeek tool history. Before DeepSeek thinking
preflight, only the paired local synthetic assistant/tool representation is lowered to a transient
user observation with the same provenance. Real provider tool history and provider reasoning state
remain unchanged. If a DeepSeek turn reaches `max_tokens` without visible text or a tool call, the
one-shot recovery hint is appended as an injected user tail after the complete assistant/tool
exchange; it never splits the reusable history prefix.

## Goal and memory branches

Goal state is typed session state, not an arbitrary durable marker. `GoalRuntime` validates updates,
persists its snapshot with the session, restores it after process/session recovery, and formats the
trusted `goal_status` fragment for the next turn. Persistence failure rolls the in-memory update
back and fails closed. Runtime state is committed through a private temporary file, file fsync,
atomic rename, and directory fsync, so a failed write cannot truncate the previously recoverable
Goal. Clearing a Goal stores an explicit tombstone that blocks legacy-state resurrection.

Memory search runs in a distinct observation branch with its own trace identity and a stable cache
partition. The branch may publish a provenance-linked synthetic observation, explicitly suppress a
redundant result, be discarded, be cancelled, or fail. Joined mode waits before the primary model
call when an exact capability chain must be verified; detached mode remains the production default
and can deliver a late observation without blocking the main response. Branch tool-loop usage is
real provider usage and must never be dropped from cache scoring.

A published memory ref is not trusted merely because the model included it in the finish payload.
The read tools record successful canonical refs and SHA-256 fingerprints inside the branch; finish
accepts only those verified refs, and provenance-aware consumers can require the corresponding
receipt. Production memory file reads reject symlink components and verify the opened regular-file
identity before and after reading. Benchmark fixtures additionally use a held, isolated sealed
source so concurrent path replacement or unrelated global logs cannot alter capability evidence.

Ordinary memory queries receive a day-stable UTC clock. Queries with relative-time intent retain a
minute-bucket timestamp, preserving searches such as “刚才”, “半小时前”, “last 90 seconds”, or “earlier this morning” without changing the
initial provider request at millisecond cadence.

This is the key distinction in error handling:

- transient transport/load/rate failures can retry within a bounded time window;
- invalid credentials, quota exhaustion, context overflow, and structural 400s stop immediately or
  enter a targeted recovery path;
- once visible stream output has started, the request is not replayed automatically;
- every actual provider invocation has a correlated `started` and terminal attempt event;
- a final interrupted turn links to its provider attempt in the Turn Errors report.

## Compaction and pruning

XiaoBa compacts at a provider-aware prompt budget, not a single model-independent threshold. It
reserves output space, keeps recent verbatim turns, builds an iterative durable summary, and starts
a new cache epoch. The compaction model call itself bypasses the prompt cache.

Before paying for a summary, deterministic pruning can replace sufficiently old, large tool results.
The active mid-turn episode and the newest results are protected. A replacement retains protocol
identity, content SHA-256, character count, a bounded head/tail preview, and an instruction to rerun
the tool or reread the source. If pruning does not recover enough budget, normal compaction follows.

Native OpenAI Responses compaction is deliberately not enabled yet. Its opaque compaction items
cannot currently be persisted and replayed losslessly through XiaoBa's generic `Message` transcript.
Encoding them as visible text would create a subtle correctness bug. The future prerequisite is a
durable provider-native item algebra; see
[OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction).

## Comparison with pi and OpenCode

The comparison used pinned snapshots so later upstream changes do not silently change these
conclusions:

- `earendil-works/pi` at `aa0ec808b970db31822e07835a46647cb51d9d66`;
- `anomalyco/opencode` at `32f278b48f1a495611165d8a9f1ace0b512933e2`.

| Concern | pi | OpenCode | XiaoBa after this workstream |
|---|---|---|---|
| Provider adaptation | Dedicated adapters normalize reasoning and cache usage, including DeepSeek's top-level hit field | AI SDK plus model/provider transforms and provider options | Three explicit wire paths with scoped opaque replay and normalized cache metrics |
| Cache affinity | Session IDs and provider-specific cache controls; one-off summaries use a fresh route and no cache retention | Stable session/request headers and sorted tools | Stable partition key, canonical tool order, provider cache plans, and request-level bypass |
| Compaction | Turn-aware cut point, iterative structured summary, recent tail, file-operation carry-forward | Turn-aware head/tail selection, durable compaction parts, bounded recent budget | Checkpoint summary plus recent tail, durable boundary/epoch, remote watermarks, cache bypass |
| Large tool output | Truncates tool results in summarization input | Marks old completed tool parts compacted after protecting recent turns/tokens | Deterministic durable pruning with protocol IDs, hashes, head/tail, and recovery instruction |
| Provider metadata | Adapter-owned reasoning blocks | Part-level provider metadata is omitted when replaying under a different model | `providerState` fingerprints endpoint/model/API type and blocks cross-boundary replay |
| Retry | Adapter retry policies | Typed API/context errors and header-aware retry delays | Typed classifier, bounded retry window, stream-output guard, exact attempt and terminal-turn records |
| Transient context | Primarily rebuilt runtime context and extension messages | System/user parts and plugins, without a shared lifecycle taxonomy | Explicit session/episode/call + stable/epoch/volatile + durable/transient annotations |

Relevant upstream code:

- pi [compaction](https://github.com/earendil-works/pi/blob/aa0ec808b970db31822e07835a46647cb51d9d66/packages/agent/src/harness/compaction/compaction.ts)
  and [OpenAI-compatible usage parsing](https://github.com/earendil-works/pi/blob/aa0ec808b970db31822e07835a46647cb51d9d66/packages/ai/src/api/openai-completions.ts);
- OpenCode [compaction/pruning](https://github.com/anomalyco/opencode/blob/32f278b48f1a495611165d8a9f1ace0b512933e2/packages/opencode/src/session/compaction.ts),
  [provider-metadata replay](https://github.com/anomalyco/opencode/blob/32f278b48f1a495611165d8a9f1ace0b512933e2/packages/opencode/src/session/message-v2.ts),
  and [request preparation](https://github.com/anomalyco/opencode/blob/32f278b48f1a495611165d8a9f1ace0b512933e2/packages/opencode/src/session/llm/request.ts).

## Measurement contract

Cache improvements must be evaluated as repeated sequences, not screenshots of one request:

1. Keep model, endpoint, tool set, stable system SHA, and cache partition fixed.
2. Change only a typed episode/call suffix.
3. Seed the cache, then run at least two follow-ups; some providers persist the common prefix only
   after observing multiple requests.
4. Compare exact attempt usage: input, cache read, cache write, fresh input, latency, retries, and
   terminal outcome.
5. Separately evaluate semantic retention after pruning/compaction; a high hit ratio is not useful if
   the agent forgets required facts.
6. Separate deterministic fixed-fixture calibration from final performance evidence. Final suites
   must include changing dynamic task tails, growing multi-turn/tool histories, session restore,
   production-default detached memory behavior, and real project tasks.

Reproducible billable probes are documented in [PROVIDER_CANARIES.md](./PROVIDER_CANARIES.md).
The local evidence for this workstream is in
[cache-canary-2026-08-02.md](./evidence/cache-canary-2026-08-02.md).

## Known boundaries and next experiments

These are deliberate follow-ups, not hidden claims of completeness:

1. **Anthropic-compatible cache markers**: keep them disabled until a canary proves one exact
   endpoint/model pair. The capability should eventually be stored per endpoint fingerprint and
   model, not as a global boolean. The available local compatible credential returned 401, so no
   proof exists yet.
2. **Native Responses compaction**: requires lossless persistence of provider-native response items
   before it can replace generic summaries.
3. **Exact token admission**: local estimation is conservative but not identical to every provider
   tokenizer. A future count-tokens adapter could reduce premature or late compaction.
4. **Longitudinal evaluation**: canaries are manual and billable. A scheduled job should record
   model/endpoint fingerprints, latency, cache ROI, and semantic-retention scores without storing
   prompts or credentials.
5. **Trace retention**: Cache Trace and Turn Errors need an explicit age/size retention policy before
   very long-running development profiles accumulate unbounded files.

None of these justify coupling Cache Trace into the core request path. They should remain separate
capability, persistence, and evaluation modules.
