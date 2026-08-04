#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any


DEFAULT_MAX_PAGES = 20
DEFAULT_MAX_CHARS = 20000
DEFAULT_MAX_TABLES = 8
DEFAULT_MAX_TABLE_ROWS = 6
DEFAULT_RENDER_DPI = 220
DEFAULT_RENDER_MAX_PAGES = 20
DEFAULT_OCR_MAX_PAGES = 5
DEFAULT_VISION_MAX_PAGES = 5
DEFAULT_VISION_API_TIMEOUT = 300
DEFAULT_MINERU_MAX_PAGES = 10
DEFAULT_MINERU_TIMEOUT = 900
DEFAULT_RESOLVED_MAX_CHARS = 50000
DEFAULT_WINDOWS_MINERU = Path("D:/mineru/venv/Scripts/mineru.exe")
CATSCOMPANY_ATTACHMENT_REF_PREFIX = "catsco_attachment:"
DEFAULT_VISION_PROMPT = (
    "Read this PDF page image conservatively. Extract visible text and describe "
    "important visual-only semantics such as charts, stamps, signatures, handwriting, "
    "figures, tables, callouts, or layout relationships. Do not invent content that is "
    "not visible."
)
RUNTIME_ENV_KEYS = frozenset(
    {
        "XIAOBA_OCR_API_URL",
        "XIAOBA_OCR_API_KEY",
        "XIAOBA_MINERU_API_URL",
        "XIAOBA_MINERU_API_KEY",
        "MINERU_API_URL",
        "XIAOBA_VISION_API_URL",
        "XIAOBA_VISION_API_KEY",
        "XIAOBA_VISION_BEARER_TOKEN",
        "READER_PROXY_URL",
        "READER_PROXY_API_KEY",
        "READER_PROXY_BEARER_TOKEN",
        "CATSCOMPANY_READER_API_URL",
        "CATSCOMPANY_API_KEY",
        "CATSCOMPANY_BEARER_TOKEN",
        "CATSCO_HTTP_BASE_URL",
    }
)
RUNTIME_ENV_FILES_LOADED: list[str] = []
RUNTIME_ENV_KEYS_LOADED: set[str] = set()
RUNTIME_ENV_LOAD_DONE = False

MIN_USEFUL_TEXT_CHARS = 80
MIN_NONBLANK_OCR_RESOLVED_CHARS = 20
MINERU_TEXT_LAYER_FALLBACK_MIN_CHARS = 1000
MINERU_TEXT_LAYER_FALLBACK_MIN_OUTPUT_CHARS = 100
MINERU_TEXT_LAYER_FALLBACK_RATIO = 0.05
SCAN_IMAGE_AREA_THRESHOLD = 0.45
LARGE_IMAGE_AREA_THRESHOLD = 0.35
VECTOR_OBJECT_OCR_THRESHOLD = 3
NEAR_BLANK_MEAN_LUMA_THRESHOLD = 254.0
NEAR_BLANK_LUMA_STDDEV_THRESHOLD = 3.0
NEAR_BLANK_DARK_PIXEL_RATIO_245_THRESHOLD = 0.005
NEAR_BLANK_DARK_PIXEL_RATIO_240_THRESHOLD = 0.001
HIGH_ABNORMAL_SYMBOL_RATIO = 0.18
MEDIUM_ABNORMAL_SYMBOL_RATIO = 0.10
HIGH_SINGLE_CHAR_LINE_RATIO = 0.45
MEDIUM_SHORT_LINE_DENSITY = 0.55
HIGH_REPEATED_LINE_RATIO = 0.45
TEXT_LAYER_TRUST_MIN_CHARS = 1000
TEXT_LAYER_TRUST_MEDIUM_AVG_LINE_LENGTH = 500
TEXT_LAYER_TRUST_HIGH_AVG_LINE_LENGTH = 1200
TEXT_LAYER_TRUST_SPARSE_LINE_MAX_COUNT = 8
TEXT_LAYER_TRUST_HIGH_MIN_CHARS = 5000
HIGH_FORMULA_SYMBOL_RATIO = 0.06
MEDIUM_FORMULA_SYMBOL_RATIO = 0.025
REDACTION_OVERLAY_DARK_LUMINANCE_THRESHOLD = 0.26
REDACTION_OVERLAY_MIN_RECT_WIDTH = 12.0
REDACTION_OVERLAY_MIN_RECT_HEIGHT = 5.0
REDACTION_OVERLAY_MIN_RECT_AREA_RATIO = 0.00005
REDACTION_OVERLAY_MAX_RECT_AREA_RATIO = 0.25
REDACTION_OVERLAY_MIN_RECT_ASPECT = 1.8
REDACTION_OVERLAY_TALL_RECT_MIN_HEIGHT = 24.0
REDACTION_OVERLAY_MIN_CHAR_OVERLAP_RATIO = 0.35
REDACTION_OVERLAY_MIN_WORD_OVERLAP_RATIO = 0.25
REDACTION_OVERLAY_MIN_COVERED_NON_LIGHT_CHARS = 4
REDACTION_OVERLAY_MIN_NON_LIGHT_SHARE = 0.55
REDACTION_OVERLAY_SPATIAL_BIN_HEIGHT = 24.0

FORMULA_SYMBOLS = set(
    "=+-*/^_<>[]{}()|~"
    "\u2248\u2260\u2264\u2265\u2211\u222b\u221a\u221e\u03c0\u00f7\u00d7\u00b1"
)
CHECKBOX_MARKERS = (
    "[ ]",
    "[]",
    "[x]",
    "[X]",
    "[v]",
    "[V]",
    "[✓]",
    "[✔]",
    "☐",
    "☑",
    "☒",
)
NON_FORMULA_SPAN_RE = re.compile(r"(?i)\b(?:file|https?)://\S+|[A-Za-z]:[\\/]\S+")
ALLOWED_SYMBOLS = set(
    ".,;:!?\"'`~@#$%&*+-=/\\|_()[]{}<>"
    "\uff0c\u3002\uff1b\uff1a\uff01\uff1f\u201c\u201d\u2018\u2019\u3001"
    "\uff08\uff09\u3010\u3011\u300a\u300b"
    "\u00b7\u2026\u2014-"
)


def io_path(path: Path) -> str:
    if os.name != "nt":
        return str(path)
    text = str(path.resolve())
    if text.startswith("\\\\?\\"):
        return text
    if text.startswith("\\\\"):
        return "\\\\?\\UNC\\" + text.lstrip("\\")
    return "\\\\?\\" + text


def ensure_dir(path: Path) -> None:
    os.makedirs(io_path(path), exist_ok=True)


def write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    ensure_dir(path.parent)
    with open(io_path(path), "w", encoding=encoding) as handle:
        handle.write(text)


def emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    raise SystemExit(exit_code)


def module_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def parse_dotenv_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[len("export ") :].strip()
    if "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
        return None
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return key, value


def runtime_env_candidate_files() -> list[Path]:
    candidates: list[Path] = []
    for env_name in ("XIAOBA_READ_PDF_ENV_FILE", "XIAOBA_RUNTIME_ENV_FILE"):
        configured = os.environ.get(env_name, "").strip()
        if configured:
            candidates.append(Path(os.path.expandvars(configured)).expanduser())

    for root_env_name in ("XIAOBA_RUNTIME_ROOT", "XIAOBA_HOME", "CATSCOMPANY_RUNTIME_ROOT"):
        root = os.environ.get(root_env_name, "").strip()
        if root:
            candidates.append(Path(os.path.expandvars(root)).expanduser() / ".env")

    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        candidates.append(Path(appdata).expanduser() / "xiaoba-cli" / ".env")
    if os.name == "nt":
        candidates.append(Path.home() / "AppData" / "Roaming" / "xiaoba-cli" / ".env")

    candidates.append(Path.cwd() / ".env")

    skill_defaults = Path(__file__).resolve().parents[1] / "config" / "defaults.env"
    candidates.append(skill_defaults)

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        try:
            normalized = str(candidate.expanduser().resolve())
        except Exception:
            normalized = str(candidate)
        normalized_key = normalized.lower() if os.name == "nt" else normalized
        if normalized_key in seen:
            continue
        seen.add(normalized_key)
        unique.append(Path(normalized))
    return unique


def load_runtime_env_defaults() -> None:
    global RUNTIME_ENV_LOAD_DONE
    if RUNTIME_ENV_LOAD_DONE:
        return
    RUNTIME_ENV_LOAD_DONE = True

    skip = os.environ.get("XIAOBA_READ_PDF_SKIP_DOTENV", "").strip().lower()
    if skip in {"1", "true", "yes", "on"}:
        return

    for path in runtime_env_candidate_files():
        if not path.is_file():
            continue
        loaded_from_file: set[str] = set()
        try:
            with open(io_path(path), encoding="utf-8-sig") as handle:
                for line in handle:
                    parsed = parse_dotenv_line(line)
                    if not parsed:
                        continue
                    key, value = parsed
                    if key not in RUNTIME_ENV_KEYS:
                        continue
                    if not value or os.environ.get(key):
                        continue
                    os.environ[key] = value
                    loaded_from_file.add(key)
        except Exception:
            continue

        if loaded_from_file:
            RUNTIME_ENV_FILES_LOADED.append(str(path))
            RUNTIME_ENV_KEYS_LOADED.update(loaded_from_file)


def split_command_line(value: str) -> list[str]:
    value = os.path.expandvars(value.strip())
    if not value:
        return []
    unquoted = value
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        unquoted = value[1:-1]
    candidate_path = Path(unquoted).expanduser()
    if candidate_path.exists():
        return [str(candidate_path)]

    tokens: list[str] = []
    current: list[str] = []
    quote: str | None = None
    for char in value:
        if char in {"'", '"'}:
            if quote == char:
                quote = None
                continue
            if quote is None:
                quote = char
                continue
        if char.isspace() and quote is None:
            if current:
                tokens.append("".join(current))
                current = []
            continue
        current.append(char)
    if current:
        tokens.append("".join(current))
    return tokens


def command_exists(tokens: list[str]) -> bool:
    if not tokens:
        return False
    executable = tokens[0]
    if any(separator in executable for separator in ("/", "\\")) or Path(executable).suffix:
        return Path(executable).expanduser().exists()
    return shutil.which(executable) is not None


def detect_ocr_backends() -> list[str]:
    backends: list[str] = []
    if shutil.which("paddleocr") or module_available("paddleocr"):
        backends.append("paddleocr")
    if shutil.which("tesseract") or module_available("pytesseract"):
        backends.append("tesseract")
    if shutil.which("rapidocr") or module_available("rapidocr_onnxruntime") or module_available("rapidocr"):
        backends.append("rapidocr")
    return backends


def find_poppler_path() -> str | None:
    for command in ("pdftoppm", "pdfinfo"):
        found = shutil.which(command)
        if not found:
            continue
        found_path = Path(found)
        if found_path.suffix.lower() == ".exe":
            return str(found_path.parent)
        sibling_exe = found_path.with_suffix(".exe")
        if sibling_exe.exists():
            return str(found_path.parent)

    home = Path.home()
    candidates = [
        home / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies" / "native" / "poppler" / "Library" / "bin",
    ]
    for candidate in candidates:
        if (candidate / "pdftoppm.exe").exists() and (candidate / "pdfinfo.exe").exists():
            return str(candidate)
    return None


def detect_page_render_availability() -> dict[str, Any]:
    has_pdf2image = module_available("pdf2image")
    has_pymupdf = module_available("fitz")
    poppler_path = find_poppler_path()
    has_pdftoppm = bool(shutil.which("pdftoppm")) or bool(poppler_path and (Path(poppler_path) / "pdftoppm.exe").exists())
    has_pdfinfo = bool(shutil.which("pdfinfo")) or bool(poppler_path and (Path(poppler_path) / "pdfinfo.exe").exists())
    has_pdf2image_poppler = has_pdf2image and has_pdftoppm
    fallback_backends: list[str] = []
    if has_pdf2image_poppler:
        fallback_backends.append("pdf2image+poppler")
    if has_pymupdf:
        fallback_backends.append("pymupdf")
    missing: list[str] = []
    if not has_pdf2image and not has_pymupdf:
        missing.append("pdf2image")
    if not has_pdftoppm and not has_pymupdf:
        missing.append("pdftoppm")
    if not has_pymupdf and not has_pdf2image_poppler:
        missing.append("pymupdf")
    return {
        "available": bool(fallback_backends),
        "backend": fallback_backends[0] if fallback_backends else None,
        "fallback_backends": fallback_backends,
        "pdf2image": has_pdf2image,
        "pymupdf": has_pymupdf,
        "pdftoppm": has_pdftoppm,
        "pdfinfo": has_pdfinfo,
        "poppler_path": poppler_path,
        "missing": missing,
        "reason": ""
        if not missing
        else "page rendering requires either pdf2image+pdftoppm or pymupdf; missing " + ", ".join(missing),
    }


def resolve_mineru_command(args: argparse.Namespace | None = None) -> dict[str, Any]:
    configured_cmd = getattr(args, "mineru_cmd", None) if args is not None else None
    if configured_cmd:
        tokens = split_command_line(str(configured_cmd))
        return {
            "source": "argument",
            "command": tokens,
            "exists": command_exists(tokens),
        }

    for env_name in ("MINERU_CMD", "MINERU_EXE"):
        env_value = os.environ.get(env_name, "")
        if not env_value:
            continue
        tokens = split_command_line(env_value)
        if tokens:
            return {
                "source": env_name,
                "command": tokens,
                "exists": command_exists(tokens),
            }

    if DEFAULT_WINDOWS_MINERU.exists():
        return {
            "source": "default_windows_path",
            "command": [str(DEFAULT_WINDOWS_MINERU)],
            "exists": True,
        }

    for command_name in ("mineru", "magic-pdf"):
        command_path = shutil.which(command_name)
        if command_path:
            return {
                "source": f"path:{command_name}",
                "command": [command_path],
                "exists": True,
            }

    return {
        "source": None,
        "command": [],
        "exists": False,
    }


def detect_mineru_availability(args: argparse.Namespace | None = None) -> dict[str, Any]:
    command_info = resolve_mineru_command(args)
    modules = [
        name
        for name in ("magic_pdf", "mineru")
        if module_available(name)
    ]
    api_url = ""
    if args is not None:
        api_url = str(getattr(args, "mineru_api", "") or "")
    api_url = api_url or os.environ.get("XIAOBA_MINERU_API_URL", "") or os.environ.get("MINERU_API_URL", "")
    backends: list[str] = []
    if api_url:
        backends.append("http_api")
    if command_info.get("command") and command_info.get("exists"):
        backends.append("local_cli")
    return {
        "available": bool(api_url) or (bool(command_info.get("command")) and bool(command_info.get("exists"))),
        "backends": backends,
        "command_source": command_info.get("source"),
        "command_exists": command_info.get("exists"),
        "modules_detected": modules,
        "api_configured": bool(api_url),
    }


def resolve_vision_api_url(
    args: argparse.Namespace | None = None,
    include_environment: bool = True,
) -> tuple[str, str | None]:
    if args is not None:
        configured = str(getattr(args, "vision_api", "") or "").strip()
        if configured:
            return configured, "argument"
    if not include_environment:
        return "", None
    for env_name in ("XIAOBA_VISION_API_URL", "READER_PROXY_URL", "CATSCOMPANY_READER_API_URL"):
        env_value = os.environ.get(env_name, "").strip()
        if env_value:
            return env_value, env_name
    catsco_base = os.environ.get("CATSCO_HTTP_BASE_URL", "").strip()
    if catsco_base:
        return catsco_base.rstrip("/") + "/api/reader", "CATSCO_HTTP_BASE_URL"
    return "", None


def detect_vision_availability(args: argparse.Namespace | None = None) -> dict[str, Any]:
    include_environment = bool(
        args is not None
        and (
            getattr(args, "run_vision", False)
            or getattr(args, "retry_short_ocr_with_vision", False)
        )
    )
    api_url, source = resolve_vision_api_url(args, include_environment=include_environment)
    return {
        "available": bool(api_url),
        "backends": ["reader_proxy"] if api_url else [],
        "api_configured": bool(api_url),
        "api_url_source": source,
    }


def detect_backend_availability(args: argparse.Namespace | None = None) -> dict[str, Any]:
    load_runtime_env_defaults()
    ocr_backends = detect_ocr_backends()
    configured_ocr_api = ""
    if args is not None:
        configured_ocr_api = str(getattr(args, "ocr_api", "") or "")
    configured_ocr_api = configured_ocr_api or os.environ.get("XIAOBA_OCR_API_URL", "")
    if configured_ocr_api and "http_api" not in ocr_backends:
        ocr_backends.insert(0, "http_api")
    page_render = detect_page_render_availability()
    mineru = detect_mineru_availability(args)
    vision = detect_vision_availability(args)
    return {
        "text_extract": module_available("pdfplumber"),
        "ocr": bool(ocr_backends),
        "ocr_backends": ocr_backends,
        "page_render": page_render["available"],
        "page_render_backend": page_render["backend"],
        "page_render_fallback_backends": page_render["fallback_backends"],
        "page_render_pdf2image": page_render["pdf2image"],
        "page_render_pymupdf": page_render["pymupdf"],
        "page_render_pdftoppm": page_render["pdftoppm"],
        "page_render_pdfinfo": page_render["pdfinfo"],
        "page_render_poppler_path": page_render["poppler_path"],
        "page_render_missing": page_render["missing"],
        "page_render_reason": page_render["reason"],
        "vision": True if vision["available"] else "unknown",
        "vision_backends": vision["backends"],
        "vision_api_configured": vision["api_configured"],
        "vision_api_url_source": vision["api_url_source"],
        "mineru": bool(mineru["available"]),
        "mineru_backends": mineru["backends"],
        "mineru_command_source": mineru["command_source"],
        "mineru_command_exists": mineru["command_exists"],
        "mineru_modules_detected": mineru["modules_detected"],
        "mineru_api_configured": mineru["api_configured"],
        "ocr_api_configured": bool(configured_ocr_api),
        "runtime_env_files_loaded": list(RUNTIME_ENV_FILES_LOADED),
        "runtime_env_loaded_keys": sorted(RUNTIME_ENV_KEYS_LOADED),
    }


def empty_quality_summary() -> dict[str, str]:
    return {
        "text_layer_quality": "low",
        "structure_risk": "unknown",
        "scan_risk": "unknown",
        "redaction_overlay_risk": "unknown",
    }


def empty_route_advisories() -> dict[str, Any]:
    return {
        "advisory_count": 0,
        "visual_verification_page_count": 0,
        "warning_page_count": 0,
        "counts_by_code": {},
        "pages": [],
    }


def default_rendered_pages() -> dict[str, Any]:
    return {
        "attempted": False,
        "status": "not_requested",
        "pages": [],
    }


def default_vision_handoff() -> dict[str, Any]:
    return {
        "attempted": False,
        "status": "not_requested",
        "pages_total": 0,
        "pages_ready": 0,
        "pages_completed": 0,
        "pages": [],
    }


def default_vision_results() -> dict[str, Any]:
    return {
        "attempted": False,
        "status": "not_requested",
        "backend": "external",
        "pages": [],
    }


def default_ocr_results() -> dict[str, Any]:
    return {
        "attempted": False,
        "status": "not_requested",
        "pages": [],
    }


def default_mineru_results() -> dict[str, Any]:
    return {
        "attempted": False,
        "status": "not_requested",
        "backend": "local_cli",
        "pages": [],
    }


def default_resolved_summary() -> dict[str, Any]:
    return {
        "pages_total": 0,
        "pages_with_text": 0,
        "pages_unavailable": 0,
        "pages_omitted": 0,
        "chars_included": 0,
        "truncated": False,
        "source_counts": {},
        "status_counts": {},
    }


def error_packet(path: str, code: str, message: str) -> dict[str, Any]:
    return {
        "ok": False,
        "source_path": path,
        "source_type": "pdf",
        "error": {"code": code, "message": message},
        "classification": "unknown",
        "coverage": {
            "pages_total": 0,
            "pages_processed": 0,
            "sampled": False,
            "pages_with_text": 0,
            "pages_without_text": 0,
            "chars_extracted": 0,
            "chars_included": 0,
        },
        "content": [],
        "tables": [],
        "images": [],
        "uncertainties": [message],
        "backend_availability": detect_backend_availability(),
        "quality_summary": empty_quality_summary(),
        "route_decision": {
            "selected": "partial",
            "confidence": "low",
            "reason": [message],
            "required_backends": [],
            "blocked_backends": [],
        },
        "route_advisories": empty_route_advisories(),
        "page_decisions": [],
        "rendered_pages": default_rendered_pages(),
        "vision_handoff": default_vision_handoff(),
        "vision_results": default_vision_results(),
        "ocr_results": default_ocr_results(),
        "mineru_results": default_mineru_results(),
        "resolved_pages": [],
        "resolved_summary": default_resolved_summary(),
        "recommended_route": "partial",
        "rendering_risk": {
            "image_conversion_needed": False,
            "compression_risk": "unknown",
            "reason": message,
        },
        "requires_ocr": False,
        "truncated": False,
    }


def is_catsco_attachment_ref(value: str) -> bool:
    return value.strip().startswith(CATSCOMPANY_ATTACHMENT_REF_PREFIX)


def catsco_runtime_roots() -> list[Path]:
    roots: list[Path] = []
    for value in (
        os.environ.get("XIAOBA_RUNTIME_ROOT", ""),
        os.environ.get("XIAOBA_HOME", ""),
        os.environ.get("CATSCOMPANY_RUNTIME_ROOT", ""),
        os.environ.get("APPDATA", "") and str(Path(os.environ["APPDATA"]) / "xiaoba-cli"),
        str(Path.cwd()),
    ):
        if not value:
            continue
        root = Path(value).expanduser()
        if root not in roots:
            roots.append(root)
    return roots


def catsco_download_dirs() -> list[Path]:
    dirs: list[Path] = []
    for root in catsco_runtime_roots():
        candidate = root / "tmp" / "downloads"
        if candidate not in dirs:
            dirs.append(candidate)
    return dirs


def describe_file_candidate(path: Path) -> dict[str, Any]:
    try:
        stat = path.stat()
    except OSError:
        return {
            "path": str(path),
            "name": path.name,
            "size_bytes": None,
            "mtime_ms": None,
        }
    return {
        "path": str(path),
        "name": path.name,
        "size_bytes": stat.st_size,
        "mtime_ms": int(stat.st_mtime * 1000),
    }


def resolve_catsco_attachment_pdf(ref: str) -> tuple[Path | None, dict[str, Any]]:
    download_dirs = catsco_download_dirs()
    candidates: list[Path] = []
    for downloads_dir in download_dirs:
        if not downloads_dir.exists() or not downloads_dir.is_dir():
            continue
        try:
            for candidate in downloads_dir.iterdir():
                if candidate.is_file() and candidate.suffix.lower() == ".pdf":
                    candidates.append(candidate)
        except OSError:
            continue

    candidates.sort(key=lambda item: item.stat().st_mtime if item.exists() else 0, reverse=True)
    resolution: dict[str, Any] = {
        "input": ref,
        "kind": "catsco_attachment",
        "strategy": "latest_pdf_in_runtime_tmp_downloads",
        "download_dirs": [str(path) for path in download_dirs],
        "candidate_count": len(candidates),
        "candidate_sample": [describe_file_candidate(path) for path in candidates[:5]],
        "warning": None,
    }
    if not candidates:
        resolution["status"] = "unresolved"
        resolution["warning"] = (
            "No local PDF candidate found under runtime tmp/downloads. "
            "Pass a real local PDF path or expose an authorized script-readable attachment path."
        )
        return None, resolution

    selected = candidates[0].resolve()
    resolution["status"] = "resolved"
    resolution["resolved_path"] = str(selected)
    if len(candidates) > 1:
        resolution["warning"] = (
            "Multiple local PDF candidates existed; selected the newest file. "
            "This is a compatibility bridge for catsco_attachment refs until the platform exposes a direct script-readable path."
        )
    return selected, resolution


def resolve_input_pdf_path(path_value: str) -> tuple[Path, dict[str, Any] | None]:
    if not is_catsco_attachment_ref(path_value):
        return Path(path_value).expanduser(), None

    resolved, resolution = resolve_catsco_attachment_pdf(path_value)
    if resolved is None:
        return Path(path_value).expanduser(), resolution
    return resolved, resolution


def parse_page_spec(spec: str, pages_total: int) -> list[int]:
    pages: list[int] = []
    seen: set[int] = set()
    normalized = spec.strip().lower()
    if normalized == "all":
        return list(range(1, pages_total + 1))
    if not normalized:
        raise ValueError("--pages cannot be empty")

    for part in normalized.split(","):
        item = part.strip()
        if not item:
            continue
        if "-" in item:
            bounds = [value.strip() for value in item.split("-", 1)]
            if len(bounds) != 2 or not bounds[0] or not bounds[1]:
                raise ValueError(f"invalid page range: {item}")
            try:
                start = int(bounds[0])
                end = int(bounds[1])
            except ValueError as exc:
                raise ValueError(f"invalid page range: {item}") from exc
            if start > end:
                raise ValueError(f"page range start is after end: {item}")
            candidates = range(start, end + 1)
        else:
            try:
                page_number = int(item)
            except ValueError as exc:
                raise ValueError(f"invalid page number: {item}") from exc
            candidates = range(page_number, page_number + 1)

        for page_number in candidates:
            if page_number < 1 or page_number > pages_total:
                raise ValueError(f"page {page_number} is outside document range 1-{pages_total}")
            if page_number not in seen:
                pages.append(page_number)
                seen.add(page_number)

    if not pages:
        raise ValueError("--pages did not select any pages")
    return pages


def compact_page_numbers(pages: list[int], limit: int = 30) -> dict[str, Any]:
    if len(pages) <= limit:
        return {"count": len(pages), "pages": pages}
    head_count = limit // 2
    tail_count = limit - head_count
    return {
        "count": len(pages),
        "head": pages[:head_count],
        "tail": pages[-tail_count:],
    }


def select_pages(args: argparse.Namespace, pages_total: int) -> tuple[str, list[int]]:
    if args.pages:
        return "explicit", parse_page_spec(args.pages, pages_total)
    if args.diagnose_all:
        return "all", list(range(1, pages_total + 1))
    return "first_n", list(range(1, min(pages_total, args.max_pages) + 1))


def compact_backend_availability(payload: dict[str, Any]) -> dict[str, Any]:
    backend = payload.get("backend_availability", {})
    if not isinstance(backend, dict):
        return {}
    keys = [
        "text_extract",
        "ocr",
        "ocr_backends",
        "ocr_api_configured",
        "page_render",
        "page_render_backend",
        "page_render_fallback_backends",
        "page_render_pdf2image",
        "page_render_pymupdf",
        "page_render_pdftoppm",
        "page_render_pdfinfo",
        "page_render_poppler_path",
        "page_render_missing",
        "page_render_reason",
        "vision",
        "vision_backends",
        "vision_api_configured",
        "vision_api_url_source",
        "mineru",
        "mineru_backends",
        "mineru_api_configured",
        "runtime_env_files_loaded",
        "runtime_env_loaded_keys",
    ]
    return {key: backend.get(key) for key in keys if key in backend}


def build_next_actions(payload: dict[str, Any]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    backend = payload.get("backend_availability", {})
    route = payload.get("route_decision", {})
    rendered = payload.get("rendered_pages", {})
    ocr = payload.get("ocr_results", {})
    coverage = payload.get("coverage", {})
    selected_route = route.get("selected") if isinstance(route, dict) else None
    required_backends = set(route.get("required_backends", []) or []) if isinstance(route, dict) else set()

    if isinstance(backend, dict) and not backend.get("text_extract"):
        actions.append(
            {
                "code": "install_read_pdf_requirements",
                "reason": "pdfplumber is not importable; text-layer diagnosis cannot be trusted.",
                "command_hint": "python -m pip install -r <SKILL_DIR>/requirements.txt",
            }
        )

    needs_ocr = selected_route == "ocr_required" or "ocr" in required_backends or bool(payload.get("requires_ocr"))
    if needs_ocr and isinstance(ocr, dict) and ocr.get("status") != "ok":
        if isinstance(ocr.get("reason"), str) and "selected; limit is" in str(ocr.get("reason")):
            actions.append(
                {
                    "code": "split_ocr_batches",
                    "reason": ocr.get("reason"),
                    "command_hint": "rerun --run-ocr on smaller --pages batches, or intentionally raise both --ocr-max-pages and --render-max-pages",
                }
            )
        elif isinstance(backend, dict) and not backend.get("ocr"):
            actions.append(
                {
                    "code": "ocr_backend_unavailable",
                    "reason": "no OCR backend was detected after runtime defaults were loaded",
                }
            )
        elif isinstance(backend, dict) and not backend.get("page_render"):
            missing = backend.get("page_render_missing") or []
            actions.append(
                {
                    "code": "install_or_fix_page_render",
                    "reason": backend.get("page_render_reason") or "OCR requires rendering PDF pages before sending them to the OCR backend.",
                    "missing": missing,
                    "command_hint": "python -m pip install -r <SKILL_DIR>/requirements.txt, then rerun the OCR command",
                }
            )
        elif isinstance(backend, dict) and backend.get("ocr_api_configured"):
            page_count = None
            if isinstance(coverage, dict):
                processed = coverage.get("page_selection", {}).get("processed", {})
                if isinstance(processed, dict):
                    page_count = processed.get("count")
            actions.append(
                {
                    "code": "run_targeted_http_ocr",
                    "reason": "HTTP OCR is configured and page rendering is available; execute OCR instead of reporting missing OCR configuration.",
                    "page_count": page_count,
                    "command_hint": "python <SKILL_DIR>/scripts/pdf-intake.py <pdf> --pages <range> --no-content --run-ocr --ocr-backend auto --output <packet.json>",
                }
            )
        else:
            actions.append(
                {
                    "code": "run_available_ocr",
                    "reason": "OCR is required and an OCR backend is available; execute targeted OCR before summarizing scanned pages.",
                    "command_hint": "python <SKILL_DIR>/scripts/pdf-intake.py <pdf> --pages <range> --no-content --run-ocr --ocr-backend auto --output <packet.json>",
                }
            )

    if isinstance(rendered, dict) and rendered.get("status") == "backend_unavailable":
        reason = rendered.get("reason")
        if not any(action.get("code") == "install_or_fix_page_render" for action in actions):
            actions.append(
                {
                    "code": "install_or_fix_page_render",
                    "reason": reason or "page rendering backend is unavailable",
                    "command_hint": "python -m pip install -r <SKILL_DIR>/requirements.txt, then rerun the rendering/OCR command",
                }
            )

    return actions


def output_summary(payload: dict[str, Any], output_path: Path) -> dict[str, Any]:
    rendered_pages = payload.get("rendered_pages", {})
    vision_handoff = payload.get("vision_handoff", {})
    vision_results = payload.get("vision_results", {})
    ocr_results = payload.get("ocr_results", {})
    mineru_results = payload.get("mineru_results", {})
    return {
        "ok": payload.get("ok"),
        "output_path": str(output_path),
        "source_path": payload.get("source_path"),
        "source_reference": payload.get("source_reference"),
        "source_resolution": payload.get("source_resolution"),
        "classification": payload.get("classification"),
        "coverage": payload.get("coverage"),
        "quality_summary": payload.get("quality_summary"),
        "route_decision": payload.get("route_decision"),
        "backend_availability": compact_backend_availability(payload),
        "next_actions": build_next_actions(payload),
        "requires_ocr": payload.get("requires_ocr"),
        "truncated": payload.get("truncated"),
        "rendered_pages": {
            "attempted": rendered_pages.get("attempted", False) if isinstance(rendered_pages, dict) else False,
            "status": rendered_pages.get("status") if isinstance(rendered_pages, dict) else None,
            "count": len(rendered_pages.get("pages", [])) if isinstance(rendered_pages, dict) else 0,
        },
        "vision_handoff": {
            "attempted": vision_handoff.get("attempted", False) if isinstance(vision_handoff, dict) else False,
            "status": vision_handoff.get("status") if isinstance(vision_handoff, dict) else None,
            "count": len(vision_handoff.get("pages", [])) if isinstance(vision_handoff, dict) else 0,
            "ready_count": vision_handoff.get("pages_ready", 0) if isinstance(vision_handoff, dict) else 0,
            "completed_count": vision_handoff.get("pages_completed", 0) if isinstance(vision_handoff, dict) else 0,
        },
        "vision_results": {
            "attempted": vision_results.get("attempted", False) if isinstance(vision_results, dict) else False,
            "status": vision_results.get("status") if isinstance(vision_results, dict) else None,
            "backend": vision_results.get("backend") if isinstance(vision_results, dict) else None,
            "count": len(vision_results.get("pages", [])) if isinstance(vision_results, dict) else 0,
        },
        "ocr_results": {
            "attempted": ocr_results.get("attempted", False) if isinstance(ocr_results, dict) else False,
            "status": ocr_results.get("status") if isinstance(ocr_results, dict) else None,
            "backend": ocr_results.get("backend") if isinstance(ocr_results, dict) else None,
            "count": len(ocr_results.get("pages", [])) if isinstance(ocr_results, dict) else 0,
        },
        "mineru_results": {
            "attempted": mineru_results.get("attempted", False) if isinstance(mineru_results, dict) else False,
            "status": mineru_results.get("status") if isinstance(mineru_results, dict) else None,
            "backend": mineru_results.get("backend") if isinstance(mineru_results, dict) else None,
            "count": len(mineru_results.get("pages", [])) if isinstance(mineru_results, dict) else 0,
        },
        "resolved_summary": payload.get("resolved_summary"),
        "uncertainties": payload.get("uncertainties", []),
    }


def run_failure_capture(output_path: Path, args: argparse.Namespace) -> dict[str, Any] | None:
    if not args.failure_candidates_output:
        return None
    collector_path = Path(__file__).with_name("collect-pdf-packet-failures.py")
    failure_output = Path(args.failure_candidates_output).expanduser().resolve()
    summary_path = Path(args.failure_candidates_summary).expanduser().resolve() if args.failure_candidates_summary else None
    report_path = Path(args.failure_candidates_report).expanduser().resolve() if args.failure_candidates_report else None
    cmd = [
        sys.executable,
        str(collector_path),
        "--input-root",
        str(output_path),
        "--output",
        str(failure_output),
    ]
    if summary_path:
        cmd.extend(["--summary", str(summary_path)])
    if report_path:
        cmd.extend(["--report", str(report_path)])
    if args.failure_capture_allow_missing_sources:
        cmd.append("--allow-missing-sources")
    if args.failure_capture_exclude_known_families:
        cmd.append("--exclude-known-families")
    if args.failure_capture_allow_untrusted_text_layer_ratio:
        cmd.append("--allow-untrusted-text-layer-ratio")
    for item in args.failure_capture_known_family or []:
        cmd.extend(["--known-family", item])

    result: dict[str, Any] = {
        "attempted": True,
        "ok": False,
        "collector": str(collector_path),
        "output_csv": str(failure_output),
        "summary": str(summary_path) if summary_path else None,
        "report": str(report_path) if report_path else None,
        "exit_code": None,
        "candidate_count": None,
        "new_family_candidate_count": None,
        "known_family_candidate_count": None,
        "parse_error_count": None,
    }
    if not collector_path.exists():
        result["error"] = f"collector_not_found: {collector_path}"
        return result
    try:
        proc = subprocess.run(
            cmd,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=args.failure_capture_timeout,
        )
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result

    result["exit_code"] = proc.returncode
    result["ok"] = proc.returncode == 0
    if proc.stderr:
        result["stderr_preview"] = proc.stderr[:1000]
    summary_payload: dict[str, Any] | None = None
    if summary_path and summary_path.exists():
        try:
            summary_payload = json.loads(summary_path.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            result["summary_read_error"] = f"{type(exc).__name__}: {exc}"
    elif proc.stdout.strip():
        try:
            summary_payload = json.loads(proc.stdout)
        except Exception:
            result["stdout_preview"] = proc.stdout[:1000]
    if summary_payload:
        result["candidate_count"] = summary_payload.get("candidate_count")
        result["new_family_candidate_count"] = summary_payload.get("new_family_candidate_count")
        result["known_family_candidate_count"] = summary_payload.get("known_family_candidate_count")
        result["parse_error_count"] = summary_payload.get("parse_error_count")
        result["signal_counts"] = summary_payload.get("signal_counts", {})
        result["known_family_counts"] = summary_payload.get("known_family_counts", {})
    return result


def normalize_confidence(value: Any, default: str = "medium") -> str:
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"high", "medium", "low"}:
            return lowered
        try:
            value = float(lowered)
        except ValueError:
            return default
    if isinstance(value, (int, float)):
        numeric = float(value)
        if numeric >= 0.85:
            return "high"
        if numeric >= 0.55:
            return "medium"
        return "low"
    return default


def vision_text_from_item(item: dict[str, Any]) -> str:
    for key in ("text", "markdown", "description", "content"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    lines = item.get("lines")
    if isinstance(lines, list):
        parts = [str(line).strip() for line in lines if str(line).strip()]
        if parts:
            return "\n".join(parts)
    return ""


def load_vision_results(path_value: str | None) -> dict[str, Any]:
    if not path_value:
        return default_vision_results()
    path = Path(path_value).expanduser().resolve()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {
            "attempted": True,
            "status": "load_failed",
            "backend": "external",
            "source_path": str(path),
            "reason": f"could not load vision results JSON: {exc}",
            "pages": [],
        }

    if isinstance(payload, list):
        raw_pages = payload
        backend = "external"
    elif isinstance(payload, dict):
        raw_pages = payload.get("pages") or payload.get("results") or []
        backend = str(payload.get("backend") or payload.get("provider") or "external")
    else:
        return {
            "attempted": True,
            "status": "load_failed",
            "backend": "external",
            "source_path": str(path),
            "reason": "vision results JSON must be an object or list",
            "pages": [],
        }

    pages: list[dict[str, Any]] = []
    raw_page_items = raw_pages if isinstance(raw_pages, list) else []
    for raw_page in raw_page_items:
        if not isinstance(raw_page, dict) or raw_page.get("page") is None:
            continue
        try:
            page_number = int(raw_page["page"])
        except (TypeError, ValueError):
            continue
        text = vision_text_from_item(raw_page)
        ok = bool(raw_page.get("ok", bool(text)))
        pages.append(
            {
                "page": page_number,
                "ok": ok,
                "text": text,
                "char_count": int(raw_page.get("char_count") or len(text)),
                "confidence": normalize_confidence(raw_page.get("confidence"), "high" if ok and text else "low"),
                "image_path": raw_page.get("image_path") or raw_page.get("path"),
                "backend": str(raw_page.get("backend") or backend),
                "error": raw_page.get("error") or raw_page.get("reason"),
                "evidence": raw_page.get("evidence", []) if isinstance(raw_page.get("evidence", []), list) else [],
            }
        )

    if pages and all(page.get("ok") and page.get("text") for page in pages):
        status = "ok"
    elif pages:
        status = "partial"
    else:
        status = "partial"
    return {
        "attempted": True,
        "status": status,
        "backend": backend,
        "source_path": str(path),
        "pages": pages,
    }


def merge_vision_results(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    if not incoming or incoming.get("status") == "not_requested":
        return existing
    if not existing or existing.get("status") == "not_requested":
        return incoming

    by_page: dict[int, dict[str, Any]] = {}
    for source in (existing, incoming):
        for item in source.get("pages", []) or []:
            if not isinstance(item, dict) or item.get("page") is None:
                continue
            try:
                by_page[int(item["page"])] = item
            except (TypeError, ValueError):
                continue
    pages = [by_page[page] for page in sorted(by_page)]
    page_statuses = ["ok" if page.get("ok") and page.get("text") else "partial" for page in pages]
    status = "ok" if pages and all(item == "ok" for item in page_statuses) else "partial"
    backends = [str(item.get("backend") or "") for item in (existing, incoming) if item.get("backend")]
    backend = backends[0] if backends and all(item == backends[0] for item in backends) else "merged"
    reasons = [
        str(item.get("reason"))
        for item in (existing, incoming)
        if item.get("reason") and item.get("status") not in {"ok", "not_requested"}
    ]
    merged = {
        "attempted": bool(existing.get("attempted") or incoming.get("attempted")),
        "status": status,
        "backend": backend,
        "pages": pages,
        "sources": [
            {
                "backend": item.get("backend"),
                "status": item.get("status"),
                "purpose": item.get("purpose"),
                "source_path": item.get("source_path"),
                "api_url": item.get("api_url"),
            }
            for item in (existing, incoming)
            if item.get("attempted")
        ],
    }
    if reasons:
        merged["reason"] = "; ".join(reasons)
    return merged


def reader_proxy_analyze_url(api_url: str) -> str:
    normalized = api_url.strip()
    if not normalized:
        return ""
    if normalized.rstrip("/").endswith("/analyze"):
        return normalized
    return normalized.rstrip("/") + "/analyze"


def resolve_vision_auth_headers(args: argparse.Namespace) -> dict[str, str]:
    key_env_names = [
        str(getattr(args, "vision_api_key_env", "") or ""),
        "XIAOBA_VISION_API_KEY",
        "READER_PROXY_API_KEY",
        "CATSCOMPANY_API_KEY",
    ]
    for env_name in key_env_names:
        if not env_name:
            continue
        value = os.environ.get(env_name, "")
        if value:
            return {
                "Authorization": f"ApiKey {value}",
                "X-API-Key": value,
            }

    bearer_env_names = [
        str(getattr(args, "vision_bearer_env", "") or ""),
        "XIAOBA_VISION_BEARER_TOKEN",
        "READER_PROXY_BEARER_TOKEN",
        "CATSCOMPANY_BEARER_TOKEN",
    ]
    for env_name in bearer_env_names:
        if not env_name:
            continue
        value = os.environ.get(env_name, "")
        if value:
            return {"Authorization": f"Bearer {value}"}
    return {}


def post_reader_proxy_vision_api(
    api_url: str,
    auth_headers: dict[str, str],
    image_path: Path,
    page_number: int,
    prompt: str,
    timeout: int,
) -> dict[str, Any]:
    body, boundary = multipart_form_data(
        {"prompt": prompt, "page": str(page_number)},
        "file",
        image_path,
    )
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Accept": "application/json",
        **auth_headers,
    }
    request = urllib.request.Request(reader_proxy_analyze_url(api_url), data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            content_type = response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        return {
            "ok": False,
            "error": f"reader proxy HTTP {exc.code}: {detail[:500]}",
            "text": "",
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": f"reader proxy request failed: {exc}",
            "text": "",
        }

    if "application/json" not in content_type.lower():
        return {
            "ok": False,
            "error": f"reader proxy returned non-JSON content type: {content_type}",
            "text": "",
            "raw_preview": raw[:500].decode("utf-8", "replace"),
        }
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        return {
            "ok": False,
            "error": f"reader proxy JSON decode failed: {exc}",
            "text": "",
            "raw_preview": raw[:500].decode("utf-8", "replace"),
        }
    if not isinstance(payload, dict):
        return {
            "ok": False,
            "error": "reader proxy response must be a JSON object",
            "text": "",
        }

    text = ""
    for key in ("analysis", "text", "markdown", "description", "content"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            text = value.strip()
            break
    ok = bool(payload.get("ok", True)) and bool(text)
    return {
        "ok": ok,
        "text": text,
        "char_count": int(payload.get("char_count") or len(text)),
        "confidence": normalize_confidence(payload.get("confidence"), "high" if ok else "low"),
        "error": payload.get("error") or payload.get("reason"),
        "raw_response_keys": sorted(payload.keys()),
    }


def run_reader_proxy_on_rendered_pages(
    render_output: dict[str, Any],
    target_pages: list[int],
    api_url: str,
    auth_headers: dict[str, str],
    prompt: str,
    timeout: int,
) -> dict[str, Any]:
    if render_output.get("status") not in {"ok", "partial"}:
        return {
            "attempted": True,
            "status": "render_failed",
            "backend": "reader_proxy",
            "reason": render_output.get("reason") or "page rendering failed",
            "pages": [],
        }

    target_set = set(target_pages)
    pages: list[dict[str, Any]] = []
    for rendered_page in render_output.get("pages", []) or []:
        page_number = int(rendered_page.get("page", 0) or 0)
        if page_number not in target_set:
            continue
        if not rendered_page.get("ok"):
            pages.append(
                {
                    "page": page_number,
                    "ok": False,
                    "backend": "reader_proxy",
                    "error": rendered_page.get("error", "page render failed"),
                }
            )
            continue
        image_path = Path(str(rendered_page["path"]))
        vision_result = post_reader_proxy_vision_api(api_url, auth_headers, image_path, page_number, prompt, timeout)
        text = str(vision_result.get("text") or "")
        pages.append(
            {
                "page": page_number,
                "ok": bool(vision_result.get("ok")),
                "backend": "reader_proxy",
                "image_path": str(image_path),
                "text": text,
                "char_count": int(vision_result.get("char_count") or len(text)),
                "confidence": vision_result.get("confidence"),
                "error": vision_result.get("error"),
                "raw_response_keys": vision_result.get("raw_response_keys", []),
                "image_diagnostics": rendered_page.get("image_diagnostics"),
                "evidence": ["resolved from reader proxy vision backend"] if text else [],
            }
        )
    status = "ok" if pages and all(page.get("ok") and page.get("text") for page in pages) else "partial"
    return {
        "attempted": True,
        "status": status,
        "backend": "reader_proxy",
        "api_url": api_url,
        "pages": pages,
    }


def run_vision_pages(
    source: Path,
    pages: list[int],
    args: argparse.Namespace,
    render_output: dict[str, Any] | None = None,
) -> dict[str, Any]:
    target_pages = sorted(set(int(page) for page in pages))
    if not target_pages:
        return {
            "attempted": False,
            "status": "no_vision_pages",
            "backend": args.vision_backend,
            "pages": [],
        }
    if len(target_pages) > args.vision_max_pages:
        return {
            "attempted": False,
            "status": "skipped_too_many_pages",
            "backend": args.vision_backend,
            "reason": f"{len(target_pages)} vision page(s) selected; limit is {args.vision_max_pages}",
            "pages": target_pages,
        }

    api_url, api_source = resolve_vision_api_url(args)
    backend = args.vision_backend
    if backend == "auto":
        backend = "reader_proxy" if api_url else ""
    if backend != "reader_proxy":
        return {
            "attempted": True,
            "status": "unsupported_backend" if backend else "backend_unavailable",
            "backend": args.vision_backend,
            "available_backends": ["reader_proxy"] if api_url else [],
            "reason": "no supported vision backend is configured",
            "pages": target_pages,
        }
    if not api_url:
        return {
            "attempted": True,
            "status": "backend_unavailable",
            "backend": "reader_proxy",
            "reason": "vision reader proxy URL is not configured",
            "pages": target_pages,
        }

    rendered_page_numbers = {
        int(page.get("page", 0) or 0)
        for page in (render_output or {}).get("pages", []) or []
        if isinstance(page, dict) and page.get("page") is not None
    }
    render_has_targets = set(target_pages).issubset(rendered_page_numbers)
    if render_output is None or render_output.get("status") not in {"ok", "partial"} or not render_has_targets:
        render_dir = (
            Path(args.render_dir).expanduser().resolve()
            if args.render_dir
            else Path(tempfile.mkdtemp(prefix="read-pdf-vision-render-"))
        )
        rendered = render_selected_pages(
            source,
            target_pages,
            render_dir,
            args.render_dpi,
            args.render_max_pages,
            purpose="vision",
        )
        vision_payload = run_reader_proxy_on_rendered_pages(
            rendered,
            target_pages,
            api_url,
            resolve_vision_auth_headers(args),
            args.vision_prompt or DEFAULT_VISION_PROMPT,
            args.vision_api_timeout,
        )
        vision_payload["rendered_pages"] = rendered
    else:
        vision_payload = run_reader_proxy_on_rendered_pages(
            render_output,
            target_pages,
            api_url,
            resolve_vision_auth_headers(args),
            args.vision_prompt or DEFAULT_VISION_PROMPT,
            args.vision_api_timeout,
        )
    vision_payload["api_url_source"] = api_source
    return vision_payload


def rendered_image_diagnostics(image: Any) -> dict[str, Any]:
    try:
        gray = image.convert("L")
        histogram = gray.histogram()
        total = sum(histogram)
        if total <= 0:
            return {"available": False, "reason": "empty rendered image"}
        mean = sum(value * count for value, count in enumerate(histogram)) / total
        variance = sum(((value - mean) ** 2) * count for value, count in enumerate(histogram)) / total
        stddev = variance ** 0.5

        def below(threshold: int) -> float:
            return sum(histogram[:threshold]) / total

        dark_245 = below(245)
        dark_240 = below(240)
        near_blank = (
            mean >= NEAR_BLANK_MEAN_LUMA_THRESHOLD
            and stddev <= NEAR_BLANK_LUMA_STDDEV_THRESHOLD
            and dark_245 <= NEAR_BLANK_DARK_PIXEL_RATIO_245_THRESHOLD
            and dark_240 <= NEAR_BLANK_DARK_PIXEL_RATIO_240_THRESHOLD
        )
        return {
            "available": True,
            "mean_luma": round(mean, 4),
            "luma_stddev": round(stddev, 4),
            "dark_pixel_ratio_245": round(dark_245, 6),
            "dark_pixel_ratio_240": round(dark_240, 6),
            "near_blank": near_blank,
        }
    except Exception as exc:
        return {"available": False, "reason": f"image diagnostics failed: {exc}"}


def render_page_image_with_pdf2image(
    source: Path,
    page_number: int,
    output_path: Path,
    dpi: int,
    page_render: dict[str, Any],
) -> dict[str, Any]:
    try:
        from pdf2image import convert_from_path  # type: ignore
    except Exception as exc:
        return {
            "page": page_number,
            "ok": False,
            "error": f"pdf2image is unavailable: {exc}",
        }

    try:
        kwargs: dict[str, Any] = {}
        if page_render.get("poppler_path"):
            kwargs["poppler_path"] = str(page_render["poppler_path"])
        images = convert_from_path(
            str(source),
            dpi=dpi,
            first_page=page_number,
            last_page=page_number,
            fmt="png",
            single_file=True,
            **kwargs,
        )
        if not images:
            return {
                "page": page_number,
                "ok": False,
                "error": "pdf2image returned no image",
            }
        image = images[0]
        image.save(output_path, "PNG")
        return {
            "page": page_number,
            "ok": True,
            "path": str(output_path),
            "dpi": dpi,
            "width_px": image.width,
            "height_px": image.height,
            "backend": "pdf2image+poppler",
            "image_diagnostics": rendered_image_diagnostics(image),
        }
    except Exception as exc:
        return {
            "page": page_number,
            "ok": False,
            "path": str(output_path),
            "dpi": dpi,
            "backend": "pdf2image+poppler",
            "error": str(exc),
        }


def render_page_image_with_pymupdf(source: Path, page_number: int, output_path: Path, dpi: int) -> dict[str, Any]:
    try:
        import fitz  # type: ignore
        from PIL import Image  # type: ignore
    except Exception as exc:
        return {
            "page": page_number,
            "ok": False,
            "path": str(output_path),
            "dpi": dpi,
            "backend": "pymupdf",
            "error": f"PyMuPDF/Pillow is unavailable: {exc}",
        }

    doc: Any = None
    try:
        doc = fitz.open(str(source))
        page_count = int(getattr(doc, "page_count", 0) or 0)
        if page_number < 1 or page_number > page_count:
            return {
                "page": page_number,
                "ok": False,
                "path": str(output_path),
                "dpi": dpi,
                "backend": "pymupdf",
                "error": f"page {page_number} is outside PDF page range 1-{page_count}",
            }
        page = doc.load_page(page_number - 1)
        zoom = dpi / 72.0
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        pix.save(str(output_path))
        with Image.open(output_path) as image:
            diagnostics = rendered_image_diagnostics(image)
            width_px = image.width
            height_px = image.height
        return {
            "page": page_number,
            "ok": True,
            "path": str(output_path),
            "dpi": dpi,
            "width_px": width_px,
            "height_px": height_px,
            "backend": "pymupdf",
            "image_diagnostics": diagnostics,
        }
    except Exception as exc:
        return {
            "page": page_number,
            "ok": False,
            "path": str(output_path),
            "dpi": dpi,
            "backend": "pymupdf",
            "error": str(exc),
        }
    finally:
        if doc is not None:
            try:
                doc.close()
            except Exception:
                pass


def render_page_image(source: Path, page_number: int, output_dir: Path, dpi: int) -> dict[str, Any]:
    ensure_dir(output_dir)
    output_path = output_dir / f"page-{page_number:04d}.png"
    page_render = detect_page_render_availability()
    if not page_render.get("available"):
        return {
            "page": page_number,
            "ok": False,
            "path": str(output_path),
            "dpi": dpi,
            "backend": None,
            "error": page_render.get("reason") or "page rendering backend is unavailable",
            "backend_availability": page_render,
        }

    attempts: list[dict[str, Any]] = []
    if page_render.get("backend") == "pdf2image+poppler":
        result = render_page_image_with_pdf2image(source, page_number, output_path, dpi, page_render)
        if result.get("ok"):
            return result
        attempts.append(result)
        if page_render.get("pymupdf"):
            fallback = render_page_image_with_pymupdf(source, page_number, output_path, dpi)
            fallback["fallback_from"] = "pdf2image+poppler"
            fallback["previous_error"] = result.get("error")
            return fallback
        return result

    if page_render.get("backend") == "pymupdf":
        result = render_page_image_with_pymupdf(source, page_number, output_path, dpi)
        if result.get("ok"):
            return result
        attempts.append(result)
        if page_render.get("pdf2image") and page_render.get("pdftoppm"):
            fallback = render_page_image_with_pdf2image(source, page_number, output_path, dpi, page_render)
            fallback["fallback_from"] = "pymupdf"
            fallback["previous_error"] = result.get("error")
            return fallback
        return result

    return {
        "page": page_number,
        "ok": False,
        "path": str(output_path),
        "dpi": dpi,
        "backend": page_render.get("backend"),
        "error": "no supported page rendering backend was selected",
        "attempts": attempts,
        "backend_availability": page_render,
    }


def needs_windows_ascii_render_proxy(source: Path) -> bool:
    if os.name != "nt":
        return False
    try:
        str(source).encode("ascii")
        return False
    except UnicodeEncodeError:
        return True


def collect_paddleocr_lines(value: Any) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    if value is None:
        return lines

    if isinstance(value, dict):
        rec_texts = value.get("rec_texts")
        rec_scores = value.get("rec_scores") or value.get("scores")
        rec_boxes = value.get("rec_boxes") or value.get("dt_polys") or value.get("boxes")
        if isinstance(rec_texts, list):
            for index, text in enumerate(rec_texts):
                line: dict[str, Any] = {"text": str(text)}
                if isinstance(rec_scores, list) and index < len(rec_scores):
                    try:
                        line["confidence"] = float(rec_scores[index])
                    except Exception:
                        pass
                if isinstance(rec_boxes, list) and index < len(rec_boxes):
                    line["box"] = rec_boxes[index]
                lines.append(line)
        for nested in value.values():
            if nested is not rec_texts and nested is not rec_scores and nested is not rec_boxes:
                lines.extend(collect_paddleocr_lines(nested))
        return lines

    if isinstance(value, tuple) and len(value) >= 2 and isinstance(value[0], str):
        line = {"text": value[0]}
        try:
            line["confidence"] = float(value[1])
        except Exception:
            pass
        return [line]

    if isinstance(value, list):
        if len(value) >= 2 and isinstance(value[1], tuple) and value[1] and isinstance(value[1][0], str):
            line = {"text": value[1][0]}
            try:
                line["confidence"] = float(value[1][1])
            except Exception:
                pass
            if value:
                line["box"] = value[0]
            return [line]
        for item in value:
            lines.extend(collect_paddleocr_lines(item))
    return lines


def run_paddleocr_image(image_path: Path, lang: str) -> dict[str, Any]:
    try:
        from paddleocr import PaddleOCR  # type: ignore
    except Exception as exc:
        return {
            "ok": False,
            "error": f"paddleocr Python module is unavailable: {exc}",
            "lines": [],
            "text": "",
        }

    init_attempts = [
        {"use_angle_cls": True, "lang": lang, "show_log": False},
        {"use_angle_cls": True, "lang": lang},
        {"lang": lang},
        {},
    ]
    ocr = None
    last_init_error = None
    for kwargs in init_attempts:
        try:
            ocr = PaddleOCR(**kwargs)
            break
        except TypeError as exc:
            last_init_error = exc
            continue
        except Exception as exc:
            return {
                "ok": False,
                "error": f"could not initialize PaddleOCR: {exc}",
                "lines": [],
                "text": "",
            }
    if ocr is None:
        return {
            "ok": False,
            "error": f"could not initialize PaddleOCR: {last_init_error}",
            "lines": [],
            "text": "",
        }

    try:
        if hasattr(ocr, "ocr"):
            try:
                raw = ocr.ocr(str(image_path), cls=True)
            except TypeError:
                raw = ocr.ocr(str(image_path))
        elif hasattr(ocr, "predict"):
            raw = ocr.predict(str(image_path))
        else:
            return {
                "ok": False,
                "error": "PaddleOCR object exposes neither ocr() nor predict()",
                "lines": [],
                "text": "",
            }
    except Exception as exc:
        return {
            "ok": False,
            "error": f"PaddleOCR failed: {exc}",
            "lines": [],
            "text": "",
        }

    lines = collect_paddleocr_lines(raw)
    text = "\n".join(line["text"] for line in lines if line.get("text"))
    confidences = [float(line["confidence"]) for line in lines if isinstance(line.get("confidence"), (int, float))]
    return {
        "ok": True,
        "line_count": len(lines),
        "char_count": len(text),
        "avg_confidence": round(sum(confidences) / len(confidences), 4) if confidences else None,
        "text": text,
        "lines": lines,
    }


def ocr_target_pages(page_decisions: list[dict[str, Any]]) -> list[int]:
    return [
        int(page["page"])
        for page in page_decisions
        if page.get("recommended_backend") == "ocr"
    ]


def ocr_short_vision_retry_pages(ocr_results: dict[str, Any]) -> list[int]:
    pages: list[int] = []
    for page in ocr_results.get("pages", []) or []:
        if not isinstance(page, dict) or page.get("page") is None:
            continue
        image_diagnostics = page.get("image_diagnostics") if isinstance(page.get("image_diagnostics"), dict) else {}
        if image_diagnostics.get("near_blank") is True:
            continue
        text = str(page.get("text") or "")
        if len(text) < MIN_NONBLANK_OCR_RESOLVED_CHARS:
            pages.append(int(page["page"]))
    return sorted(set(pages))


def mark_vision_results_purpose(
    vision_results: dict[str, Any],
    purpose: str,
    ocr_results: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not vision_results or not isinstance(vision_results, dict):
        return vision_results
    marked = dict(vision_results)
    marked["purpose"] = purpose
    ocr_by_page = {
        int(page["page"]): page
        for page in (ocr_results or {}).get("pages", []) or []
        if isinstance(page, dict) and page.get("page") is not None
    }
    marked_pages: list[dict[str, Any]] = []
    for page in marked.get("pages", []) or []:
        if not isinstance(page, dict):
            continue
        item = dict(page)
        item["purpose"] = purpose
        ocr_page = ocr_by_page.get(int(item.get("page") or 0))
        if ocr_page:
            item["source_ocr_char_count"] = ocr_page.get("char_count")
            item["source_ocr_near_blank"] = (
                ocr_page.get("image_diagnostics", {}).get("near_blank")
                if isinstance(ocr_page.get("image_diagnostics"), dict)
                else None
            )
        evidence = list(item.get("evidence") or [])
        if purpose == "ocr_short_retry":
            evidence.append("vision retry after suspiciously short OCR output")
        item["evidence"] = evidence
        marked_pages.append(item)
    marked["pages"] = marked_pages
    return marked


def vision_target_pages(page_decisions: list[dict[str, Any]]) -> list[int]:
    return [
        int(page["page"])
        for page in page_decisions
        if page.get("recommended_backend") == "vision"
    ]


def render_handoff_target_pages(
    page_decisions: list[dict[str, Any]],
    include_ocr: bool,
    include_vision: bool = True,
) -> list[int]:
    backends: set[str] = set()
    if include_ocr:
        backends.add("ocr")
    if include_vision:
        backends.add("vision")
    return [
        int(page["page"])
        for page in page_decisions
        if page.get("recommended_backend") in backends
    ]


def mineru_target_pages(page_decisions: list[dict[str, Any]]) -> list[int]:
    return [
        int(page["page"])
        for page in page_decisions
        if page.get("recommended_backend") == "mineru"
    ]


def contiguous_page_scope(pages: list[int]) -> dict[str, Any]:
    unique_pages = sorted(set(pages))
    if not unique_pages:
        return {
            "target_pages": [],
            "start_page": None,
            "end_page": None,
            "expanded": False,
            "executed_pages": [],
        }
    start_page = unique_pages[0]
    end_page = unique_pages[-1]
    executed_pages = list(range(start_page, end_page + 1))
    return {
        "target_pages": unique_pages,
        "start_page": start_page,
        "end_page": end_page,
        "expanded": executed_pages != unique_pages,
        "executed_pages": executed_pages,
    }


def contiguous_page_groups(pages: list[int]) -> list[list[int]]:
    unique_pages = sorted(set(int(page) for page in pages))
    if not unique_pages:
        return []
    groups: list[list[int]] = [[unique_pages[0]]]
    for page in unique_pages[1:]:
        if page == groups[-1][-1] + 1:
            groups[-1].append(page)
        else:
            groups.append([page])
    return groups


def coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def tail_text(value: str, limit: int = 4000) -> str:
    if len(value) <= limit:
        return value
    return value[-limit:]


def redact_url(value: str) -> str:
    if not value:
        return value
    try:
        parsed = urllib.parse.urlsplit(value)
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        redacted_query = []
        changed = False
        for key, item in query:
            if key.lower() in {"key", "api_key", "token", "access_token", "password", "secret"}:
                redacted_query.append((key, "<redacted>"))
                changed = True
            else:
                redacted_query.append((key, item))
        if not changed:
            return value
        return urllib.parse.urlunsplit(
            (
                parsed.scheme,
                parsed.netloc,
                parsed.path,
                urllib.parse.urlencode(redacted_query),
                parsed.fragment,
            )
        )
    except Exception:
        lowered = value.lower()
        if any(marker in lowered for marker in ("key=", "token=", "password=", "secret=")):
            return "<redacted-url>"
        return value


def sanitize_command(command: list[str]) -> list[str]:
    sanitized: list[str] = []
    redact_next = False
    for token in command:
        if redact_next:
            sanitized.append(redact_url(token))
            redact_next = False
            continue
        sanitized.append(token)
        if token in {"--api-url", "--api", "--token", "--api-key"}:
            redact_next = True
    return sanitized


def list_mineru_output_files(output_dir: Path, limit: int = 80) -> list[dict[str, Any]]:
    if not output_dir.exists():
        return []
    files: list[dict[str, Any]] = []
    for path in sorted(output_dir.rglob("*")):
        if not path.is_file():
            continue
        files.append(
            {
                "path": str(path.relative_to(output_dir)).replace("\\", "/"),
                "size_bytes": path.stat().st_size,
            }
        )
        if len(files) >= limit:
            break
    return files


def mineru_item_page_number(item: Any) -> int | None:
    if not isinstance(item, dict):
        return None
    for key in ("page_idx", "page_index"):
        value = item.get(key)
        if isinstance(value, int):
            return value + 1
        if isinstance(value, str) and value.isdigit():
            return int(value) + 1
    for key in ("page", "page_no", "page_number"):
        value = item.get(key)
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return None


def mineru_item_page_candidates(item: Any, target_pages: list[int]) -> list[int]:
    page_number = mineru_item_page_number(item)
    candidates: list[int] = []
    if page_number is not None:
        candidates.append(page_number)

    if isinstance(item, dict) and target_pages:
        first_target = min(target_pages)
        for key in ("page_idx", "page_index"):
            value = item.get(key)
            page_index: int | None = None
            if isinstance(value, int):
                page_index = value
            elif isinstance(value, str) and value.isdigit():
                page_index = int(value)
            if page_index is not None:
                candidates.append(first_target + page_index)

    deduped: list[int] = []
    for candidate in candidates:
        if candidate not in deduped:
            deduped.append(candidate)
    return deduped


def mineru_item_text(item: Any) -> str:
    if not isinstance(item, dict):
        return ""
    chunks: list[str] = []
    for key in ("text", "content", "md", "markdown", "html"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            chunks.append(value.strip())
    table_body = item.get("table_body")
    if isinstance(table_body, str) and table_body.strip():
        chunks.append(table_body.strip())
    return "\n\n".join(chunks)


def collect_mineru_page_texts(output_dir: Path, target_pages: list[int]) -> list[dict[str, Any]]:
    target_set = set(target_pages)
    by_page: dict[int, list[dict[str, str]]] = {}
    if not output_dir.exists():
        return []

    json_files = sorted(output_dir.rglob("*content_list*.json"))
    for json_path in json_files:
        try:
            payload = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        items = payload if isinstance(payload, list) else payload.get("content", []) if isinstance(payload, dict) else []
        if not isinstance(items, list):
            continue
        for item in items:
            page_number = mineru_item_page_number(item)
            if page_number is None or page_number not in target_set:
                continue
            text = mineru_item_text(item)
            if not text:
                continue
            by_page.setdefault(page_number, []).append(
                {
                    "text": text,
                    "source_file": str(json_path.relative_to(output_dir)).replace("\\", "/"),
                }
            )

    if len(target_pages) == 1 and not by_page.get(target_pages[0]):
        markdown_files = sorted(output_dir.rglob("*.md"))
        for markdown_path in markdown_files:
            try:
                text = markdown_path.read_text(encoding="utf-8").strip()
            except Exception:
                continue
            if not text:
                continue
            by_page.setdefault(target_pages[0], []).append(
                {
                    "text": text,
                    "source_file": str(markdown_path.relative_to(output_dir)).replace("\\", "/"),
                }
            )
            break

    extracted_pages: list[dict[str, Any]] = []
    for page_number in sorted(by_page):
        parts = by_page[page_number]
        text = "\n\n".join(part["text"] for part in parts).strip()
        extracted_pages.append(
            {
                "page": page_number,
                "ok": bool(text),
                "char_count": len(text),
                "text": text,
                "source_files": sorted({part["source_file"] for part in parts}),
            }
        )
    return extracted_pages


def find_mineru_content_lists(value: Any) -> list[list[dict[str, Any]]]:
    found: list[list[dict[str, Any]]] = []
    if isinstance(value, list):
        if any(isinstance(item, dict) and ("text" in item or "table_body" in item or "page_idx" in item) for item in value):
            found.append([item for item in value if isinstance(item, dict)])
        for item in value:
            found.extend(find_mineru_content_lists(item))
        return found
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"content_list", "content_list_v2"} and isinstance(item, list):
                found.extend(find_mineru_content_lists(item))
            elif isinstance(item, (dict, list)):
                found.extend(find_mineru_content_lists(item))
    return found


def find_mineru_markdown_texts(value: Any) -> list[str]:
    texts: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"md_content", "markdown", "md"} and isinstance(item, str) and item.strip():
                texts.append(item.strip())
            elif isinstance(item, (dict, list)):
                texts.extend(find_mineru_markdown_texts(item))
    elif isinstance(value, list):
        for item in value:
            texts.extend(find_mineru_markdown_texts(item))
    return texts


def collect_mineru_response_pages(payload: Any, target_pages: list[int]) -> list[dict[str, Any]]:
    target_set = set(target_pages)
    by_page: dict[int, list[str]] = {}
    for content_list in find_mineru_content_lists(payload):
        for item in content_list:
            page_number = None
            for candidate in mineru_item_page_candidates(item, target_pages):
                if candidate in target_set:
                    page_number = candidate
                    break
            if page_number is None:
                if len(target_pages) == 1:
                    page_number = target_pages[0]
                else:
                    continue
            text = mineru_item_text(item)
            if text:
                by_page.setdefault(page_number, []).append(text)

    if not by_page and len(target_pages) == 1:
        markdown_texts = find_mineru_markdown_texts(payload)
        if markdown_texts:
            by_page[target_pages[0]] = ["\n\n".join(markdown_texts)]

    pages: list[dict[str, Any]] = []
    for page_number in sorted(by_page):
        text = "\n\n".join(part for part in by_page[page_number] if part).strip()
        pages.append(
            {
                "page": page_number,
                "ok": bool(text),
                "char_count": len(text),
                "text": text,
                "source_files": ["http_response"],
            }
        )
    return pages


def post_mineru_api(
    api_url: str,
    api_key: str,
    source: Path,
    scope: dict[str, Any],
    args: argparse.Namespace,
    method: str | None = None,
) -> dict[str, Any]:
    parse_method = method or args.mineru_method
    fields: list[tuple[str, str]] = [
        ("backend", args.mineru_engine),
        ("parse_method", parse_method),
        ("formula_enable", "true"),
        ("table_enable", "true"),
        ("image_analysis", "false"),
        ("return_md", "true"),
        ("return_content_list", "true"),
        ("return_middle_json", "false"),
        ("return_model_output", "false"),
        ("return_images", "false"),
        ("response_format_zip", "false"),
        ("start_page_id", str(int(scope["start_page"]) - 1)),
        ("end_page_id", str(int(scope["end_page"]) - 1)),
    ]
    if args.mineru_lang:
        fields.append(("lang_list", args.mineru_lang))
    body, boundary = multipart_form_data(fields, "files", source, "application/pdf")
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Accept": "application/json",
    }
    if api_key:
        headers["X-API-Key"] = api_key
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(api_url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=args.mineru_api_timeout) as response:
            raw = response.read()
            content_type = response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        return {
            "ok": False,
            "error": f"MinerU API HTTP {exc.code}: {detail[:1000]}",
            "payload": None,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": f"MinerU API request failed: {exc}",
            "payload": None,
        }

    if "application/json" not in content_type.lower():
        return {
            "ok": False,
            "error": f"MinerU API returned non-JSON content type: {content_type}",
            "payload": None,
            "raw_preview": raw[:500].decode("utf-8", "replace"),
        }
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        return {
            "ok": False,
            "error": f"MinerU API JSON decode failed: {exc}",
            "payload": None,
            "raw_preview": raw[:500].decode("utf-8", "replace"),
        }
    return {
        "ok": True,
        "error": None,
        "method": parse_method,
        "payload": payload,
    }


def mineru_api_attempt_summary(result: dict[str, Any], method: str) -> dict[str, Any]:
    payload = result.get("payload")
    return {
        "method": method,
        "ok": bool(result.get("ok")),
        "error": result.get("error"),
        "raw_response_keys": sorted(payload.keys()) if isinstance(payload, dict) else [],
    }


def mineru_batch_summary(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": result.get("status"),
        "backend": result.get("backend"),
        "pages": result.get("pages", []),
        "page_scope": result.get("page_scope"),
        "method": result.get("method"),
        "requested_method": result.get("requested_method"),
        "reason": result.get("reason"),
        "extracted_page_count": len(result.get("extracted_pages", []) or []),
    }


def merge_mineru_batch_results(
    pages: list[int],
    groups: list[list[int]],
    results: list[dict[str, Any]],
    args: argparse.Namespace,
) -> dict[str, Any]:
    statuses = [str(result.get("status") or "") for result in results]
    if results and all(status == "ok" for status in statuses):
        status = "ok"
    elif results and all(status == "skipped_too_many_pages" for status in statuses):
        status = "skipped_too_many_pages"
    else:
        status = "partial"

    backends = [str(result.get("backend") or "") for result in results if result.get("backend")]
    backend = backends[0] if backends and all(item == backends[0] for item in backends) else args.mineru_backend
    extracted_pages: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []
    output_files: list[dict[str, Any]] = []
    reasons: list[str] = []
    for result in results:
        extracted_pages.extend(result.get("extracted_pages", []) or [])
        output_files.extend(result.get("output_files", []) or [])
        for attempt in result.get("attempts", []) or []:
            attempt_with_scope = dict(attempt)
            attempt_with_scope["pages"] = result.get("pages", [])
            attempts.append(attempt_with_scope)
        if result.get("reason"):
            reasons.append(str(result["reason"]))

    extracted_pages.sort(key=lambda item: int(item.get("page", 0) or 0))
    methods = [str(result.get("method") or "") for result in results if result.get("method")]
    requested_methods = [str(result.get("requested_method") or "") for result in results if result.get("requested_method")]
    return {
        "attempted": any(bool(result.get("attempted")) for result in results),
        "status": status,
        "backend": backend,
        "api_configured": any(bool(result.get("api_configured")) for result in results),
        "method": methods[0] if methods and all(item == methods[0] for item in methods) else None,
        "requested_method": requested_methods[0] if requested_methods and all(item == requested_methods[0] for item in requested_methods) else args.mineru_method,
        "engine": args.mineru_engine,
        "lang": args.mineru_lang,
        "pages": sorted(set(pages)),
        "page_scope": {
            "target_pages": sorted(set(pages)),
            "start_page": min(pages) if pages else None,
            "end_page": max(pages) if pages else None,
            "expanded": False,
            "executed_pages": [page for group in groups for page in group],
            "groups": [contiguous_page_scope(group) for group in groups],
        },
        "extracted_pages": extracted_pages,
        "attempts": attempts,
        "output_files": output_files,
        "batches": [mineru_batch_summary(result) for result in results],
        "reason": "; ".join(reasons) if reasons else None,
    }


def run_mineru_pages(source: Path, pages: list[int], args: argparse.Namespace) -> dict[str, Any]:
    if not pages:
        return {
            "attempted": False,
            "status": "no_mineru_pages",
            "backend": args.mineru_backend,
            "pages": [],
        }
    target_pages = sorted(set(int(page) for page in pages))
    if len(target_pages) > args.mineru_max_pages:
        return {
            "attempted": False,
            "status": "skipped_too_many_pages",
            "backend": args.mineru_backend,
            "reason": f"{len(target_pages)} MinerU target page(s) selected; limit is {args.mineru_max_pages}",
            "pages": target_pages,
            "page_scope": {
                "target_pages": target_pages,
                "start_page": target_pages[0],
                "end_page": target_pages[-1],
                "expanded": False,
                "executed_pages": target_pages,
                "groups": [contiguous_page_scope(group) for group in contiguous_page_groups(target_pages)],
            },
        }
    groups = contiguous_page_groups(target_pages)
    if len(groups) > 1:
        batch_results = [run_mineru_pages(source, group, args) for group in groups]
        return merge_mineru_batch_results(target_pages, groups, batch_results, args)

    scope = contiguous_page_scope(target_pages)
    executed_pages = scope["executed_pages"]
    if len(executed_pages) > args.mineru_max_pages:
        return {
            "attempted": False,
            "status": "skipped_too_many_pages",
            "backend": args.mineru_backend,
            "reason": f"{len(executed_pages)} page(s) would be sent to MinerU; limit is {args.mineru_max_pages}",
            "pages": scope["target_pages"],
            "page_scope": scope,
        }

    api_url = args.mineru_api or os.environ.get("XIAOBA_MINERU_API_URL", "") or os.environ.get("MINERU_API_URL", "")
    api_key = os.environ.get(args.mineru_api_key_env, "") if args.mineru_api_key_env else ""
    backend = args.mineru_backend
    if backend == "auto":
        backend = "http_api" if api_url else "local_cli"

    if backend == "http_api":
        if not api_url:
            return {
                "attempted": True,
                "status": "backend_unavailable",
                "backend": "http_api",
                "reason": "MinerU API URL is not configured",
                "pages": scope["target_pages"],
                "page_scope": scope,
            }
        effective_method = args.mineru_method
        api_result = post_mineru_api(api_url, api_key, source, scope, args, effective_method)
        attempts = [mineru_api_attempt_summary(api_result, effective_method)]
        if not api_result.get("ok") and args.mineru_method == "auto":
            effective_method = "ocr"
            api_result = post_mineru_api(api_url, api_key, source, scope, args, effective_method)
            attempts.append(mineru_api_attempt_summary(api_result, effective_method))
        extracted_pages = collect_mineru_response_pages(api_result.get("payload"), scope["target_pages"]) if api_result.get("payload") is not None else []
        status = "ok" if api_result.get("ok") and extracted_pages else "partial"
        reason = None
        if not api_result.get("ok"):
            reason = api_result.get("error") or "MinerU API request failed"
        elif not extracted_pages:
            reason = "MinerU API returned no extracted page text"
        if (
            api_result.get("ok")
            and not extracted_pages
            and len(scope["target_pages"]) > 1
            and find_mineru_markdown_texts(api_result.get("payload"))
        ):
            split_groups = [[page] for page in scope["target_pages"]]
            split_results = [run_mineru_pages(source, group, args) for group in split_groups]
            merged = merge_mineru_batch_results(scope["target_pages"], split_groups, split_results, args)
            original_attempts = []
            for attempt in attempts:
                attempt_with_scope = dict(attempt)
                attempt_with_scope["pages"] = scope["target_pages"]
                attempt_with_scope["fallback"] = "split_unmapped_mineru_markdown"
                original_attempts.append(attempt_with_scope)
            merged["attempts"] = original_attempts + list(merged.get("attempts", []) or [])
            merged["fallback_reason"] = (
                "MinerU API returned markdown without page mapping for a multi-page request; "
                "retried requested pages individually."
            )
            return merged
        return {
            "attempted": True,
            "status": status,
            "backend": "http_api",
            "api_url": api_url,
            "api_configured": True,
            "method": effective_method,
            "requested_method": args.mineru_method,
            "engine": args.mineru_engine,
            "lang": args.mineru_lang,
            "pages": scope["target_pages"],
            "page_scope": scope,
            "extracted_pages": extracted_pages,
            "raw_response_keys": sorted(api_result.get("payload", {}).keys()) if isinstance(api_result.get("payload"), dict) else [],
            "attempts": attempts,
            "reason": reason,
            "error": api_result.get("error"),
        }

    command_info = resolve_mineru_command(args)
    command_prefix = list(command_info.get("command") or [])
    if backend != "local_cli":
        return {
            "attempted": True,
            "status": "unsupported_backend",
            "backend": args.mineru_backend,
            "reason": "v1 MinerU execution supports http_api and local_cli",
            "pages": scope["target_pages"],
            "page_scope": scope,
        }
    if not command_prefix or not command_info.get("exists"):
        return {
            "attempted": True,
            "status": "backend_unavailable",
            "backend": "local_cli",
            "reason": "MinerU CLI is not configured or not executable",
            "command_source": command_info.get("source"),
            "command_exists": command_info.get("exists"),
            "pages": scope["target_pages"],
            "page_scope": scope,
        }

    output_dir = (
        Path(args.mineru_output_dir).expanduser().resolve()
        if args.mineru_output_dir
        else Path(tempfile.mkdtemp(prefix="read-pdf-mineru-"))
    )
    ensure_dir(output_dir)

    command = [
        *command_prefix,
        "--path",
        str(source),
        "--output",
        str(output_dir),
        "--method",
        args.mineru_method,
        "--start",
        str(int(scope["start_page"]) - 1),
        "--end",
        str(int(scope["end_page"]) - 1),
    ]
    if args.mineru_engine:
        command.extend(["--backend", args.mineru_engine])
    if args.mineru_lang:
        command.extend(["--lang", args.mineru_lang])
    for extra_arg in args.mineru_extra_arg or []:
        command.append(extra_arg)

    try:
        proc = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=args.mineru_timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "attempted": True,
            "status": "timeout",
            "backend": "local_cli",
            "reason": f"MinerU timed out after {args.mineru_timeout} seconds",
            "command_source": command_info.get("source"),
            "command": sanitize_command(command),
            "output_dir": str(output_dir),
            "pages": scope["target_pages"],
            "page_scope": scope,
            "stdout_tail": tail_text(coerce_text(exc.stdout)),
            "stderr_tail": tail_text(coerce_text(exc.stderr)),
        }
    except Exception as exc:
        return {
            "attempted": True,
            "status": "execution_failed",
            "backend": "local_cli",
            "reason": str(exc),
            "command_source": command_info.get("source"),
            "command": sanitize_command(command),
            "output_dir": str(output_dir),
            "pages": scope["target_pages"],
            "page_scope": scope,
        }

    status = "ok" if proc.returncode == 0 else "partial"
    files = list_mineru_output_files(output_dir)
    extracted_pages = collect_mineru_page_texts(output_dir, scope["target_pages"])
    result = {
        "attempted": True,
        "status": status,
        "backend": "local_cli",
        "command_source": command_info.get("source"),
        "command": sanitize_command(command),
        "returncode": proc.returncode,
        "method": args.mineru_method,
        "engine": args.mineru_engine,
        "lang": args.mineru_lang,
        "api_configured": bool(api_url),
        "output_dir": str(output_dir),
        "output_files": files,
        "pages": scope["target_pages"],
        "extracted_pages": extracted_pages,
        "page_scope": scope,
        "stdout_tail": tail_text(coerce_text(proc.stdout)),
        "stderr_tail": tail_text(coerce_text(proc.stderr)),
    }
    manifest_path = output_dir / "read-pdf-mineru-run.json"
    try:
        write_text(manifest_path, json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        result["manifest_path"] = str(manifest_path)
    except Exception as exc:
        result["manifest_write_error"] = str(exc)
    return result


def render_selected_pages(
    source: Path,
    pages: list[int],
    output_dir: Path,
    dpi: int,
    max_pages: int,
    purpose: str = "selected_pages",
) -> dict[str, Any]:
    if len(pages) > max_pages:
        return {
            "attempted": False,
            "status": "skipped_too_many_pages",
            "purpose": purpose,
            "target_pages": pages,
            "reason": f"{len(pages)} page(s) selected for rendering; limit is {max_pages}",
            "pages": [],
        }
    page_render = detect_page_render_availability()
    if not page_render["available"]:
        return {
            "attempted": True,
            "status": "backend_unavailable",
            "purpose": purpose,
            "target_pages": pages,
            "reason": page_render.get("reason") or "page rendering backend is unavailable",
            "backend_availability": page_render,
            "pages": [],
        }
    render_source = source
    proxy_temp_dir: tempfile.TemporaryDirectory[str] | None = None
    source_proxy: dict[str, Any] = {"used": False}
    if needs_windows_ascii_render_proxy(source):
        try:
            proxy_temp_dir = tempfile.TemporaryDirectory(prefix="read-pdf-render-source-")
            render_source = Path(proxy_temp_dir.name) / "source.pdf"
            shutil.copyfile(source, render_source)
            source_proxy = {
                "used": True,
                "reason": "Windows PDF renderer path was proxied because the source path contains non-ASCII characters.",
            }
        except Exception as exc:
            return {
                "attempted": True,
                "status": "partial",
                "purpose": purpose,
                "target_pages": pages,
                "dpi": dpi,
                "output_dir": str(output_dir),
                "source_proxy": {
                    "used": False,
                    "error": f"could not create ASCII render proxy: {exc}",
                },
                "pages": [
                    {
                        "page": page_number,
                        "ok": False,
                        "dpi": dpi,
                        "backend": page_render.get("backend") or "page_render",
                        "error": f"could not create ASCII render proxy: {exc}",
                    }
                    for page_number in pages
                ],
            }
    try:
        rendered = [render_page_image(render_source, page_number, output_dir, dpi) for page_number in pages]
    finally:
        if proxy_temp_dir is not None:
            proxy_temp_dir.cleanup()
    status = "ok" if all(page.get("ok") for page in rendered) else "partial"
    return {
        "attempted": True,
        "status": status,
        "purpose": purpose,
        "target_pages": pages,
        "dpi": dpi,
        "output_dir": str(output_dir),
        "source_proxy": source_proxy,
        "pages": rendered,
    }


def merge_rendered_pages(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    if not incoming or incoming.get("status") == "not_requested":
        return existing
    if not existing or existing.get("status") == "not_requested":
        return incoming

    combined_pages: dict[int, dict[str, Any]] = {}
    unnumbered_pages: list[dict[str, Any]] = []
    for render_output in (existing, incoming):
        for page in render_output.get("pages", []) or []:
            if not isinstance(page, dict) or page.get("page") is None:
                if isinstance(page, dict):
                    unnumbered_pages.append(page)
                continue
            combined_pages[int(page["page"])] = page
    pages = [combined_pages[key] for key in sorted(combined_pages)] + unnumbered_pages

    statuses = [str(item.get("status")) for item in (existing, incoming) if item.get("status")]
    status = "ok" if statuses and all(item == "ok" for item in statuses) else "partial"
    reasons = [
        str(item.get("reason"))
        for item in (existing, incoming)
        if item.get("reason") and item.get("status") != "ok"
    ]
    purposes = sorted(
        {
            str(item.get("purpose"))
            for item in (existing, incoming)
            if item.get("purpose")
        }
    )
    output_dirs = sorted(
        {
            str(item.get("output_dir"))
            for item in (existing, incoming)
            if item.get("output_dir")
        }
    )
    source_proxy_parts = [
        item.get("source_proxy")
        for item in (existing, incoming)
        if isinstance(item.get("source_proxy"), dict)
    ]

    merged = {
        "attempted": bool(existing.get("attempted") or incoming.get("attempted")),
        "status": status,
        "purpose": "merged" if len(purposes) > 1 else (purposes[0] if purposes else None),
        "purposes": purposes,
        "target_pages": sorted(
            {
                int(page)
                for item in (existing, incoming)
                for page in (item.get("target_pages", []) or [])
                if isinstance(page, int) or str(page).isdigit()
            }
        ),
        "dpi": incoming.get("dpi") or existing.get("dpi"),
        "output_dir": output_dirs[0] if len(output_dirs) == 1 else None,
        "output_dirs": output_dirs,
        "source_proxy": {
            "used": any(bool(part.get("used")) for part in source_proxy_parts),
            "parts": source_proxy_parts,
        },
        "pages": pages,
    }
    if reasons:
        merged["reason"] = "; ".join(reasons)
    return merged


def run_ocr_pages(
    source: Path,
    pages: list[int],
    args: argparse.Namespace,
    render_output: dict[str, Any] | None = None,
) -> dict[str, Any]:
    backend = args.ocr_backend
    available_backends = detect_ocr_backends()
    api_url = args.ocr_api or os.environ.get("XIAOBA_OCR_API_URL", "")
    api_key = os.environ.get(args.ocr_api_key_env, "") if args.ocr_api_key_env else ""
    if api_url and "http_api" not in available_backends:
        available_backends = ["http_api", *available_backends]
    if backend == "auto":
        if api_url:
            backend = "http_api"
        else:
            backend = "paddleocr" if "paddleocr" in available_backends else ""
    if not backend:
        return {
            "attempted": True,
            "status": "backend_unavailable",
            "backend": args.ocr_backend,
            "available_backends": available_backends,
            "reason": "no supported OCR backend is available",
            "pages": [],
        }
    if backend == "http_api":
        if not api_url:
            return {
                "attempted": True,
                "status": "backend_unavailable",
                "backend": "http_api",
                "available_backends": available_backends,
                "reason": "OCR API URL is not configured",
                "pages": [],
            }
        if len(pages) > args.ocr_max_pages:
            return {
                "attempted": False,
                "status": "skipped_too_many_pages",
                "backend": "http_api",
                "reason": f"{len(pages)} OCR page(s) selected; limit is {args.ocr_max_pages}",
                "pages": [],
            }
        if render_output is None or render_output.get("status") not in {"ok", "partial"}:
            render_dir = (
                Path(args.render_dir).expanduser().resolve()
                if args.render_dir
                else Path(tempfile.mkdtemp(prefix="read-pdf-ocr-render-"))
            )
            rendered = render_selected_pages(
                source,
                pages,
                render_dir,
                args.render_dpi,
                args.render_max_pages,
                purpose="ocr",
            )
            ocr_payload = run_http_ocr_on_rendered_pages(
                rendered,
                api_url,
                api_key,
                args.ocr_lang,
                args.ocr_api_timeout,
            )
            ocr_payload["rendered_pages"] = rendered
            return ocr_payload
        ocr_payload = run_http_ocr_on_rendered_pages(
            render_output,
            api_url,
            api_key,
            args.ocr_lang,
            args.ocr_api_timeout,
        )
        ocr_payload["rendered_pages"] = render_output
        return ocr_payload

    if backend != "paddleocr":
        return {
            "attempted": True,
            "status": "unsupported_backend",
            "backend": backend,
            "available_backends": available_backends,
            "reason": "v1 OCR execution only supports PaddleOCR",
            "pages": [],
        }
    if "paddleocr" not in available_backends:
        return {
            "attempted": True,
            "status": "backend_unavailable",
            "backend": "paddleocr",
            "available_backends": available_backends,
            "reason": "PaddleOCR is not installed or not on PATH",
            "pages": [],
        }
    if len(pages) > args.ocr_max_pages:
        return {
            "attempted": False,
            "status": "skipped_too_many_pages",
            "backend": "paddleocr",
            "reason": f"{len(pages)} OCR page(s) selected; limit is {args.ocr_max_pages}",
            "pages": [],
        }

    if render_output is None or render_output.get("status") not in {"ok", "partial"}:
        render_dir = (
            Path(args.render_dir).expanduser().resolve()
            if args.render_dir
            else Path(tempfile.mkdtemp(prefix="read-pdf-ocr-render-"))
        )
        rendered = render_selected_pages(
            source,
            pages,
            render_dir,
            args.render_dpi,
            args.render_max_pages,
            purpose="ocr",
        )
        ocr_payload = run_ocr_on_rendered_pages(rendered, args.ocr_lang)
        ocr_payload["rendered_pages"] = rendered
        return ocr_payload
    ocr_payload = run_ocr_on_rendered_pages(render_output, args.ocr_lang)
    ocr_payload["rendered_pages"] = render_output
    return ocr_payload


def run_ocr_on_rendered_pages(render_output: dict[str, Any], lang: str) -> dict[str, Any]:
    if render_output.get("status") not in {"ok", "partial"}:
        return {
            "attempted": True,
            "status": "render_failed",
            "backend": "paddleocr",
            "reason": render_output.get("reason") or "page rendering failed",
            "pages": [],
        }

    pages: list[dict[str, Any]] = []
    for rendered_page in render_output.get("pages", []):
        if not rendered_page.get("ok"):
            pages.append(
                {
                    "page": rendered_page.get("page"),
                    "ok": False,
                    "error": rendered_page.get("error", "page render failed"),
                }
            )
            continue
        image_path = Path(str(rendered_page["path"]))
        ocr_result = run_paddleocr_image(image_path, lang)
        pages.append(
            {
                "page": rendered_page.get("page"),
                "ok": ocr_result.get("ok"),
                "image_path": str(image_path),
                "line_count": ocr_result.get("line_count", 0),
                "char_count": ocr_result.get("char_count", 0),
                "avg_confidence": ocr_result.get("avg_confidence"),
                "text": ocr_result.get("text", ""),
                "lines": ocr_result.get("lines", []),
                "error": ocr_result.get("error"),
                "image_diagnostics": rendered_page.get("image_diagnostics"),
            }
        )
    status = "ok" if pages and all(page.get("ok") for page in pages) else "partial"
    return {
        "attempted": True,
        "status": status,
        "backend": "paddleocr",
        "pages": pages,
    }


def multipart_form_data(
    fields: dict[str, str] | list[tuple[str, str]],
    file_field: str,
    file_path: Path,
    content_type: str = "image/png",
) -> tuple[bytes, str]:
    boundary = "----xiaoba-read-pdf-" + os.urandom(8).hex()
    chunks: list[bytes] = []
    field_items = fields.items() if isinstance(fields, dict) else fields
    for name, value in field_items:
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}\r\n".encode("utf-8"))
    chunks.append(
        (
            f'Content-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("utf-8")
    )
    chunks.append(file_path.read_bytes())
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), boundary


def post_ocr_api(
    api_url: str,
    api_key: str,
    image_path: Path,
    page_number: int,
    lang: str,
    timeout: int,
) -> dict[str, Any]:
    body, boundary = multipart_form_data(
        {"page": str(page_number), "lang": lang},
        "file",
        image_path,
    )
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Accept": "application/json",
    }
    if api_key:
        headers["X-API-Key"] = api_key
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(api_url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        return {
            "ok": False,
            "error": f"OCR API HTTP {exc.code}: {detail[:500]}",
            "text": "",
            "lines": [],
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": f"OCR API request failed: {exc}",
            "text": "",
            "lines": [],
        }

    lines = payload.get("lines", [])
    text = str(payload.get("text", ""))
    return {
        "ok": bool(payload.get("ok")),
        "line_count": int(payload.get("line_count", len(lines) if isinstance(lines, list) else 0) or 0),
        "char_count": int(payload.get("char_count", len(text)) or 0),
        "avg_confidence": payload.get("avg_confidence"),
        "text": text,
        "lines": lines if isinstance(lines, list) else [],
        "error": payload.get("error") or "; ".join(str(item) for item in payload.get("warnings", []) or []),
        "raw_backend": payload.get("backend"),
    }


def run_http_ocr_on_rendered_pages(
    render_output: dict[str, Any],
    api_url: str,
    api_key: str,
    lang: str,
    timeout: int,
) -> dict[str, Any]:
    if render_output.get("status") not in {"ok", "partial"}:
        return {
            "attempted": True,
            "status": "render_failed",
            "backend": "http_api",
            "reason": render_output.get("reason") or "page rendering failed",
            "pages": [],
        }

    pages: list[dict[str, Any]] = []
    for rendered_page in render_output.get("pages", []):
        page_number = int(rendered_page.get("page", 0) or 0)
        if not rendered_page.get("ok"):
            pages.append(
                {
                    "page": page_number,
                    "ok": False,
                    "error": rendered_page.get("error", "page render failed"),
                }
            )
            continue
        image_path = Path(str(rendered_page["path"]))
        ocr_result = post_ocr_api(api_url, api_key, image_path, page_number, lang, timeout)
        pages.append(
            {
                "page": page_number,
                "ok": ocr_result.get("ok"),
                "image_path": str(image_path),
                "line_count": ocr_result.get("line_count", 0),
                "char_count": ocr_result.get("char_count", 0),
                "avg_confidence": ocr_result.get("avg_confidence"),
                "text": ocr_result.get("text", ""),
                "lines": ocr_result.get("lines", []),
                "error": ocr_result.get("error"),
                "image_diagnostics": rendered_page.get("image_diagnostics"),
            }
        )
    status = "ok" if pages and all(page.get("ok") for page in pages) else "partial"
    return {
        "attempted": True,
        "status": status,
        "backend": "http_api",
        "api_url": api_url,
        "pages": pages,
    }


def page_text_confidence_from_decision(page_decision: dict[str, Any]) -> str:
    quality = str(page_decision.get("text_layer_quality") or "low")
    route_confidence = str(page_decision.get("route_confidence") or "low")
    if quality == "high" and route_confidence == "high":
        return "high"
    if quality in {"high", "medium"} and route_confidence in {"high", "medium"}:
        return "medium"
    return "low"


def ocr_confidence(page: dict[str, Any]) -> str:
    char_count = int(page.get("char_count") or 0)
    avg_confidence = page.get("avg_confidence")
    try:
        score = float(avg_confidence)
    except Exception:
        score = None
    if char_count <= 0:
        return "low"
    if score is not None and score >= 0.9:
        return "high"
    if score is None or score >= 0.75:
        return "medium"
    return "low"


def int_or_zero(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def mineru_output_much_shorter_than_text_layer(
    page_decision: dict[str, Any],
    content_item: dict[str, Any],
    mineru_page: dict[str, Any] | None,
) -> bool:
    if not mineru_page:
        return False
    text_layer_chars = max(
        int_or_zero(content_item.get("char_count")),
        int_or_zero((page_decision.get("signals") or {}).get("char_count")),
    )
    if text_layer_chars < MINERU_TEXT_LAYER_FALLBACK_MIN_CHARS:
        return False
    mineru_chars = max(
        int_or_zero(mineru_page.get("char_count")),
        len(str(mineru_page.get("text") or "")),
    )
    if mineru_chars <= 0:
        return False
    return mineru_chars < max(
        MINERU_TEXT_LAYER_FALLBACK_MIN_OUTPUT_CHARS,
        int(text_layer_chars * MINERU_TEXT_LAYER_FALLBACK_RATIO),
    )


def clip_resolved_text(value: str, remaining: int) -> tuple[str, int, bool]:
    if remaining <= 0:
        return "", 0, bool(value)
    if len(value) <= remaining:
        return value, len(value), False
    return value[:remaining], remaining, True


def build_resolved_pages(
    content: list[dict[str, Any]],
    page_decisions: list[dict[str, Any]],
    vision_results: dict[str, Any],
    ocr_results: dict[str, Any],
    mineru_results: dict[str, Any],
    max_chars: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    content_by_page = {int(item["page"]): item for item in content if item.get("page") is not None}
    vision_by_page = {
        int(item["page"]): item
        for item in vision_results.get("pages", []) or []
        if isinstance(item, dict) and item.get("page") is not None
    }
    ocr_by_page = {
        int(item["page"]): item
        for item in ocr_results.get("pages", []) or []
        if isinstance(item, dict) and item.get("page") is not None
    }
    mineru_by_page = {
        int(item["page"]): item
        for item in mineru_results.get("extracted_pages", []) or []
        if isinstance(item, dict) and item.get("page") is not None
    }

    resolved_pages: list[dict[str, Any]] = []
    remaining_chars = max_chars
    truncated = False
    for page_decision in page_decisions:
        page_number = int(page_decision["page"])
        content_item = content_by_page.get(page_number, {})
        recommended = str(page_decision.get("recommended_backend") or "partial")
        evidence = list(page_decision.get("evidence") or [])

        source = "unavailable"
        status = "unavailable"
        confidence = "low"
        raw_text = ""
        details: dict[str, Any] = {}

        mineru_page = mineru_by_page.get(page_number)
        vision_page = vision_by_page.get(page_number)
        vision_purpose = str(vision_page.get("purpose") or "") if vision_page else ""
        vision_text = str(vision_page.get("text") or "") if vision_page else ""
        vision_allowed = bool(
            vision_page
            and (
                recommended == "vision"
                or (recommended == "ocr" and vision_purpose == "ocr_short_retry" and vision_text)
            )
        )
        if vision_allowed and vision_page:
            source = "vision"
            raw_text = str(vision_page.get("text") or "")
            confidence = normalize_confidence(vision_page.get("confidence"), "high" if raw_text else "low")
            status = "ok" if vision_page.get("ok") and raw_text else "partial"
            details = {
                "backend": vision_page.get("backend"),
                "purpose": vision_purpose or None,
                "image_path": vision_page.get("image_path"),
                "char_count": vision_page.get("char_count", len(raw_text)),
                "error": vision_page.get("error"),
            }
            if vision_page.get("source_ocr_char_count") is not None:
                details["source_ocr_char_count"] = vision_page.get("source_ocr_char_count")
            if vision_page.get("source_ocr_near_blank") is not None:
                details["source_ocr_near_blank"] = vision_page.get("source_ocr_near_blank")
            evidence.extend(str(item) for item in vision_page.get("evidence", []) or [])
            if raw_text:
                if vision_purpose == "ocr_short_retry":
                    evidence.append("resolved from vision retry after suspiciously short OCR output")
                else:
                    evidence.append("resolved from vision result")
            else:
                evidence.append("vision result provided but returned no usable text")
        elif (
            recommended == "mineru"
            and mineru_page
            and mineru_page.get("text")
            and not mineru_output_much_shorter_than_text_layer(page_decision, content_item, mineru_page)
        ):
            source = "mineru"
            status = "ok"
            confidence = "medium"
            raw_text = str(mineru_page.get("text") or "")
            details = {
                "source_files": mineru_page.get("source_files", []),
                "char_count": mineru_page.get("char_count", len(raw_text)),
            }
            evidence.append("resolved from MinerU extracted output")
        else:
            if (
                recommended == "mineru"
                and mineru_page
                and mineru_page.get("text")
                and mineru_output_much_shorter_than_text_layer(page_decision, content_item, mineru_page)
            ):
                text_layer_chars = max(
                    int_or_zero(content_item.get("char_count")),
                    int_or_zero((page_decision.get("signals") or {}).get("char_count")),
                )
                mineru_text = str(mineru_page.get("text") or "")
                details = {
                    "mineru_output_rejected": True,
                    "mineru_char_count": max(int_or_zero(mineru_page.get("char_count")), len(mineru_text)),
                    "text_layer_char_count": text_layer_chars,
                    "source_files": mineru_page.get("source_files", []),
                    "quality_warning": "mineru_output_much_shorter_than_available_text_layer",
                }
                evidence.append(
                    "MinerU output was much shorter than the available text layer; using text extraction as partial evidence"
                )
            ocr_page = ocr_by_page.get(page_number)
            if recommended == "ocr" and ocr_page:
                source = "ocr"
                raw_text = str(ocr_page.get("text") or "")
                confidence = ocr_confidence(ocr_page)
                status = "ok" if ocr_page.get("ok") and raw_text else "partial"
                image_diagnostics = (
                    ocr_page.get("image_diagnostics")
                    if isinstance(ocr_page.get("image_diagnostics"), dict)
                    else {}
                )
                details = {
                    "line_count": ocr_page.get("line_count", 0),
                    "char_count": ocr_page.get("char_count", len(raw_text)),
                    "avg_confidence": ocr_page.get("avg_confidence"),
                    "image_path": ocr_page.get("image_path"),
                    "image_diagnostics": image_diagnostics,
                    "error": ocr_page.get("error"),
                }
                if raw_text:
                    evidence.append("resolved from OCR result")
                    if (
                        not image_diagnostics.get("near_blank")
                        and len(raw_text) < MIN_NONBLANK_OCR_RESOLVED_CHARS
                    ):
                        status = "partial"
                        confidence = "low"
                        details["quality_warning"] = "ocr_output_suspiciously_short_on_nonblank_page"
                        evidence.append(
                            "OCR output is suspiciously short on a non-blank rendered page; verify with orientation-aware OCR or vision"
                        )
                elif image_diagnostics.get("near_blank"):
                    evidence.append("OCR ran on near-blank rendered page and returned no usable text")
                else:
                    evidence.append("OCR ran but returned no usable text")
            else:
                content_text = str(content_item.get("text") or "")
                if content_text:
                    source = "text_extract"
                    raw_text = content_text
                    confidence = page_text_confidence_from_decision(page_decision)
                    status = "ok" if recommended == "text_extract" else "partial"
                    details = {
                        **details,
                        "char_count": content_item.get("char_count", len(content_text)),
                        "included_char_count": content_item.get("included_char_count", len(content_text)),
                    }
                    if recommended == "vision":
                        evidence.append(
                            "vision backend not completed; text extraction is partial because visual semantics may be missing"
                        )
                    elif recommended != "text_extract":
                        evidence.append(f"fallback backend {recommended} not completed; using text extraction as partial evidence")
                    else:
                        evidence.append("resolved from text extraction")
                elif content_item.get("text_omitted"):
                    source = "text_extract"
                    status = "omitted"
                    confidence = "low"
                    details = {
                        **details,
                        "char_count": content_item.get("char_count", 0),
                        "included_char_count": 0,
                    }
                    if recommended == "vision":
                        evidence.append(
                            "text exists but was omitted by --no-content; visual semantics remain unresolved"
                        )
                    evidence.append("text exists but was omitted by --no-content")
                else:
                    evidence.append(f"no resolved text available; recommended backend is {recommended}")

        text, included_count, page_truncated = clip_resolved_text(raw_text, remaining_chars)
        remaining_chars -= included_count
        if page_truncated:
            truncated = True
            status = "partial" if status == "ok" else status
            evidence.append("resolved text truncated by --resolved-max-chars")

        resolved_pages.append(
            {
                "page": page_number,
                "source": source,
                "status": status,
                "confidence": confidence,
                "recommended_backend": recommended,
                "text": text,
                "char_count": len(raw_text),
                "included_char_count": included_count,
                "text_truncated": page_truncated,
                "details": details,
                "evidence": evidence,
            }
        )

    source_counts = Counter(str(page["source"]) for page in resolved_pages)
    status_counts = Counter(str(page["status"]) for page in resolved_pages)
    summary = {
        "pages_total": len(resolved_pages),
        "pages_with_text": sum(1 for page in resolved_pages if page.get("text")),
        "pages_unavailable": status_counts.get("unavailable", 0),
        "pages_omitted": status_counts.get("omitted", 0),
        "chars_included": sum(int(page.get("included_char_count") or 0) for page in resolved_pages),
        "truncated": truncated,
        "source_counts": dict(source_counts),
        "status_counts": dict(status_counts),
    }
    return resolved_pages, summary


def build_vision_handoff(
    page_decisions: list[dict[str, Any]],
    rendered_pages: dict[str, Any],
    resolved_pages: list[dict[str, Any]],
) -> dict[str, Any]:
    vision_decisions = [
        page
        for page in page_decisions
        if page.get("recommended_backend") == "vision" and page.get("page") is not None
    ]
    if not vision_decisions:
        return default_vision_handoff()

    rendered_by_page = {
        int(page["page"]): page
        for page in rendered_pages.get("pages", []) or []
        if isinstance(page, dict) and page.get("page") is not None
    }
    resolved_by_page = {
        int(page["page"]): page
        for page in resolved_pages
        if isinstance(page, dict) and page.get("page") is not None
    }

    attempted = bool(rendered_pages.get("attempted"))
    pages: list[dict[str, Any]] = []
    ready_count = 0
    completed_count = 0
    for decision in vision_decisions:
        page_number = int(decision["page"])
        rendered_page = rendered_by_page.get(page_number, {})
        resolved_page = resolved_by_page.get(page_number, {})
        rendered_ok = bool(rendered_page.get("ok") and rendered_page.get("path"))
        vision_completed = resolved_page.get("source") == "vision" and resolved_page.get("status") == "ok"
        if vision_completed:
            page_status = "completed"
            completed_count += 1
        elif rendered_ok:
            page_status = "ready"
            ready_count += 1
        elif attempted and rendered_page:
            page_status = "render_failed"
        elif attempted:
            page_status = "render_missing"
        else:
            page_status = "render_required"
        pages.append(
            {
                "page": page_number,
                "status": page_status,
                "image_path": rendered_page.get("path"),
                "render_backend": rendered_page.get("backend"),
                "dpi": rendered_page.get("dpi"),
                "resolved_source": resolved_page.get("source"),
                "resolved_status": resolved_page.get("status"),
                "resolved_confidence": resolved_page.get("confidence"),
                "evidence": list(decision.get("evidence") or []),
            }
        )

    if completed_count == len(vision_decisions):
        status = "completed"
    elif ready_count + completed_count == len(vision_decisions):
        status = "ok"
    elif not attempted:
        status = "render_required"
    elif str(rendered_pages.get("status")) in {"backend_unavailable", "skipped_too_many_pages"}:
        status = str(rendered_pages.get("status"))
    else:
        status = "partial"

    return {
        "attempted": attempted,
        "status": status,
        "handoff_type": "vision",
        "consumer": "read_file_or_vision_backend",
        "pages_total": len(vision_decisions),
        "pages_ready": ready_count,
        "pages_completed": completed_count,
        "pages": pages,
    }


def clip_text(value: str, remaining: int) -> tuple[str, int, bool]:
    if remaining <= 0:
        return "", 0, bool(value)
    if len(value) <= remaining:
        return value, len(value), False
    return value[:remaining], remaining, True


def ratio(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator, 4)


def risk_max(values: list[str]) -> str:
    order = {"unknown": 0, "low": 1, "medium": 2, "high": 3}
    return max(values or ["unknown"], key=lambda value: order.get(value, 0))


def quality_min(values: list[str]) -> str:
    order = {"low": 0, "medium": 1, "high": 2}
    return min(values or ["low"], key=lambda value: order.get(value, 0))


def normalize_cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    return text[:500]


def normalize_table(table: Any, max_rows: int) -> dict[str, Any]:
    rows = table or []
    sampled = rows[:max_rows]
    width = 0
    for row in rows:
        if isinstance(row, list):
            width = max(width, len(row))
    return {
        "row_count": len(rows),
        "column_count": width,
        "sampled_rows": [[normalize_cell(cell) for cell in (row or [])] for row in sampled],
        "sampled": len(rows) > len(sampled),
    }


def text_lines(text: str) -> tuple[list[str], list[str]]:
    raw_lines = text.splitlines() if text else []
    nonempty = [line.strip() for line in raw_lines if line.strip()]
    return raw_lines, nonempty


def abnormal_symbol_ratio(text: str) -> float:
    chars = [char for char in text if not char.isspace()]
    if not chars:
        return 0.0
    abnormal = 0
    for char in chars:
        if char.isalnum() or char in ALLOWED_SYMBOLS:
            continue
        if "\u4e00" <= char <= "\u9fff":
            continue
        abnormal += 1
    return ratio(abnormal, len(chars))


def formula_symbol_ratio(text: str) -> float:
    text = NON_FORMULA_SPAN_RE.sub(" ", text)
    for marker in CHECKBOX_MARKERS:
        text = text.replace(marker, " ")
    chars = [char for char in text if not char.isspace()]
    if not chars:
        return 0.0
    return ratio(sum(1 for char in chars if char in FORMULA_SYMBOLS), len(chars))


def compute_text_health(text: str) -> dict[str, Any]:
    raw_lines, nonempty = text_lines(text)
    stripped = text.strip()
    char_count = len(stripped)
    line_count = len(nonempty)
    empty_line_ratio = ratio(len(raw_lines) - line_count, len(raw_lines)) if raw_lines else 0.0
    avg_line_length = round(sum(len(line) for line in nonempty) / line_count, 2) if line_count else 0.0
    single_char_line_ratio = ratio(sum(1 for line in nonempty if len(line) <= 2), line_count)
    short_line_density = ratio(sum(1 for line in nonempty if len(line) <= 8), line_count)
    repeated_line_ratio = 0.0
    if line_count:
        counts = Counter(nonempty)
        repeated = sum(count - 1 for count in counts.values() if count > 1)
        repeated_line_ratio = ratio(repeated, line_count)

    replacement_char_count = stripped.count("\ufffd")
    abnormal_ratio = abnormal_symbol_ratio(stripped)
    formula_ratio = formula_symbol_ratio(stripped)

    quality = "high"
    evidence: list[str] = []
    if char_count == 0:
        quality = "low"
        evidence.append("no extractable text")
    elif char_count < MIN_USEFUL_TEXT_CHARS:
        quality = "medium"
        evidence.append(f"low text volume: {char_count} chars")

    if replacement_char_count:
        quality = "low"
        evidence.append(f"replacement characters: {replacement_char_count}")
    if abnormal_ratio >= HIGH_ABNORMAL_SYMBOL_RATIO:
        quality = "low"
        evidence.append(f"high abnormal symbol ratio: {abnormal_ratio}")
    elif abnormal_ratio >= MEDIUM_ABNORMAL_SYMBOL_RATIO and quality == "high":
        quality = "medium"
        evidence.append(f"medium abnormal symbol ratio: {abnormal_ratio}")

    if single_char_line_ratio >= HIGH_SINGLE_CHAR_LINE_RATIO and line_count >= 8:
        quality = "low"
        evidence.append(f"high single-character line ratio: {single_char_line_ratio}")
    elif short_line_density >= MEDIUM_SHORT_LINE_DENSITY and line_count >= 10 and quality == "high":
        quality = "medium"
        evidence.append(f"high short-line density: {short_line_density}")

    if repeated_line_ratio >= HIGH_REPEATED_LINE_RATIO and line_count >= 8:
        quality = "medium" if quality == "high" else quality
        evidence.append(f"high repeated-line ratio: {repeated_line_ratio}")

    if avg_line_length and avg_line_length < 4 and line_count >= 8:
        quality = "low"
        evidence.append(f"very short average line length: {avg_line_length}")

    return {
        "char_count": char_count,
        "line_count": line_count,
        "avg_line_length": avg_line_length,
        "empty_line_ratio": empty_line_ratio,
        "single_char_line_ratio": single_char_line_ratio,
        "short_line_density": short_line_density,
        "replacement_char_count": replacement_char_count,
        "abnormal_symbol_ratio": abnormal_ratio,
        "repeated_line_ratio": repeated_line_ratio,
        "formula_symbol_ratio": formula_ratio,
        "quality": quality,
        "evidence": evidence,
    }


def compute_text_layer_trust_risk(text_health: dict[str, Any]) -> dict[str, Any]:
    char_count = int(text_health.get("char_count", 0) or 0)
    line_count = int(text_health.get("line_count", 0) or 0)
    avg_line_length = float(text_health.get("avg_line_length", 0.0) or 0.0)
    risk = "low"
    evidence: list[str] = []

    sparse_extreme_lines = (
        char_count >= TEXT_LAYER_TRUST_MIN_CHARS
        and 0 < line_count <= TEXT_LAYER_TRUST_SPARSE_LINE_MAX_COUNT
        and avg_line_length >= TEXT_LAYER_TRUST_MEDIUM_AVG_LINE_LENGTH
    )
    if sparse_extreme_lines:
        risk = "medium"
        evidence.append(
            "large text layer packed into very few extracted lines: "
            f"{char_count} chars across {line_count} lines, avg line {avg_line_length}"
        )

    if (
        sparse_extreme_lines
        and char_count >= TEXT_LAYER_TRUST_HIGH_MIN_CHARS
        and avg_line_length >= TEXT_LAYER_TRUST_HIGH_AVG_LINE_LENGTH
    ):
        risk = "high"

    return {
        "risk": risk,
        "evidence": evidence,
    }


def image_bbox_area(image: dict[str, Any], page_width: float, page_height: float) -> float:
    try:
        x0 = max(0.0, float(image.get("x0", 0.0)))
        x1 = min(page_width, float(image.get("x1", x0)))
        top = max(0.0, float(image.get("top", image.get("y0", 0.0))))
        bottom = min(page_height, float(image.get("bottom", image.get("y1", top))))
        return max(0.0, x1 - x0) * max(0.0, bottom - top)
    except Exception:
        return 0.0


def safe_box_value(value: Any) -> float:
    try:
        result = float(value)
        if result != result:
            return 0.0
        return result
    except Exception:
        return 0.0


def object_bbox(obj: dict[str, Any]) -> tuple[float, float, float, float]:
    return (
        safe_box_value(obj.get("x0")),
        safe_box_value(obj.get("top", obj.get("y0"))),
        safe_box_value(obj.get("x1")),
        safe_box_value(obj.get("bottom", obj.get("y1"))),
    )


def bbox_area(box: tuple[float, float, float, float]) -> float:
    x0, top, x1, bottom = box
    return max(0.0, x1 - x0) * max(0.0, bottom - top)


def bbox_overlap_area(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax0, atop, ax1, abottom = a
    bx0, btop, bx1, bbottom = b
    width = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    height = max(0.0, min(abottom, bbottom) - max(atop, btop))
    return width * height


def bbox_center_inside(inner: tuple[float, float, float, float], outer: tuple[float, float, float, float]) -> bool:
    x0, top, x1, bottom = inner
    ox0, otop, ox1, obottom = outer
    cx = (x0 + x1) / 2.0
    cy = (top + bottom) / 2.0
    return ox0 <= cx <= ox1 and otop <= cy <= obottom


def bbox_bin_range(
    box: tuple[float, float, float, float],
    bin_height: float = REDACTION_OVERLAY_SPATIAL_BIN_HEIGHT,
) -> range:
    top = max(0.0, box[1])
    bottom = max(top, box[3])
    start = int(top // bin_height)
    end = int(bottom // bin_height)
    return range(start, end + 1)


def build_bbox_vertical_index(
    boxes: list[tuple[int, Any, tuple[float, float, float, float], float]],
) -> dict[int, list[tuple[int, Any, tuple[float, float, float, float], float]]]:
    index: dict[int, list[tuple[int, Any, tuple[float, float, float, float], float]]] = {}
    for item in boxes:
        for bin_id in bbox_bin_range(item[2]):
            index.setdefault(bin_id, []).append(item)
    return index


def indexed_bbox_candidates(
    index: dict[int, list[tuple[int, Any, tuple[float, float, float, float], float]]],
    box: tuple[float, float, float, float],
) -> list[tuple[int, Any, tuple[float, float, float, float], float]]:
    seen: set[int] = set()
    candidates: list[tuple[int, Any, tuple[float, float, float, float], float]] = []
    for bin_id in bbox_bin_range(box):
        for item in index.get(bin_id, []):
            item_id = item[0]
            if item_id in seen:
                continue
            seen.add(item_id)
            candidates.append(item)
    return candidates


def normalize_pdf_color(color: Any) -> tuple[float, ...] | None:
    if color is None:
        return None
    if isinstance(color, (int, float)):
        value = max(0.0, min(1.0, safe_box_value(color)))
        return (value,)
    if isinstance(color, (list, tuple)):
        values = [max(0.0, min(1.0, safe_box_value(item))) for item in color[:4]]
        return tuple(values) if values else None
    return None


def pdf_color_luminance(color: Any) -> float | None:
    normalized = normalize_pdf_color(color)
    if not normalized:
        return None
    if len(normalized) == 1:
        return normalized[0]
    r, g, b = (list(normalized) + [0.0, 0.0, 0.0])[:3]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def is_dark_fill_rect(rect: dict[str, Any]) -> bool:
    if rect.get("fill") is False:
        return False
    luminance = pdf_color_luminance(rect.get("non_stroking_color"))
    return luminance is not None and luminance <= REDACTION_OVERLAY_DARK_LUMINANCE_THRESHOLD


def is_light_text_char(char: dict[str, Any]) -> bool:
    luminance = pdf_color_luminance(char.get("non_stroking_color"))
    return luminance is not None and luminance >= 0.72


def is_dark_text_char(char: dict[str, Any]) -> bool:
    luminance = pdf_color_luminance(char.get("non_stroking_color"))
    return luminance is not None and luminance <= 0.45


def compute_redaction_overlay_signals(page: Any, page_width: float, page_height: float) -> dict[str, Any]:
    page_area = max(1.0, page_width * page_height)
    rects = list(getattr(page, "rects", []) or [])

    dark_rects: list[tuple[dict[str, Any], tuple[float, float, float, float], float, float]] = []
    for rect in rects:
        box = object_bbox(rect)
        width = max(0.0, box[2] - box[0])
        height = max(0.0, box[3] - box[1])
        area_ratio = bbox_area(box) / page_area
        if width < REDACTION_OVERLAY_MIN_RECT_WIDTH or height < REDACTION_OVERLAY_MIN_RECT_HEIGHT:
            continue
        if area_ratio < REDACTION_OVERLAY_MIN_RECT_AREA_RATIO or area_ratio > REDACTION_OVERLAY_MAX_RECT_AREA_RATIO:
            continue
        if not is_dark_fill_rect(rect):
            continue
        aspect = width / max(1.0, height)
        if aspect < REDACTION_OVERLAY_MIN_RECT_ASPECT and height < REDACTION_OVERLAY_TALL_RECT_MIN_HEIGHT:
            continue
        dark_rects.append((rect, box, area_ratio, aspect))

    if not dark_rects:
        return {
            "risk": "low",
            "dark_rect_count": 0,
            "overlap_rect_count": 0,
            "covered_dark_char_count": 0,
            "covered_unknown_char_count": 0,
            "covered_light_char_count": 0,
            "covered_word_count": 0,
            "max_rect_area_ratio": 0.0,
            "rects_sample": [],
            "evidence": [],
        }

    chars = list(getattr(page, "chars", []) or [])
    try:
        words = page.extract_words() or []
    except Exception:
        words = []

    char_boxes = []
    for index, char in enumerate(chars):
        box = object_bbox(char)
        char_boxes.append((index, char, box, bbox_area(box)))
    word_boxes = []
    for index, word in enumerate(words):
        box = object_bbox(word)
        word_boxes.append((index, word, box, bbox_area(box)))
    char_index = build_bbox_vertical_index(char_boxes)
    word_index = build_bbox_vertical_index(word_boxes)
    overlap_rects: list[dict[str, Any]] = []
    covered_dark_chars = 0
    covered_unknown_chars = 0
    covered_light_chars = 0
    covered_words: set[int] = set()
    max_rect_area_ratio = 0.0

    for rect, rect_box, area_ratio, aspect in dark_rects:
        rect_dark_chars = 0
        rect_unknown_chars = 0
        rect_light_chars = 0
        rect_words: set[int] = set()

        for _, char, char_box, char_area in indexed_bbox_candidates(char_index, rect_box):
            if char_area <= 0:
                continue
            overlap = bbox_overlap_area(rect_box, char_box)
            if overlap <= 0 and not bbox_center_inside(char_box, rect_box):
                continue
            if overlap > 0 and overlap / char_area < REDACTION_OVERLAY_MIN_CHAR_OVERLAP_RATIO:
                continue
            if is_light_text_char(char):
                rect_light_chars += 1
            elif is_dark_text_char(char):
                rect_dark_chars += 1
            else:
                rect_unknown_chars += 1

        for word_index_value, _, word_box, word_area in indexed_bbox_candidates(word_index, rect_box):
            if word_area <= 0:
                continue
            overlap = bbox_overlap_area(rect_box, word_box)
            if overlap <= 0 and not bbox_center_inside(word_box, rect_box):
                continue
            if overlap > 0 and overlap / word_area < REDACTION_OVERLAY_MIN_WORD_OVERLAP_RATIO:
                continue
            rect_words.add(word_index_value)

        non_light_chars = rect_dark_chars + rect_unknown_chars
        if non_light_chars < REDACTION_OVERLAY_MIN_COVERED_NON_LIGHT_CHARS:
            continue
        total_covered_chars = rect_light_chars + non_light_chars
        if total_covered_chars and ratio(non_light_chars, total_covered_chars) < REDACTION_OVERLAY_MIN_NON_LIGHT_SHARE:
            continue

        overlap_rects.append(
            {
                "x0": round(rect_box[0], 3),
                "top": round(rect_box[1], 3),
                "x1": round(rect_box[2], 3),
                "bottom": round(rect_box[3], 3),
                "area_ratio": round(area_ratio, 5),
                "aspect": round(aspect, 3),
                "covered_dark_chars": rect_dark_chars,
                "covered_unknown_chars": rect_unknown_chars,
                "covered_light_chars": rect_light_chars,
                "covered_word_count": len(rect_words),
                "fill_luminance": round(pdf_color_luminance(rect.get("non_stroking_color")) or 0.0, 4),
            }
        )
        covered_dark_chars += rect_dark_chars
        covered_unknown_chars += rect_unknown_chars
        covered_light_chars += rect_light_chars
        covered_words.update(rect_words)
        max_rect_area_ratio = max(max_rect_area_ratio, area_ratio)

    covered_non_light_chars = covered_dark_chars + covered_unknown_chars
    overlap_rect_count = len(overlap_rects)
    if overlap_rect_count >= 3 or covered_non_light_chars >= 30:
        risk = "high"
    elif overlap_rect_count >= 2 or covered_non_light_chars >= 12:
        risk = "medium"
    elif overlap_rect_count:
        risk = "low"
    else:
        risk = "low"

    evidence: list[str] = []
    if overlap_rect_count:
        evidence = [
            f"{overlap_rect_count} dark filled rect(s) overlap extractable non-light text",
            f"covered_dark_chars={covered_dark_chars}",
            f"covered_unknown_chars={covered_unknown_chars}",
            f"covered_words={len(covered_words)}",
        ]

    return {
        "risk": risk,
        "dark_rect_count": len(dark_rects),
        "overlap_rect_count": overlap_rect_count,
        "covered_dark_char_count": covered_dark_chars,
        "covered_unknown_char_count": covered_unknown_chars,
        "covered_light_char_count": covered_light_chars,
        "covered_word_count": len(covered_words),
        "max_rect_area_ratio": round(max_rect_area_ratio, 5),
        "rects_sample": overlap_rects[:5],
        "evidence": evidence,
    }


def compute_visual_signals(page: Any) -> dict[str, Any]:
    page_width = float(page.width) if page.width is not None else 0.0
    page_height = float(page.height) if page.height is not None else 0.0
    page_area = page_width * page_height
    page_images = list(getattr(page, "images", []) or [])
    image_areas = [image_bbox_area(image, page_width, page_height) for image in page_images]
    total_image_area = min(sum(image_areas), page_area) if page_area else 0.0
    largest_image_area = max(image_areas) if image_areas else 0.0
    image_area_ratio = ratio(total_image_area, page_area)
    largest_image_area_ratio = ratio(largest_image_area, page_area)
    scan_risk = "high" if largest_image_area_ratio >= SCAN_IMAGE_AREA_THRESHOLD else "low"
    if scan_risk == "low" and image_area_ratio >= LARGE_IMAGE_AREA_THRESHOLD:
        scan_risk = "medium"

    objects = getattr(page, "objects", {}) or {}
    object_counts: dict[str, int] = {}
    if isinstance(objects, dict):
        for key, value in objects.items():
            try:
                object_counts[str(key)] = len(value or [])
            except Exception:
                object_counts[str(key)] = 0

    rect_count = object_counts.get("rect", len(getattr(page, "rects", []) or []))
    curve_count = object_counts.get("curve", len(getattr(page, "curves", []) or []))
    pdf_line_count = object_counts.get("line", len(getattr(page, "lines", []) or []))
    char_object_count = object_counts.get("char", len(getattr(page, "chars", []) or []))
    non_text_object_count = sum(
        count for key, count in object_counts.items() if key not in {"char", "image"}
    )
    vector_object_count = rect_count + curve_count + pdf_line_count
    redaction_overlay = compute_redaction_overlay_signals(page, page_width, page_height)

    return {
        "image_count": len(page_images),
        "image_area_ratio": image_area_ratio,
        "largest_image_area_ratio": largest_image_area_ratio,
        "rect_count": rect_count,
        "curve_count": curve_count,
        "pdf_line_count": pdf_line_count,
        "char_object_count": char_object_count,
        "vector_object_count": vector_object_count,
        "non_text_object_count": non_text_object_count,
        "page_width": page_width,
        "page_height": page_height,
        "scan_risk": scan_risk,
        "redaction_overlay": redaction_overlay,
    }


def multi_column_suspect(page: Any) -> bool:
    try:
        words = page.extract_words() or []
    except Exception:
        return False
    if len(words) < 80 or not page.width:
        return False
    page_width = float(page.width)
    line_groups: dict[int, list[dict[str, Any]]] = {}
    for word in words:
        try:
            top = float(word.get("top", word.get("doctop", 0.0)))
        except Exception:
            continue
        line_key = round(top / 3.0)
        line_groups.setdefault(line_key, []).append(word)

    candidate_lines = 0
    column_gap_lines = 0
    for line_words in line_groups.values():
        if len(line_words) < 5:
            continue
        boxes: list[tuple[float, float]] = []
        for word in line_words:
            try:
                x0 = max(0.0, float(word.get("x0", 0.0)))
                x1 = min(page_width, float(word.get("x1", x0)))
            except Exception:
                continue
            if x1 > x0:
                boxes.append((x0, x1))
        if len(boxes) < 5:
            continue
        boxes.sort(key=lambda box: box[0])
        candidate_lines += 1
        for (_, prev_x1), (next_x0, _) in zip(boxes, boxes[1:]):
            gap = next_x0 - prev_x1
            if gap < page_width * 0.08:
                continue
            gap_left = prev_x1 / page_width
            gap_right = next_x0 / page_width
            if gap_left <= 0.48 and gap_right >= 0.52:
                column_gap_lines += 1
                break

    if candidate_lines >= 8 and ratio(column_gap_lines, candidate_lines) >= 0.45:
        return True

    left = 0
    center = 0
    right = 0
    for word in words:
        try:
            x0 = float(word.get("x0", 0.0))
            x1 = float(word.get("x1", x0))
        except Exception:
            continue
        x_center = ((x0 + x1) / 2.0) / page_width
        if x_center < 0.42:
            left += 1
        elif x_center > 0.58:
            right += 1
        else:
            center += 1
    total = left + center + right
    if total == 0:
        return False
    return (
        candidate_lines >= 8
        and ratio(left, total) >= 0.25
        and ratio(right, total) >= 0.25
        and ratio(center, total) <= 0.18
        and ratio(column_gap_lines, candidate_lines) >= 0.25
    )


def compute_layout_risk(page: Any, text: str, tables: list[Any]) -> dict[str, Any]:
    health = compute_text_health(text)
    table_count = len(tables)
    formula_ratio = health["formula_symbol_ratio"]
    short_line_density = health["short_line_density"]
    multi_column = multi_column_suspect(page)
    risk = "low"
    evidence: list[str] = []

    if table_count >= 2:
        risk = "high"
        evidence.append(f"multiple table hints: {table_count}")
    elif table_count == 1:
        risk = "medium"
        evidence.append("table hint present")

    if formula_ratio >= HIGH_FORMULA_SYMBOL_RATIO:
        risk = "high"
        evidence.append(f"high formula-symbol ratio: {formula_ratio}")
    elif formula_ratio >= MEDIUM_FORMULA_SYMBOL_RATIO and risk == "low":
        risk = "medium"
        evidence.append(f"medium formula-symbol ratio: {formula_ratio}")

    if multi_column:
        risk = "high" if len(text) >= 500 else "medium"
        evidence.append("multi-column layout suspected")
    elif short_line_density >= MEDIUM_SHORT_LINE_DENSITY and health["line_count"] >= 10 and risk == "low":
        risk = "medium"
        evidence.append(f"high short-line density: {short_line_density}")

    return {
        "table_count": table_count,
        "short_line_density": short_line_density,
        "formula_symbol_ratio": formula_ratio,
        "multi_column_suspect": multi_column,
        "risk": risk,
        "evidence": evidence,
    }


def classify_pdf(pages_processed: int, pages_with_text: int, pages_with_images: int) -> str:
    if pages_processed == 0:
        return "unknown"
    pages_without_text = pages_processed - pages_with_text
    if pages_with_text == pages_processed:
        return "text"
    if pages_with_text == 0 and pages_with_images > 0:
        return "scanned_or_image_only"
    if pages_with_text == 0:
        return "no_extractable_text"
    if pages_without_text > 0:
        return "mixed"
    return "unknown"


def decide_page_route(signals: dict[str, Any]) -> dict[str, Any]:
    text = signals["text_health"]
    visual = signals["visual"]
    layout = signals["layout"]
    char_count = int(text["char_count"])
    text_quality = str(text["quality"])
    scan_risk = str(visual["scan_risk"])
    layout_risk = str(layout["risk"])
    image_area_ratio = float(visual["image_area_ratio"])
    largest_image_area_ratio = float(visual["largest_image_area_ratio"])
    vector_object_count = int(visual.get("vector_object_count", 0))
    non_text_object_count = int(visual.get("non_text_object_count", 0))
    table_count = int(layout.get("table_count", 0))
    multi_column_suspect = bool(layout.get("multi_column_suspect", False))
    evidence: list[str] = []

    if char_count == 0 and (image_area_ratio >= LARGE_IMAGE_AREA_THRESHOLD or largest_image_area_ratio >= LARGE_IMAGE_AREA_THRESHOLD):
        evidence.append("no text layer and dominant page image")
        return {
            "recommended_backend": "ocr",
            "confidence": "high",
            "evidence": evidence,
        }

    if char_count < MIN_USEFUL_TEXT_CHARS and scan_risk in {"medium", "high"}:
        evidence.append(f"low text volume with {scan_risk} scan risk")
        return {
            "recommended_backend": "ocr",
            "confidence": "medium",
            "evidence": evidence,
        }

    if char_count == 0 and (
        vector_object_count >= VECTOR_OBJECT_OCR_THRESHOLD
        or non_text_object_count >= VECTOR_OBJECT_OCR_THRESHOLD
        or table_count > 0
        or layout_risk in {"medium", "high"}
    ):
        evidence.append("no text layer but vector or layout objects detected")
        return {
            "recommended_backend": "ocr",
            "confidence": "medium",
            "evidence": evidence,
        }

    if char_count == 0:
        evidence.append("no text layer and no dominant image detected")
        return {
            "recommended_backend": "partial",
            "confidence": "low",
            "evidence": evidence,
        }

    if (
        char_count < MIN_USEFUL_TEXT_CHARS
        and text_quality in {"low", "medium"}
        and scan_risk == "low"
        and layout_risk == "low"
        and table_count == 0
        and (
            vector_object_count >= VECTOR_OBJECT_OCR_THRESHOLD
            or non_text_object_count >= VECTOR_OBJECT_OCR_THRESHOLD
        )
    ):
        evidence.extend(text["evidence"])
        evidence.append("very sparse text layer with vector or non-text page objects")
        return {
            "recommended_backend": "ocr",
            "confidence": "medium",
            "evidence": evidence,
        }

    if layout_risk == "high":
        evidence.extend(layout["evidence"])
        return {
            "recommended_backend": "mineru",
            "confidence": "medium",
            "evidence": evidence,
        }

    if text_quality == "low":
        evidence.extend(text["evidence"])
        backend = "ocr" if scan_risk in {"medium", "high"} else "mineru"
        return {
            "recommended_backend": backend,
            "confidence": "medium",
            "evidence": evidence or ["low text-layer quality"],
        }

    if text_quality == "medium" and layout_risk == "medium":
        evidence.extend(text["evidence"])
        evidence.extend(layout["evidence"])
        return {
            "recommended_backend": "mineru",
            "confidence": "low",
            "evidence": evidence or ["medium text and layout quality"],
        }

    if (
        text_quality == "high"
        and layout_risk in {"low", "medium"}
        and image_area_ratio >= 0.35
        and table_count == 0
        and not multi_column_suspect
    ):
        if layout_risk == "medium":
            evidence.extend(layout["evidence"])
        evidence.append("large visual region may contain non-text semantics")
        return {
            "recommended_backend": "vision",
            "confidence": "low",
            "evidence": evidence,
        }

    if layout_risk == "medium":
        evidence.extend(layout["evidence"])
    evidence.append("text layer appears usable")
    return {
        "recommended_backend": "text_extract",
        "confidence": "high" if text_quality == "high" and layout_risk == "low" else "medium",
        "evidence": evidence,
    }


def route_name_for_backend(backend: str) -> str:
    return {
        "text_extract": "text_extract",
        "ocr": "ocr_required",
        "vision": "vision_required",
        "mineru": "mineru_required",
        "partial": "partial",
    }.get(backend, "partial")


def decide_document_route(page_decisions: list[dict[str, Any]], backend_availability: dict[str, Any]) -> dict[str, Any]:
    if not page_decisions:
        return {
            "selected": "partial",
            "confidence": "low",
            "reason": ["no pages processed"],
            "required_backends": [],
            "blocked_backends": [],
        }

    backends = [str(page["recommended_backend"]) for page in page_decisions]
    unique_backends = set(backends)
    required = sorted(backend for backend in unique_backends if backend not in {"text_extract", "partial"})
    blocked: list[str] = []
    for backend in required:
        availability_key = "mineru" if backend == "mineru" else backend
        available = backend_availability.get(availability_key)
        if available is False:
            blocked.append(backend)

    reasons: list[str] = []
    if blocked:
        reasons.append(f"required backend unavailable: {', '.join(blocked)}")
    counts = Counter(backends)
    reasons.append(
        "page backend mix: "
        + ", ".join(f"{backend}={count}" for backend, count in sorted(counts.items()))
    )

    if blocked and any(backend in {"ocr", "mineru"} for backend in blocked):
        selected = "partial"
        confidence = "low"
    elif len(unique_backends) == 1:
        selected = route_name_for_backend(backends[0])
        confidence = page_decisions[0]["route_confidence"]
    else:
        selected = "hybrid"
        confidence = "medium"

    if any(str(page["route_confidence"]) == "low" for page in page_decisions):
        confidence = "low" if confidence != "high" else "medium"

    return {
        "selected": selected,
        "confidence": confidence,
        "reason": reasons,
        "required_backends": required,
        "blocked_backends": blocked,
    }


def rendering_risk(
    classification: str,
    tables: list[dict[str, Any]],
    images: list[dict[str, Any]],
    route_decision: dict[str, Any],
) -> dict[str, Any]:
    selected = route_decision.get("selected")
    needs_image = selected in {"ocr_required", "vision_required", "hybrid", "partial"} or classification in {
        "scanned_or_image_only",
        "mixed",
        "no_extractable_text",
    }
    if classification == "scanned_or_image_only":
        risk = "high"
        reason = "PDF pages have no extractable text and appear image-based; OCR or vision may lose small text if rendered too low-resolution."
    elif selected == "mineru_required":
        risk = "medium"
        reason = "Document structure risk is high; lightweight text extraction may lose reading order, tables, or formulas."
    elif classification == "mixed":
        risk = "medium"
        reason = "Some processed pages lack extractable text; image conversion may be needed for those pages."
    elif tables:
        risk = "medium"
        reason = "PDF table structure can be lossy; use table extraction results as hints unless verified."
    elif images:
        risk = "low"
        reason = "Images are present, but text extraction covered processed pages."
    else:
        risk = "low"
        reason = ""
    return {
        "image_conversion_needed": needs_image,
        "compression_risk": risk,
        "reason": reason,
    }


def metadata_to_json(metadata: Any) -> dict[str, str]:
    if not metadata:
        return {}
    result: dict[str, str] = {}
    for key, value in dict(metadata).items():
        if value is None:
            continue
        result[str(key)] = str(value)
    return result


def summarize_quality(page_decisions: list[dict[str, Any]]) -> dict[str, str]:
    return {
        "text_layer_quality": quality_min([str(page["text_layer_quality"]) for page in page_decisions]),
        "structure_risk": risk_max([str(page["layout_risk"]) for page in page_decisions]),
        "scan_risk": risk_max([str(page["scan_risk"]) for page in page_decisions]),
        "redaction_overlay_risk": risk_max([str(page.get("redaction_overlay_risk", "low")) for page in page_decisions]),
        "text_layer_trust_risk": risk_max([str(page.get("text_layer_trust_risk", "low")) for page in page_decisions]),
    }


def build_page_advisories(page_decision: dict[str, Any]) -> list[dict[str, Any]]:
    advisories: list[dict[str, Any]] = []
    overlay_risk = str(page_decision.get("redaction_overlay_risk", "low"))
    trust_risk = str(page_decision.get("text_layer_trust_risk", "low"))
    backend = str(page_decision.get("recommended_backend", "partial"))
    page_number = int(page_decision.get("page", 0) or 0)

    if overlay_risk == "high" and backend == "text_extract":
        advisories.append(
            {
                "code": "redaction_overlay_visual_verification",
                "severity": "medium",
                "page": page_number,
                "recommended_action": "vision_or_visible_content_check",
                "does_not_change_backend": True,
                "reason": (
                    "High redaction-overlay risk on a page otherwise routed to text_extract; "
                    "text extraction may include text that is visually covered."
                ),
            }
        )
    elif overlay_risk == "medium" and backend == "text_extract":
        advisories.append(
            {
                "code": "redaction_overlay_text_extract_warning",
                "severity": "low",
                "page": page_number,
                "recommended_action": "warn_before_treating_hidden_text_as_visible",
                "does_not_change_backend": True,
                "reason": (
                    "Medium redaction-overlay risk on a text_extract page; keep text extraction "
                    "but avoid assuming all extracted text is visible."
                ),
            }
        )
    elif overlay_risk == "high" and backend in {"mineru", "ocr", "vision"}:
        advisories.append(
            {
                "code": "redaction_overlay_preserve_visible_content_caution",
                "severity": "low",
                "page": page_number,
                "recommended_action": "preserve_visible_vs_hidden_text_caution",
                "does_not_change_backend": True,
                "reason": (
                    "High redaction-overlay risk is present, but the page already routes to a "
                    f"non-text_extract backend ({backend})."
                ),
            }
        )

    if trust_risk == "high" and backend == "text_extract":
        advisories.append(
            {
                "code": "text_layer_trust_visual_verification",
                "severity": "medium",
                "page": page_number,
                "recommended_action": "visible_content_check",
                "does_not_change_backend": True,
                "reason": (
                    "The text layer is unusually large and packed into very few extracted lines; "
                    "extracted text may include invisible, clipped, or adversarially interleaved content."
                ),
            }
        )
    elif trust_risk == "medium" and backend == "text_extract":
        advisories.append(
            {
                "code": "text_layer_trust_warning",
                "severity": "low",
                "page": page_number,
                "recommended_action": "warn_before_treating_extracted_text_as_visible",
                "does_not_change_backend": True,
                "reason": (
                    "The text layer has unusual long-line density; keep text extraction but avoid "
                    "assuming all extracted text is visible without a render check."
                ),
            }
        )

    return advisories


def summarize_route_advisories(page_decisions: list[dict[str, Any]]) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    pages: list[dict[str, Any]] = []
    visual_pages: set[int] = set()
    warning_pages: set[int] = set()

    for page_decision in page_decisions:
        page_number = int(page_decision.get("page", 0) or 0)
        for advisory in page_decision.get("advisories") or []:
            code = str(advisory.get("code", "unknown"))
            counts[code] += 1
            if code in {"redaction_overlay_visual_verification", "text_layer_trust_visual_verification"}:
                visual_pages.add(page_number)
            elif code in {"redaction_overlay_text_extract_warning", "text_layer_trust_warning"}:
                warning_pages.add(page_number)
            pages.append(
                {
                    "page": page_number,
                    "code": code,
                    "severity": advisory.get("severity"),
                    "recommended_action": advisory.get("recommended_action"),
                    "current_backend": page_decision.get("recommended_backend"),
                    "does_not_change_backend": advisory.get("does_not_change_backend", True),
                    "reason": advisory.get("reason"),
                }
            )

    if not pages:
        return empty_route_advisories()

    return {
        "advisory_count": len(pages),
        "visual_verification_page_count": len(visual_pages),
        "warning_page_count": len(warning_pages),
        "counts_by_code": dict(sorted(counts.items())),
        "pages": pages,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    backend_availability = detect_backend_availability(args)
    configured_ocr_api = args.ocr_api or os.environ.get("XIAOBA_OCR_API_URL", "")
    if configured_ocr_api:
        backend_availability["ocr"] = True
        backends = list(backend_availability.get("ocr_backends", []))
        if "http_api" not in backends:
            backends.insert(0, "http_api")
        backend_availability["ocr_backends"] = backends
        backend_availability["ocr_api_configured"] = True
    try:
        import pdfplumber  # type: ignore
    except Exception as exc:  # pragma: no cover - environment dependent
        return error_packet(
            args.pdf,
            "missing_dependency",
            f"pdfplumber is required for read-pdf intake: {exc}",
        )

    source, source_resolution = resolve_input_pdf_path(args.pdf)
    if not source.exists():
        packet = error_packet(str(source), "file_not_found", f"PDF not found: {source}")
        if source_resolution:
            packet["source_reference"] = args.pdf
            packet["source_resolution"] = source_resolution
        return packet
    if not source.is_file():
        packet = error_packet(str(source), "not_a_file", f"PDF path is not a file: {source}")
        if source_resolution:
            packet["source_reference"] = args.pdf
            packet["source_resolution"] = source_resolution
        return packet
    if source.suffix.lower() != ".pdf":
        packet = error_packet(str(source), "not_pdf", f"Expected a .pdf file: {source}")
        if source_resolution:
            packet["source_reference"] = args.pdf
            packet["source_resolution"] = source_resolution
        return packet

    source = source.resolve()
    size_bytes = source.stat().st_size
    content: list[dict[str, Any]] = []
    tables: list[dict[str, Any]] = []
    images: list[dict[str, Any]] = []
    page_decisions: list[dict[str, Any]] = []
    uncertainties: list[str] = []

    chars_extracted = 0
    chars_included = 0
    pages_with_text = 0
    pages_without_text = 0
    pages_with_images = 0
    remaining_chars = args.max_chars
    truncated = False

    try:
        with pdfplumber.open(str(source)) as pdf:
            pages_total = len(pdf.pages)
            try:
                selection_mode, selected_pages = select_pages(args, pages_total)
            except ValueError as exc:
                return error_packet(str(source), "bad_page_range", str(exc))
            pages_to_process = len(selected_pages)
            sampled = pages_to_process < pages_total
            metadata = metadata_to_json(pdf.metadata)

            for index in selected_pages:
                page = pdf.pages[index - 1]
                page_uncertainties: list[str] = []
                try:
                    text = page.extract_text() or ""
                except Exception as exc:
                    text = ""
                    page_uncertainties.append(f"page {index}: text extraction failed: {exc}")

                text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
                char_count = len(text)
                chars_extracted += char_count
                has_text = bool(text.strip())
                if has_text:
                    pages_with_text += 1
                else:
                    pages_without_text += 1

                visual_signals = compute_visual_signals(page)
                image_count = int(visual_signals["image_count"])
                if image_count:
                    pages_with_images += 1
                    images.append(
                        {
                            "page": index,
                            "count": image_count,
                            "image_area_ratio": visual_signals["image_area_ratio"],
                            "largest_image_area_ratio": visual_signals["largest_image_area_ratio"],
                        }
                    )

                page_tables: list[Any] = []
                table_error = None
                try:
                    page_tables = page.extract_tables() or []
                except Exception as exc:
                    table_error = str(exc)
                    page_uncertainties.append(f"page {index}: table extraction failed: {exc}")

                for table_index, table in enumerate(page_tables, start=1):
                    if len(tables) >= args.max_tables:
                        truncated = True
                        break
                    normalized = normalize_table(table, args.max_table_rows)
                    tables.append(
                        {
                            "page": index,
                            "table_index": table_index,
                            **normalized,
                        }
                    )

                text_health = compute_text_health(text)
                text_layer_trust = compute_text_layer_trust_risk(text_health)
                layout_signals = compute_layout_risk(page, text, page_tables)
                page_signals = {
                    "text_health": text_health,
                    "visual": visual_signals,
                    "layout": layout_signals,
                }
                page_route = decide_page_route(page_signals)
                redaction_overlay = visual_signals["redaction_overlay"]
                page_evidence = list(page_route["evidence"])
                if redaction_overlay["evidence"]:
                    page_evidence.extend(
                        f"redaction overlay signal: {item}" for item in redaction_overlay["evidence"]
                    )
                if text_layer_trust["evidence"]:
                    page_evidence.extend(
                        f"text-layer trust signal: {item}" for item in text_layer_trust["evidence"]
                    )
                page_decision = {
                    "page": index,
                    "text_layer_quality": text_health["quality"],
                    "scan_risk": visual_signals["scan_risk"],
                    "layout_risk": layout_signals["risk"],
                    "redaction_overlay_risk": redaction_overlay["risk"],
                    "text_layer_trust_risk": text_layer_trust["risk"],
                    "recommended_backend": page_route["recommended_backend"],
                    "route_confidence": page_route["confidence"],
                    "signals": {
                        "char_count": text_health["char_count"],
                        "line_count": text_health["line_count"],
                        "avg_line_length": text_health["avg_line_length"],
                        "empty_line_ratio": text_health["empty_line_ratio"],
                        "single_char_line_ratio": text_health["single_char_line_ratio"],
                        "abnormal_symbol_ratio": text_health["abnormal_symbol_ratio"],
                        "repeated_line_ratio": text_health["repeated_line_ratio"],
                        "text_layer_trust_risk": text_layer_trust["risk"],
                        "image_count": visual_signals["image_count"],
                        "image_area_ratio": visual_signals["image_area_ratio"],
                        "largest_image_area_ratio": visual_signals["largest_image_area_ratio"],
                        "rect_count": visual_signals["rect_count"],
                        "curve_count": visual_signals["curve_count"],
                        "pdf_line_count": visual_signals["pdf_line_count"],
                        "char_object_count": visual_signals["char_object_count"],
                        "vector_object_count": visual_signals["vector_object_count"],
                        "non_text_object_count": visual_signals["non_text_object_count"],
                        "redaction_overlay_risk": redaction_overlay["risk"],
                        "redaction_overlay_dark_rect_count": redaction_overlay["dark_rect_count"],
                        "redaction_overlay_overlap_rect_count": redaction_overlay["overlap_rect_count"],
                        "redaction_overlay_covered_dark_char_count": redaction_overlay["covered_dark_char_count"],
                        "redaction_overlay_covered_unknown_char_count": redaction_overlay["covered_unknown_char_count"],
                        "redaction_overlay_covered_word_count": redaction_overlay["covered_word_count"],
                        "redaction_overlay_max_rect_area_ratio": redaction_overlay["max_rect_area_ratio"],
                        "table_count": layout_signals["table_count"],
                        "short_line_density": layout_signals["short_line_density"],
                        "formula_symbol_ratio": layout_signals["formula_symbol_ratio"],
                        "multi_column_suspect": layout_signals["multi_column_suspect"],
                    },
                    "redaction_overlay_rects_sample": redaction_overlay["rects_sample"],
                    "evidence": page_evidence,
                }
                page_decision["advisories"] = build_page_advisories(page_decision)
                page_decisions.append(page_decision)

                if args.no_content:
                    included_text = ""
                    included_count = 0
                    text_omitted = bool(text)
                else:
                    included_text, included_count, page_truncated = clip_text(text, remaining_chars)
                    remaining_chars -= included_count
                    chars_included += included_count
                    text_omitted = False
                    if page_truncated:
                        truncated = True

                content.append(
                    {
                        "page": index,
                        "has_text": has_text,
                        "char_count": char_count,
                        "included_char_count": included_count,
                        "text": included_text,
                        "text_omitted": text_omitted,
                        "image_count": image_count,
                        "table_count": len(page_tables),
                        "table_error": table_error,
                        "width": float(page.width) if page.width is not None else None,
                        "height": float(page.height) if page.height is not None else None,
                    }
                )
                uncertainties.extend(page_uncertainties)

            if sampled:
                if selection_mode == "first_n":
                    uncertainties.append(
                        f"Processed first {pages_to_process} of {pages_total} pages; rerun with --diagnose-all or a larger --max-pages for full coverage."
                    )
                elif selection_mode == "explicit":
                    uncertainties.append(
                        f"Processed selected page(s) from {pages_total} total pages; rerun with --diagnose-all for full-document diagnostics."
                    )
            if args.no_content and chars_extracted:
                uncertainties.append(
                    "Page text was omitted by --no-content; rerun targeted pages without --no-content for content extraction."
                )
            if pages_without_text:
                uncertainties.append(
                    f"{pages_without_text} processed page(s) have no extractable text and may require OCR."
                )
            if truncated:
                uncertainties.append("Output content was truncated by max page, character, or table limits.")

            classification = classify_pdf(pages_to_process, pages_with_text, pages_with_images)
            quality_summary = summarize_quality(page_decisions)
            route_decision = decide_document_route(page_decisions, backend_availability)
            route_advisories = summarize_route_advisories(page_decisions)
            requires_ocr = any(page["recommended_backend"] == "ocr" for page in page_decisions)
            rendered_pages: dict[str, Any] = default_rendered_pages()
            vision_results: dict[str, Any] = load_vision_results(args.vision_results)
            ocr_results: dict[str, Any] = default_ocr_results()
            mineru_results: dict[str, Any] = default_mineru_results()
            should_run_ocr = bool(args.run_ocr or args.run_recommended or args.retry_short_ocr_with_vision)
            should_run_mineru = bool(args.run_mineru or args.run_recommended)
            should_run_vision = bool(args.run_vision)
            should_render_recommended = bool(args.render_recommended or args.run_recommended)
            if vision_results.get("status") in {"load_failed", "partial"}:
                uncertainties.append(
                    "Vision results did not load cleanly: "
                    + str(vision_results.get("reason") or vision_results.get("status"))
                )

            if args.render_dir and not should_run_ocr and not should_run_vision and not should_render_recommended:
                rendered_pages = render_selected_pages(
                    source,
                    selected_pages,
                    Path(args.render_dir).expanduser().resolve(),
                    args.render_dpi,
                    args.render_max_pages,
                    purpose="selected_pages",
                )
                if rendered_pages.get("status") != "ok":
                    uncertainties.append(
                        "Page rendering did not complete cleanly: "
                        + str(rendered_pages.get("reason") or rendered_pages.get("status"))
                    )

            if should_render_recommended:
                render_targets = render_handoff_target_pages(
                    page_decisions,
                    include_ocr=not should_run_ocr,
                    include_vision=not should_run_vision,
                )
                if render_targets:
                    render_dir = (
                        Path(args.render_dir).expanduser().resolve()
                        if args.render_dir
                        else Path(tempfile.mkdtemp(prefix="read-pdf-recommended-render-"))
                    )
                    recommended_render = render_selected_pages(
                        source,
                        render_targets,
                        render_dir,
                        args.render_dpi,
                        args.render_max_pages,
                        purpose="recommended_handoff",
                    )
                    rendered_pages = merge_rendered_pages(rendered_pages, recommended_render)
                    if recommended_render.get("status") != "ok":
                        uncertainties.append(
                            "Recommended page rendering did not complete cleanly: "
                            + str(recommended_render.get("reason") or recommended_render.get("status"))
                        )

            if should_run_vision:
                target_pages = vision_target_pages(page_decisions)
                if not target_pages:
                    auto_vision_results = {
                        "attempted": False,
                        "status": "no_vision_pages",
                        "backend": args.vision_backend,
                        "pages": [],
                    }
                else:
                    auto_vision_results = run_vision_pages(source, target_pages, args, rendered_pages)
                    embedded_render = auto_vision_results.pop("rendered_pages", None)
                    if isinstance(embedded_render, dict):
                        rendered_pages = merge_rendered_pages(rendered_pages, embedded_render)
                    if auto_vision_results.get("status") != "ok":
                        uncertainties.append(
                            "Vision backend did not complete cleanly: "
                            + str(auto_vision_results.get("reason") or auto_vision_results.get("status"))
                        )
                vision_results = merge_vision_results(vision_results, auto_vision_results)

            if should_run_ocr:
                target_pages = ocr_target_pages(page_decisions)
                if not target_pages:
                    ocr_results = {
                        "attempted": False,
                        "status": "no_ocr_pages",
                        "backend": args.ocr_backend,
                        "pages": [],
                    }
                else:
                    ocr_results = run_ocr_pages(source, target_pages, args)
                    embedded_render = ocr_results.pop("rendered_pages", None)
                    if isinstance(embedded_render, dict):
                        rendered_pages = merge_rendered_pages(rendered_pages, embedded_render)
                    if ocr_results.get("status") != "ok":
                        uncertainties.append(
                            "OCR did not complete cleanly: "
                            + str(ocr_results.get("reason") or ocr_results.get("status"))
                        )
                    if args.retry_short_ocr_with_vision:
                        retry_pages = ocr_short_vision_retry_pages(ocr_results)
                        if retry_pages:
                            retry_vision_results = run_vision_pages(source, retry_pages, args, rendered_pages)
                            retry_vision_results = mark_vision_results_purpose(
                                retry_vision_results,
                                "ocr_short_retry",
                                ocr_results,
                            )
                            embedded_render = retry_vision_results.pop("rendered_pages", None)
                            if isinstance(embedded_render, dict):
                                rendered_pages = merge_rendered_pages(rendered_pages, embedded_render)
                            if retry_vision_results.get("status") != "ok":
                                uncertainties.append(
                                    "OCR-short vision retry did not complete cleanly: "
                                    + str(retry_vision_results.get("reason") or retry_vision_results.get("status"))
                                )
                            vision_results = merge_vision_results(vision_results, retry_vision_results)
                        else:
                            uncertainties.append(
                                "OCR-short vision retry requested, but no non-blank OCR result under "
                                f"{MIN_NONBLANK_OCR_RESOLVED_CHARS} characters was found."
                            )

            if should_run_mineru:
                target_pages = mineru_target_pages(page_decisions)
                if not target_pages:
                    mineru_results = {
                        "attempted": False,
                        "status": "no_mineru_pages",
                        "backend": args.mineru_backend,
                        "pages": [],
                    }
                else:
                    mineru_results = run_mineru_pages(source, target_pages, args)
                    if mineru_results.get("status") != "ok":
                        uncertainties.append(
                            "MinerU did not complete cleanly: "
                            + str(mineru_results.get("reason") or mineru_results.get("status"))
                        )

            if route_decision["blocked_backends"]:
                uncertainties.append(
                    "Recommended backend unavailable: "
                    + ", ".join(route_decision["blocked_backends"])
                    + ". Returning a partial diagnostic packet."
                )

            resolved_pages, resolved_summary = build_resolved_pages(
                content,
                page_decisions,
                vision_results,
                ocr_results,
                mineru_results,
                args.resolved_max_chars,
            )
            if resolved_summary.get("truncated"):
                uncertainties.append("Resolved page text was truncated by --resolved-max-chars.")

            vision_handoff = build_vision_handoff(page_decisions, rendered_pages, resolved_pages)
            if vision_handoff.get("status") == "render_required":
                uncertainties.append(
                    "Vision-required page(s) were not rendered; rerun with --render-recommended or --run-recommended for image handoff."
                )
            elif vision_handoff.get("status") not in {"not_requested", "ok", "completed"}:
                uncertainties.append(
                    "Vision handoff is not fully ready: " + str(vision_handoff.get("status"))
                )

            return {
                "ok": True,
                "source_path": str(source),
                "source_reference": args.pdf if source_resolution else None,
                "source_resolution": source_resolution,
                "source_type": "pdf",
                "file": {
                    "name": source.name,
                    "size_bytes": size_bytes,
                },
                "pdf": {
                    "page_count": pages_total,
                    "metadata": metadata,
                },
                "classification": classification,
                "coverage": {
                    "pages_total": pages_total,
                    "pages_processed": pages_to_process,
                    "sampled": sampled,
                    "page_selection": {
                        "mode": selection_mode,
                        "requested": args.pages if args.pages else ("all" if args.diagnose_all else f"first {args.max_pages}"),
                        "processed": compact_page_numbers(selected_pages),
                    },
                    "pages_with_text": pages_with_text,
                    "pages_without_text": pages_without_text,
                    "chars_extracted": chars_extracted,
                    "chars_included": chars_included,
                },
                "content": content,
                "tables": tables,
                "images": images,
                "uncertainties": uncertainties,
                "backend_availability": backend_availability,
                "quality_summary": quality_summary,
                "route_decision": route_decision,
                "route_advisories": route_advisories,
                "page_decisions": page_decisions,
                "rendered_pages": rendered_pages,
                "vision_handoff": vision_handoff,
                "vision_results": vision_results,
                "ocr_results": ocr_results,
                "mineru_results": mineru_results,
                "resolved_pages": resolved_pages,
                "resolved_summary": resolved_summary,
                "recommended_route": route_decision["selected"],
                "rendering_risk": rendering_risk(classification, tables, images, route_decision),
                "requires_ocr": requires_ocr,
                "truncated": truncated,
            }
    except Exception as exc:
        return error_packet(str(source), "pdf_open_or_extract_failed", str(exc))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a bounded structured intake packet for a PDF.")
    parser.add_argument("pdf", help="Path to a PDF file.")
    parser.add_argument("--pages", help="1-based page selection such as 1-5,9,12-14. Use 'all' for every page.")
    parser.add_argument("--diagnose-all", action="store_true", help="Inspect every page for diagnostics. Pair with --no-content for long PDFs.")
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES, help="Maximum pages to inspect.")
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS, help="Maximum text characters to include.")
    parser.add_argument("--resolved-max-chars", type=int, default=DEFAULT_RESOLVED_MAX_CHARS, help="Maximum normalized resolved text characters to include.")
    parser.add_argument("--max-tables", type=int, default=DEFAULT_MAX_TABLES, help="Maximum tables to include.")
    parser.add_argument("--max-table-rows", type=int, default=DEFAULT_MAX_TABLE_ROWS, help="Maximum rows per sampled table.")
    parser.add_argument("--no-content", action="store_true", help="Run diagnostics but omit extracted page text from content[].")
    parser.add_argument("--output", help="Write the full packet to this JSON file and print a compact summary to stdout.")
    parser.add_argument("--render-dir", help="Render selected pages to PNG files in this directory.")
    parser.add_argument("--render-dpi", type=int, default=DEFAULT_RENDER_DPI, help="DPI for rendered page images.")
    parser.add_argument("--render-max-pages", type=int, default=DEFAULT_RENDER_MAX_PAGES, help="Safety limit for page rendering.")
    parser.add_argument("--render-recommended", action="store_true", help="Render only pages whose diagnostic route recommends OCR or vision handoff.")
    parser.add_argument("--run-recommended", action="store_true", help="Attempt recommended executable fallback backends and render vision handoff pages, subject to safety limits.")
    parser.add_argument("--vision-results", help="JSON file with external vision/read_file results to merge into resolved_pages for pages routed to vision.")
    parser.add_argument("--run-vision", action="store_true", help="Attempt vision on pages whose diagnostic route recommends vision.")
    parser.add_argument("--retry-short-ocr-with-vision", action="store_true", help="After OCR, attempt vision only on rendered non-blank OCR pages whose OCR text is under 20 characters.")
    parser.add_argument("--vision-backend", default="auto", choices=["auto", "reader_proxy"], help="Vision backend to use when --run-vision is set.")
    parser.add_argument("--vision-api", help="Reader proxy base URL or /analyze endpoint. Can also be set with XIAOBA_VISION_API_URL, READER_PROXY_URL, CATSCOMPANY_READER_API_URL, or CATSCO_HTTP_BASE_URL.")
    parser.add_argument("--vision-api-key-env", default="XIAOBA_VISION_API_KEY", help="Environment variable containing a reader proxy API key.")
    parser.add_argument("--vision-bearer-env", default="XIAOBA_VISION_BEARER_TOKEN", help="Environment variable containing a reader proxy bearer token.")
    parser.add_argument("--vision-api-timeout", type=int, default=DEFAULT_VISION_API_TIMEOUT, help="HTTP vision request timeout in seconds.")
    parser.add_argument("--vision-max-pages", type=int, default=DEFAULT_VISION_MAX_PAGES, help="Safety limit for vision execution.")
    parser.add_argument("--vision-prompt", default=DEFAULT_VISION_PROMPT, help="Prompt sent to the reader proxy for each rendered PDF page image.")
    parser.add_argument("--run-ocr", action="store_true", help="Attempt OCR on pages whose diagnostic route recommends OCR.")
    parser.add_argument("--ocr-backend", default="auto", choices=["auto", "paddleocr", "http_api"], help="OCR backend to use when --run-ocr is set.")
    parser.add_argument("--ocr-lang", default="ch", help="OCR language code passed to the OCR backend.")
    parser.add_argument("--ocr-max-pages", type=int, default=DEFAULT_OCR_MAX_PAGES, help="Safety limit for OCR execution.")
    parser.add_argument("--ocr-api", help="HTTP OCR endpoint. Can also be set with XIAOBA_OCR_API_URL.")
    parser.add_argument("--ocr-api-key-env", default="XIAOBA_OCR_API_KEY", help="Environment variable containing the OCR API key.")
    parser.add_argument("--ocr-api-timeout", type=int, default=300, help="HTTP OCR request timeout in seconds.")
    parser.add_argument("--run-mineru", action="store_true", help="Attempt MinerU on pages whose diagnostic route recommends MinerU.")
    parser.add_argument("--mineru-backend", default="auto", choices=["auto", "http_api", "local_cli"], help="MinerU backend to use when --run-mineru is set.")
    parser.add_argument("--mineru-cmd", help="MinerU CLI command or executable path. Can also be set with MINERU_CMD or MINERU_EXE.")
    parser.add_argument("--mineru-method", default="auto", choices=["auto", "txt", "ocr"], help="MinerU --method value.")
    parser.add_argument("--mineru-engine", default="pipeline", help="MinerU --backend value. Defaults to pipeline for CPU-compatible local parsing.")
    parser.add_argument("--mineru-lang", help="MinerU OCR language, such as ch.")
    parser.add_argument("--mineru-api", help="HTTP MinerU /file_parse endpoint. Can also be set with XIAOBA_MINERU_API_URL.")
    parser.add_argument("--mineru-api-key-env", default="XIAOBA_MINERU_API_KEY", help="Environment variable containing the MinerU API key.")
    parser.add_argument("--mineru-api-timeout", type=int, default=1800, help="HTTP MinerU request timeout in seconds.")
    parser.add_argument("--mineru-output-dir", help="Directory for raw MinerU output.")
    parser.add_argument("--mineru-max-pages", type=int, default=DEFAULT_MINERU_MAX_PAGES, help="Safety limit for MinerU execution.")
    parser.add_argument("--mineru-timeout", type=int, default=DEFAULT_MINERU_TIMEOUT, help="MinerU subprocess timeout in seconds.")
    parser.add_argument("--mineru-extra-arg", action="append", help="Extra argument passed to the MinerU CLI. Repeat for multiple args.")
    parser.add_argument(
        "--failure-candidates-output",
        help="After writing --output, run the packet failure collector on that packet and write a failure-intake CSV.",
    )
    parser.add_argument("--failure-candidates-summary", help="Optional JSON summary path for --failure-candidates-output.")
    parser.add_argument("--failure-candidates-report", help="Optional markdown report path for --failure-candidates-output.")
    parser.add_argument("--failure-capture-timeout", type=int, default=300, help="Packet failure collector timeout in seconds.")
    parser.add_argument(
        "--failure-capture-allow-missing-sources",
        action="store_true",
        help="Pass --allow-missing-sources to collect-pdf-packet-failures.py.",
    )
    parser.add_argument(
        "--failure-capture-exclude-known-families",
        action="store_true",
        help="Pass --exclude-known-families to collect-pdf-packet-failures.py.",
    )
    parser.add_argument(
        "--failure-capture-allow-untrusted-text-layer-ratio",
        action="store_true",
        help="Pass --allow-untrusted-text-layer-ratio to collect-pdf-packet-failures.py for audits of old ratio-only behavior.",
    )
    parser.add_argument(
        "--failure-capture-known-family",
        action="append",
        help="Additional LABEL=REGEX known-family marker passed to collect-pdf-packet-failures.py. Repeat for multiple markers.",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.pages and args.diagnose_all:
        emit(error_packet(args.pdf, "bad_argument", "Use either --pages or --diagnose-all, not both."), 2)
    if args.max_pages <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--max-pages must be positive"), 2)
    if args.max_chars <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--max-chars must be positive"), 2)
    if args.resolved_max_chars <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--resolved-max-chars must be positive"), 2)
    if args.max_tables < 0:
        emit(error_packet(args.pdf, "bad_argument", "--max-tables must be zero or positive"), 2)
    if args.max_table_rows <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--max-table-rows must be positive"), 2)
    if args.render_dpi <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--render-dpi must be positive"), 2)
    if args.render_max_pages <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--render-max-pages must be positive"), 2)
    if args.ocr_max_pages <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--ocr-max-pages must be positive"), 2)
    if args.ocr_api_timeout <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--ocr-api-timeout must be positive"), 2)
    if args.vision_api_timeout <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--vision-api-timeout must be positive"), 2)
    if args.vision_max_pages <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--vision-max-pages must be positive"), 2)
    if args.mineru_max_pages <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--mineru-max-pages must be positive"), 2)
    if args.mineru_timeout <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--mineru-timeout must be positive"), 2)
    if args.mineru_api_timeout <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--mineru-api-timeout must be positive"), 2)
    if args.failure_capture_timeout <= 0:
        emit(error_packet(args.pdf, "bad_argument", "--failure-capture-timeout must be positive"), 2)
    if args.failure_candidates_output and not args.output:
        emit(error_packet(args.pdf, "bad_argument", "--failure-candidates-output requires --output"), 2)

    payload = run(args)
    if args.output:
        output_path = Path(args.output).expanduser().resolve()
        try:
            write_text(output_path, json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as exc:
            emit(error_packet(args.pdf, "output_write_failed", f"Could not write output JSON: {exc}"), 1)
        summary = output_summary(payload, output_path)
        failure_capture = run_failure_capture(output_path, args)
        if failure_capture is not None:
            summary["failure_capture"] = failure_capture
        exit_code = 0 if payload.get("ok") and (failure_capture is None or failure_capture.get("ok")) else 1
        emit(summary, exit_code)
    emit(payload, 0 if payload.get("ok") else 1)


if __name__ == "__main__":
    main()
