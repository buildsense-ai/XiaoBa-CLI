"""OCR duty log images using a vision model to extract time, date, and campus.

Supports two API formats, auto-detected from --api-base:
  - Anthropic Messages API (base contains "anthropic" or "claude")
  - OpenAI Chat Completions API (all other bases)

Environment variables (highest to lowest priority):
  DUTY_LOG_OCR_API_KEY > GAUZ_LLM_API_KEY
  DUTY_LOG_OCR_API_BASE > GAUZ_LLM_API_BASE
  DUTY_LOG_OCR_MODEL > GAUZ_LLM_MODEL

Default model: gpt-4o-mini (cheap, widely available, vision-capable).
To use Anthropic Claude, set --api-base to https://api.anthropic.com.
"""
import argparse
import base64
import json
import mimetypes
import os
import sys
from pathlib import Path

import requests

API_KEY = os.environ.get("DUTY_LOG_OCR_API_KEY") or os.environ.get("GAUZ_LLM_API_KEY", "")
API_BASE = os.environ.get("DUTY_LOG_OCR_API_BASE") or os.environ.get("GAUZ_LLM_API_BASE", "")
MODEL = os.environ.get("DUTY_LOG_OCR_MODEL") or os.environ.get("GAUZ_LLM_MODEL", "")

PROMPT = """You are an OCR system. Analyze this photo of a school duty log.

Extract exactly three fields from the image:

1. **Time (HH:MM)** — large white characters displayed prominently at the bottom of the photo, showing when the photo was taken. Format as HH:MM (24-hour), e.g. "06:58", "14:20".

2. **Date (YYYY.MM.DD)** — date string from the watermark overlay at the bottom of the image. Format as YYYY.MM.DD, e.g. "2026.05.08".

3. **Campus (校区)** — the school campus name from the watermark. Look for "东校区" or "西校区" in the watermark text. Return exactly "东校区" or "西校区".

Return ONLY valid JSON, no other text, no markdown fences:

{"hhmm": "06:58", "date": "2026.05.08", "campus": "西校区"}

If a field is not determinable, set it to null:

{"hhmm": null, "date": "2026.05.08", "campus": "西校区"}"""


def detect_format(api_base):
    """Return 'anthropic' or 'openai' based on the API base URL."""
    base_lower = api_base.lower()
    if any(kw in base_lower for kw in ("anthropic", "claude")):
        return "anthropic"
    return "openai"


def default_model(api_format):
    if api_format == "anthropic":
        return "claude-haiku-4-5-20251001"
    return "gpt-4o-mini"


def encode_image(image_path):
    path = Path(image_path)
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")
    mime_type, _ = mimetypes.guess_type(str(path))
    if mime_type not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
        mime_type = "image/jpeg"
    data = base64.b64encode(path.read_bytes()).decode("utf-8")
    return mime_type, data


def call_anthropic(image_path, api_key, api_base, model):
    mime_type, image_data = encode_image(image_path)

    resp = requests.post(
        f"{api_base.rstrip('/')}/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": 256,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": image_data}},
                    {"type": "text", "text": PROMPT},
                ],
            }],
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["content"][0]["text"].strip()


def call_openai(image_path, api_key, api_base, model):
    mime_type, image_data = encode_image(image_path)
    data_url = f"data:{mime_type};base64,{image_data}"

    resp = requests.post(
        f"{api_base.rstrip('/')}/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": 256,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_url}},
                    {"type": "text", "text": PROMPT},
                ],
            }],
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"].strip()


def parse_response(text):
    # Strip markdown fences if present
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:]) if lines[0].startswith("```") else text
        if text.endswith("```"):
            text = text[:-3]
    text = text.strip()
    result = json.loads(text)

    for field in ("hhmm", "date", "campus"):
        if field not in result:
            result[field] = None

    missing = [f for f in ("hhmm", "date", "campus") if result.get(f) is None]
    return result, missing


def ocr_image(image_path, api_key=None, api_base=None, model=None, api_format=None):
    api_key = api_key or API_KEY
    api_base = api_base or API_BASE

    if not api_key:
        return {"error": "No API key configured. Set DUTY_LOG_OCR_API_KEY or GAUZ_LLM_API_KEY."}

    # Determine format and model
    if api_format:
        fmt = api_format
    elif api_base:
        fmt = detect_format(api_base)
    else:
        fmt = "openai"

    model = model or MODEL or default_model(fmt)

    # Default API base
    if not api_base:
        api_base = "https://api.anthropic.com" if fmt == "anthropic" else "https://api.openai.com/v1"

    try:
        if fmt == "anthropic":
            text = call_anthropic(image_path, api_key, api_base, model)
        else:
            text = call_openai(image_path, api_key, api_base, model)

        result, missing = parse_response(text)
        result["_missing"] = missing
        result["_model"] = model
        return result

    except FileNotFoundError as e:
        return {"error": str(e)}
    except requests.RequestException as e:
        return {"error": f"API request failed: {e}"}
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        return {"error": f"Failed to parse response: {e}", "raw": str(text)[:500] if "text" in dir() else ""}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OCR a duty log image with a vision model")
    parser.add_argument("--image", required=True, help="Path to the image file")
    parser.add_argument("--api-key", help="API key")
    parser.add_argument("--api-base", help="API base URL (auto-detects Anthropic vs OpenAI format)")
    parser.add_argument("--model", help="Model name (default: gpt-4o-mini)")
    parser.add_argument("--format", choices=("anthropic", "openai"), help="Force API format")
    args = parser.parse_args()

    if not API_KEY and not args.api_key:
        print(json.dumps({"error": "No API key. Set --api-key or DUTY_LOG_OCR_API_KEY env var."}, ensure_ascii=False))
        sys.exit(3)

    result = ocr_image(args.image, args.api_key, args.api_base, args.model, args.format)

    exit_code = 0
    if "error" in result and "raw" not in result:
        exit_code = 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(exit_code)
