#!/usr/bin/env python3
"""Call the Cats reader proxy for a single local file or URL."""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


STRICT_GUARDRAIL_PROMPT = (
    "Read this file conservatively and do not guess. "
    "Only report text or structure that is directly visible. "
    "If any text is blurry, cropped, tiny, or uncertain, write [unclear] instead of inferring. "
    "Preserve the original visible language. "
    "Do not infer the document type, app name, course name, business meaning, or context unless the exact words are visible. "
    "Output in three sections when applicable: Visible text, Layout/structure, and Only clearly visible colors/icons. "
    "Do not add conclusions, diagnosis, or background knowledge."
)
DEFAULT_PROMPT = (
    f"{STRICT_GUARDRAIL_PROMPT} "
    "Primary task: extract all visible text from this file in reading order as much as possible."
)
DEFAULT_HTTP_BASE_URL = "https://app.catsco.cc"
DEFAULT_READER_API_PATH = "/api/reader"
DEFAULT_TIMEOUT_SECONDS = 300


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Call the Cats reader proxy API.")
    parser.add_argument("file_path")
    parser.add_argument("analysis_prompt", nargs="?", default=DEFAULT_PROMPT)
    parser.add_argument("--full", action="store_true", help="Disable page limits for PDFs.")
    parser.add_argument(
        "--force-vision",
        action="store_true",
        help="Skip local PDF text extraction and always use the upstream vision model.",
    )
    parser.add_argument(
        "--page-limit",
        type=int,
        default=None,
        help="Override the default PDF page limit. Use 0 for no limit.",
    )
    return parser.parse_args()


def _normalize_prompt(user_prompt: str) -> str:
    cleaned = (user_prompt or "").strip()
    if not cleaned:
        return DEFAULT_PROMPT
    return f"{STRICT_GUARDRAIL_PROMPT} Primary task: {cleaned}"


def _is_url(value: str) -> bool:
    parsed = urllib.parse.urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _guess_content_type(file_path: Path) -> str:
    content_type, _ = mimetypes.guess_type(str(file_path))
    return content_type or "application/octet-stream"


def _add_form_field(lines: list[bytes], boundary: str, name: str, value: str) -> None:
    lines.append(f"--{boundary}".encode("utf-8"))
    lines.append(f'Content-Disposition: form-data; name="{name}"'.encode("utf-8"))
    lines.append(b"")
    lines.append(value.encode("utf-8"))


def _build_multipart_body(file_path: Path, data: dict[str, str]) -> tuple[bytes, str]:
    boundary = f"advanced-reader-{uuid.uuid4().hex}"
    lines: list[bytes] = []

    for name, value in data.items():
        _add_form_field(lines, boundary, name, value)

    lines.append(f"--{boundary}".encode("utf-8"))
    lines.append(
        (
            f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"'
        ).encode("utf-8")
    )
    lines.append(f"Content-Type: {_guess_content_type(file_path)}".encode("utf-8"))
    lines.append(b"")
    lines.append(file_path.read_bytes())
    lines.append(f"--{boundary}--".encode("utf-8"))
    lines.append(b"")

    return b"\r\n".join(lines), boundary


def _resolve_reader_base_url() -> str:
    explicit_url = (
        os.environ.get("CATSCOMPANY_READER_API_URL")
        or os.environ.get("READER_PROXY_URL")
        or ""
    ).strip()
    if explicit_url:
        return explicit_url.rstrip("/")

    http_base_url = (
        os.environ.get("CATSCOMPANY_HTTP_BASE_URL") or DEFAULT_HTTP_BASE_URL
    ).strip().rstrip("/")
    if not http_base_url:
        http_base_url = DEFAULT_HTTP_BASE_URL
    return f"{http_base_url}{DEFAULT_READER_API_PATH}"


def _build_proxy_auth_headers() -> dict[str, str]:
    api_key = (
        os.environ.get("CATSCOMPANY_API_KEY")
        or os.environ.get("READER_PROXY_API_KEY")
        or ""
    ).strip()
    if api_key:
        return {"Authorization": f"ApiKey {api_key}"}

    bearer_token = (
        os.environ.get("CATSCOMPANY_BEARER_TOKEN")
        or os.environ.get("READER_PROXY_BEARER_TOKEN")
        or ""
    ).strip()
    if bearer_token:
        return {"Authorization": f"Bearer {bearer_token}"}

    raise RuntimeError(
        "Cats reader proxy requires CATSCOMPANY_API_KEY / READER_PROXY_API_KEY, "
        "or CATSCOMPANY_BEARER_TOKEN / READER_PROXY_BEARER_TOKEN."
    )


def _download_url_to_temp(url: str) -> tuple[Path, tempfile.TemporaryDirectory[str]]:
    temp_dir = tempfile.TemporaryDirectory(prefix="reader-proxy-url-")
    parsed = urllib.parse.urlparse(url)
    file_name = Path(parsed.path).name or "remote-file.bin"
    target = Path(temp_dir.name) / file_name

    request = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(request, timeout=300) as response:
        target.write_bytes(response.read())

    return target, temp_dir


def _resolve_input_path(raw_input: str) -> tuple[Path, tempfile.TemporaryDirectory[str] | None]:
    if _is_url(raw_input):
        return _download_url_to_temp(raw_input)

    file_path = Path(raw_input).expanduser().resolve()
    if not file_path.exists():
        raise FileNotFoundError(f"File does not exist: {file_path}")
    return file_path, None


def main() -> int:
    args = parse_args()
    prompt = _normalize_prompt(args.analysis_prompt)
    base_url = _resolve_reader_base_url()

    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    try:
        file_path, temp_dir = _resolve_input_path(args.file_path)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"Failed to download remote file: {exc}", file=sys.stderr)
        return 1

    page_limit = args.page_limit
    if args.full and page_limit is None:
        page_limit = 0

    data = {"prompt": prompt}
    if page_limit is not None:
        data["page_limit"] = str(page_limit)
    if args.force_vision:
        data["force_vision"] = "true"

    body, boundary = _build_multipart_body(file_path, data)
    analyze_url = f"{base_url}/analyze"
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    try:
        headers.update(_build_proxy_auth_headers())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    request = urllib.request.Request(
        analyze_url,
        data=body,
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
            status_code = response.status
            response_text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace").strip()
        print(
            f"Cats reader proxy returned {exc.code}: {body_text}",
            file=sys.stderr,
        )
        return 1
    except urllib.error.URLError as exc:
        print(f"Cats reader proxy request failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()

    if status_code != 200:
        print(
            f"Cats reader proxy returned {status_code}: {response_text.strip()}",
            file=sys.stderr,
        )
        return 1

    try:
        payload = json.loads(response_text)
    except ValueError:
        print(response_text.strip())
        return 0

    analysis = payload.get("analysis")
    if isinstance(analysis, str) and analysis.strip():
        print(analysis.strip())
        return 0

    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
