---
name: advanced-reader
description: Conservative fallback skill for reading images, screenshots, scanned files, and PDFs only when attachment understanding is required. Use it when the user needs content extracted from an attachment and the current model cannot read the attachment reliably.
category: tools
invocable: both
argument-hint: "<file_path_or_url> [analysis_prompt]"
max-turns: 8
---

# Advanced Reader

Use this skill only as a fallback when the user provides an image, screenshot,
scanned document, or PDF and the current model cannot read the attachment
reliably.

The role of this skill is narrow:

1. Send the attachment to the Cats `POST /api/reader/analyze` proxy.
2. Return extracted content or tightly bounded attachment understanding.
3. Let XiaoBa's main model produce the final answer afterward.

## Core Rules

- Do not call the API if the user question can be answered without opening the attachment.
- Do not guess attachment content from the file name or path.
- Treat this skill as a reader, not as the final response generator.
- Prefer extraction-oriented prompts over interpretive prompts.
- For PDFs, keep the default conservative mode unless the user clearly asks for full-document coverage.
- If the API call fails, explain that attachment parsing failed and ask the user for another try or extra text context.

## Default Call

Run:

```bash
python "<SKILL_DIR>/scripts/invoke_reader_api.py" "<file_path_or_url>" "<analysis_prompt>"
```

The helper script reads:

- `CATSCOMPANY_HTTP_BASE_URL`
- `CATSCOMPANY_API_KEY`
- optional: `CATSCOMPANY_READER_API_URL`
- optional overrides: `READER_PROXY_URL`, `READER_PROXY_API_KEY`, `READER_PROXY_BEARER_TOKEN`
- Default value: `https://app.catsco.cc/api/reader`

The skill no longer calls `advanced-reader` directly. Cats backend handles
service-to-service forwarding and upstream signing.

## Escalated Call

Use broader coverage only when the user explicitly needs it:

```bash
python "<SKILL_DIR>/scripts/invoke_reader_api.py" --full "<file_path_or_url>" "<analysis_prompt>"
python "<SKILL_DIR>/scripts/invoke_reader_api.py" --force-vision "<file_path_or_url>" "<analysis_prompt>"
```

## Preferred Prompts

- General extraction:
  `Extract the visible text and structure from this file. If there is little text, describe only the clearly visible content without adding conclusions.`
- Screenshot reading:
  `Extract the visible text, UI labels, error messages, and layout from this screenshot. Do not diagnose yet.`
- PDF extraction:
  `Extract the document text and preserve section structure as much as possible.`
- OCR-style reading:
  `Read all visible text from this file and keep the original order and hierarchy as much as possible.`

## When To Use

- The user asks what is written in an image or screenshot.
- The user uploads a PDF and wants the content extracted or summarized later.
- The user asks you to read a scan, OCR-like image, or screenshot text.
- The answer depends on the attachment and the current model cannot read it reliably.

## When Not To Use

- The user question is purely textual and does not depend on the attachment.
- The user already pasted the relevant text into the conversation.
- The current model has already read the attachment successfully.
- The user only needs a meta-level answer that does not require opening the file.

## Flow

1. Locate the local attachment path or remote attachment URL.
2. Build a prompt that asks for extraction first, not interpretation.
3. Call the helper script.
4. Read the extracted result.
5. Continue the conversation using that result as input to the main model.

## Output Rules

- Use the API result as attachment context for the next answer.
- Do not treat the API result as the final user-facing answer unless the user asked for raw extraction only.
- Do not say you cannot see the image before trying this fallback when attachment reading is truly required.
