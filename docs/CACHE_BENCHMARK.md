# Cache benchmark evidence and scoring

The cache benchmark has two deliberately separate layers:

1. The online runner executes a real XiaoBa `AgentSession`, records every physical provider attempt, and seals provider-reported usage as private evidence.
2. The offline scorer validates the evidence without network access. It never infers hits from latency, request similarity, local token estimates, or cache writes.

Calibration runs diagnose the implementation. Acceptance requires the complete contract below; an isolated high cache-read ratio is not a pass.

## Online profiles

The online runner requires an explicit `--profile calibration|acceptance`. Calibration is for short diagnostic runs and remains `calibration_only` even after three 100% rounds. Acceptance requires at least 24 warm logical calls per main case and seals `benchmark_profile: "acceptance"`; the final aggregator rejects calibration evidence.

- Goal state is updated through `GoalRuntime`, persisted with the session, restored, and attested only from typed `goal_status` provenance.
- Every workload runs the real Memory Branch and records every physical branch-provider attempt. One memory-only task must search, successfully read, publish an exact canonical ref backed by a branch-local content receipt, and link that observation into the main request. The other three tasks must suppress redundant memory when no authorized record is relevant. Branch execution, quality, safety, and provenance remain fail-closed. Its cache usage is auxiliary diagnostics: missing usage does not block primary acceptance, while malformed reported usage is still invalid.
- The formal runner binds Memory Branch to the dedicated DeepSeek flash credential instead of inheriting the primary model. NewCLI acceptance therefore measures only NewCLI main/checkpoint traffic, while every Memory physical attempt remains linked, attested, and fail-closed as auxiliary evidence.
- Sealed Memory relevance ignores authorization paths, partition markers, and generic benchmark terms. A record may publish only when it contains an exact task-specific entity from the current input; otherwise the branch must suppress it with empty refs. This prevents broad search terms from turning unrelated authorized evidence into task context.
- The joined branch mode is intentional for deterministic capability correlation. Detached/concurrent and late-observation behavior is tested separately and would require a new versioned benchmark topology before it could replace this acceptance schedule.
- Every warm logical call uses a changing runtime tail while preserving the provider-visible reusable prefix. The four fixed task families make runs comparable; broader project-task benchmarks remain complementary product-performance evidence.
- Every online logical call has a 180-second watchdog. On expiry the runner first aborts through the session so provider and journal lifecycles settle, then fails with a fixed timeout code. Reasoning providers receive a sufficient output budget; exact-token oracles and safety gates are unchanged.

Do not edit evidence, exclude branch retries/tool-loop calls, weaken capability declarations, or promote a synthetic marker to make a calibration run pass.

## Acceptance contract

The latest three consecutive rounds must pass every independent provider cell for the same artifact. A cell is the exact tuple of:

- `provider_instance_id`
- `provider_adapter`
- `model`
- `api_type`
- `surface`
- `traffic_class` (`primary` or `auxiliary_memory`)

Only `primary` cells qualify the cache target. Primary accounting includes every main-origin `main_inference` and `checkpoint_compaction` physical request, including failed checkpoints with valid reported usage. Memory-origin checkpoint, Memory Branch, and subagent cache usage never enters the primary numerator or denominator. Each round has two token-weighted qualification gates over the warm primary requests:

1. `sum(cache_read_tokens) / sum(input_tokens) >= 0.94`.
2. The same ratio after task weights are water-filled so no task contributes more than 25% is at least `0.94`.

At least four tasks must have positive input weight in each primary cell. An `auxiliary_memory` cell reports observable warm/cold/all token totals and raw ratio, but it has neither a 94% threshold nor a task-cap threshold. Missing auxiliary cache usage is retained as an unobservable diagnostic and does not affect primary qualification. `cache_write_tokens` is diagnostic only. In both traffic classes, failed/retried/incomplete execution and quality, safety, capability, or provenance failures remain fail-closed. Artifact drift resets the streak, and the scorer never selects a more favorable historical trio.

The required cold call is not discarded or treated as a free calibration failure. Its valid provider-reported input and cache-read tokens are retained as `cold_*` diagnostics; `all_*` fields retain valid observable usage from all cold and warm physical attempts, including failed attempts that still report usage. Every primary cold physical request must pass the same usage observability, quality, safety, capability, metadata, and stable-prefix checks as a warm request; auxiliary cold calls retain the same functional gates while cache usage remains diagnostic. Cold usage is excluded only from the two 94% qualification ratios because a deliberately partitioned first request measures admission rather than reusable-prefix performance.

## Capability, quality, and safety gates

Primary scopes must cover all fixed capabilities, and every physical provider request in either traffic class must attest the capabilities declared by its own case:

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
- a no-tool/no-confirmation result plus a complete bounded retry-chain result;
- oracle and execution-plan fingerprints;
- a provider-visible request fingerprint;
- a stable-prefix fingerprint.

Stable-prefix drift within a case/run/round is invalid. Internal lifecycle IDs are excluded from the provider-visible fingerprint, but model-visible content and cache placement remain covered.

The online workload uses four deterministic common tasks: repository orientation, test triage, destructive-action review, and next-step planning. It creates and restores a real session, installs a real read-only skill fixture, supplies trusted group identity and a scoped device grant, exposes actual tools, creates a typed Goal, plan, and active subagent, and injects runtime feedback. Each task has a paired Memory Branch case, so the manifest contains four main cases and four branch cases. Each main logical call must contain exactly one `main_inference` plus zero or more main-origin `checkpoint_compaction` requests. A branch logical call must contain at least one `memory_branch_inference` and may also contain memory-origin checkpoints. Every physical request remains ordered, observable, and token-accounted; subagent inference is rejected from the current formal topology.

The destructive-action task is deliberately memory-only: its restored transcript contains an opaque action record ID, while the prior classification and exact decision token exist only in one authorized historical ref. The branch must publish that exact ref and the linked main call must use the observation. A finish payload cannot invent provenance: every published ref must have a branch-local receipt from a successful `memory_read_turn` or `memory_neighbors` result, and the benchmark requires the expected SHA-256 of the model-visible read result. The other three tasks have no relevant authorized memory and must finish with `inject:false`; suppressed branches prove that the sidecar ran without granting a fake `memory` capability to the main request.

## Provider usage contracts

Version 7 evidence does not accept collector-supplied normalized `input_tokens`, `cache_read_tokens`, or `cache_read_source` fields. Each attempt seals `usage.provider_usage`, an allowlisted projection of the exact numeric fields returned by the provider. The offline scorer selects the contract, derives normalized input/read counts, and verifies that the derived source matches the manifest:

| Raw usage contract | Allowed provider fields | Scorer input | Scorer cache read and exact source |
| --- | --- | --- | --- |
| `openai-responses-v1` | `input_tokens`, `cached_tokens`, optional `cache_write_tokens` | `input_tokens` | `cached_tokens` as `openai.input_tokens_details.cached_tokens` |
| `openai-chat-v1` | `prompt_tokens`, `cached_tokens`, optional `cache_write_tokens` | `prompt_tokens` | `cached_tokens` as `openai.prompt_tokens_details.cached_tokens` |
| `deepseek-chat-v1` | `prompt_tokens`, `prompt_cache_hit_tokens` | `prompt_tokens` | `prompt_cache_hit_tokens` as `deepseek.prompt_cache_hit_tokens` |
| `anthropic-messages-v1` | `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | sum of all three fields | `cache_read_input_tokens` as `anthropic.cache_read_input_tokens` |

Fields from another contract and unknown fields are rejected. All present usage values must be non-negative integers. A reported numeric zero is observable; an absent required input or cache-read field is unobservable. That is acceptance-blocking for main-origin primary requests and diagnostic-only for Memory-origin auxiliary requests. Anthropic normalized input requires all three input components, including explicit zero values. Cache-write fields remain diagnostic and never enter the cache-read numerator.

## Evidence schemas

The strict v7 schemas are:

- `xiaoba.cache_benchmark_manifest.v7`
- `xiaoba.cache_benchmark_round.v7`
- `xiaoba.cache_benchmark_attempt.v7`
- `xiaoba.cache_benchmark_ledger.v7`
- `xiaoba.cache_benchmark_result.v7`

Unknown or missing fields are rejected. The manifest fixes the acceptance criteria at `0.94`, three consecutive rounds, a 25% maximum task weight, warm-only qualification (`include_cold_in_primary_ratio` must be `false`), and `qualification_traffic_class: "primary"`. Main attempts derive the `primary` class and Memory Branch attempts derive `auxiliary_memory`; only primary cache ratios qualify, while auxiliary usage observability, completion, quality, safety, capability, and provenance gates remain mandatory. It also fixes exact cold/warm call counts, task fixtures, oracle contracts, execution plans, capability coverage, and provider usage sources.

Online manifests additionally seal `benchmark_profile` and a provider-neutral `workload_contract_fingerprint`. The config fingerprint covers both values as well as the fixed scoring criteria. Legacy offline fixtures may omit the pair, but final multi-provider acceptance rejects any manifest that is not explicitly `acceptance`.

Each evidence JSONL contains one round header followed by attempts in the exact physical order observed by the synchronous attempt journal. Within a case/run, logical calls must remain monotonic from cold to warm. A joined memory-branch call sharing the same task, run ID, and logical call must precede its main call even when the branch uses a different provider/model. `attempt_number` must be contiguous and every provider retry, checkpoint, or branch tool-loop continuation becomes an additional attempt; physical requests cannot be hidden behind a logical call. Each attempt seals role, request kind/origin, per-call provider attempt number, session fingerprint, tool count/fingerprint, started/terminal journal sequences, record fingerprints, previous-record links, and a recomputable lifecycle fingerprint. The scorer reconstructs each logical call's sequence and hash chain, requires checkpoints to use cache bypass with the exact empty-tool fingerprint, and requires checkpoints to share the owning origin's session. A retry chain is limited to two physical requests numbered `1,2`: the first must terminate as `retrying` with no usage, the second must be the unique success, and all provider-visible request, tool, cache, role, origin, session, provider, model, and API fingerprints must remain identical. Reasoning-replay recovery is recorded and cannot masquerade as a transparent transport retry. Because a failed request may already have warmed provider cache, a primary retry qualifies only when the first error proves that no HTTP request was dispatched (for example DNS/refused/connect-timeout evidence); generic timeout, reset, socket, and HTTP failures remain visible but invalidate that acceptance round. A succeeded/failed/cancelled/retrying attempt must have a terminal record; only `incomplete` may omit it. The attempt usage object contains only the raw `provider_usage` projection described above. The ledger enumerates every round from 1 through `latest_round`, and fingerprints cover the entire canonical round. Missing logical calls, undeclared logical calls, primary call padding, reordered attempts, broken journal linkage, or modified evidence are invalid.

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
  --profile acceptance \
  --round 1 \
  --warm-calls 24
```

The credential parser accepts only the six provider-specific `API_KEY`, `BASE_URL`, and `MODEL` variables plus `XIAOBA_BENCH_DEEPSEEK_CACHE_READ_SOURCE`. That seventh value must explicitly select either the OpenAI-compatible nested field or the native DeepSeek top-level field. The observed raw provider contract must match it or scoring fails closed. The file is a non-shell format: no `export`, comments, substitutions, duplicate keys, unknown keys, or unsafe whitespace. On POSIX, the parent must be `0700`, the file `0600`, and both must be owned by the current user. The loader opens with `O_NOFOLLOW`, validates with `fstat`, and reads that same descriptor; replacing the path after validation cannot substitute different credentials.

The runner permits at most one provider retry in a sealed 120-second retry window with a 5-second maximum delay, while the enclosing logical-call watchdog remains authoritative. Retry success preserves availability but does not automatically preserve cache-measurement eligibility: only the provably pre-dispatch primary retry contract above can qualify. It uses provider-default reasoning, gives DeepSeek enough output budget to return visible text, and adds a case/round/reserved-run-nonce system marker. The marker isolates the required cold call from earlier calibration caches while remaining identical for all warm calls in that case and round. It contains no user or credential data.

The runtime path must not exist before invocation. The CLI has no `--working-directory` option and rejects unknown arguments; callers cannot point the benchmark at their repository. An outer launcher validates the visible invocation but never creates runtime or evidence state. It starts the actual runner as a one-time nonce-bound child with an explicit minimal environment allowlist, so even a startup hook that erases its own `NODE_OPTIONS`/argv trace cannot propagate into the evidence process. The child rejects all other `NODE_*`, `LD_*`, `DYLD_*`, `OPENSSL_*`, and `SSL_*` inputs, plus inherited prompt/profile/dotenv/config/data-root/model/test-root/identity overrides. It then binds both prompt aliases and the bundled app root to the fingerprinted repository, disables prompt overrides and log upload, fixes benchmark identity/surface/retry/feedback/device-alias settings, and creates read-only deterministic dotenv, runtime-profile, and config controls in the fresh private runtime. After dynamic import and again before evidence sealing, it revalidates the environment and verifies the actual `PathResolver` source plus runtime, data, logs, state, prompt-override, and skills roots. The CLI creates a private runtime root, skills directory, marker, and synthetic workspace beneath `--runtime-data-dir`, then runs the real session against that workspace. The memory fixture is an isolated per-run `O_EXCL`/`O_NOFOLLOW` source held open for the round; the branch store reads that descriptor instead of scanning global or workspace logs. Its bytes, inode, path identity, directory identities, and content fingerprint are checked before and after every logical call and again before evidence sealing. Every model-selected non-memory tool is denied before dispatch, so a tool call fails safety and exact-attempt gates without reading or changing the caller's repository. Use a different fresh runtime path for every provider round.

The acceptance launcher intentionally rejects ambient custom-CA variables because unbound trust roots could change endpoint identity without changing the artifact fingerprint. The current NewCLI and DeepSeek contracts use their public HTTPS endpoints. Supporting a private-CA provider later requires an explicit CLI input whose CA bytes and path identity are sealed into the artifact/run contract; it must not be restored as ambient environment inheritance. The evidence process assumes the current OS user and fingerprinted installation are trusted—arbitrary local code with that user's privileges can replace the launcher or evidence files and is outside this local benchmark's trust boundary.

### Online run reservation and incomplete runs

An online run reserves its round before the first provider request. The output directory contains:

- an exclusive `.online-run.lock`, held from reservation through successful sealing;
- `round-N.run.jsonl`, whose fsynced `started` record binds the suite, round, random cache-partition nonce, artifact, manifest, and config fingerprints;
- per-call attempt journals, followed on success by the sealed round evidence and contiguous ledger.

On success, the evidence store fsyncs `round-N.jsonl` before advancing `ledger.json`; the reservation then appends a `sealed` record containing the evidence fingerprint and releases the writer lock. A second writer cannot share the output directory while this lease is active.

Failure, interruption, or process death leaves an unsealed reservation and any completed attempt journals as incomplete evidence. It is intentionally not resumable or overwriteable in place: a later invocation against that output directory fails with `online_incomplete_round_exists`. Preserve the directory as the failed-run record, choose a new provider evidence directory, and restart the candidate acceptance sequence at round 1. Do not delete the reservation or manually advance the ledger.

The CLI fingerprints the executable `dist` tree, prompt assets, package manifest and lockfile, the resolved installed dependency tree, and the active Node runtime contract before dynamically loading the online runner. The runner recomputes and compares that pre-bound value before reserving or making a provider request, then recomputes it again before sealing. An external `node_modules` root is allowed only when its resolved bytes are scanned; symlinks escaping the resolved dependency tree are rejected. Rebuild before every run; changing any covered file changes the fingerprint and resets acceptance.

`provider_instance_id` includes a 128-bit SHA-256-derived fingerprint of the normalized configured API base. The endpoint itself is never written to evidence, but switching a gateway or provider endpoint changes the manifest and therefore cannot silently continue the same provider cell or acceptance streak. A cache-partition nonce may appear only once in a ledger; duplicate nonces are rejected.

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

## Multi-provider final aggregation

Single-provider scorer output is necessary but not sufficient for the goal. Final evidence must be bound with:

```sh
npm run benchmark:cache:acceptance -- \
  --newcli-dir /private/path/evidence/newcli \
  --deepseek-dir /private/path/evidence/deepseek \
  --format text
```

The aggregator takes the same exclusive `.online-run.lock` used by the writer while loading each provider snapshot. It rejects an active writer, missing or extra round/reservation files, and any reservation that is not exactly one `started` record followed by a matching `sealed` record whose suite, nonce, artifact, manifest, config, and evidence fingerprints bind the sealed round and ledger.

It then runs the strict scorer itself and requires exactly NewCLI Responses plus DeepSeek Chat Completions for the primary traffic, explicit `acceptance` profiles, at least 24 warm logical calls per primary case, three passing qualifying rounds per provider, and one identical executable artifact fingerprint across both provider streaks. Acceptance also recomputes a versioned official topology fingerprint over task fixtures, oracle/execution plans, scenario, surface, role, declared capabilities, and run identity. Provider fields and warm sample counts are deliberately excluded from that topology fingerprint, then validated separately. Every provider-visible `case_id` must additionally equal the official provider/task/role identity, so a renamed or padded stable partition marker also fails. The current joined topology requires each task's main and branch cases to declare identical run IDs and cold/warm logical-call counts; a separate small branch provider is allowed, but undersampling or running it after the paired main call is not. Relabeling a cache-hostile main case as auxiliary therefore fails even if every ordinary manifest/workload fingerprint is recomputed. A future asynchronous/sampled Memory Branch must introduce a new versioned topology and explicit link schedule rather than silently weakening this joined contract. That artifact fingerprint covers compiled code, prompts, package manifests and lockfile, every installed `node_modules` file and in-tree symlink target, and the actual Node/V8/OpenSSL/platform/architecture runtime contract. A repository-external `node_modules` root is allowed only because its resolved bytes are scanned; dependency symlinks that escape that resolved tree fail closed. The fingerprint is recomputed before execution and after the round to detect drift. The provider-neutral workload fingerprint is recomputed from the concrete task fixture, oracle, execution plan, scenario, role, capability, surface, and run contract of every case; a self-declared hash cannot conceal different workloads. Missing/duplicate or disguised primary providers, calibration evidence, insufficient primary samples, topology drift, malformed evidence, or mismatched workload/artifact identities fail closed. A valid but observable primary result that simply misses the ratio remains an ordinary failed acceptance (exit 1), not invalid evidence.
