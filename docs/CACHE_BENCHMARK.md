# Cache benchmark evidence and scoring

The cache benchmark has two deliberately separate layers:

1. The online runner executes a real XiaoBa `AgentSession`, records every physical provider attempt, and seals provider-reported usage as private evidence.
2. The offline scorer validates the evidence without network access. It never infers hits from latency, request similarity, local token estimates, or cache writes.

Calibration runs diagnose the implementation. Acceptance requires the complete contract below; an isolated high cache-read ratio is not a pass.

## Stage 2 status: calibration only

The current Stage 2 online workload is deliberately **non-acceptance** evidence. It exercises a real main `AgentSession`, but two required capability paths are not yet present:

- the durable objective marker is workload state, not a typed Goal runtime observation (`goal_status`);
- the memory sidecar is disabled, so a final `memory` runtime-observation marker is not evidence of a real Memory Branch session and its physical provider attempts.

Until both paths are implemented and observed at the provider boundary, the machine gate must return a non-passing result even if the reported cache-read ratio is at least 94%. In particular, the request attestor does not credit the durable objective as `goal`, so the current all-capabilities manifest produces `capability_attestation_incomplete`/`capability_coverage_incomplete`. Do not edit evidence, weaken the manifest, or promote a synthetic marker to make a calibration run pass.

## Acceptance contract

The latest three consecutive rounds must pass every independent provider cell for the same artifact. A cell is the exact tuple of:

- `provider_instance_id`
- `provider_adapter`
- `model`
- `api_type`
- `surface`

Each round has two token-weighted gates, both including the cold call:

1. `sum(cache_read_tokens) / sum(input_tokens) >= 0.94`.
2. The same ratio after task weights are water-filled so no task contributes more than 25% is at least `0.94`.

At least four tasks must have positive input weight in each cell. `cache_write_tokens` is diagnostic only. A failed, retried, incomplete, unobservable, quality-failing, safety-failing, or capability-incomplete attempt invalidates the round. Artifact drift resets the streak, and the scorer never selects a more favorable historical trio.

## Capability, quality, and safety gates

Every case declares and every physical provider request must attest all fixed capabilities:

- `identity`
- `group-chat-participants`
- `device-authorization`
- `tools`
- `skills`
- `plan`
- `goal`
- `subagent`
- `memory`
- `runtime-feedback`
- `session-recovery`

The online runner derives this attestation from the actual request observed at the model-attempt boundary. It does not trust a scenario label. Each attempt also carries:

- an exact-output oracle result for task quality;
- a no-tool/no-confirmation/no-retry safety result;
- oracle and execution-plan fingerprints;
- a provider-visible request fingerprint;
- a stable-prefix fingerprint.

Stable-prefix drift within a case/run/round is invalid. Internal lifecycle IDs are excluded from the provider-visible fingerprint, but model-visible content and cache placement remain covered.

The main online workload uses four deterministic common tasks: repository orientation, test triage, destructive-action review, and next-step planning. It creates and restores a real session, installs a real read-only skill fixture, supplies a trusted group identity and scoped device grant, exposes actual tools, creates a plan and active subagent, injects runtime feedback, and handles the final prompt as a `memory` runtime observation. This is useful calibration coverage, but the observation is not a Memory Branch. A separate workload must execute the real branch session and record every physical branch-provider attempt before acceptance can be enabled.

## Provider usage contracts

Version 3 evidence does not accept collector-supplied normalized `input_tokens`, `cache_read_tokens`, or `cache_read_source` fields. Each attempt seals `usage.provider_usage`, an allowlisted projection of the exact numeric fields returned by the provider. The offline scorer selects the contract, derives normalized input/read counts, and verifies that the derived source matches the manifest:

| Raw usage contract | Allowed provider fields | Scorer input | Scorer cache read and exact source |
| --- | --- | --- | --- |
| `openai-responses-v1` | `input_tokens`, `cached_tokens`, optional `cache_write_tokens` | `input_tokens` | `cached_tokens` as `openai.input_tokens_details.cached_tokens` |
| `openai-chat-v1` | `prompt_tokens`, `cached_tokens`, optional `cache_write_tokens` | `prompt_tokens` | `cached_tokens` as `openai.prompt_tokens_details.cached_tokens` |
| `deepseek-chat-v1` | `prompt_tokens`, `prompt_cache_hit_tokens` | `prompt_tokens` | `prompt_cache_hit_tokens` as `deepseek.prompt_cache_hit_tokens` |
| `anthropic-messages-v1` | `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | sum of all three fields | `cache_read_input_tokens` as `anthropic.cache_read_input_tokens` |

Fields from another contract and unknown fields are rejected. All present usage values must be non-negative integers. A reported numeric zero is observable; an absent required input or cache-read field is unobservable. Anthropic normalized input requires all three input components, including explicit zero values. Cache-write fields remain diagnostic and never enter the cache-read numerator.

## Evidence schemas

The strict v3 schemas are:

- `xiaoba.cache_benchmark_manifest.v3`
- `xiaoba.cache_benchmark_round.v3`
- `xiaoba.cache_benchmark_attempt.v3`
- `xiaoba.cache_benchmark_ledger.v3`
- `xiaoba.cache_benchmark_result.v3`

Unknown or missing fields are rejected. The manifest fixes the acceptance criteria at `0.94`, three consecutive rounds, a 25% maximum task weight, and cold inclusion. It also fixes exact cold/warm call counts, task fixtures, oracle contracts, execution plans, capability coverage, and provider usage sources.

Each evidence JSONL contains one round header followed by attempts in physical order. `attempt_number` must be contiguous and every provider retry becomes an additional attempt; retries cannot be hidden behind a logical call. The attempt usage object contains only the raw `provider_usage` projection described above. The ledger enumerates every round from 1 through `latest_round`, and fingerprints cover the entire canonical round. Missing, extra, reordered, or modified evidence is invalid.

The round header also seals a random 128-bit `cache_partition_nonce`. The nonce is reserved before network activity and appears in the first system marker for every case in that run. It stays fixed across that case's warm calls, but changes for every new invocation even when case and round numbers are reused in a different output directory. This makes a required cold request distinguishable from every prior calibration run.

The evidence store writes private `0600` files inside `0700` directories, fsyncs the sealed round before advancing the ledger, and rejects symlinks, weak existing files, and path traversal. Journals and evidence contain only allowlisted metadata, usage, statuses, and SHA-256 fingerprints—never credentials, endpoints, prompt bodies, response bodies, or arbitrary provider errors.

## Online runner

Build first, then invoke the runner with a repository-external credential file and repository-external output/runtime directories:

```sh
npm run build
npm run benchmark:cache:online -- \
  --credentials /private/path/providers.env \
  --output-dir /private/path/evidence/newcli \
  --runtime-data-dir /private/path/fresh-runtime/newcli-round-1 \
  --provider newcli \
  --round 1 \
  --warm-calls 24
```

The credential parser accepts only the six provider-specific `API_KEY`, `BASE_URL`, and `MODEL` variables defined by the runner. It is a non-shell format: no `export`, comments, substitutions, duplicate keys, unknown keys, or unsafe whitespace. On POSIX, the parent must be `0700`, the file `0600`, and both must be owned by the current user.

The runner disables model retries, uses provider-default reasoning, gives DeepSeek enough output budget to return visible text, and adds a case/round/reserved-run-nonce system marker. The marker isolates the required cold call from earlier calibration caches while remaining identical for all warm calls in that case and round. It contains no user or credential data.

The runtime path must not exist before invocation. The CLI has no `--working-directory` option and rejects unknown arguments; callers cannot point the benchmark at their repository. It creates a private runtime root, skills directory, marker, and synthetic workspace beneath `--runtime-data-dir`, then runs the real session against that workspace. Every model-selected tool is denied before dispatch, so a tool call fails safety and exact-attempt gates without reading or changing the caller's repository. Use a different fresh runtime path for every provider round.

### Online run reservation and incomplete runs

An online run reserves its round before the first provider request. The output directory contains:

- an exclusive `.online-run.lock`, held from reservation through successful sealing;
- `round-N.run.jsonl`, whose fsynced `started` record binds the suite, round, random cache-partition nonce, artifact, manifest, and config fingerprints;
- per-call attempt journals, followed on success by the sealed round evidence and contiguous ledger.

On success, the evidence store fsyncs `round-N.jsonl` before advancing `ledger.json`; the reservation then appends a `sealed` record containing the evidence fingerprint and releases the writer lock. A second writer cannot share the output directory while this lease is active.

Failure, interruption, or process death leaves an unsealed reservation and any completed attempt journals as incomplete evidence. It is intentionally not resumable or overwriteable in place: a later invocation against that output directory fails with `online_incomplete_round_exists`. Preserve the directory as the failed-run record, choose a new provider evidence directory, and restart the candidate acceptance sequence at round 1. Do not delete the reservation or manually advance the ledger.

The CLI fingerprints the executable `dist` tree, prompt assets, package manifest, and lockfile before dynamically loading the online runner. The runner recomputes and compares that pre-bound value before reserving or making a provider request, then recomputes it again before sealing. Symlinks are rejected. Rebuild before every run; changing any covered file changes the fingerprint and resets acceptance.

`provider_instance_id` includes a short SHA-256-derived fingerprint of the normalized configured API base. The endpoint itself is never written to evidence, but switching a gateway or provider endpoint changes the manifest and therefore cannot silently continue the same provider cell or acceptance streak.

Run each provider into its own evidence directory. Do not reuse calibration evidence for final acceptance. For a final acceptance candidate, every consecutive round for one provider must use the **same exact `--output-dir`**, so one manifest and append-only ledger bind rounds 1, 2, 3, and any later rounds. Only `--runtime-data-dir` changes to a new nonexistent directory for each round. Do not collect the three rounds in separate output directories and later combine them.

Consecutive rounds in that fixed provider directory must retain the same artifact fingerprint, manifest, model/API contract, and exact warm-call count. Use a different fixed evidence directory for each provider. If an incomplete reservation forces a new directory, the prior streak does not carry over.

## Offline scorer

```sh
npm run benchmark:cache -- \
  --manifest manifest.json \
  --ledger ledger.json \
  --evidence round-1.jsonl \
  --evidence round-2.jsonl \
  --evidence round-3.jsonl \
  --format text
```

Use `--format json` for canonical JSON and `--output result.json` to write a private `0600` result.

- Exit `0`: the latest three qualifying rounds pass.
- Exit `1`: valid and observable evidence fails or is incomplete.
- Exit `2`: evidence is invalid/unobservable, or ledger/evidence consistency fails.

Reports contain only fixed reason/capability names, round numbers, counts, ratios, and fingerprints. An offline unsigned scorer cannot detect an attacker who rewrites both the complete ledger and every external copy of its anchor; production acceptance must preserve or externally anchor each published ledger fingerprint.
