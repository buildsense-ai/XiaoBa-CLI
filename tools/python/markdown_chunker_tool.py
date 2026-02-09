#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Markdown Chunker Tool
Parse MinerU full.md into chapter-level blocks (text/image/table/heading).
"""

import os
import re
from typing import Any, Dict, List, Optional

from utils.base_tool import BaseTool


HEADING_RE = re.compile(r"^\s*(#{1,6})\s+(.+?)\s*$")
IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def parse_heading_line(line: str) -> Optional[Dict[str, Any]]:
    match = HEADING_RE.match(line)
    if not match:
        return None
    hashes = match.group(1)
    raw_text = match.group(2).strip()
    num_match = re.match(r"^(\d+(?:\.\d+)*)(?:\.)?\s*(.*)$", raw_text)
    if num_match:
        number = num_match.group(1)
        title = num_match.group(2).strip() or raw_text
        level = number.count(".") + 1
    else:
        number = ""
        title = raw_text
        level = len(hashes)
    return {
        "raw": raw_text,
        "number": number,
        "title": title,
        "level": level,
        "hash_level": len(hashes),
    }


def split_text_blocks(text: str, max_len: int) -> List[str]:
    if not text.strip():
        return []
    paragraphs = re.split(r"\n\s*\n+", text.strip())
    blocks: List[str] = []
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if max_len <= 0 or len(para) <= max_len:
            blocks.append(para)
            continue
        # Split long paragraph by nearest space.
        start = 0
        while start < len(para):
            end = min(start + max_len, len(para))
            if end < len(para):
                space = para.rfind(" ", start, end)
                if space > start + 50:
                    end = space
            blocks.append(para[start:end].strip())
            start = end
    return blocks


class MarkdownChunkerTool(BaseTool):
    """Parse full.md into chapter-level blocks."""

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.validate_params(params, ["full_md_path"])

        full_md_path = params["full_md_path"]
        if not os.path.exists(full_md_path):
            raise ValueError(f"full.md 不存在: {full_md_path}")

        chapter_level = int(params.get("chapter_level", 1))
        include_heading_blocks = bool(params.get("include_heading_blocks", True))
        resolve_images = bool(params.get("resolve_images", True))
        max_text_block_chars = int(params.get("max_text_block_chars", 1200))
        skip_first_heading = bool(params.get("skip_first_heading", True))
        keep_empty_chapters = bool(params.get("keep_empty_chapters", True))
        outline_only = bool(params.get("outline_only", False))
        chapter_selector = params.get("chapter_selector")

        base_dir = os.path.dirname(full_md_path)

        with open(full_md_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.read().splitlines()

        # Identify chapter boundaries
        chapter_starts: List[Dict[str, Any]] = []
        paper_title = ""
        first_heading_consumed = False

        for idx, line in enumerate(lines):
            info = parse_heading_line(line)
            if not info:
                continue
            effective_level = info["level"]
            if effective_level != chapter_level:
                continue
            if skip_first_heading and not first_heading_consumed:
                paper_title = info["raw"]
                first_heading_consumed = True
                continue
            chapter_starts.append(
                {
                    "index": len(chapter_starts) + 1,
                    "title": info["raw"],
                    "number": info["number"],
                    "start_line": idx,
                }
            )

        # Build chapter slices
        chapters: List[Dict[str, Any]] = []
        for i, ch in enumerate(chapter_starts):
            start = ch["start_line"] + 1
            end = chapter_starts[i + 1]["start_line"] if i + 1 < len(chapter_starts) else len(lines)
            chapter_lines = lines[start:end]
            blocks = self._parse_blocks(
                chapter_lines,
                base_dir,
                chapter_level=chapter_level,
                include_heading_blocks=include_heading_blocks,
                resolve_images=resolve_images,
                max_text_block_chars=max_text_block_chars,
            )
            stats = self._count_blocks(blocks)
            chapter = {
                "index": ch["index"],
                "title": ch["title"],
                "number": ch["number"],
                "blocks": blocks,
                "stats": stats,
            }
            if outline_only:
                chapter["blocks"] = []
            if blocks or keep_empty_chapters:
                chapters.append(chapter)

        # Optional filtering
        if chapter_selector:
            chapters = self._filter_chapters(chapters, chapter_selector)

        return {
            "paper_title": paper_title,
            "full_md_path": full_md_path,
            "chapter_count": len(chapters),
            "outline_only": outline_only,
            "chapters": chapters,
        }

    def _parse_blocks(
        self,
        lines: List[str],
        base_dir: str,
        chapter_level: int,
        include_heading_blocks: bool,
        resolve_images: bool,
        max_text_block_chars: int,
    ) -> List[Dict[str, Any]]:
        blocks: List[Dict[str, Any]] = []
        text_lines: List[str] = []
        section_stack: List[Dict[str, Any]] = []
        pending_table_caption = ""

        def flush_text():
            nonlocal text_lines
            if not text_lines:
                return
            raw_text = "\n".join(text_lines).strip()
            for chunk in split_text_blocks(raw_text, max_text_block_chars):
                blocks.append(
                    {
                        "type": "text",
                        "text": chunk,
                        "section_path": [s["raw"] for s in section_stack],
                    }
                )
            text_lines = []

        i = 0
        while i < len(lines):
            line = lines[i]
            stripped = line.strip()

            # Sub-headings
            heading_info = parse_heading_line(line)
            if heading_info and heading_info["level"] > chapter_level:
                flush_text()
                # Maintain section stack
                while section_stack and section_stack[-1]["level"] >= heading_info["level"]:
                    section_stack.pop()
                section_stack.append(heading_info)
                if include_heading_blocks:
                    blocks.append(
                        {
                            "type": "heading",
                            "text": heading_info["raw"],
                            "number": heading_info["number"],
                            "level": heading_info["level"],
                            "section_path": [s["raw"] for s in section_stack],
                        }
                    )
                i += 1
                continue

            # Table caption line
            if re.match(r"^\s*Table\s+\d+", stripped):
                # Look ahead to see if a table follows
                j = i + 1
                while j < len(lines) and not lines[j].strip():
                    j += 1
                if j < len(lines) and lines[j].lstrip().startswith("<table"):
                    pending_table_caption = stripped
                    i += 1
                    continue

            # Table block
            if stripped.startswith("<table"):
                flush_text()
                table_lines = [line]
                i += 1
                while i < len(lines):
                    table_lines.append(lines[i])
                    if "</table>" in lines[i]:
                        i += 1
                        break
                    i += 1
                table_html = "\n".join(table_lines).strip()
                blocks.append(
                    {
                        "type": "table",
                        "html": table_html,
                        "caption": pending_table_caption,
                        "section_path": [s["raw"] for s in section_stack],
                    }
                )
                pending_table_caption = ""
                continue

            # Image block
            img_match = IMAGE_RE.search(line)
            if img_match:
                flush_text()
                img_path = img_match.group(1).strip()
                resolved_path = os.path.normpath(os.path.join(base_dir, img_path)) if resolve_images else ""
                caption = ""
                j = i + 1
                while j < len(lines) and not lines[j].strip():
                    j += 1
                if j < len(lines):
                    next_line = lines[j].strip()
                    if re.match(r"^(Figure|Fig\.|Table)\s+\d+", next_line):
                        caption = next_line
                        i = j  # Skip caption line
                blocks.append(
                    {
                        "type": "image",
                        "image_path": img_path,
                        "resolved_path": resolved_path,
                        "caption": caption,
                        "section_path": [s["raw"] for s in section_stack],
                    }
                )
                i += 1
                continue

            text_lines.append(line)
            i += 1

        flush_text()
        return blocks

    def _count_blocks(self, blocks: List[Dict[str, Any]]) -> Dict[str, int]:
        stats = {"text": 0, "image": 0, "table": 0, "heading": 0}
        for block in blocks:
            block_type = block.get("type", "")
            if block_type in stats:
                stats[block_type] += 1
        stats["total"] = len(blocks)
        return stats

    def _filter_chapters(self, chapters: List[Dict[str, Any]], selector: Any) -> List[Dict[str, Any]]:
        if isinstance(selector, int):
            return [c for c in chapters if c["index"] == selector]
        if isinstance(selector, str):
            selector = selector.strip()
            if selector.isdigit():
                idx = int(selector)
                return [c for c in chapters if c["index"] == idx or c["title"].startswith(f"{idx}.")]
            return [
                c
                for c in chapters
                if selector.lower() in c["title"].lower() or c["title"].startswith(selector)
            ]
        return chapters


if __name__ == "__main__":
    MarkdownChunkerTool().run()
