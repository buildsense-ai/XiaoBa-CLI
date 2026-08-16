#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

try:
    import fitz  # PyMuPDF
except Exception as exc:  # pragma: no cover
    print(f"PyMuPDF is required for qa-pdf.py: {exc}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run basic QA on a PDF and optionally render the first page.")
    parser.add_argument("pdf")
    parser.add_argument("--out", "-o")
    parser.add_argument("--preview")
    parser.add_argument("--expect-type", choices=["report", "one-pager", "slides"])
    parser.add_argument("--expect-pages", type=int)
    args = parser.parse_args()

    pdf_path = Path(args.pdf).resolve()
    if not pdf_path.exists():
        fail(f"PDF not found: {pdf_path}")

    out_path = Path(args.out).resolve() if args.out else pdf_path.with_suffix(".pdf-qa.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    pages = []
    blank_pages = []
    for index, page in enumerate(doc):
        text = page.get_text("text").strip()
        rect = page.rect
        sample = render_sample(page)
        blank = len(text) == 0 and sample["dark_pixel_ratio"] < 0.002
        if blank:
            blank_pages.append(index + 1)
        pages.append(
            {
                "page": index + 1,
                "width_pt": round(rect.width, 2),
                "height_pt": round(rect.height, 2),
                "text_chars": len(text),
                "dark_pixel_ratio": sample["dark_pixel_ratio"],
                "blank": blank,
            }
        )

    preview_path = None
    if args.preview and doc.page_count:
        preview_path = str(Path(args.preview).resolve())
        Path(preview_path).parent.mkdir(parents=True, exist_ok=True)
        pix = doc[0].get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
        pix.save(preview_path)

    errors = []
    if doc.page_count <= 0:
        errors.append("empty_pdf")
    if blank_pages:
        errors.append("blank_pages")
    expected_pages = args.expect_pages
    if expected_pages is None and args.expect_type == "one-pager":
        expected_pages = 1
    if expected_pages is not None and doc.page_count != expected_pages:
        errors.append("page_count_mismatch")
    dimension_warning = page_dimension_warning(args.expect_type, pages)
    warnings = [dimension_warning] if dimension_warning else []

    result = {
        "ok": not errors,
        "input": str(pdf_path),
        "page_count": doc.page_count,
        "expected_pages": expected_pages,
        "expect_type": args.expect_type,
        "errors": errors,
        "warnings": warnings,
        "blank_pages": blank_pages,
        "pages": pages,
        "preview": preview_path,
    }
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"ok": result["ok"], "output": str(out_path), "page_count": doc.page_count, "expected_pages": expected_pages, "errors": errors, "warnings": warnings}, indent=2))
    return 0 if result["ok"] else 1


def render_sample(page: fitz.Page) -> dict[str, float]:
    pix = page.get_pixmap(matrix=fitz.Matrix(0.25, 0.25), alpha=False)
    samples = pix.samples
    if not samples:
        return {"dark_pixel_ratio": 0.0}
    channels = pix.n
    pixels = len(samples) // channels
    dark = 0
    for i in range(0, len(samples), channels):
        r = samples[i]
        g = samples[i + 1] if channels > 1 else r
        b = samples[i + 2] if channels > 2 else r
        if (r + g + b) / 3 < 245:
            dark += 1
    return {"dark_pixel_ratio": round(dark / max(1, pixels), 6)}


def page_dimension_warning(expect_type: str | None, pages: list[dict[str, object]]) -> str | None:
    if not expect_type or not pages:
        return None
    first = pages[0]
    width = float(first["width_pt"])
    height = float(first["height_pt"])
    ratio = width / height if height else 0
    if expect_type == "slides" and abs(ratio - (16 / 9)) > 0.04:
        return f"slides page ratio is {ratio:.3f}, expected about 1.778"
    if expect_type in {"report", "one-pager"} and not (0.68 < ratio < 0.82):
        return f"{expect_type} page ratio is {ratio:.3f}, expected portrait A4/Letter-like page"
    return None


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    raise SystemExit(main())
