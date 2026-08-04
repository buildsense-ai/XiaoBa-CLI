#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_TIMEOUT_SECONDS = 60
DEFAULT_MIN_SIZE_BYTES = 1024


def main() -> int:
    parser = argparse.ArgumentParser(description="Export local HTML to PDF with installed Edge, Chrome, or Chromium.")
    parser.add_argument("input", help="Local .html/.htm file.")
    parser.add_argument("output", nargs="?", help="Output .pdf path.")
    parser.add_argument("--browser", help="Explicit browser executable path.")
    parser.add_argument("--overwrite", action="store_true", help="Replace an existing PDF.")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--min-size", type=int, default=DEFAULT_MIN_SIZE_BYTES)
    args = parser.parse_args()

    payload = run(args)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload.get("ok") else 1


def run(args: argparse.Namespace) -> dict[str, Any]:
    source = Path(args.input).expanduser()
    output = Path(args.output).expanduser() if args.output else source.with_suffix(".pdf")

    if not source.exists():
        return fail(source, output, "input_not_found", f"Input HTML not found: {source}")
    if not source.is_file():
        return fail(source, output, "input_not_file", f"Input is not a file: {source}")
    if source.suffix.lower() not in {".html", ".htm"}:
        return fail(source, output, "unsupported_source", "Only local .html/.htm input is supported.")

    source = source.resolve()
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not args.overwrite:
        return fail(source, output, "output_exists", f"Output already exists: {output}")
    if output.exists() and args.overwrite:
        output.unlink()

    browser = find_browser(args.browser)
    if not browser:
        return fail(
            source,
            output,
            "browser_not_found",
            "No installed Chrome, Edge, or Chromium executable was found.",
            checked_browser_candidates=[str(item) for item in browser_candidates()],
        )

    try:
        completed = render_html_to_pdf(browser, source, output, timeout=args.timeout)
    except subprocess.TimeoutExpired:
        return fail(source, output, "browser_timeout", f"Browser render exceeded {args.timeout} seconds.")
    except Exception as exc:
        return fail(source, output, "render_failed", str(exc))

    validation, warnings = validate_pdf(output, args.min_size)
    if completed.returncode != 0:
        return fail(
            source,
            output,
            "browser_nonzero_exit",
            f"Browser exited with code {completed.returncode}.",
            browser={"path": str(browser), "name": browser_name(browser)},
            validation=validation,
            warnings=warnings,
            stdout=(completed.stdout or "").strip()[-2000:],
            stderr=(completed.stderr or "").strip()[-2000:],
        )

    return {
        "ok": bool(validation["exists"] and validation["size_ok"] and validation["pdf_header_ok"]),
        "input": str(source),
        "output": str(output),
        "browser": {"path": str(browser), "name": browser_name(browser)},
        "validation": validation,
        "warnings": warnings,
    }


def render_html_to_pdf(browser: Path, source: Path, output: Path, *, timeout: int) -> subprocess.CompletedProcess[str]:
    command = [
        str(browser),
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-extensions",
        "--allow-file-access-from-files",
        "--print-to-pdf-no-header",
        "--no-pdf-header-footer",
        f"--print-to-pdf={str(output)}",
        source.as_uri(),
    ]
    return subprocess.run(
        command,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def validate_pdf(output: Path, min_size: int) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    exists = output.exists() and output.is_file()
    size = output.stat().st_size if exists else 0
    header_ok = False
    if exists:
        with output.open("rb") as handle:
            header_ok = handle.read(5) == b"%PDF-"
    if exists and size < min_size:
        warnings.append(f"PDF size is below {min_size} bytes.")
    if exists and not header_ok:
        warnings.append("Output file does not start with a PDF header.")
    return {
        "exists": exists,
        "size_bytes": size,
        "size_ok": size >= min_size,
        "pdf_header_ok": header_ok,
    }, warnings


def find_browser(explicit: str | None = None) -> Path | None:
    candidates = [Path(explicit)] if explicit else browser_candidates()
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate.resolve()
        found = shutil.which(str(candidate))
        if found:
            return Path(found).resolve()
    return None


def browser_candidates() -> list[Path]:
    candidates: list[Path] = []
    env_browser = os.environ.get("XIAOBA_PDF_BROWSER") or os.environ.get("PDF_BROWSER")
    if env_browser:
        candidates.append(Path(env_browser))

    for name in [
        "chrome",
        "chrome.exe",
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "msedge",
        "msedge.exe",
        "microsoft-edge",
    ]:
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))

    for base_var, rels in [
        ("PROGRAMFILES", [r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"]),
        ("PROGRAMFILES(X86)", [r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"]),
        ("LOCALAPPDATA", [r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe"]),
    ]:
        base = os.environ.get(base_var)
        if base:
            candidates.extend(Path(base) / rel for rel in rels)

    if sys.platform == "darwin":
        candidates.extend(
            [
                Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
                Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
            ]
        )

    seen: set[str] = set()
    unique: list[Path] = []
    for candidate in candidates:
        key = str(candidate).lower()
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def browser_name(path: Path) -> str:
    lower = str(path).lower()
    if "edge" in lower:
        return "edge"
    if "chrome" in lower:
        return "chrome"
    if "chromium" in lower:
        return "chromium"
    return path.name


def fail(source: Path, output: Path, code: str, message: str, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": False,
        "input": str(source),
        "output": str(output),
        "error": {"code": code, "message": message},
        "validation": {
            "exists": False,
            "size_bytes": 0,
            "size_ok": False,
            "pdf_header_ok": False,
        },
        "warnings": [],
    }
    payload.update(extra)
    return payload


if __name__ == "__main__":
    raise SystemExit(main())
