# Provider API Reference

Read this reference only to configure a custom image endpoint or diagnose API failures.

## Runtime configuration

| Variable | Required | Default | Meaning |
|---|---:|---|---|
| `CATSCO_HTTP_BASE_URL` | XiaoBa runtime | `https://app.catsco.cc` with CatsCo identity | Existing CatsCo service URL; the adapter derives its `/v1` image gateway automatically |
| `CATSCOMPANY_HTTP_BASE_URL` | Gateway fallback | none | Legacy alias for `CATSCO_HTTP_BASE_URL` |
| `CATSCO_IMAGE_API_BASE` | No | derived gateway | Optional explicit CatsCo image-gateway override; base URL or full `/images/generations` or `/images/edits` URL |
| `CATSCO_API_KEY` | Gateway preferred | current bot binding | Bot API key sent as `ApiKey` only to the selected CatsCo gateway |
| `CATSCOMPANY_API_KEY` | Gateway fallback | none | Legacy alias for `CATSCO_API_KEY` |
| `CATSCO_USER_TOKEN` | Gateway only | existing CatsCo login | Bearer login token used directly when no bot key exists, or retried once after an explicit bot-key HTTP 401 |
| `CATSCOMPANY_USER_TOKEN` | Gateway fallback | none | Legacy alias for `CATSCO_USER_TOKEN` |
| `IMAGE_GEN_API_KEY` | Yes | none | Preferred bearer token |
| `OPENAI_API_KEY` | Fallback | none | Used only when `IMAGE_GEN_API_KEY` is absent |
| `IMAGE_GEN_API_BASE` | No | `https://api.openai.com/v1` | Base URL or full `/images/generations` or `/images/edits` URL; the adapter selects the sibling route from the request |
| `IMAGE_GEN_MODEL` | No | `gpt-image-2` | Model sent to the endpoint |
| `IMAGE_GEN_TIMEOUT_MS` | No | `600000` | HTTP timeout, 1-600 seconds; keep the deployed reverse proxy and CatsCo upstream timeout below this client budget so structured errors arrive before a client abort |
| `IMAGE_GEN_MAX_RETRIES` | No | `1` | Bounded retries for an explicit HTTP 429 submit rejection and safe image-URL downloads; never retries an ambiguous paid submit |
| `IMAGE_GEN_RETRY_DELAY_MS` | No | `1000` | Base delay between retries |
| `IMAGE_GEN_MAX_IMAGE_BYTES` | No | `26214400` | Maximum accepted output size |
| `IMAGE_GEN_ALLOW_INSECURE_HTTP` | No | `false` | Set to `true` only for a trusted local HTTP endpoint |
| `IMAGE_GEN_DISABLE_CATSCO_GATEWAY` | No | `false` | Disable automatic gateway derivation for a deliberate direct-provider run; an explicit `CATSCO_IMAGE_API_BASE` still wins |
| `IMAGE_GEN_ASYNC_SUBMIT` | No | `false` | Send `async: true` only for deliberate direct-provider text generation; CatsCo gateway mode and reference-guided edits remain synchronous |
| `IMAGE_GEN_ASYNC_POLL_BASE` | No | selected endpoint origin | Base used for `GET /v1/tasks/<task-id>` |
| `IMAGE_GEN_ASYNC_POLL_INTERVAL_MS` | No | `3000` | Delay between task-status requests |
| `IMAGE_GEN_ASYNC_TIMEOUT_MS` | No | `1800000` | Maximum asynchronous polling duration |
| `IMAGE_GEN_PROVIDER` | No | `auto` | `auto`, `image2`, or `dreamina`; `auto` applies the safe fallback policy below |
| `IMAGE_GEN_ENV_FILE` | No | auto-discovered | Explicit `.env` file to read on each generation run |
| `DREAMINA_CLI_BIN` | No | `dreamina` | Absolute path or command name for the official Dreamina CLI |
| `DREAMINA_CLI_TIMEOUT_MS` | No | `120000` | Per-command CLI timeout; a submit timeout becomes `submission_unknown` |
| `DREAMINA_IMAGE_WAIT_SECONDS` | No | `120` | Inline query window before returning a persisted pending result |
| `DREAMINA_IMAGE_POLL_INTERVAL_MS` | No | `3000` | Initial delay between Dreamina `query_result` calls |

Do not put credentials in request files or command-line arguments. The script never reads `GAUZ_LLM_API_KEY` because an LLM credential does not imply access to an image endpoint.

For an ordinary natural-language request, `prepare-request.mjs` writes hash-bound `source_prompt` and `source_request` references instead of duplicating text into `request.json`. The generator resolves both paths relative to `request.json`, verifies SHA-256, uses the authored prompt as model input, and preserves the raw request for traceability. `source_brief` remains legacy compatibility only. A structured upstream request may use `prompt` directly, but a request cannot contain more than one model-facing prompt source.

`prepare-reference.mjs` accepts a local image path or direct public image URL, stores the actual bytes under `<run-dir>/references/`, and appends a descriptor to `references.json`. It accepts 1-3 nonduplicate PNG/JPEG/WebP references, at most 8 MiB each and 16 MiB total, with edges from 64 to 8192 pixels and at most 40 megapixels. `prepare-request.mjs --references` revalidates that manifest and converts every path to a path relative to `request.json`. The generator verifies bytes, format, dimensions, and SHA-256 again before any API call.

The generator fills missing image variables from configuration files in this order: `IMAGE_GEN_ENV_FILE`, `<XIAOBA_USER_DATA_DIR>/.env`, `<CATSCO_USER_DATA_DIR>/.env`, `<XIAOBA_ELECTRON_USER_DATA_DIR>/.env`, `<XIAOBA_RUNTIME_ROOT>/.env`, then `<cwd>/.env`. Existing process variables take precedence. Only the documented image variables, CatsCo gateway variables, and the `OPENAI_API_KEY` fallback are read; unrelated `.env` values are ignored. This per-run loading lets an installed XiaoBa Skill use updated provider settings without restarting the host.

When the XiaoBa runtime exposes `CATSCO_HTTP_BASE_URL` or an existing CatsCo identity, the adapter automatically calls `<CatsCo HTTP base>/v1/images/generations` for text-only requests and `<CatsCo HTTP base>/v1/images/edits` when references are present. It prefers `CATSCO_API_KEY` with the `ApiKey` scheme. If that identity receives an explicit HTTP 401 and `CATSCO_USER_TOKEN` exists, the adapter retries the same gateway request exactly once with the `Bearer` scheme. Missing bot identity uses the user token directly. Direct-provider credentials are ignored in gateway mode. `CATSCO_IMAGE_API_BASE` overrides the derived gateway. Outside CatsCo, or when `IMAGE_GEN_DISABLE_CATSCO_GATEWAY=true`, the adapter uses `IMAGE_GEN_API_BASE` plus `IMAGE_GEN_API_KEY` as before. Never configure a third-party provider URL as a CatsCo gateway.

The CatsCo gateway owns two server-side provider lanes. The client sends one synchronous request; the gateway strips `async`, starts both fully capable lanes concurrently, retries transient failures independently within one shared deadline, validates completed image responses, and returns the first valid result. The client never repeats the gateway request to simulate another race round. A task ID is an incompatible provider response, not a successful race result. A structured `race_exhausted` or `providers_unavailable` response is distinct from an unstructured proxy timeout and permits the `auto` runner to start one Dreamina fallback.

`IMAGE_GEN_ASYNC_POLL_BASE` is a direct-provider setting and is ignored in gateway mode. Gateway responses must already contain a completed image, so CatsCo credentials are never used for client-side task polling.

## Provider routing

`run-image.mjs` is the public execution entrypoint. `generate-image.mjs` remains the internal Image2 adapter and `generate-dreamina-image.mjs` remains the internal Dreamina adapter.

- `auto` starts with Image2. It may fallback only when the emitted contract says `submission_state=not_submitted` and `fallback_safe=true`, including missing Image2 configuration, a missing reference route, HTTP 401/404/429/501, a single HTTP 503 rejection, or an edits-only HTTP 400 that explicitly asks for the missing reference attachment.
- `image2` disables fallback.
- `dreamina` is an explicit provider choice and never contacts Image2.
- HTTP 403 is not a fallback condition because it may represent a content or policy rejection.
- HTTP 500/502/504/524, client timeout, connection loss, and any interrupted Image2 submission become `submission_unknown`; the same run cannot contact either provider again.

Every adapter failure exposes the same decision contract:

```json
{
  "failure": {
    "phase": "submit",
    "submission_state": "not_submitted",
    "retry_safe": false,
    "fallback_safe": true
  },
  "recovery": {
    "next_action": "fallback_to_dreamina",
    "can_resume_same_task": false,
    "requires_user_confirmation": false,
    "duplicate_generation_risk": false
  }
}
```

`submission_state` is `not_submitted`, `submitted`, or `unknown`. The runner branches on these fields rather than duplicating status-code rules. `recovery.next_action` tells the host whether to retry safely, resume a saved task, fix input or configuration, fallback, stop, or ask once before creating a fresh Dreamina run.

The runner writes `provider-state.json` before submission. A process that disappears while `status=image2_submitting` is treated as unknown on resume. Image2 failures are preserved in `image2-error.json`; safe fallback keeps that record before Dreamina starts. `provider-error.json` preserves the final failure and recovery action for the host.

Dreamina account state is external to the Skill. Before its first submit, the adapter runs `dreamina user_credit`. Missing login returns `auth_required` without creating a generation task. The Skill never runs `login`, `relogin`, `logout`, installation, or upgrade commands.

## HTTP requests

### Text-only generation

The adapter sends:

```http
POST <IMAGE_GEN_API_BASE>/images/generations
Authorization: Bearer <key>
Content-Type: application/json
```

```json
{
  "model": "configured model",
  "prompt": "normalized prompt",
  "n": 1,
  "size": "1024x1024",
  "quality": "medium",
  "output_format": "png"
}
```

### Reference-guided generation

When `reference_images` is present, the adapter selects the sibling edits endpoint and sends JSON rather than multipart form data:

```http
POST <IMAGE_GEN_API_BASE>/images/edits
Authorization: Bearer <key>
Content-Type: application/json
```

```json
{
  "model": "configured model",
  "prompt": "normalized prompt with ordered reference-use mapping",
  "images": [
    {"image_url": "data:image/png;base64,..."}
  ],
  "n": 1,
  "size": "1024x1024",
  "quality": "medium",
  "output_format": "png"
}
```

Reference bytes are encoded only in memory for the outbound call. Full data URLs are deliberately omitted from dry-run output, logs, `request.json`, and `result.json`; those artifacts retain paths, hashes, dimensions, source provenance, and `use_for` instead.

When a reference-guided request has no explicit size, the normalized request still records `size=auto`, but the edits adapter omits the outbound `size` field. Some OpenAI-compatible edits routes reject the literal `auto`; omission preserves provider selection without forcing a square canvas. Explicit sizes remain in the outbound request unchanged.

`IMAGE_GEN_ASYNC_SUBMIT=true` applies only to deliberate direct-provider `/images/generations` calls. The CatsCo gateway and edits adapter omit `async`; neither first sends an unsupported async request and then replays the paid POST.

The endpoint must return one of these shapes:

```json
{"data":[{"b64_json":"..."}]}
```

```json
{"data":[{"url":"https://signed-image-url.example/..."}]}
```

It may instead return an asynchronous task:

```json
{
  "task_id": "task_123",
  "status": "processing",
  "progress": 0
}
```

The adapter writes `pending.json` and polls:

```http
GET <IMAGE_GEN_ASYNC_POLL_BASE>/v1/tasks/task_123
Authorization: Bearer <key>
```

Polling succeeds when the task endpoint returns the normal `data` array. A timed-out query or failed result download preserves `pending.json` and can be resumed with `--task-id` without submitting another generation. Safe image-URL GET retries are bounded by `IMAGE_GEN_MAX_RETRIES` and never create a new task.

The pending record binds the task ID to the original request file hash, request path, output directory, configured model, and task endpoint. Resume fails if any of these change. The generation command has no overwrite mode; use a new run directory for every new paid request.

Only PNG, JPEG, and WebP payloads are accepted. The script detects the actual format from file bytes instead of trusting the requested extension.

The script also reads actual pixel dimensions from PNG/JPEG/WebP bytes. A materially wrong aspect ratio fails with `IMAGE_DIMENSION_MISMATCH`. Providers may return different pixel dimensions while preserving the requested ratio; this remains successful but is recorded in `output.dimensions` and `warnings`.

### Dreamina CLI requests

Text-only input uses `dreamina text2image`; references use `dreamina image2image` with the same validated local files in manifest order. Both submit exactly one image, omit the model flag so the shared account's supported default remains authoritative, and pass `resolution_type=2k`, the resolution supported across every model family listed by the current official CLI. This explicit value avoids an observed CLI/service failure when the documented resolution default was omitted. Common ratios map directly; `landscape`, `portrait`, and `square` map to `3:2`, `2:3`, and `1:1`. Unsupported custom ratios fail before submission.

A successful submit must return `submit_id`. The adapter saves it in `dreamina-task.json` before querying. Every later run calls `dreamina query_result --submit_id=<id> --download_dir=<run-output>`; it never uses task history to guess identity and never resubmits after query or download failure. The transient `user_credit` preflight may retry once before submission. A transient query or missing download may query the same saved task once more in the current invocation, then remains resumable across runs. Provider output is locally validated, staged in a temporary file, and then moved into place. Invalid cached downloads are removed so they cannot poison later resumes; a missing, corrupt, or overwritten final image is repaired from the original task.

## Failure codes

| Code | Meaning | Normal action |
|---|---|---|
| `MISSING_CATSCO_IDENTITY` | Gateway mode is configured but no CatsCo bot or user credential is available | Connect a bot or sign in and retry |
| `MISSING_API_KEY` | No supported credential is configured | Configure the runtime environment |
| `INVALID_REQUEST` | Request fields or values violate the V1 contract | Correct `request.json` |
| `SOURCE_BRIEF_UNREADABLE` | The hash-bound natural brief cannot be read | Restore `brief.txt` at the recorded path |
| `SOURCE_BRIEF_MISMATCH` | `brief.txt` changed after request preparation | Restore the original brief or start a fresh run |
| `UNSUPPORTED_OPERATION` | Masked/local editing, batch, or transparency was requested | Explain the supported boundary |
| `INVALID_REFERENCE_IMAGE` | A descriptor or manifest violates the reference contract | Reacquire or reprepare the reference |
| `UNSUPPORTED_REFERENCE_IMAGE` | Input bytes are not PNG/JPEG/WebP, often because a page URL returned HTML | Download the actual image file and retry |
| `REFERENCE_IMAGE_TOO_LARGE` | One reference exceeds 8 MiB | Compress or resize it before preparing a fresh request |
| `REFERENCE_IMAGES_TOO_LARGE` | Combined references exceed 16 MiB | Compress or remove a reference |
| `REFERENCE_IMAGE_DIMENSIONS_UNSUPPORTED` | Reference dimensions fall outside the supported range | Resize the source image |
| `REFERENCE_IMAGE_HASH_MISMATCH` | Prepared reference bytes changed | Restore the original or prepare a fresh request |
| `REFERENCE_IMAGE_METADATA_MISMATCH` | Recorded format, byte count, or dimensions no longer match | Reprepare the request from the acquired image |
| `REFERENCE_GATEWAY_UNAVAILABLE` | CatsCo `/images/edits` route is not deployed | Keep the run directory, deploy the route, then retry |
| `API_REQUEST_FAILED` | Provider rejected the request | Report provider message and HTTP status |
| `API_TIMEOUT` | Provider exceeded the configured timeout | Check provider status before manually retrying; the server may still be processing |
| `API_NETWORK_ERROR` | Endpoint could not be reached or the connection was lost | Check provider status before manually retrying |
| `UPSTREAM_TIMEOUT` | A gateway returned HTTP 504/524 before generation finished | Use an async job API, a route with a longer origin timeout, or a faster provider |
| `IMAGE_RACE_EXHAUSTED` | The CatsCo relay race reached its total deadline without a valid completed image | In `auto`, start one Dreamina fallback and preserve the race ID |
| `IMAGE_RACE_UNAVAILABLE` | Every eligible CatsCo relay was excluded or unavailable | In `auto`, start one Dreamina fallback and inspect gateway provider health |
| `INVALID_API_RESPONSE` | Provider response does not match the contract | Verify endpoint compatibility |
| `INVALID_IMAGE` | Returned bytes are not PNG/JPEG/WebP | Treat the run as failed |
| `IMAGE_DIMENSION_MISMATCH` | Returned aspect ratio differs materially from the request | Treat the run as failed or regenerate with a supported ratio |
| `OUTPUT_EXISTS` | The run directory already contains outputs | Use a fresh run directory |
| `PENDING_TASK_EXISTS` | The run directory records an unfinished task | Resume the recorded task ID |
| `PENDING_TASK_NOT_FOUND` | `--task-id` was supplied without the matching pending record | Recover the original run directory and `pending.json` |
| `INVALID_PENDING_TASK` | The pending record is missing required task data or cannot be parsed | Inspect the run record before taking any paid action |
| `ASYNC_TASK_ID_MISMATCH` | The requested task ID differs from `pending.json` | Resume the task ID recorded in `pending.json` |
| `PENDING_TASK_CONTEXT_MISMATCH` | The request path or output directory differs from the submitted run | Use the original request and run directory |
| `PENDING_TASK_REQUEST_MISMATCH` | `request.json` changed after submission | Restore the original request before resuming |
| `PENDING_TASK_PROVIDER_MISMATCH` | The model or polling endpoint changed after submission | Restore the submitted provider configuration |
| `ASYNC_TASK_NOT_FOUND` | Task expired or does not exist | Check the provider task list before regenerating |
| `ASYNC_TASK_FAILED` | Provider marked the task failed/expired/canceled | Report the provider error |
| `ASYNC_POLL_FAILED` | Task query returned an invalid non-transient response | Check polling base and provider status |
| `ASYNC_TASK_TIMEOUT` | Task did not finish within the polling window | Keep `pending.json` and resume later |
| `AUTH_REQUIRED` | Shared Dreamina OAuth state is missing or expired | Administrator logs in once, then rerun the same command |
| `INSUFFICIENT_CREDIT` | Shared Dreamina account lacks usable credit or membership | Restore credit/capacity; relogin is not the fix |
| `COMPLIANCE_CONFIRMATION_REQUIRED` | Dreamina requires one-time web confirmation | Administrator completes the confirmation, then resume |
| `CLI_UNAVAILABLE` | Official `dreamina` command is not installed or not on `PATH` | Fix the shared runtime installation |
| `UNSUPPORTED_DREAMINA_RATIO` | Request ratio is outside Dreamina's supported set | Choose a supported ratio before submitting |
| `SUBMISSION_UNKNOWN` | A paid submit may have succeeded without returning trustworthy identity | Stop this run; ask once before creating a fresh Dreamina run because duplication and extra cost are possible |
| `QUERY_FAILED` | Dreamina task query failed after `submit_id` was saved | Rerun the same command to query the same task |
| `DOWNLOAD_FAILED` | Dreamina reported success but output was not materialized | Query/download the same `submit_id` again |

Only `run-image.mjs` may switch providers. The Skill makes one POST to the CatsCo gateway; relay fan-out and repeated rounds stay inside that server. Structured race exhaustion permits one Dreamina fallback in `auto` even though duplicate Image2 work may exist. In deliberate direct-provider mode, a billable POST retries only after an explicit HTTP 429 rejection; HTTP 500/502/503/504/524, a client timeout, lost connection, an invalid successful response, or another unknown submission is never retried. For HTTP 400, only an edits request explicitly asking for the missing reference attachment is fallback-safe. Non-billable preflight, saved-task query, and result-download retries remain bounded and never create a second generation task.
