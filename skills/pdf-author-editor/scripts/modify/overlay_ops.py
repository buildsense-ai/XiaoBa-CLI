from __future__ import annotations

from pathlib import Path
from typing import Any

import fitz


OVERLAY_OPS = {
    "watermark",
    "stamp",
    "text_stamp",
    "image_stamp",
    "page_number",
    "highlight",
    "note",
    "annotation",
    "cover_box",
}


def apply_overlay_ops(request: dict[str, Any], input_path: Path, output_path: Path) -> dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"Input PDF not found: {input_path}")
    if input_path.resolve() == output_path.resolve():
        raise ValueError("Output PDF must not overwrite the input PDF.")

    actions = list(request.get("actions") or [])
    operation = str(request.get("operation") or "").strip()
    if operation and not actions and operation in OVERLAY_OPS:
        actions = [{"type": operation, **request}]
    if not actions:
        raise ValueError("overlay operation requires actions.")

    doc = fitz.open(str(input_path))
    total_pages = len(doc)
    applied: list[dict[str, Any]] = []
    try:
        for action in actions:
            action_type = normalize_action_type(action.get("type"))
            pages = parse_pages(action.get("pages", "all"), len(doc))
            for page_number in pages:
                page = doc[page_number - 1]
                if action_type == "watermark":
                    draw_watermark(page, action)
                elif action_type in {"stamp", "text_stamp"}:
                    draw_text_stamp(page, action)
                elif action_type == "image_stamp":
                    draw_image_stamp(page, action, input_path)
                elif action_type == "page_number":
                    draw_page_number(page, page_number, len(doc), action)
                elif action_type == "highlight":
                    draw_highlight(page, action)
                elif action_type in {"note", "annotation"}:
                    draw_note(page, action)
                elif action_type == "cover_box":
                    draw_cover_box(page, action)
                else:
                    raise ValueError(f"Unsupported overlay operation: {action_type or action.get('type')}")
            applied.append({"type": action_type, "pages": pages})

        output_path.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(output_path))
    finally:
        doc.close()

    return {
        "operation": "overlay",
        "input": str(input_path),
        "output": str(output_path),
        "page_count_after": total_pages,
        "applied": applied,
        "actions": actions,
    }


def draw_watermark(page: fitz.Page, action: dict[str, Any]) -> None:
    text = str(action.get("text") or "WATERMARK")
    rect = page.rect
    font_size = float(action.get("font_size") or action.get("fontsize") or 42)
    color = parse_color(action.get("color"), default=(0.65, 0.65, 0.65))
    opacity = float(action.get("opacity", 0.18))
    box = fitz.Rect(rect.x0 + 40, rect.y0 + rect.height * 0.42, rect.x1 - 40, rect.y0 + rect.height * 0.58)
    insert_textbox(page, box, text, font_size, color, align=fitz.TEXT_ALIGN_CENTER, opacity=opacity)


def draw_text_stamp(page: fitz.Page, action: dict[str, Any]) -> None:
    text = str(action.get("text") or action.get("label") or "STAMP")
    font_size = float(action.get("font_size") or action.get("fontsize") or 18)
    color = parse_color(action.get("color"), default=(0.8, 0.05, 0.05))
    rect = rect_for_position(page.rect, action.get("position", "top-right"), float(action.get("width", 160)), float(action.get("height", 42)))
    border = parse_color(action.get("border_color"), default=color)
    page.draw_rect(rect, color=border, width=1.2, overlay=True)
    insert_textbox(page, rect, text, font_size, color, align=fitz.TEXT_ALIGN_CENTER, opacity=float(action.get("opacity", 1)))


def draw_image_stamp(page: fitz.Page, action: dict[str, Any], input_path: Path) -> None:
    image = action.get("image") or action.get("src") or action.get("path")
    if not image:
        raise ValueError("image_stamp requires image/src/path.")
    image_path = Path(image)
    if not image_path.is_absolute():
        image_path = input_path.parent / image_path
    if not image_path.exists():
        raise FileNotFoundError(f"Stamp image not found: {image_path}")
    rect = rect_for_position(page.rect, action.get("position", "top-right"), float(action.get("width", 120)), float(action.get("height", 60)))
    page.insert_image(rect, filename=str(image_path), overlay=True)


def draw_page_number(page: fitz.Page, page_number: int, total: int, action: dict[str, Any]) -> None:
    text = str(action.get("format") or "{page} / {total}").replace("{page}", str(page_number)).replace("{total}", str(total))
    font_size = float(action.get("font_size") or action.get("fontsize") or 9)
    color = parse_color(action.get("color"), default=(0.25, 0.25, 0.25))
    rect = rect_for_position(page.rect, action.get("position", "bottom-center"), float(action.get("width", 120)), float(action.get("height", 18)))
    insert_textbox(page, rect, text, font_size, color, align=fitz.TEXT_ALIGN_CENTER, opacity=float(action.get("opacity", 1)))


def draw_highlight(page: fitz.Page, action: dict[str, Any]) -> None:
    color = parse_color(action.get("color"), default=(1, 0.9, 0.2))
    opacity = float(action.get("opacity", 0.35))
    rects = locate_rects(page, action)
    if not rects:
        raise ValueError("highlight requires rect, target_text, target, or text.")
    for rect in rects:
        page.draw_rect(rect, color=None, fill=color, fill_opacity=opacity, overlay=True)


def draw_note(page: fitz.Page, action: dict[str, Any]) -> None:
    text = str(action.get("text") or action.get("note") or "")
    if not text:
        raise ValueError("note requires text.")
    rect = action_rect(action) or rect_for_position(page.rect, action.get("position", "right"), float(action.get("width", 180)), float(action.get("height", 72)))
    fill = parse_color(action.get("fill"), default=(1, 0.98, 0.82))
    border = parse_color(action.get("border_color"), default=(0.8, 0.65, 0.25))
    page.draw_rect(rect, color=border, fill=fill, width=1, overlay=True)
    insert_textbox(page, rect + (6, 6, -6, -6), text, float(action.get("font_size", 9)), parse_color(action.get("color"), default=(0.1, 0.1, 0.1)), align=fitz.TEXT_ALIGN_LEFT)


def draw_cover_box(page: fitz.Page, action: dict[str, Any]) -> None:
    rects = locate_rects(page, action)
    if not rects:
        raise ValueError("cover_box requires rect, target_text, target, or text.")
    fill = parse_color(action.get("fill") or action.get("color"), default=(1, 1, 1))
    for rect in rects:
        page.draw_rect(rect, color=None, fill=fill, overlay=True)


def locate_rects(page: fitz.Page, action: dict[str, Any]) -> list[fitz.Rect]:
    rect = action_rect(action)
    if rect:
        return [rect]
    target = action.get("target_text") or action.get("target") or action.get("text")
    if target:
        return list(page.search_for(str(target)))
    return []


def action_rect(action: dict[str, Any]) -> fitz.Rect | None:
    value = action.get("rect")
    if isinstance(value, list) and len(value) == 4:
        return fitz.Rect(*[float(part) for part in value])
    return None


def rect_for_position(page_rect: fitz.Rect, position: Any, width: float, height: float) -> fitz.Rect:
    margin = 24
    pos = str(position or "top-right").lower()
    if pos == "center":
        x0 = page_rect.x0 + (page_rect.width - width) / 2
        y0 = page_rect.y0 + (page_rect.height - height) / 2
    elif pos in {"bottom-center", "bottom"}:
        x0 = page_rect.x0 + (page_rect.width - width) / 2
        y0 = page_rect.y1 - margin - height
    elif pos in {"top-center", "top"}:
        x0 = page_rect.x0 + (page_rect.width - width) / 2
        y0 = page_rect.y0 + margin
    elif pos == "bottom-left":
        x0 = page_rect.x0 + margin
        y0 = page_rect.y1 - margin - height
    elif pos == "bottom-right":
        x0 = page_rect.x1 - margin - width
        y0 = page_rect.y1 - margin - height
    elif pos in {"left", "middle-left"}:
        x0 = page_rect.x0 + margin
        y0 = page_rect.y0 + (page_rect.height - height) / 2
    elif pos in {"right", "middle-right"}:
        x0 = page_rect.x1 - margin - width
        y0 = page_rect.y0 + (page_rect.height - height) / 2
    elif pos == "top-left":
        x0 = page_rect.x0 + margin
        y0 = page_rect.y0 + margin
    else:
        x0 = page_rect.x1 - margin - width
        y0 = page_rect.y0 + margin
    return fitz.Rect(x0, y0, x0 + width, y0 + height)


def insert_textbox(page: fitz.Page, rect: fitz.Rect, text: str, font_size: float, color: tuple[float, float, float], align: int, opacity: float = 1) -> None:
    kwargs = {
        "fontsize": font_size,
        "color": color,
        "align": align,
        "overlay": True,
    }
    try:
        page.insert_textbox(rect, text, fill_opacity=opacity, **kwargs)
    except TypeError:
        page.insert_textbox(rect, text, **kwargs)


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


def normalize_action_type(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_")
