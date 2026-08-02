# Cache benchmark evidence and scoring

This benchmark is the offline acceptance layer for provider-reported prompt-cache reads. It does not call models, infer hits from latency, inspect prompt bodies, or count cache writes as hits. A separate runner produces a manifest, an append-only round ledger, and one JSONL evidence file for every recorded round.

## Acceptance contract

A result passes only when the latest three consecutive rounds all pass every independent cell for the same artifact. A cell is the exact tuple of:

- `provider_instance_id`
- `provider_adapter`
- `model`
- `api_type`
- `surface`

Every cell has two gates:

1. `sum(cache_read_tokens) / sum(input_tokens) >= 0.94` across cold and warm calls.
2. The same ratio after task weights are water-filled so no task contributes more than 25% is at least `0.94`.

At least four tasks must have positive input weight in each cell. Cold calls remain in the primary ratio. `cache_write_tokens` is diagnostic only and never enters the numerator.

An invalid, failed, incomplete, or unobservable round breaks the streak. It does not permanently poison later evidence: three newer passing rounds can qualify. Artifact drift also resets the streak. The scorer never selects a better historical trio.

## Fixed capability coverage

Every provider instance + adapter + model + API scope must cover all of these capabilities across its manifest cases:

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

Different surfaces may contribute to the same scope-level union. The list is built into the scorer and cannot be shortened by a manifest. Each case also records `scenario_family` and `session_type`, so coverage is not inferred from four arbitrary task IDs. Missing capabilities make the result incomplete and are reported by their fixed names.

## Provider usage contracts

`provider_adapter` is strictly `openai` or `anthropic`. `api_type`, `cache_read_source`, and adapter must match one of these contracts:

| Adapter/API | Allowed `cache_read_source` |
| --- | --- |
| `openai` + `openai-responses` | `openai.input_tokens_details.cached_tokens`, `provider-compatible-declared` |
| `openai` + `openai-chat-completions` | `openai.prompt_tokens_details.cached_tokens`, `deepseek.prompt_cache_hit_tokens`, `provider-compatible-declared` |
| `anthropic` + `anthropic-messages` | `anthropic.cache_read_input_tokens`, `provider-compatible-declared` |

The case fixes one source, and every attempt must match it. Cases that would merge different sources into one cell are rejected.

The collector normalizes input as follows:

| API | `input_tokens` |
| --- | --- |
| OpenAI-compatible Responses | response `input_tokens` |
| OpenAI-compatible Chat / DeepSeek | response `prompt_tokens` |
| Anthropic Messages | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` |
| Declared compatible adapter | adapter-tested normalized input |

A reported numeric zero is observable. If the expected provider field is absent, the attempt omits `cache_read_tokens`; the round is unobservable. Legacy traces, locally inferred reuse, writes, latency, and token estimates are not qualifying evidence.

## Manifest

The manifest is strict JSON with schema `xiaoba.cache_benchmark_manifest.v1`. Unknown or missing fields are rejected. Acceptance criteria are fixed at `0.94`, three rounds, 25% maximum task weight, and cold inclusion.

Abbreviated case shape:

```json
{
  "schema": "xiaoba.cache_benchmark_manifest.v1",
  "suite_id": "cache-suite-v1",
  "criteria": {
    "minimum_read_ratio": 0.94,
    "consecutive_rounds": 3,
    "maximum_task_weight": 0.25,
    "include_cold_in_primary_ratio": true
  },
  "cases": [
    {
      "case_id": "case-1",
      "provider_instance_id": "provider-local-a",
      "provider_adapter": "openai",
      "model": "model-a",
      "api_type": "openai-responses",
      "surface": "cli",
      "task_id": "task-1",
      "task_fixture_fingerprint": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "cache_read_source": "openai.input_tokens_details.cached_tokens",
      "scenario_family": "identity-and-device",
      "session_type": "direct",
      "capabilities": ["identity", "group-chat-participants", "device-authorization"],
      "runs": [
        {"run_id": "run-1", "required_cold_calls": 1, "required_warm_calls": 1}
      ]
    }
  ]
}
```

`required_cold_calls` is fixed at one and `required_warm_calls` is positive. Both counts are exact. Extra attempts—including extra successful calls—are invalid, as are retries, duplicate call/attempt IDs, failures, cancellations, and non-terminal attempts.

The provider instance is a stable local alias, never an endpoint, credential, or credential hash. Every fingerprint is lowercase `sha256:<64 hex>`. Manifest fingerprinting recursively sorts object keys and sorts cases/runs by ID before SHA-256. Config fingerprinting covers the fixed criteria.

## Round evidence JSONL

Each evidence file contains exactly one round. The first non-empty line is a `xiaoba.cache_benchmark_round.v1` header. Remaining lines are `xiaoba.cache_benchmark_attempt.v1` attempts. Each attempt repeats `suite_id`, `round`, and a one-based `attempt_number`; these must match the header and physical line order, preventing cross-round splicing.

Header:

```json
{"schema":"xiaoba.cache_benchmark_round.v1","suite_id":"cache-suite-v1","round":1,"artifact_fingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","manifest_fingerprint":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","config_fingerprint":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
```

Attempt:

```json
{"schema":"xiaoba.cache_benchmark_attempt.v1","suite_id":"cache-suite-v1","round":1,"attempt_number":1,"case_id":"case-1","run_id":"run-1","call_id":"call-1","attempt_id":"attempt-1","metadata":{"provider_instance_id":"provider-local-a","provider_adapter":"openai","model":"model-a","api_type":"openai-responses","surface":"cli","task_id":"task-1","task_fixture_fingerprint":"sha256:1111111111111111111111111111111111111111111111111111111111111111","scenario_family":"identity-and-device","session_type":"direct"},"cache_class":"cold","outcome":"succeeded","usage":{"input_tokens":250,"cache_read_tokens":0,"cache_read_source":"openai.input_tokens_details.cached_tokens","cache_write_tokens":250}}
```

Missing/non-positive input, negative reads, reads above input, metadata drift, unknown runs, and missing or extra coverage invalidate a round. A missing `cache_read_tokens` field makes it unobservable.

## Complete round ledger

The CLI requires a strict `xiaoba.cache_benchmark_ledger.v1` JSON document:

```json
{
  "schema": "xiaoba.cache_benchmark_ledger.v1",
  "suite_id": "cache-suite-v1",
  "latest_round": 3,
  "rounds": [
    {"round": 1, "evidence_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    {"round": 2, "evidence_fingerprint": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
    {"round": 3, "evidence_fingerprint": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
  ]
}
```

The ledger must enumerate every round from `1` through `latest_round` exactly once. Its fingerprints cover each entire canonical round header plus all attempts in physical order. The supplied evidence set must match the ledger exactly: omitted, extra, duplicated, reordered, or modified round content is globally invalid. This prevents a caller from hiding a recorded latest failure by submitting only older evidence.

The report includes the canonical ledger fingerprint. The runner must persist or externally anchor that fingerprint when the ledger is updated; an offline unsigned scorer cannot detect an attacker who rewrites both the complete ledger and every external copy of its anchor.

## CLI

```sh
npm run build
npm run benchmark:cache -- --manifest manifest.json --ledger ledger.json --evidence round-1.jsonl --evidence round-2.jsonl --evidence round-3.jsonl --format text
```

Use `--format json` for canonical deterministic JSON and `--output result.json` to write instead of stdout. Output files are forced to mode `0600`.

Exit codes:

- `0`: latest three qualifying rounds pass.
- `1`: valid, observable evidence failed or is incomplete.
- `2`: current evidence is invalid/unobservable, or the ledger/evidence collection is inconsistent.

Reports contain fixed reason/capability names, round numbers, counts, ratios, and SHA-256 fingerprints only. They do not echo input paths, endpoints, prompt/response bodies, environment variables, arbitrary parser errors, or unknown fields. The scorer and reporter perform no network operations.
