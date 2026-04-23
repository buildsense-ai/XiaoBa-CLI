---
name: vision-analysis
description: Fallback image analysis skill that delegates to the cloud advanced-reader API when the current model cannot reliably read screenshots, scans, or other image attachments. Use it for image understanding only; let the main model produce the final answer afterward.
category: tools
invocable: both
argument-hint: "<file_path_or_url> [analysis_prompt]"
max-turns: 8
---

# Vision Analysis

Use this skill as a compatibility alias for image-reading fallback.

Its job is:

1. Send the image to the Cats `POST /api/reader/analyze` proxy.
2. Return extracted visual content, text, and basic structure.
3. Let XiaoBa continue the conversation and produce the final answer.

## Rules

- Prefer extraction and faithful reading over speculation.
- Accept either a local file path or a remote image URL.
- If there is visible text, extract it first.
- If any text is blurry, tiny, cropped, or uncertain, explicitly mark it as `[unclear]`.
- Do not infer the document type, scenario, business meaning, or app name unless the exact words are visible.
- If the current model cannot directly inspect the image, use this skill instead of saying you cannot see the image.
- Do not treat the skill result as the final answer unless the user explicitly wants raw extraction.

## Call

```bash
python "<SKILL_DIR>/scripts/invoke_reader_api.py" "<file_path_or_url>" "<analysis_prompt>"
```

The helper script reads:

- `CATSCOMPANY_HTTP_BASE_URL`
- `CATSCOMPANY_API_KEY`
- optional: `CATSCOMPANY_READER_API_URL`
- optional overrides: `READER_PROXY_URL`, `READER_PROXY_API_KEY`, `READER_PROXY_BEARER_TOKEN`

The skill does not call `advanced-reader` directly anymore. Cats backend owns
the internal forwarding and upstream signing.

## Suggested Prompts

- `Read this image conservatively and do not guess. Extract all visible text in reading order. If any text is uncertain, write [unclear]. Do not infer the document type or purpose.`
- `Extract the visible text, UI labels, error messages, and layout from this screenshot. Mark unclear text as [unclear]. Do not diagnose yet.`
- `Read all visible text from this image and keep the original order and hierarchy as much as possible. Do not infer missing words.`
