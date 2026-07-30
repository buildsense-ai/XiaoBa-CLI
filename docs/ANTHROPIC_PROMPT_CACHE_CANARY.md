# Anthropic Prompt Cache Canary

This canary verifies the native Anthropic prompt-caching request path with two requests that share
the same stable system prefix and use different dynamic system suffixes.

## Safety boundary

The script always targets `https://api.anthropic.com`; a relay URL cannot be configured. It emits
only:

- the request and message IDs;
- the model and API path;
- SHA-256 hashes of the stable and dynamic system blocks;
- input, cache creation/read, and output token usage.

Prompt bodies and credentials are never written to the evidence record. Error output is limited to
the error type, HTTP status, and request ID.

## Run

Use a dedicated official Anthropic credential and choose a currently supported model:

```bash
ANTHROPIC_CANARY_API_KEY=... \
ANTHROPIC_CANARY_MODEL=... \
npm run canary:anthropic-prompt-cache -- \
  --run \
  --output .scratch/anthropic-prompt-cache-canary.json
```

The command makes two billable API requests. The output file is created with owner-only
permissions. Inspect the record before attaching it to an issue or pull request; do not attach
environment files or debug logs.

## Interpret

A useful record has:

- the same `stable_system_sha256` for the pair;
- different `dynamic_system_sha256` values;
- `/v1/messages?beta=prompt_caching` as each `api_path`;
- non-zero `cache_creation_input_tokens` on cache creation and non-zero
  `cache_read_input_tokens` when the stable prefix is reused.

Cache availability and minimum cacheable-prefix rules are controlled by Anthropic. A zero cache
read is a failed canary result, not evidence of a cache gain.
