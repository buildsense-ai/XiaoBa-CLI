# Stage 9 evidence: primary and auxiliary cache accounting

Date: 2026-08-02

## Scope

This stage freezes the acceptance boundary requested for Memory Branch traffic:

- main-agent model attempts are `primary` and alone qualify against the 94% target;
- asynchronous Memory Branch attempts are `auxiliary_memory` and do not pass or fail on cache ratio;
- every auxiliary physical attempt still requires real provider usage, terminal success, quality, safety, declared capability/provenance, ordering, metadata, and stable-prefix evidence;
- a cache-hot auxiliary branch cannot rescue a low primary ratio, and a cache-cold branch cannot lower a passing primary ratio.

The evidence schema is v6 because this changes scoring semantics. Traffic class is derived from the sealed execution role and is included in cell and capability-scope fingerprints and reports.

## Baseline reinterpretation

The private Stage 8 calibration evidence was reinterpreted without changing any provider usage:

- NewCLI primary warm usage: `29,696 / 31,561 = 94.090808%`.
- NewCLI auxiliary Memory Branch warm usage: `15,360 / 27,811 = 55.229945%`.
- DeepSeek primary warm usage in the one-warm canary: `30,080 / 36,187 = 83.123774%`.
- DeepSeek auxiliary Memory Branch warm usage: `37,760 / 39,375 = 95.898413%`.

The NewCLI result therefore already crosses the primary boundary even though its branch does not. The DeepSeek one-warm result does not yet qualify, but inspection of the prior three-warm provider evidence showed that the unsafe-action main prefix learned after its first warm request: `3,072 / 9,095`, then `8,832 / 9,065`, then `8,832 / 9,070`. A separate real-provider probe reproduced the same admission behavior for both exact and changing dynamic tails. The low first hit is retained in the formal denominator; no observation/provider rewrite is justified.

## Integrity controls

- Primary and auxiliary cases with the same provider/model/API/surface occupy different cells.
- Primary cells retain the raw token-weighted and 25%-task-capped 94% gates. Auxiliary cells report raw/cold/all totals but have no ratio or task-cap threshold.
- Observable usage from failed warm attempts remains in the denominator while the attempt invalidates the round; failure cannot hide low cache usage.
- Each primary logical call still requires exactly one physical attempt, preventing appended cache-hot calls from padding the ratio. Branch tool loops may contain multiple fully recorded attempts.
- Primary capability scopes must cover all eleven Goal capabilities. Auxiliary scopes must cover every capability declared by their branch cases, including `memory` only when evidence-backed provenance was observed.
- Final provider identity and the 24-warm minimum apply to primary cases. A separate auxiliary small-model provider is allowed, but the current joined topology requires its declared logical-call schedule to match each paired main case.
- Final acceptance recomputes a versioned official topology fingerprint over task fixtures, oracle and execution plans, scenario, surface, role, capabilities, and run identity. Provider fields and warm counts are checked separately, every provider-visible case ID must equal the official provider/task/role identity, and provider-neutral main/branch ordering is enforced. Relabeling main traffic as auxiliary, padding the stable case marker, or undersampling a joined branch fails even if ordinary manifest, workload, config, and result fingerprints are recomputed.
- The default online manifest now fingerprints the memory fixture with the same raw-byte SHA-256 contract used by the sealed runtime fixture, so the official topology equals real online evidence.

## Verification

- `npm run build`: passed.
- Official runtime suite: 1,647 total / 1,639 passed / 0 failed / 8 skipped.
- Regression coverage proves auxiliary 0% does not fail primary qualification, auxiliary 100% does not rescue a primary miss, and separate auxiliary provider/model usage is scored without joining the primary ratio.
- Auxiliary failed/non-terminal outcomes, missing cache-read usage, quality or safety failures, missing memory capability/provenance, and role mismatch all remain fail-closed.
- A role-swap acceptance regression recomputes every ordinary workload/result fingerprint and is still rejected by official topology binding.
- Secret scan found no provider credential in repository changes.
- The actual Dashboard started against an isolated runtime root on port 4394; `/`, `/api/status`, and `/readiness` returned HTTP 200, then the process exited cleanly. No dashboard or UI file changed, so desktop/mobile visual interaction testing was not applicable.

## Acceptance status

This stage establishes correct accounting; it does not itself claim final goal completion. The remaining acceptance action is to expose the sealed `acceptance` runner profile and collect three consecutive 24-warm primary rounds for both NewCLI and DeepSeek from one unchanged artifact.
