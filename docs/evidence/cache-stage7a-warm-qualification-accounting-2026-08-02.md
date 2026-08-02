# Stage 7A warm qualification accounting — 2026-08-02

This is a redacted measurement-contract record. It contains no credentials, provider endpoints,
prompt bodies, response bodies, or private provider evidence. This stage does not claim that a
provider has reached the 94% acceptance threshold, and it does not claim that the current workload is
yet capability-complete.

## Scope closed in this stage

- The strict benchmark protocol advances from v4 to v5. Manifest, round, attempt, ledger, and result
  schemas all reject prior-version evidence instead of silently reinterpreting an old streak.
- The required cache-partitioned cold call remains mandatory and fully fail-closed, but no longer
  contributes to either 94% qualification gate. The primary token-weighted ratio and the 25%-capped
  task ratio use only physical attempts labelled `warm` by the exact logical-call contract.
- Cold is diagnostic, not optional. Before its usage is separated, every cold physical attempt still
  passes outcome, quality, safety, oracle, execution-plan, capability, metadata, provider usage,
  cache-read source, range, stable-prefix, exact-count, nonce, ledger, and fingerprint validation.
  A missing or malformed cold call therefore remains invalid or unobservable and cannot be hidden by
  strong warm results.
- Result cells explicitly declare `qualification_cache_class=warm`. They retain warm qualification
  totals in the existing primary fields, valid cold-only evidence in `cold_*`, and valid observable
  usage from all physical provider attempts in `all_*`, including failed attempts that report usage.
  Cache writes remain excluded from every cache-read numerator.
- The manifest requires `include_cold_in_primary_ratio=false`. Setting it to true, presenting a v4
  manifest, or mixing v4 evidence with v5 is a schema error. A v5 acceptance sequence must start a new
  append-only ledger and earn three new consecutive qualifying rounds.

## Why this is capability-preserving

The change does not alter a model request, provider adapter, injected context, tool, skill, Goal,
Plan, subagent, Memory event, runtime feedback, device authorization, identity path, or session
restore path. It corrects only which already-validated usage samples answer the qualification
question. A deliberately isolated first request measures admission and has a different purpose from
the repeated requests that measure reusable-prefix performance.

The stricter gates continue to apply to cold and warm alike. In particular, a cache-hot cold call
cannot rescue warm evidence below 94%; a zero-hit cold call remains visible while valid 94% warm
evidence can qualify; and missing cold provider cache-read usage still makes the round unobservable.

## Verification

- `npm run build`: passed.
- Official `npm test`: 1,532 tests; 1,524 passed; 0 failed; 0 cancelled; 8 skipped.
- Focused cache benchmark suites: 64 tests; 64 passed; 0 failed, cancelled, or skipped.
- Coverage includes the exact 94% boundary, warm-only token weighting and task capping, cold-only and
  combined diagnostics, failed-attempt usage retention, hot-cold/low-warm rejection, zero-hit cold
  diagnostics, missing cold usage, variable and run-paired Memory Branch physical attempts, monotonic
  cold-to-warm calls, retries and incomplete attempts, strict v4 rejection for every evidence type,
  criteria downgrade rejection, deterministic report rendering, and the CLI 0/1/2 exit contract.
- The compiled application was started with an isolated data directory. The Dashboard root and
  `/api/status` both returned HTTP 200, after which the process stopped normally and the temporary
  directory was removed.
- Independent read-only evidence/security review approved the final diff with no P0-P2 finding. It
  verified that cold failures cannot be excluded, every branch physical attempt remains gated, old
  evidence cannot be reused, and the additional result fields do not expose prompts, endpoints,
  credentials, paths, or arbitrary provider errors.
- No dashboard or other UI files changed, so desktop/mobile visual and interaction testing was not
  applicable.
- `git diff --check` passed. A repository-diff secret scan is required again immediately before
  commit.

## Remaining work before final acceptance

The current online workload still recreates a same-shaped restored session for each logical call.
It does not yet prove cache behavior over a naturally growing conversation whose Goal, Plan,
subagent, runtime feedback, participant, device, tool, skill, and Memory state change over time.
Current capability attestation also observes the internal message model before provider-specific wire
lowering, so it cannot prove final Responses, Chat, DeepSeek, or Anthropic ordering and cache
placement.

Independent lifecycle audits additionally found that trusted speaker labels and provider-visible
authorized device routes need stronger provenance binding, runtime feedback and subagent state are not
fully recoverable, Plan is turn-local, skills are not yet canonically enumerated, and Anthropic moves
dynamic system context before the full transcript. Those are subsequent independent runtime and
benchmark stages. This v5 contract is only the measurement foundation that prevents cold admission
cost from distorting the warm 94% target while preserving all cold evidence and failure gates.
