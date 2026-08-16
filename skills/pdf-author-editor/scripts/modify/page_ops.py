from __future__ import annotations

from pathlib import Path
from typing import Any

from pypdf import PdfReader, PdfWriter


PAGE_OPS = {
    "merge",
    "split",
    "split_pages",
    "delete",
    "delete_pages",
    "rotate",
    "rotate_pages",
    "reorder",
    "reorder_pages",
    "extract",
    "extract_pages",
}


def apply_page_ops(request: dict[str, Any], input_path: Path | None, output_path: Path, out_dir: Path) -> dict[str, Any]:
    actions = list(request.get("actions") or [])
    operation = str(request.get("operation") or "").strip()
    if operation and not actions and operation in PAGE_OPS:
        actions = [{"type": operation}]

    if _contains_action(actions, {"merge"}) or request.get("inputs"):
        return merge_pdfs(request, input_path, output_path)

    if not input_path:
        raise ValueError("page_ops requires input.path unless merging request.inputs.")
    if not input_path.exists():
        raise FileNotFoundError(f"Input PDF not found: {input_path}")
    if input_path.resolve() == output_path.resolve():
        raise ValueError("Output PDF must not overwrite the input PDF.")

    if _contains_action(actions, {"split", "split_pages"}):
        return split_pdf(request, input_path, out_dir)

    reader = PdfReader(str(input_path))
    total_pages = len(reader.pages)
    working_pages = list(range(1, total_pages + 1))
    rotations: dict[int, int] = {}

    for action in actions:
        action_type = normalize_action_type(action.get("type"))
        if action_type in {"delete", "delete_pages"}:
            remove = set(parse_pages(action.get("pages"), total_pages))
            working_pages = [page for page in working_pages if page not in remove]
        elif action_type in {"extract", "extract_pages"}:
            keep = parse_pages(action.get("pages"), total_pages)
            working_pages = [page for page in keep if page in working_pages]
        elif action_type in {"reorder", "reorder_pages"}:
            order = parse_pages(action.get("pages") or action.get("order"), total_pages)
            working_pages = order
        elif action_type in {"rotate", "rotate_pages"}:
            degrees = int(action.get("degrees", action.get("angle", 90)))
            pages = parse_pages(action.get("pages", "all"), total_pages)
            for page in pages:
                rotations[page] = (rotations.get(page, 0) + degrees) % 360
        elif action_type in {"merge", "split", "split_pages"}:
            continue
        else:
            raise ValueError(f"Unsupported page operation: {action_type or action.get('type')}")

    writer = PdfWriter()
    for page_number in working_pages:
        if page_number < 1 or page_number > total_pages:
            raise ValueError(f"Page out of range: {page_number} (total {total_pages})")
        page = reader.pages[page_number - 1]
        if page_number in rotations:
            page.rotate(rotations[page_number])
        writer.add_page(page)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as handle:
        writer.write(handle)

    return {
        "operation": "page_ops",
        "input": str(input_path),
        "output": str(output_path),
        "page_count_before": total_pages,
        "page_count_after": len(working_pages),
        "selected_pages": working_pages,
        "actions": actions,
    }


def merge_pdfs(request: dict[str, Any], input_path: Path | None, output_path: Path) -> dict[str, Any]:
    input_specs = request.get("inputs") or []
    paths: list[Path] = []
    if input_path:
        paths.append(input_path)
    for spec in input_specs:
        if isinstance(spec, str):
            paths.append(Path(spec))
        elif isinstance(spec, dict) and spec.get("path"):
            paths.append(Path(spec["path"]))

    if len(paths) < 2:
        raise ValueError("merge requires at least two input PDFs.")
    for item in paths:
        if not item.exists():
            raise FileNotFoundError(f"Input PDF not found: {item}")
        if item.resolve() == output_path.resolve():
            raise ValueError("Output PDF must not overwrite an input PDF.")

    writer = PdfWriter()
    page_counts: list[int] = []
    for item in paths:
        reader = PdfReader(str(item))
        page_counts.append(len(reader.pages))
        for page in reader.pages:
            writer.add_page(page)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as handle:
        writer.write(handle)

    return {
        "operation": "merge",
        "inputs": [str(item) for item in paths],
        "input_page_counts": page_counts,
        "output": str(output_path),
        "page_count_after": sum(page_counts),
    }


def split_pdf(request: dict[str, Any], input_path: Path, out_dir: Path) -> dict[str, Any]:
    reader = PdfReader(str(input_path))
    total_pages = len(reader.pages)
    ranges = request.get("ranges")
    actions = list(request.get("actions") or [])
    for action in actions:
        if normalize_action_type(action.get("type")) in {"split", "split_pages"} and action.get("ranges"):
            ranges = action.get("ranges")
            break

    page_groups = parse_ranges(ranges, total_pages) if ranges else [[page] for page in range(1, total_pages + 1)]
    outputs: list[str] = []
    base = safe_stem(input_path)
    for index, group in enumerate(page_groups, start=1):
        writer = PdfWriter()
        for page_number in group:
            writer.add_page(reader.pages[page_number - 1])
        output_path = out_dir / f"{base}-part-{index}.pdf"
        with output_path.open("wb") as handle:
            writer.write(handle)
        outputs.append(str(output_path))

    return {
        "operation": "split",
        "input": str(input_path),
        "outputs": outputs,
        "page_count_before": total_pages,
        "parts": page_groups,
    }


def parse_ranges(value: Any, total_pages: int) -> list[list[int]]:
    if not isinstance(value, list):
        raise ValueError("split ranges must be a list.")
    groups: list[list[int]] = []
    for item in value:
        groups.append(parse_pages(item, total_pages))
    return groups


def parse_pages(value: Any, total_pages: int) -> list[int]:
    if value is None or value == "all":
        return list(range(1, total_pages + 1))
    if isinstance(value, int):
        pages = [value]
    elif isinstance(value, list):
        pages = []
        for item in value:
            pages.extend(parse_pages(item, total_pages))
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


def _contains_action(actions: list[dict[str, Any]], names: set[str]) -> bool:
    return any(normalize_action_type(action.get("type")) in names for action in actions)


def safe_stem(path: Path) -> str:
    stem = path.stem or "document"
    return "".join(char if char.isalnum() or char in "._-" else "-" for char in stem).strip("-") or "document"
