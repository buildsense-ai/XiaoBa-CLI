# Stage 8 evidence: real-provider calibration and final acceptance binding

Date: 2026-08-02

## Scope

This stage makes calibration evidence impossible to confuse with final acceptance and binds the final decision across NewCLI and DeepSeek. It does not claim that the 94% target has been reached.

## Real-provider baseline

Two repository-external, private, sealed calibration canaries were run with provider-reported usage as the only cache-read source. Every recorded attempt passed the workload quality and safety gates.

- NewCLI / `gpt-5.6-sol`: warm physical attempts `45,056 / 59,372 = 75.887624%`; warm main `29,696 / 31,561 = 94.090808%`; warm Memory Branch `15,360 / 27,811 = 55.229945%`.
- DeepSeek / `deepseek-v4-flash`: warm physical attempts `67,840 / 75,562 = 89.780578%`; warm main `30,080 / 36,187 = 83.123774%`; warm Memory Branch `37,760 / 39,375 = 95.898413%`.
- The DeepSeek-compatible endpoint actually returned the nested OpenAI Chat cache field. The external credential contract now declares that exact source; native top-level DeepSeek usage remains a separately allowed explicit contract.

These runs are calibration only. They identified NewCLI branch tool-loop tails and the changing joined memory observation in the DeepSeek unsafe-action main call as the next optimization targets.

## Acceptance integrity changes

- Online manifests explicitly seal `benchmark_profile: calibration` and cannot be promoted to final success, while real ratio/quality/safety failures retain their stronger failed status.
- DeepSeek cache-read source selection is explicit, allowlisted, and fail-closed. Simultaneous OpenAI and DeepSeek cache fields are treated as ambiguous and unobservable.
- Final aggregation requires exactly NewCLI Responses and DeepSeek Chat Completions, at least 24 warm logical calls per case, and each provider's latest three passing rounds.
- Provider identity is bound to one consistent redacted endpoint instance, adapter, API type, and exact usage source.
- The provider-neutral workload contract is recomputed from concrete manifest cases instead of trusting a declared hash. It covers task fixtures, oracle, execution plan, scenario, surface, role, capabilities, and run counts.
- Both providers must bind the same recomputed workload/config and the same executable artifact fingerprint. The artifact now covers compiled code, prompts, package metadata, actual installed dependency bytes and contained symlink targets, plus the Node/V8/OpenSSL/platform/architecture runtime contract; external or modified installs can no longer hide behind the same lockfile hash.
- The outer online CLI never creates evidence. It validates the visible invocation and launches the actual runner as a one-time nonce-bound child with a minimal environment allowlist; a startup hook that deletes its own `NODE_OPTIONS`/argv trace therefore remains confined to the outer process. The evidence child rejects all remaining Node/native loader and TLS/CA variables plus prompt/profile/dotenv/config/model/test-root/data-root/identity overrides. It fixes prompt, identity, surface, retry, feedback, device-alias, skills, and runtime inputs, creates read-only deterministic controls, and verifies the real `PathResolver` source and every derived root after dynamic import and before sealing.
- The acceptance reader takes the online writer lock, verifies exact ledger/evidence/reservation round sets, and requires every reservation to contain one matching `started` record followed by one matching `sealed` record. Active, incomplete, orphaned, extra, replaced, weak-mode, wrong-owner, or symlinked evidence fails closed.
- A valid observable provider result that misses the target remains a normal failed acceptance (exit 1); malformed or unobservable evidence is invalid (exit 2).

## Verification

- `npm run build`: passed.
- Focused cache benchmark, online foundation, and acceptance coverage is included in the official full suite below.
- Focused OpenAI/DeepSeek runtime feedback tests: 25/25 passed.
- Official runtime suite: 1,639 total / 1,631 passed / 0 failed / 8 skipped.
- The acceptance CLI independently rejected the two one-warm-call calibration canaries as non-acceptance evidence.
- Secret scan of repository changes found no provider credential or endpoint value.
- The actual Dashboard started against an isolated runtime root on port 4392; `/`, `/api/status`, and `/readiness` returned HTTP 200, then the process exited cleanly.
- No dashboard or other UI files changed, so desktop/mobile visual and interaction testing was not applicable.

## Review history

The frozen-tree reviews found two result-classification bugs and a sequence of acceptance-integrity gaps: calibration masking a real failure, ordinary provider failure becoming invalid, missing online reservation validation, self-declared workload identity, weak provider identity matching, an artifact hash that did not bind the actual runtime/install, unsealed prompt/profile inputs, incomplete loader/TLS/test-root coverage, and a self-erasing preload bypass in the original same-process design. Each finding received a regression test. The final design isolates the runner in a minimal-environment child and validates the actual path resolution rather than trusting environment strings.
