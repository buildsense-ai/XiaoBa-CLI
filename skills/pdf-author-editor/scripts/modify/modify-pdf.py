from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from overlay_ops import apply_overlay_ops
from page_ops import apply_page_ops


def main() -> int:
    args = parse_args()
    request_path = args.request.resolve()
    request = read_json(request_path)
    base_dir = request_path.parent
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    input_path = resolve_input_path(request, base_dir)
    output_path = resolve_output_path(request, out_dir, args.output)
    operation = choose_operation(request)

    result_path = out_dir / "modify-result.json"
    qa_path = out_dir / "qa.json"
    preview_path = out_dir / "preview-page-1.png"

    try:
        if operation == "overlay":
            if input_path is None:
                raise ValueError("overlay operation requires input.path.")
            operation_result = apply_overlay_ops(request, input_path, output_path)
            pdf_for_qa = output_path
        else:
            operation_result = apply_page_ops(request, input_path, output_path, out_dir)
            pdf_for_qa = Path(operation_result["output"]) if operation_result.get("output") else None

        qa_result = None
        split_qa_results: list[dict[str, str]] = []
        if args.qa and pdf_for_qa and pdf_for_qa.exists():
            qa_result = run_pdf_qa(pdf_for_qa, qa_path, preview_path)
        elif args.qa and operation_result.get("outputs"):
            for index, item in enumerate(operation_result["outputs"], start=1):
                part_pdf = Path(item)
                part_qa = out_dir / f"qa-part-{index}.json"
                part_preview = out_dir / f"preview-part-{index}.png"
                part_qa_result = run_pdf_qa(part_pdf, part_qa, part_preview)
                split_qa_results.append({
                    "pdf": str(part_pdf),
                    "qaPath": str(part_qa),
                    "qa": summarize_pdf_qa(part_qa_result),
                    "preview": str(part_preview),
                })

        result = {
            "ok": True,
            "status": "success",
            "operation": operation,
            "input": str(input_path) if input_path else None,
            "output": str(pdf_for_qa) if pdf_for_qa else None,
            "outputs": operation_result.get("outputs"),
            "result": operation_result,
            "qa": str(qa_path) if qa_result else None,
            "preview": str(preview_path) if qa_result else None,
            "part_checks": split_qa_results,
            "result_path": str(result_path),
        }
        write_json(result_path, result)
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        result = {
            "ok": False,
            "status": "failed",
            "operation": operation,
            "input": str(input_path) if input_path else None,
            "output": str(output_path),
            "error": str(error),
            "result_path": str(result_path),
        }
        write_json(result_path, result)
        print(json.dumps(result, indent=2), file=sys.stderr)
        return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply pdf-author-editor modify operations.")
    parser.add_argument("request", type=Path)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--no-qa", dest="qa", action="store_false")
    parser.set_defaults(qa=True)
    return parser.parse_args()


def choose_operation(request: dict[str, Any]) -> str:
    operation = normalize_action_type(request.get("operation"))
    actions = list(request.get("actions") or [])
    action_types = {normalize_action_type(action.get("type")) for action in actions}
    overlay_types = {"overlay", "watermark", "stamp", "text_stamp", "image_stamp", "page_number", "highlight", "note", "annotation", "cover_box"}
    if operation == "overlay" or action_types & overlay_types:
        return "overlay"
    return "page_ops"


def resolve_input_path(request: dict[str, Any], base_dir: Path) -> Path | None:
    value = request.get("input")
    path_value = None
    if isinstance(value, str):
        path_value = value
    elif isinstance(value, dict):
        path_value = value.get("path")
    if not path_value:
        return None
    path = Path(path_value)
    return path if path.is_absolute() else (base_dir / path).resolve()


def resolve_output_path(request: dict[str, Any], out_dir: Path, arg_output: Path | None) -> Path:
    value = arg_output or request.get("output")
    if value:
        path = Path(value)
        return path if path.is_absolute() else (out_dir / path).resolve()
    return out_dir / "final.pdf"


def run_pdf_qa(pdf_path: Path, qa_path: Path, preview_path: Path) -> dict[str, Any]:
    script_path = Path(__file__).resolve().parents[1] / "author" / "qa-pdf.py"
    command = [
        sys.executable,
        str(script_path),
        str(pdf_path),
        "--out",
        str(qa_path),
        "--preview",
        str(preview_path),
    ]
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"qa-pdf failed with {result.returncode}")
    return read_json(qa_path)


def summarize_pdf_qa(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": value.get("ok"),
        "page_count": value.get("page_count"),
        "errors": value.get("errors") or [],
        "warnings": value.get("warnings") or [],
        "blank_pages": value.get("blank_pages") or [],
    }


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")


def normalize_action_type(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_")


if __name__ == "__main__":
    raise SystemExit(main())
