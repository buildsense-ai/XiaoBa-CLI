#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
INTAKE_SCRIPT = SCRIPT_DIR / "pdf-intake.py"
REQUIREMENTS_FILE = SKILL_DIR / "requirements.txt"

DEFAULT_TEXT_MAX_PAGES = 80
DEFAULT_BATCH_SIZE = 20
DEFAULT_OCR_TOTAL_MAX_PAGES = 80
DEFAULT_MINERU_TOTAL_MAX_PAGES = 0


def emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    raise SystemExit(exit_code)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def tail_text(value: str, limit: int = 4000) -> str:
    if len(value) <= limit:
        return value
    return value[-limit:]


def safe_stem(value: str) -> str:
    text = value.strip()
    if text.startswith("catsco_attachment:"):
        text = "catsco_attachment_" + text.split(":", 1)[1]
    else:
        text = Path(text).name or "pdf"
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", text)
    text = text.strip("._-")
    return text[:80] or "pdf"


def default_output_dir(pdf: str) -> Path:
    configured = os.environ.get("XIAOBA_READ_PDF_OUTPUT_DIR", "").strip()
    if configured:
        root = Path(os.path.expandvars(configured)).expanduser()
    else:
        appdata = os.environ.get("APPDATA", "").strip()
        if appdata:
            root = Path(appdata).expanduser() / "xiaoba-cli" / "outputs" / "read-pdf"
        elif os.name == "nt":
            root = Path.home() / "AppData" / "Roaming" / "xiaoba-cli" / "outputs" / "read-pdf"
        else:
            root = Path.cwd() / "read-pdf-output"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return root / f"{stamp}-{safe_stem(pdf)}"


def module_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def run_command(cmd: list[str], timeout: int | None = None) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        return {
            "ok": False,
            "timeout": True,
            "returncode": None,
            "command": cmd,
            "stdout": stdout,
            "stdout_tail": tail_text(stdout),
            "stderr_tail": tail_text(stderr),
        }
    except Exception as exc:
        return {
            "ok": False,
            "returncode": None,
            "command": cmd,
            "error": str(exc),
            "stdout": "",
            "stdout_tail": "",
            "stderr_tail": "",
        }
    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    return {
        "ok": proc.returncode == 0,
        "timeout": False,
        "returncode": proc.returncode,
        "command": cmd,
        "stdout": stdout,
        "stdout_tail": tail_text(stdout),
        "stderr_tail": tail_text(stderr),
    }


def ensure_dependencies(auto_install: bool, timeout: int) -> dict[str, Any]:
    required = {
        "pdfplumber": "pdfplumber",
        "pdf2image": "pdf2image",
        "pillow": "PIL",
        "pymupdf": "fitz",
    }
    module_status = {
        name: {"module": module, "available": module_available(module)}
        for name, module in required.items()
    }
    missing_initial = [name for name, status in module_status.items() if not status["available"]]
    result: dict[str, Any] = {
        "ok": not missing_initial,
        "auto_install": auto_install,
        "python_executable": sys.executable,
        "python_version": sys.version.split()[0],
        "requirements_file": str(REQUIREMENTS_FILE),
        "requirements_present": REQUIREMENTS_FILE.exists(),
        "required_modules": module_status,
        "missing_initial": missing_initial,
        "install_attempted": False,
        "missing_after": missing_initial,
    }
    if not missing_initial:
        result["ok"] = True
        return result
    if not auto_install:
        return result
    if not REQUIREMENTS_FILE.exists():
        result["reason"] = "requirements.txt not found"
        return result

    install_cmd = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--only-binary=:all:",
        "--timeout",
        "60",
        "--retries",
        "1",
        "-r",
        str(REQUIREMENTS_FILE),
    ]
    result["install_command"] = subprocess.list2cmdline(install_cmd)
    install_result = run_command(install_cmd, timeout=timeout)
    module_status_after = {
        name: {"module": module, "available": module_available(module)}
        for name, module in required.items()
    }
    missing_after = [name for name, status in module_status_after.items() if not status["available"]]
    result.update(
        {
            "install_attempted": True,
            "required_modules_after": module_status_after,
            "install_result": {
                "ok": install_result.get("ok"),
                "returncode": install_result.get("returncode"),
                "timeout": install_result.get("timeout"),
                "stdout_tail": install_result.get("stdout_tail"),
                "stderr_tail": install_result.get("stderr_tail"),
            },
            "missing_after": missing_after,
            "ok": not missing_after,
        }
    )
    return result


def parse_stdout_json(text: str) -> dict[str, Any] | None:
    text = text.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def run_intake(
    pdf: str,
    output_path: Path,
    extra_args: list[str],
    timeout: int | None,
) -> dict[str, Any]:
    cmd = [sys.executable, str(INTAKE_SCRIPT), pdf, *extra_args, "--output", str(output_path)]
    command_result = run_command(cmd, timeout=timeout)
    stdout_json = parse_stdout_json(str(command_result.get("stdout") or ""))
    packet = read_json(output_path)
    return {
        "ok": bool(command_result.get("ok")) and bool(packet and packet.get("ok")),
        "packet_path": str(output_path),
        "command": cmd,
        "returncode": command_result.get("returncode"),
        "timeout": command_result.get("timeout"),
        "stdout_summary": stdout_json,
        "stderr_tail": command_result.get("stderr_tail"),
        "packet": packet,
    }


def pages_for_backend(packet: dict[str, Any] | None, backend: str) -> list[int]:
    if not isinstance(packet, dict):
        return []
    pages: list[int] = []
    for decision in packet.get("page_decisions", []) or []:
        if not isinstance(decision, dict):
            continue
        if decision.get("recommended_backend") != backend:
            continue
        try:
            page = int(decision.get("page"))
        except Exception:
            continue
        pages.append(page)
    return sorted(set(pages))


def processed_pages(packet: dict[str, Any] | None) -> list[int]:
    if not isinstance(packet, dict):
        return []
    pages: list[int] = []
    for decision in packet.get("page_decisions", []) or []:
        if not isinstance(decision, dict):
            continue
        try:
            pages.append(int(decision.get("page")))
        except Exception:
            continue
    return sorted(set(pages))


def compact_pages(pages: list[int]) -> str:
    unique = sorted(set(pages))
    if not unique:
        return ""
    ranges: list[str] = []
    start = prev = unique[0]
    for page in unique[1:]:
        if page == prev + 1:
            prev = page
            continue
        ranges.append(str(start) if start == prev else f"{start}-{prev}")
        start = prev = page
    ranges.append(str(start) if start == prev else f"{start}-{prev}")
    return ",".join(ranges)


def page_spec_slug(page_spec: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", page_spec)
    slug = slug.strip("._-")
    return slug[:80] or "pages"


def chunk_pages(pages: list[int], size: int) -> list[list[int]]:
    if size <= 0:
        size = DEFAULT_BATCH_SIZE
    return [pages[index : index + size] for index in range(0, len(pages), size)]


def write_output_snapshot(output: str | None, payload: dict[str, Any]) -> None:
    if not output:
        return
    write_json(Path(output).expanduser().resolve(), payload)


def runner_argv(
    pdf: str,
    pages: list[int],
    output_path: Path,
    args: argparse.Namespace,
    *,
    run_mineru: bool = False,
    run_vision: bool = False,
    ocr_total_max_pages: int | None = None,
    mineru_total_max_pages: int | None = None,
) -> list[str]:
    page_spec = compact_pages(pages)
    argv = [
        sys.executable,
        str(Path(__file__).resolve()),
        pdf,
        "--pages",
        page_spec,
        "--batch-size",
        str(args.batch_size),
        "--intake-timeout",
        str(args.intake_timeout),
        "--output",
        str(output_path),
        "--output-dir",
        str(output_path.parent),
    ]
    if args.no_install:
        argv.append("--no-install")
    if ocr_total_max_pages is not None:
        argv.extend(["--ocr-total-max-pages", str(ocr_total_max_pages)])
    if run_mineru:
        argv.append("--run-mineru")
        if mineru_total_max_pages is not None:
            argv.extend(["--mineru-total-max-pages", str(mineru_total_max_pages)])
    if run_vision:
        argv.append("--run-vision")
        argv.extend(["--vision-total-max-pages", str(max(len(pages), args.vision_total_max_pages))])
    return argv


def continuation_command(
    kind: str,
    pdf: str,
    pages: list[int],
    output_dir: Path,
    args: argparse.Namespace,
    *,
    reason: str,
    run_mineru: bool = False,
    run_vision: bool = False,
    ocr_total_max_pages: int | None = None,
    mineru_total_max_pages: int | None = None,
) -> dict[str, Any]:
    page_spec = compact_pages(pages)
    path = output_dir / "continuations" / f"{kind}-{page_spec_slug(page_spec)}.run.json"
    argv = runner_argv(
        pdf,
        pages,
        path,
        args,
        run_mineru=run_mineru,
        run_vision=run_vision,
        ocr_total_max_pages=ocr_total_max_pages,
        mineru_total_max_pages=mineru_total_max_pages,
    )
    auto_runnable = kind == "ocr" or (kind == "retry" and not run_mineru and not run_vision)
    return {
        "kind": kind,
        "reason": reason,
        "pages": page_spec,
        "page_count": len(pages),
        "output": str(path),
        "argv": argv,
        "command": subprocess.list2cmdline(argv),
        "auto_runnable": auto_runnable,
    }


def summarize_packet(packet: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(packet, dict):
        return {}
    ocr = packet.get("ocr_results", {}) if isinstance(packet.get("ocr_results"), dict) else {}
    mineru = packet.get("mineru_results", {}) if isinstance(packet.get("mineru_results"), dict) else {}
    vision = packet.get("vision_results", {}) if isinstance(packet.get("vision_results"), dict) else {}
    return {
        "ok": packet.get("ok"),
        "source_path": packet.get("source_path"),
        "source_reference": packet.get("source_reference"),
        "classification": packet.get("classification"),
        "coverage": packet.get("coverage"),
        "quality_summary": packet.get("quality_summary"),
        "route_decision": packet.get("route_decision"),
        "backend_availability": packet.get("backend_availability"),
        "resolved_summary": packet.get("resolved_summary"),
        "ocr_results": {
            "attempted": ocr.get("attempted"),
            "status": ocr.get("status"),
            "backend": ocr.get("backend"),
            "count": len(ocr.get("pages", []) or []),
        },
        "mineru_results": {
            "attempted": mineru.get("attempted"),
            "status": mineru.get("status"),
            "backend": mineru.get("backend"),
            "count": len(mineru.get("pages", []) or []),
        },
        "vision_results": {
            "attempted": vision.get("attempted"),
            "status": vision.get("status"),
            "backend": vision.get("backend"),
            "count": len(vision.get("pages", []) or []),
        },
    }


def build_next_action(
    *,
    is_complete: bool,
    result_ok: bool,
    continuation_commands: list[dict[str, Any]],
    resolved_text_path: str | None,
    blocked_codes: list[str],
) -> dict[str, Any]:
    if is_complete:
        return {
            "action": "summarize_from_resolved_text",
            "reason": "Requested scope is complete.",
            "resolved_text_path": resolved_text_path,
            "auto_runnable": False,
        }

    for command in continuation_commands:
        if command.get("auto_runnable"):
            return {
                "action": "run_continuation",
                "reason": command.get("reason") or "A safe continuation command is available.",
                "kind": command.get("kind"),
                "pages": command.get("pages"),
                "page_count": command.get("page_count"),
                "output": command.get("output"),
                "argv": command.get("argv"),
                "command": command.get("command"),
                "auto_runnable": True,
            }

    if continuation_commands:
        first = continuation_commands[0]
        return {
            "action": "backend_decision_required",
            "reason": "Remaining work requires MinerU, vision, or another non-auto fallback.",
            "kind": first.get("kind"),
            "pages": first.get("pages"),
            "page_count": first.get("page_count"),
            "command": first.get("command"),
            "auto_runnable": False,
            "blocked_or_capped": blocked_codes,
        }

    return {
        "action": "report_partial" if result_ok else "report_failure",
        "reason": "No safe continuation command is available.",
        "resolved_text_path": resolved_text_path,
        "auto_runnable": False,
        "blocked_or_capped": blocked_codes,
    }


def collect_resolved_text(packet_paths: list[str], output_path: Path) -> dict[str, Any]:
    page_map: dict[int, dict[str, Any]] = {}
    status_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    for packet_path in packet_paths:
        packet = read_json(Path(packet_path))
        if not isinstance(packet, dict):
            continue
        for page in packet.get("resolved_pages", []) or []:
            if not isinstance(page, dict):
                continue
            try:
                page_num = int(page.get("page"))
            except Exception:
                continue
            text = str(page.get("text") or "")
            existing = page_map.get(page_num)
            if existing and len(str(existing.get("text") or "")) >= len(text):
                continue
            page_map[page_num] = {
                "page": page_num,
                "status": page.get("status"),
                "source": page.get("source"),
                "confidence": page.get("confidence"),
                "text": text,
            }

    lines = [
        "# read-pdf resolved text",
        "",
        "This file contains normalized page text only. It omits OCR boxes and backend diagnostics.",
        "",
    ]
    chars_written = 0
    pages_with_text = 0
    for page_num in sorted(page_map):
        page = page_map[page_num]
        status = str(page.get("status") or "unknown")
        source = str(page.get("source") or "unknown")
        status_counts[status] = status_counts.get(status, 0) + 1
        source_counts[source] = source_counts.get(source, 0) + 1
        text = str(page.get("text") or "").strip()
        if text:
            pages_with_text += 1
            chars_written += len(text)
        confidence = page.get("confidence")
        confidence_part = f", confidence={confidence}" if confidence is not None else ""
        lines.append(f"## Page {page_num} ({status}, {source}{confidence_part})")
        lines.append("")
        lines.append(text if text else "[no resolved text]")
        lines.append("")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines), encoding="utf-8")
    return {
        "path": str(output_path),
        "pages_seen": len(page_map),
        "pages_with_text": pages_with_text,
        "pages_without_text": len(page_map) - pages_with_text,
        "chars_written": chars_written,
        "status_counts": status_counts,
        "source_counts": source_counts,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="One-command read-pdf runner: install light deps, diagnose, then run targeted backends."
    )
    parser.add_argument("pdf", help="PDF path or catsco_attachment:<id> reference.")
    parser.add_argument("--pages", help="1-based page selection such as 1-5,9. Use all for every page.")
    parser.add_argument("--output", help="Write this runner summary JSON to a file.")
    parser.add_argument("--output-dir", help="Directory for diagnosis/final packet files.")
    parser.add_argument("--diagnose-only", action="store_true", help="Only run diagnosis, do not run content/backend pass.")
    parser.add_argument("--no-install", action="store_true", help="Do not install requirements.txt when light deps are missing.")
    parser.add_argument("--install-timeout", type=int, default=600, help="Pip install timeout in seconds.")
    parser.add_argument("--intake-timeout", type=int, default=1800, help="Each pdf-intake.py command timeout in seconds.")
    parser.add_argument("--text-max-pages", type=int, default=DEFAULT_TEXT_MAX_PAGES, help="Text pages to include when no pages are explicit.")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="Maximum OCR pages per backend batch.")
    parser.add_argument("--ocr-total-max-pages", type=int, default=DEFAULT_OCR_TOTAL_MAX_PAGES, help="Maximum OCR pages to run automatically.")
    parser.add_argument("--no-auto-ocr", action="store_true", help="Do not run OCR automatically even if diagnosis recommends it.")
    parser.add_argument("--run-mineru", action="store_true", help="Run MinerU on pages that diagnosis recommends for MinerU.")
    parser.add_argument(
        "--mineru-total-max-pages",
        type=int,
        default=DEFAULT_MINERU_TOTAL_MAX_PAGES,
        help="Maximum MinerU pages to run when --run-mineru is set. Use 0 for no cap.",
    )
    parser.add_argument("--run-vision", action="store_true", help="Run vision on pages that diagnosis recommends for vision.")
    parser.add_argument("--vision-total-max-pages", type=int, default=5, help="Maximum vision pages to run automatically.")
    parser.add_argument("--retry-short-ocr-with-vision", action="store_true", help="After OCR, retry suspiciously short OCR pages with vision.")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.text_max_pages <= 0:
        emit({"ok": False, "error": {"code": "bad_argument", "message": "--text-max-pages must be positive"}}, 2)
    if args.batch_size <= 0:
        emit({"ok": False, "error": {"code": "bad_argument", "message": "--batch-size must be positive"}}, 2)
    if args.ocr_total_max_pages < 0:
        emit({"ok": False, "error": {"code": "bad_argument", "message": "--ocr-total-max-pages must be zero or positive"}}, 2)
    if args.mineru_total_max_pages < 0:
        emit({"ok": False, "error": {"code": "bad_argument", "message": "--mineru-total-max-pages must be zero or positive"}}, 2)

    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else default_output_dir(args.pdf)
    output_dir.mkdir(parents=True, exist_ok=True)

    dep_check = ensure_dependencies(auto_install=not args.no_install, timeout=args.install_timeout)
    result: dict[str, Any] = {
        "ok": False,
        "tool": "read-pdf-runner",
        "source": args.pdf,
        "output_dir": str(output_dir),
        "dependency_check": dep_check,
        "diagnosis": None,
        "execution": {
            "attempted": False,
            "packets": [],
            "skipped": [],
        },
    }
    if not dep_check.get("ok"):
        result["error"] = {
            "code": "dependency_unavailable",
            "message": "Light PDF dependencies are missing and could not be installed.",
        }
        write_output_snapshot(args.output, result)
        emit(result, 1)

    diagnosis_path = output_dir / "diagnosis.packet.json"
    diagnosis_args = ["--no-content"]
    if args.pages:
        diagnosis_args.extend(["--pages", args.pages])
    else:
        diagnosis_args.append("--diagnose-all")
    diagnosis = run_intake(args.pdf, diagnosis_path, diagnosis_args, timeout=args.intake_timeout)
    diagnosis_packet = diagnosis.get("packet")
    result["diagnosis"] = {
        "ok": diagnosis.get("ok"),
        "packet_path": diagnosis.get("packet_path"),
        "returncode": diagnosis.get("returncode"),
        "timeout": diagnosis.get("timeout"),
        "summary": summarize_packet(diagnosis_packet),
        "stdout_summary": diagnosis.get("stdout_summary"),
        "stderr_tail": diagnosis.get("stderr_tail"),
    }
    if not diagnosis.get("ok"):
        result["error"] = {
            "code": "diagnosis_failed",
            "message": "pdf-intake.py did not produce a successful diagnosis packet.",
        }
        write_output_snapshot(args.output, result)
        emit(result, 1)

    if args.diagnose_only:
        result["ok"] = True
        result["final_packet_path"] = str(diagnosis_path)
        result["execution"]["skipped"].append(
            {"code": "diagnose_only", "reason": "--diagnose-only was set"}
        )
        write_output_snapshot(args.output, result)
        emit(result, 0)

    all_processed = processed_pages(diagnosis_packet)
    text_pages_all = pages_for_backend(diagnosis_packet, "text_extract")
    ocr_pages_all = pages_for_backend(diagnosis_packet, "ocr")
    mineru_pages_all = pages_for_backend(diagnosis_packet, "mineru")
    vision_pages_all = pages_for_backend(diagnosis_packet, "vision")
    partial_pages_all = pages_for_backend(diagnosis_packet, "partial")

    selected_pages = set(text_pages_all[: args.text_max_pages])
    auto_ocr = not args.no_auto_ocr and args.ocr_total_max_pages > 0
    ocr_pages = ocr_pages_all[: args.ocr_total_max_pages] if auto_ocr else []
    selected_pages.update(ocr_pages)

    mineru_pages: list[int] = []
    if args.run_mineru:
        if args.mineru_total_max_pages > 0:
            mineru_pages = mineru_pages_all[: args.mineru_total_max_pages]
        else:
            mineru_pages = mineru_pages_all
        selected_pages.update(mineru_pages)
        if len(mineru_pages_all) > len(mineru_pages):
            result["execution"]["skipped"].append(
                {
                    "code": "mineru_capped",
                    "reason": f"{len(mineru_pages_all)} MinerU page(s) recommended; only {len(mineru_pages)} selected by --mineru-total-max-pages",
                    "pages_not_run": compact_pages(mineru_pages_all[len(mineru_pages) :]),
                }
            )
    elif mineru_pages_all:
        result["execution"]["skipped"].append(
            {
                "code": "mineru_not_run",
                "reason": "diagnosis recommended MinerU, but --run-mineru was not set",
                "pages": compact_pages(mineru_pages_all),
            }
        )

    vision_pages: list[int] = []
    if args.run_vision:
        vision_pages = vision_pages_all[: args.vision_total_max_pages]
        selected_pages.update(vision_pages)
        if len(vision_pages_all) > len(vision_pages):
            result["execution"]["skipped"].append(
                {
                    "code": "vision_capped",
                    "reason": f"{len(vision_pages_all)} vision page(s) recommended; only {len(vision_pages)} selected by --vision-total-max-pages",
                    "pages_not_run": compact_pages(vision_pages_all[len(vision_pages) :]),
                }
            )
    elif vision_pages_all:
        result["execution"]["skipped"].append(
            {
                "code": "vision_not_run",
                "reason": "diagnosis recommended vision, but --run-vision was not set",
                "pages": compact_pages(vision_pages_all),
            }
        )

    if partial_pages_all:
        result["execution"]["skipped"].append(
            {
                "code": "partial_unresolved",
                "reason": "diagnosis could not select a reliable backend for these pages",
                "pages": compact_pages(partial_pages_all),
            }
        )

    if not auto_ocr and ocr_pages_all:
        result["execution"]["skipped"].append(
            {
                "code": "ocr_not_run",
                "reason": "diagnosis recommended OCR, but automatic OCR is disabled or capped at zero",
                "pages": compact_pages(ocr_pages_all),
            }
        )
    elif len(ocr_pages_all) > len(ocr_pages):
        result["execution"]["skipped"].append(
            {
                "code": "ocr_capped",
                "reason": f"{len(ocr_pages_all)} OCR page(s) recommended; only {len(ocr_pages)} selected by --ocr-total-max-pages",
                "pages_not_run": compact_pages(ocr_pages_all[len(ocr_pages) :]),
            }
        )

    final_pages = sorted(selected_pages)
    if not final_pages:
        result["ok"] = True
        result["final_packet_path"] = str(diagnosis_path)
        result["execution"]["skipped"].append(
            {"code": "no_pages_selected", "reason": "diagnosis produced no processed pages"}
        )
        write_output_snapshot(args.output, result)
        emit(result, 0)

    result["execution"]["attempted"] = True
    result["execution"]["selected_pages"] = compact_pages(final_pages)
    result["execution"]["selected_page_count"] = len(final_pages)
    result["execution"]["auto_ocr_pages"] = compact_pages(ocr_pages)
    result["execution"]["mineru_pages"] = compact_pages(mineru_pages)
    result["execution"]["vision_pages"] = compact_pages(vision_pages)

    ocr_set = set(ocr_pages)
    backend_batches: list[list[int]]
    if ocr_pages and len(ocr_pages) > args.batch_size:
        non_ocr_pages = [page for page in final_pages if page not in ocr_set]
        backend_batches = []
        if non_ocr_pages:
            backend_batches.append(non_ocr_pages)
        backend_batches.extend(chunk_pages(ocr_pages, args.batch_size))
    else:
        backend_batches = [final_pages]

    result["execution"]["batch_plan"] = []
    for index, batch in enumerate(backend_batches, start=1):
        batch_ocr_pages = [page for page in batch if page in ocr_set]
        packet_path = output_dir / f"content-batch-{index:02d}.packet.json"
        result["execution"]["batch_plan"].append(
            {
                "index": index,
                "status": "pending",
                "pages": compact_pages(batch),
                "page_count": len(batch),
                "ocr_pages": compact_pages(batch_ocr_pages),
                "ocr_page_count": len(batch_ocr_pages),
                "packet_path": str(packet_path),
            }
        )
    write_output_snapshot(args.output, result)

    all_ok = True
    for index, batch in enumerate(backend_batches, start=1):
        page_arg = compact_pages(batch)
        packet_path = output_dir / f"content-batch-{index:02d}.packet.json"
        extra = ["--pages", page_arg]
        batch_ocr_count = len([page for page in batch if page in ocr_set])
        if batch_ocr_count:
            extra.extend(
                [
                    "--run-ocr",
                    "--ocr-backend",
                    "auto",
                    "--ocr-max-pages",
                    str(batch_ocr_count),
                    "--render-max-pages",
                    str(max(batch_ocr_count, 1)),
                ]
            )
            if args.retry_short_ocr_with_vision:
                extra.append("--retry-short-ocr-with-vision")
                extra.extend(["--vision-max-pages", str(args.vision_total_max_pages)])
        if args.run_mineru:
            extra.extend(["--run-mineru", "--mineru-backend", "auto"])
        if args.run_vision:
            extra.extend(["--run-vision", "--vision-backend", "auto"])

        packet_run = run_intake(args.pdf, packet_path, extra, timeout=args.intake_timeout)
        packet = packet_run.get("packet")
        all_ok = all_ok and bool(packet_run.get("ok"))
        batch_status = "ok" if packet_run.get("ok") else "timeout" if packet_run.get("timeout") else "failed"
        try:
            result["execution"]["batch_plan"][index - 1]["status"] = batch_status
            result["execution"]["batch_plan"][index - 1]["returncode"] = packet_run.get("returncode")
            result["execution"]["batch_plan"][index - 1]["timeout"] = packet_run.get("timeout")
        except Exception:
            pass
        result["execution"]["packets"].append(
            {
                "ok": packet_run.get("ok"),
                "kind": "content_backend_batch",
                "pages": page_arg,
                "page_count": len(batch),
                "packet_path": str(packet_path),
                "returncode": packet_run.get("returncode"),
                "timeout": packet_run.get("timeout"),
                "summary": summarize_packet(packet),
                "stdout_summary": packet_run.get("stdout_summary"),
                "stderr_tail": packet_run.get("stderr_tail"),
            }
        )
        write_output_snapshot(args.output, result)

    result["ok"] = bool(all_ok)
    content_packet_paths = [
        str(item.get("packet_path")) for item in result["execution"]["packets"] if item.get("packet_path")
    ]
    resolved_text = collect_resolved_text(content_packet_paths, output_dir / "resolved-text.md")
    result["resolved_text_path"] = resolved_text.get("path")
    result["resolved_text"] = resolved_text
    result["content_packet_paths"] = content_packet_paths
    result["final_packet_path"] = content_packet_paths[0] if len(content_packet_paths) == 1 else None
    if len(content_packet_paths) > 1:
        result["execution"]["skipped"].append(
            {
                "code": "multi_packet_content",
                "reason": "content/backend results were split across multiple packet files; use content_packet_paths instead of a single final packet",
            }
        )
    result["packet_paths"] = [str(diagnosis_path)] + [
        str(item.get("packet_path")) for item in result["execution"]["packets"] if item.get("packet_path")
    ]

    continuation_commands: list[dict[str, Any]] = []
    if not auto_ocr and ocr_pages_all:
        continuation_commands.append(
            continuation_command(
                "ocr",
                args.pdf,
                ocr_pages_all,
                output_dir,
                args,
                reason="OCR pages were recommended but automatic OCR was disabled or capped at zero.",
                ocr_total_max_pages=len(ocr_pages_all),
            )
        )
    elif len(ocr_pages_all) > len(ocr_pages):
        remaining = ocr_pages_all[len(ocr_pages) :]
        continuation_commands.append(
            continuation_command(
                "ocr",
                args.pdf,
                remaining,
                output_dir,
                args,
                reason="OCR pages remain after --ocr-total-max-pages cap.",
                ocr_total_max_pages=len(remaining),
            )
        )

    if args.run_mineru and len(mineru_pages_all) > len(mineru_pages):
        remaining = mineru_pages_all[len(mineru_pages) :]
        continuation_commands.append(
            continuation_command(
                "mineru",
                args.pdf,
                remaining,
                output_dir,
                args,
                reason="MinerU pages remain after --mineru-total-max-pages cap.",
                run_mineru=True,
                mineru_total_max_pages=0,
            )
        )
    elif not args.run_mineru and mineru_pages_all:
        continuation_commands.append(
            continuation_command(
                "mineru",
                args.pdf,
                mineru_pages_all,
                output_dir,
                args,
                reason="MinerU pages were recommended but --run-mineru was not set.",
                run_mineru=True,
                mineru_total_max_pages=0,
            )
        )

    if args.run_vision and len(vision_pages_all) > len(vision_pages):
        remaining = vision_pages_all[len(vision_pages) :]
        continuation_commands.append(
            continuation_command(
                "vision",
                args.pdf,
                remaining,
                output_dir,
                args,
                reason="Vision pages remain after --vision-total-max-pages cap.",
                run_vision=True,
            )
        )
    elif not args.run_vision and vision_pages_all:
        continuation_commands.append(
            continuation_command(
                "vision",
                args.pdf,
                vision_pages_all,
                output_dir,
                args,
                reason="Vision pages were recommended but --run-vision was not set.",
                run_vision=True,
            )
        )

    for batch, packet_item in zip(backend_batches, result["execution"]["packets"]):
        if packet_item.get("ok"):
            continue
        batch_ocr_pages = [page for page in batch if page in ocr_set]
        continuation_commands.append(
            continuation_command(
                "retry",
                args.pdf,
                batch,
                output_dir,
                args,
                reason=f"Batch {packet_item.get('pages')} did not complete successfully.",
                run_mineru=bool(args.run_mineru),
                run_vision=bool(args.run_vision),
                ocr_total_max_pages=len(batch_ocr_pages) if batch_ocr_pages else None,
                mineru_total_max_pages=0 if args.run_mineru else None,
            )
        )

    result["continuation_commands"] = continuation_commands
    expected_pages = set(all_processed)
    completed_pages = set(final_pages)
    skipped_codes = [
        str(item.get("code"))
        for item in result["execution"].get("skipped", [])
        if isinstance(item, dict)
    ]
    coverage_complete = bool(expected_pages) and expected_pages.issubset(completed_pages)
    blocked_codes = [
        code
        for code in skipped_codes
        if code
        in {
            "ocr_capped",
            "ocr_not_run",
            "mineru_capped",
            "mineru_not_run",
            "vision_capped",
            "vision_not_run",
            "partial_unresolved",
        }
    ]
    is_complete = bool(result["ok"]) and coverage_complete and not blocked_codes
    next_action = build_next_action(
        is_complete=is_complete,
        result_ok=bool(result["ok"]),
        continuation_commands=continuation_commands,
        resolved_text_path=str(resolved_text.get("path") or "") or None,
        blocked_codes=blocked_codes,
    )
    result["next_action"] = next_action
    result["reader_brief"] = {
        "status": "complete" if is_complete else "partial",
        "summary_scope": "requested_pages" if is_complete else "processed_pages_only",
        "requested_pages": compact_pages(sorted(expected_pages)),
        "processed_pages": compact_pages(final_pages),
        "pages_expected": len(expected_pages),
        "pages_processed": len(final_pages),
        "pages_with_resolved_text": resolved_text.get("pages_with_text"),
        "chars_available": resolved_text.get("chars_written"),
        "resolved_text_path": resolved_text.get("path"),
        "content_packet_paths": content_packet_paths,
        "blocked_or_capped": blocked_codes,
        "continuation_commands": continuation_commands,
        "next_action": next_action,
        "agent_instruction": (
            "Safe to summarize the requested scope from resolved_text_path."
            if is_complete
            else "Do not present this as a full-document read. Follow reader_brief.next_action before answering."
        ),
    }
    if not result["ok"]:
        result["error"] = {
            "code": "execution_incomplete",
            "message": "One or more content/backend batches did not complete successfully.",
        }
    if args.output:
        write_json(Path(args.output).expanduser().resolve(), result)
    emit(result, 0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
