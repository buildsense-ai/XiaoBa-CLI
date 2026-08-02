# Cache and provider replay evidence — 2026-08-02

This record contains only redacted usage summaries. Credentials, prompts, response text, and
compatible endpoint origins were not persisted.

| Canary | Result | Evidence |
|---|---|---|
| OpenAI-compatible Responses, `gpt-5.6-terra` | passed | attempt 3 read 15,104 of 15,661 input tokens; attempts 1-2 read 0 |
| Canonical DeepSeek Responses, `deepseek-v4-flash` | passed | attempts 2-3 each read 13,696 of 13,709 input tokens |
| Canonical DeepSeek Chat Completions, same model | passed | warm-cache attempts each read 13,696 of 13,709; validates Chat cache-usage parsing |
| Canonical DeepSeek thinking tool replay, same model | passed | first response: one tool call plus private reasoning; replay completed; second request read 384 of 464 input tokens |
| Anthropic-compatible Messages, `claude-opus-4-6` | not run successfully | local test credential was rejected with HTTP 401; no cache capability conclusion |

Interpretation:

- stable-prefix placement works on the two available live provider families;
- a two-request-only benchmark would have falsely failed the OpenAI-compatible Responses route;
- DeepSeek `prompt_cache_hit_tokens` must be normalized or Chat cache hits disappear from Cache
  Trace;
- the previously failing thinking/tool replay structure completes on a real DeepSeek request;
- Anthropic-compatible markers remain disabled until a fresh local credential can produce evidence.
