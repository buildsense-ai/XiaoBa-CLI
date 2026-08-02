# Provider cache and replay canaries

These scripts make real, billable requests. Build first, use dedicated low-budget credentials, and
put credentials only in local environment variables or a local untracked launcher. Never paste a
key into an issue, PR, test fixture, or chat.

All evidence files are created with owner-only permissions. They contain hashes and usage counters,
not prompt bodies, response text, credentials, or compatible endpoint origins.

## OpenAI, compatible Responses, and DeepSeek cache

The probe sends three requests with the same >=24k-character stable system prefix and different
small suffixes. Three attempts are intentional: a provider may persist a shared prefix only after it
has observed two related requests.

```bash
npm run build

XIAOBA_CANARY_API_KEY=... \
XIAOBA_CANARY_API_BASE=https://api.deepseek.com \
XIAOBA_CANARY_MODEL=... \
XIAOBA_CANARY_API_MODE=chat_completions \
npm run canary:provider-cache -- \
  --run \
  --output .scratch/deepseek-chat-cache.json
```

Use `XIAOBA_CANARY_API_MODE=responses` for Responses API. A non-OpenAI/non-DeepSeek compatible
endpoint additionally requires `XIAOBA_CANARY_ALLOW_COMPATIBLE=true`.

`verdict: passed` requires a cache read after the seed attempt. A zero read with non-zero input is
`failed_no_reuse`; missing usable counters is `unsupported_usage`.

## DeepSeek thinking + tool replay

This probe asks DeepSeek Chat Completions for one tool call, retains its private reasoning block,
adds the matching tool result, and makes the continuation request.

```bash
XIAOBA_CANARY_API_KEY=... \
XIAOBA_CANARY_API_BASE=https://api.deepseek.com \
XIAOBA_CANARY_MODEL=... \
npm run canary:deepseek-reasoning -- \
  --run \
  --output .scratch/deepseek-reasoning.json
```

`passed` means the first response produced a tool call and the structurally complete replay request
completed. `has_reasoning: true` confirms that the private reasoning path was actually exercised.

## Anthropic prompt caching

```bash
ANTHROPIC_CANARY_API_KEY=... \
ANTHROPIC_CANARY_MODEL=... \
npm run canary:anthropic-prompt-cache -- \
  --run \
  --output .scratch/anthropic-cache.json
```

For a compatible Anthropic endpoint, also set:

```bash
ANTHROPIC_CANARY_API_BASE=https://... \
ANTHROPIC_CANARY_ALLOW_COMPATIBLE=true
```

Passing a compatible canary proves only that exact endpoint/model pair at that time. XiaoBa does not
currently enable Anthropic cache markers on compatible endpoints automatically.
