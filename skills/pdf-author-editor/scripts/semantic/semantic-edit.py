from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    import fitz
except Exception as exc:  # pragma: no cover
    print(f"PyMuPDF is required for semantic-edit.py: {exc}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    args = parse_args()
    request_path = args.request.resolve()
    edit_plan_path = args.edit_plan.resolve()
    request = read_json(request_path)
    edit_plan = read_json(edit_plan_path)
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    result_path = out_dir / "semantic-result.json"
    route = normalize_route(edit_plan.get("recommended_route") or request.get("operation"))

    try:
        if route == "blocked":
            result = blocked_result("semantic_route_blocked", result_path)
        elif route == "rebuild":
            result = prepare_rebuild(request, edit_plan, out_dir, result_path)
        elif route in {"short_text_edit", "overlay_edit"}:
            output_path = resolve_output_path(request, out_dir, args.output)
            result = apply_visible_text_edits(request, edit_plan, route, request_path, output_path, out_dir, result_path, args.qa)
        else:
            result = blocked_result(f"unsupported_semantic_route:{route}", result_path)

        write_json(result_path, result)
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        result = {
            "ok": False,
            "status": "failed",
            "operation": route,
            "error": str(error),
            "result_path": str(result_path),
        }
        write_json(result_path, result)
        print(json.dumps(result, indent=2), file=sys.stderr)
        return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Execute planned semantic PDF edits.")
    parser.add_argument("request", type=Path)
    parser.add_argument("edit_plan", type=Path)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--no-qa", dest="qa", action="store_false")
    parser.set_defaults(qa=True)
    return parser.parse_args()


def prepare_rebuild(request: dict[str, Any], edit_plan: dict[str, Any], out_dir: Path, result_path: Path) -> dict[str, Any]:
    content = explicit_author_content(request)
    if content is None:
        content = rebuild_content_from_read_pdf(request, edit_plan)
    if content is None:
        return blocked_result("rebuild_content_missing", result_path)

    rebuild_source = out_dir / "rebuild-content.json"
    verification_path = out_dir / "semantic-verification.json"
    verification = verify_rebuild_content(content, edit_plan)
    write_json(rebuild_source, content)
    write_json(verification_path, verification)
    return {
        "ok": True,
        "status": "rebuild_ready",
        "operation": "rebuild",
        "output": None,
        "rebuild_source": str(rebuild_source),
        "verification": str(verification_path),
        "verification_summary": summarize_semantic_verification(verification),
        "result_path": str(result_path),
    }


def explicit_author_content(request: dict[str, Any]) -> dict[str, Any] | None:
    for key in ("revised_content", "structured_content", "content_document"):
        value = request.get(key)
        if isinstance(value, dict):
            return normalize_author_document(value, request)

    value = request.get("content")
    if isinstance(value, dict):
        return normalize_author_document(value, request)
    if isinstance(value, list):
        return normalize_author_document({"content": value}, request)
    return None


def rebuild_content_from_read_pdf(request: dict[str, Any], edit_plan: dict[str, Any]) -> dict[str, Any] | None:
    read_pdf = request.get("read_pdf_result")
    if not isinstance(read_pdf, dict):
        return None
    pages = read_pdf.get("pages")
    if not isinstance(pages, list) or not pages:
        return None

    changes = list(edit_plan.get("changes") or [])
    blocks: list[dict[str, Any]] = [
        {
            "type": "callout",
            "tone": "info",
            "title": "Rebuilt from extracted PDF text",
            "text": "The layout is regenerated from structured text. Existing PDF internals are not reused.",
        }
    ]

    for page in pages:
        page_number = page.get("page")
        text = str(page.get("text") or "").strip()
        if not text:
            continue
        revised = apply_text_replacements(text, changes)
        blocks.append({"type": "heading", "level": 2, "text": f"Page {page_number}"})
        blocks.append({"type": "paragraph", "text": revised})

    if len(blocks) == 1:
        return None

    return normalize_author_document({"content": blocks}, request)


def normalize_author_document(value: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    if value.get("delivery_type") and value.get("meta") and value.get("content"):
        return value

    meta = dict(value.get("meta") or request.get("meta") or {})
    if not meta.get("title"):
        meta["title"] = request.get("title") or request.get("options", {}).get("title") or "Revised PDF"

    return {
        "schema_version": value.get("schema_version", 1),
        "delivery_type": value.get("delivery_type") or request.get("delivery_type") or request.get("options", {}).get("delivery_type") or "report",
        "meta": meta,
        "page": value.get("page") or request.get("page") or {"size": "A4", "orientation": "portrait", "margins": "normal"},
        "content": value.get("content") or [],
        "export": value.get("export") or {"html": True, "pdf": True},
    }


def apply_text_replacements(text: str, changes: list[dict[str, Any]]) -> str:
    revised = text
    for change in changes:
        target = change.get("target_text")
        replacement = change.get("replacement_text")
        if target and replacement:
            revised = revised.replace(str(target), str(replacement))
    return revised


def apply_visible_text_edits(
    request: dict[str, Any],
    edit_plan: dict[str, Any],
    route: str,
    request_path: Path,
    output_path: Path,
    out_dir: Path,
    result_path: Path,
    qa: bool,
) -> dict[str, Any]:
    source_pdf = resolve_source_pdf(request, edit_plan, request_path)
    if source_pdf is None:
        return blocked_result("source_pdf_missing", result_path)
    if not source_pdf.exists():
        return blocked_result(f"source_pdf_not_found:{source_pdf}", result_path)
    if source_pdf.resolve() == output_path.resolve():
        raise ValueError("Output PDF must not overwrite the input PDF.")

    changes = list(edit_plan.get("changes") or [])
    if not changes:
        return blocked_result("semantic_changes_missing", result_path)

    doc = fitz.open(str(source_pdf))
    applied: list[dict[str, Any]] = []
    visual_dir = out_dir / "semantic-visual"
    visual_regions: list[dict[str, Any]] = []
    page_previews: dict[int, dict[str, Any]] = {}
    modified_pages: set[int] = set()
    try:
        for change in changes:
            matches = locate_change_matches(doc, change)
            if isinstance(matches, dict):
                doc.close()
                return blocked_result(matches["reason"], result_path)
            for match in matches:
                page = doc[match["page"] - 1]
                replacement = str(change.get("replacement_text") or "")
                rect = match["rect"]
                page_number = int(match["page"])
                if page_number not in page_previews:
                    before_page_path = visual_dir / f"page-{page_number}-before.png"
                    page_previews[page_number] = {
                        "page": page_number,
                        "before": render_page(page, before_page_path),
                    }

                visual_id = safe_file_part(f"{change.get('id') or 'change'}-p{page_number}-occ{match.get('occurrence') or 1}")
                clip = visual_clip_for_change(page, rect, replacement, change, route)
                before_region_path = visual_dir / f"{visual_id}-before.png"
                after_region_path = visual_dir / f"{visual_id}-after.png"
                before_region, before_pix = render_clip(page, clip, before_region_path)
                draw_visible_replacement(page, rect, replacement, change, route)
                after_region, after_pix = render_clip(page, clip, after_region_path)
                diff = compare_pixmaps(before_pix, after_pix)
                visual_region = {
                    "id": change.get("id"),
                    "page": page_number,
                    "occurrence": match.get("occurrence"),
                    "match_method": match.get("method"),
                    "clip": [round(clip.x0, 2), round(clip.y0, 2), round(clip.x1, 2), round(clip.y1, 2)],
                    "before": before_region,
                    "after": after_region,
                    "diff": diff,
                }
                visual_regions.append(visual_region)
                modified_pages.add(page_number)
                applied.append({
                    "id": change.get("id"),
                    "page": page_number,
                    "occurrence": match.get("occurrence"),
                    "match_method": match.get("method"),
                    "target_text": change.get("target_text"),
                    "replacement_text": replacement,
                    "rect": [round(rect.x0, 2), round(rect.y0, 2), round(rect.x1, 2), round(rect.y1, 2)],
                    "strategy": route,
                    "visual": visual_region,
                })

        output_path.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(output_path), garbage=4, deflate=True)
        for page_number in sorted(modified_pages):
            after_page_path = visual_dir / f"page-{page_number}-after.png"
            page_previews[page_number]["after"] = render_page(doc[page_number - 1], after_page_path)
    finally:
        if not doc.is_closed:
            doc.close()

    qa_result = None
    qa_path = out_dir / "qa.json"
    preview_path = out_dir / "preview-page-1.png"
    if qa:
        qa_result = run_pdf_qa(output_path, qa_path, preview_path)

    verification_path = out_dir / "semantic-verification.json"
    verification = verify_visible_edits(output_path, edit_plan, applied)
    write_json(verification_path, verification)

    visual_diff_path = out_dir / "semantic-visual-diff.json"
    visual_diff = {
        "ok": True,
        "mode": "semantic_visible_edit",
        "pages": [page_previews[page] for page in sorted(page_previews)],
        "regions": visual_regions,
        "summary": summarize_visual_diff(visual_regions),
    }
    write_json(visual_diff_path, visual_diff)

    return {
        "ok": True,
        "status": "success",
        "operation": route,
        "input": str(source_pdf),
        "output": str(output_path),
        "applied_changes": applied,
        "qa": str(qa_path) if qa_result else None,
        "qa_summary": summarize_pdf_qa(qa_result) if qa_result else None,
        "preview": str(preview_path) if qa_result else None,
        "verification": str(verification_path),
        "verification_summary": summarize_semantic_verification(verification),
        "visual_diff": str(visual_diff_path),
        "visual_diff_summary": visual_diff["summary"],
        "result_path": str(result_path),
    }


def locate_change_matches(doc: fitz.Document, change: dict[str, Any]) -> list[dict[str, Any]] | dict[str, str]:
    target = str(change.get("target_text") or "")
    if not target:
        return {"reason": f"target_text_missing:{change.get('id') or ''}"}

    pages = parse_pages(change.get("pages") or "all", doc.page_count)
    rect_match = explicit_rect_match(change, pages)
    if rect_match:
        return [rect_match]

    matches: list[dict[str, Any]] = []
    match_mode = str(change.get("match_mode") or "auto").strip().lower()
    for page_number in pages:
        page = doc[page_number - 1]
        page_matches: list[dict[str, Any]] = []
        if match_mode in {"auto", "exact"}:
            for rect in page.search_for(target):
                page_matches.append({"page": page_number, "rect": rect, "method": "exact"})
        if not page_matches and match_mode in {"auto", "normalized", "normalized_words"}:
            page_matches.extend(normalized_word_matches(page, page_number, target))
        matches.extend(page_matches)

    if not matches:
        return {"reason": f"target_text_not_found:{change.get('id') or target[:40]}"}
    selected = select_matches(matches, change)
    if isinstance(selected, dict):
        return selected
    return selected


def explicit_rect_match(change: dict[str, Any], pages: list[int]) -> dict[str, Any] | None:
    rect_value = change.get("rect")
    if not (isinstance(rect_value, list) and len(rect_value) == 4):
        return None
    page_number = int(change.get("page") or (pages[0] if pages else 1))
    return {
        "page": page_number,
        "rect": fitz.Rect(*[float(part) for part in rect_value]),
        "method": "explicit_rect",
        "occurrence": 1,
    }


def normalized_word_matches(page: fitz.Page, page_number: int, target: str) -> list[dict[str, Any]]:
    words = page.get_text("words", sort=True)
    if not words:
        return []

    text_parts: list[str] = []
    spans: list[tuple[int, int, fitz.Rect]] = []
    cursor = 0
    for word in words:
        token = str(word[4]).strip()
        if not token:
            continue
        if text_parts:
            text_parts.append(" ")
            cursor += 1
        start = cursor
        text_parts.append(token)
        cursor += len(token)
        spans.append((start, cursor, fitz.Rect(word[0], word[1], word[2], word[3])))

    page_text = "".join(text_parts)
    needle = normalize_space(target)
    if not needle:
        return []

    matches: list[dict[str, Any]] = []
    start_at = 0
    while True:
        index = page_text.find(needle, start_at)
        if index < 0:
            break
        end = index + len(needle)
        rects = [rect for span_start, span_end, rect in spans if span_start < end and span_end > index]
        if rects:
            matches.append({
                "page": page_number,
                "rect": union_rects(rects),
                "method": "normalized_words",
            })
        start_at = index + 1
    return matches


def select_matches(matches: list[dict[str, Any]], change: dict[str, Any]) -> list[dict[str, Any]] | dict[str, str]:
    occurrence = change.get("occurrence", change.get("match_index"))
    if isinstance(occurrence, str) and occurrence.strip().lower() == "all":
        return annotate_occurrences(matches)
    if occurrence is not None:
        try:
            index = int(occurrence)
        except Exception:
            return {"reason": f"invalid_occurrence:{change.get('id') or occurrence}"}
        if index < 1 or index > len(matches):
            return {"reason": f"occurrence_out_of_range:{change.get('id') or index}:{len(matches)}"}
        return annotate_occurrences([matches[index - 1]], start=index)
    if bool(change.get("allow_multiple")):
        return annotate_occurrences(matches)
    if len(matches) > 1:
        target = str(change.get("target_text") or "")
        return {"reason": f"target_text_not_unique:{change.get('id') or target[:40]}:{len(matches)}"}
    return annotate_occurrences(matches)


def annotate_occurrences(matches: list[dict[str, Any]], start: int = 1) -> list[dict[str, Any]]:
    return [{**match, "occurrence": start + offset} for offset, match in enumerate(matches)]


def draw_visible_replacement(page: fitz.Page, rect: fitz.Rect, text: str, change: dict[str, Any], route: str) -> None:
    font_size = float(change.get("font_size") or estimate_font_size(rect))
    color = parse_color(change.get("color"), default=(0, 0, 0))
    fill = parse_color(change.get("fill"), default=(1, 1, 1))
    margin = float(change.get("padding", 1.5))

    cover = fitz.Rect(rect.x0 - margin, rect.y0 - margin, rect.x1 + margin, rect.y1 + margin)
    cover = constrain_rect(cover, page.rect)
    page.draw_rect(cover, color=None, fill=fill, overlay=True)

    if route == "overlay_edit":
        insert_rect = expanded_text_box(page.rect, rect, text, font_size, min_height=max(rect.height + 6, font_size * 2.2))
        border_value = change.get("border_color")
        border_width = float(change.get("border_width") or (0.6 if border_value else 0))
        if border_width > 0:
            border = parse_color(border_value, default=(0.25, 0.42, 0.75))
            page.draw_rect(insert_rect, color=border, fill=fill, width=border_width, overlay=True)
        else:
            page.draw_rect(insert_rect, color=None, fill=fill, overlay=True)
        insert_rect = insert_rect + (4, 3, -4, -3)
    else:
        insert_rect = expanded_text_box(page.rect, rect, text, font_size, min_height=max(rect.height + 4, font_size * 1.4))

    insert_textbox(page, insert_rect, text, font_size, color)


def visual_clip_for_change(page: fitz.Page, rect: fitz.Rect, text: str, change: dict[str, Any], route: str) -> fitz.Rect:
    font_size = float(change.get("font_size") or estimate_font_size(rect))
    if route == "overlay_edit":
        insert_rect = expanded_text_box(page.rect, rect, text, font_size, min_height=max(rect.height + 6, font_size * 2.2))
    else:
        insert_rect = expanded_text_box(page.rect, rect, text, font_size, min_height=max(rect.height + 4, font_size * 1.4))
    return expanded_clip(page.rect, union_rects([rect, insert_rect]), padding=18)


def expanded_text_box(page_rect: fitz.Rect, anchor: fitz.Rect, text: str, font_size: float, min_height: float) -> fitz.Rect:
    text_width = estimate_text_width(text, font_size)
    width = max(anchor.width + 6, text_width + 8)
    width = min(width, page_rect.x1 - anchor.x0 - 18)
    height = max(min_height, font_size * (1.4 + max(0, text_width / max(width, 1) - 1) * 1.2))
    height = min(height, page_rect.y1 - anchor.y0 - 18)
    rect = fitz.Rect(anchor.x0 - 1, anchor.y0 - 2, anchor.x0 + width, anchor.y0 + height)
    return constrain_rect(rect, page_rect)


def insert_textbox(page: fitz.Page, rect: fitz.Rect, text: str, font_size: float, color: tuple[float, float, float]) -> None:
    kwargs = {
        "fontsize": font_size,
        "fontname": "helv",
        "color": color,
        "align": fitz.TEXT_ALIGN_LEFT,
        "overlay": True,
    }
    result = page.insert_textbox(rect, text, **kwargs)
    if isinstance(result, (int, float)) and result < 0:
        smaller = max(5, font_size - 1.5)
        page.insert_textbox(rect, text, fontsize=smaller, fontname="helv", color=color, align=fitz.TEXT_ALIGN_LEFT, overlay=True)


def estimate_font_size(rect: fitz.Rect) -> float:
    return min(14, max(6, rect.height * 0.68))


def estimate_text_width(text: str, font_size: float) -> float:
    try:
        return fitz.get_text_length(text, fontname="helv", fontsize=font_size)
    except Exception:
        return len(text) * font_size * 0.52


def constrain_rect(rect: fitz.Rect, page_rect: fitz.Rect) -> fitz.Rect:
    return fitz.Rect(
        max(page_rect.x0, rect.x0),
        max(page_rect.y0, rect.y0),
        min(page_rect.x1, rect.x1),
        min(page_rect.y1, rect.y1),
    )


def expanded_clip(page_rect: fitz.Rect, rect: fitz.Rect, padding: float) -> fitz.Rect:
    return constrain_rect(
        fitz.Rect(rect.x0 - padding, rect.y0 - padding, rect.x1 + padding, rect.y1 + padding),
        page_rect,
    )


def render_page(page: fitz.Page, output_path: Path, zoom: float = 1.5) -> dict[str, Any]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    pix.save(str(output_path))
    return {
        "path": str(output_path),
        "width_px": pix.width,
        "height_px": pix.height,
    }


def render_clip(page: fitz.Page, clip: fitz.Rect, output_path: Path, zoom: float = 3.0) -> tuple[dict[str, Any], fitz.Pixmap]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)
    pix.save(str(output_path))
    return {
        "path": str(output_path),
        "width_px": pix.width,
        "height_px": pix.height,
    }, pix


def compare_pixmaps(before: fitz.Pixmap, after: fitz.Pixmap) -> dict[str, Any]:
    if before.width != after.width or before.height != after.height or before.n != after.n:
        return {
            "comparable": False,
            "changed_pixel_ratio": None,
            "mean_abs_delta": None,
            "reason": "pixmap_shape_mismatch",
        }

    before_samples = before.samples
    after_samples = after.samples
    channels = before.n
    color_channels = min(channels, 3)
    pixels = max(1, before.width * before.height)
    changed = 0
    total_delta = 0.0

    for index in range(0, len(before_samples), channels):
        pixel_delta = 0
        for channel in range(color_channels):
            pixel_delta += abs(before_samples[index + channel] - after_samples[index + channel])
        mean_delta = pixel_delta / color_channels
        total_delta += mean_delta
        if mean_delta > 8:
            changed += 1

    return {
        "comparable": True,
        "changed_pixel_ratio": round(changed / pixels, 6),
        "mean_abs_delta": round(total_delta / pixels, 4),
    }


def summarize_visual_diff(regions: list[dict[str, Any]]) -> dict[str, Any]:
    comparable = [region.get("diff", {}) for region in regions if region.get("diff", {}).get("comparable")]
    changed_ratios = [float(item.get("changed_pixel_ratio") or 0) for item in comparable]
    return {
        "region_count": len(regions),
        "max_changed_pixel_ratio": round(max(changed_ratios), 6) if changed_ratios else None,
        "regions_with_change": sum(1 for ratio in changed_ratios if ratio > 0),
    }


def union_rects(rects: list[fitz.Rect]) -> fitz.Rect:
    result = fitz.Rect(rects[0])
    for rect in rects[1:]:
        result |= rect
    return result


def normalize_space(value: Any) -> str:
    return " ".join(str(value or "").split())


def safe_file_part(value: Any) -> str:
    text = str(value or "item")
    cleaned = "".join(char if char.isalnum() or char in {"-", "_", "."} else "-" for char in text)
    cleaned = cleaned.strip("-._")
    return cleaned[:80] or "item"


def resolve_source_pdf(request: dict[str, Any], edit_plan: dict[str, Any], request_path: Path) -> Path | None:
    value = edit_plan.get("source_pdf") or request.get("read_pdf_result", {}).get("source_pdf")
    if not value and request.get("input", {}).get("type") == "pdf":
        value = request.get("input", {}).get("path")
    if not value:
        return None

    candidate = Path(str(value))
    if candidate.is_absolute():
        return candidate

    bases = []
    input_path = request.get("input", {}).get("path")
    if input_path:
        bases.append(Path(str(input_path)).parent)
    bases.extend([Path.cwd(), request_path.parent])

    for base in bases:
        resolved = (base / candidate).resolve()
        if resolved.exists():
            return resolved
    return (bases[0] / candidate).resolve() if bases else candidate.resolve()


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


def summarize_pdf_qa(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {
        "ok": value.get("ok"),
        "page_count": value.get("page_count"),
        "errors": value.get("errors") or [],
        "warnings": value.get("warnings") or [],
        "blank_pages": value.get("blank_pages") or [],
    }


def verify_visible_edits(pdf_path: Path, edit_plan: dict[str, Any], applied: list[dict[str, Any]]) -> dict[str, Any]:
    doc = fitz.open(str(pdf_path))
    try:
        text_by_page = {index + 1: normalize_space(page.get_text("text")) for index, page in enumerate(doc)}
    finally:
        doc.close()

    changes = list(edit_plan.get("changes") or [])
    checks = []
    for change in changes:
        change_id = change.get("id")
        replacement = normalize_space(change.get("replacement_text"))
        target = normalize_space(change.get("target_text"))
        applied_items = [item for item in applied if item.get("id") == change_id]
        pages = sorted({int(item["page"]) for item in applied_items if item.get("page")})
        page_text = " ".join(text_by_page.get(page, "") for page in pages) if pages else " ".join(text_by_page.values())
        replacement_present = bool(replacement and replacement in page_text)
        target_extractable = bool(target and target in page_text)
        checks.append({
            "id": change_id,
            "pages": pages,
            "applied_count": len(applied_items),
            "replacement_present": replacement_present,
            "target_extractable": target_extractable,
            "match_methods": sorted({str(item.get("match_method")) for item in applied_items if item.get("match_method")}),
        })

    errors = []
    warnings = []
    for check in checks:
        if check["applied_count"] < 1:
            errors.append(f"change_not_applied:{check['id']}")
        if not check["replacement_present"]:
            errors.append(f"replacement_not_extractable:{check['id']}")
        if check["target_extractable"]:
            warnings.append(f"target_still_extractable:{check['id']}")

    return {
        "ok": not errors,
        "mode": "semantic_visible_edit",
        "checks": checks,
        "errors": errors,
        "warnings": warnings,
    }


def verify_rebuild_content(content: dict[str, Any], edit_plan: dict[str, Any]) -> dict[str, Any]:
    content_text = normalize_space(collect_text(content))
    checks = []
    for change in list(edit_plan.get("changes") or []):
        replacement = normalize_space(change.get("replacement_text"))
        target = normalize_space(change.get("target_text"))
        checks.append({
            "id": change.get("id"),
            "replacement_present": bool(replacement and replacement in content_text),
            "target_present": bool(target and target in content_text),
        })

    errors = [f"replacement_missing:{check['id']}" for check in checks if not check["replacement_present"]]
    warnings = [f"target_still_present:{check['id']}" for check in checks if check["target_present"]]
    return {
        "ok": not errors,
        "mode": "semantic_rebuild_content",
        "checks": checks,
        "errors": errors,
        "warnings": warnings,
    }


def summarize_semantic_verification(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {
        "ok": value.get("ok"),
        "mode": value.get("mode"),
        "errors": value.get("errors") or [],
        "warnings": value.get("warnings") or [],
    }


def collect_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(collect_text(item) for item in value)
    if isinstance(value, dict):
        return " ".join(collect_text(item) for item in value.values())
    return str(value)


def blocked_result(reason: str, result_path: Path) -> dict[str, Any]:
    return {
        "ok": False,
        "status": "blocked",
        "operation": "semantic",
        "reason": reason,
        "result_path": str(result_path),
    }


def parse_pages(value: Any, total_pages: int) -> list[int]:
    if value is None or value == "all":
        return list(range(1, total_pages + 1))
    if isinstance(value, int):
        pages = [value]
    elif isinstance(value, list):
        pages = [int(item) for item in value]
    elif isinstance(value, str):
        pages = []
        for part in value.split(","):
            token = part.strip()
            if not token:
                continue
            if "-" in token:
                start_text, end_text = token.split("-", 1)
                start = int(start_text)
                end = int(end_text)
                step = 1 if start <= end else -1
                pages.extend(range(start, end + step, step))
            else:
                pages.append(int(token))
    else:
        raise ValueError(f"Unsupported pages value: {value!r}")
    for page in pages:
        if page < 1 or page > total_pages:
            raise ValueError(f"Page out of range: {page} (total {total_pages})")
    return pages


def parse_color(value: Any, default: tuple[float, float, float]) -> tuple[float, float, float]:
    if value is None:
        return default
    if isinstance(value, str):
        text = value.strip().lower()
        named = {
            "black": (0, 0, 0),
            "white": (1, 1, 1),
            "red": (0.85, 0.05, 0.05),
            "blue": (0.05, 0.2, 0.8),
            "gray": (0.5, 0.5, 0.5),
            "grey": (0.5, 0.5, 0.5),
            "yellow": (1, 0.9, 0.2),
        }
        if text in named:
            return named[text]
        if text.startswith("#") and len(text) == 7:
            return tuple(int(text[i : i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]
    if isinstance(value, list) and len(value) == 3:
        parts = [float(part) for part in value]
        if any(part > 1 for part in parts):
            parts = [part / 255 for part in parts]
        return (parts[0], parts[1], parts[2])
    return default


def normalize_route(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_") or "blocked"


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
