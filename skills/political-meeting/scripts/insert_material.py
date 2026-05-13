"""插入一份材料到总表。使用 OfficeCLI + 文档缓存。"""

import os
import sys
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from officecli_helper import (
    DocxCache, detect_week_status, get_missing_items,
    get_or_create_week, insert_learning_content_text,
    insert_photo, insert_signin_sheet, update_brief_intro,
    copy_docx_content,
    oc_add_para,
    DEFAULT_SCHOOL, DEFAULT_SEMESTER, MATERIAL_ORDER
)
from format_convert import (
    detect_format, extract_doc_text,
    extract_first_title, pdf_to_images, count_chars
)
from config import get_docx_path


def insert_material(docx_path, week_title, material_type, source_file=None):
    """核心函数：将一份材料插入总表。"""

    week_keyword = week_title.replace(DEFAULT_SEMESTER, "").strip() or week_title[-20:]

    get_or_create_week(docx_path, week_title)
    status = detect_week_status(docx_path, week_keyword)

    if material_type == "签到表" and status.get("签到表"):
        return False, "「签到表」已插入，如需替换请联系管理员"
    if material_type in ("会议记录", "标题", "简要介绍"):
        return True, ""

    if material_type == "签到表":
        if not source_file:
            return False, "签到表需要上传图片文件"
        fmt = detect_format(source_file)
        if fmt not in ("image", "pdf"):
            return False, f"签到表文件格式不支持（{fmt}），请发送图片或 PDF"
        if fmt == "pdf":
            for img in pdf_to_images(source_file):
                status = insert_signin_sheet(docx_path, week_keyword, img)
        else:
            status = insert_signin_sheet(docx_path, week_keyword, source_file)

    elif material_type == "会议照片":
        if not source_file:
            return False, "会议照片需要上传图片文件"
        fmt = detect_format(source_file)
        if fmt not in ("image", "pdf"):
            return False, f"会议照片文件格式不支持（{fmt}），请发送图片或 PDF"
        if fmt == "pdf":
            for img in pdf_to_images(source_file):
                status = insert_photo(docx_path, week_keyword, img)
        else:
            status = insert_photo(docx_path, week_keyword, source_file)

    elif material_type == "学习内容":
        if not source_file:
            return False, "学习内容需要上传文件"
        fmt = detect_format(source_file)

        if fmt == "docx":
            copy_docx_content(docx_path, week_keyword, source_file)
            status = detect_week_status(docx_path, week_keyword)
            content_title = extract_first_title(source_file, fmt)

        elif fmt == "doc":
            text = extract_doc_text(source_file)
            paragraphs = _filter([line.strip() for line in text.split("\n") if line.strip()])
            status = insert_learning_content_text(docx_path, week_keyword, paragraphs)
            content_title = extract_first_title(source_file, fmt)

        elif fmt == "pdf":
            for img in pdf_to_images(source_file):
                status = insert_photo(docx_path, week_keyword, img)
            missing = get_missing_items(status)
            report = [m for m in missing if m not in ("会议记录", "标题", "简要介绍")]
            msg = "✅ PDF 已转为图片插入"
            if report:
                msg += f"\n该周还缺：{'、'.join(report)}"
            return True, msg
        else:
            return False, f"学习内容文件格式不支持（{fmt}），请发送 .docx 或 .doc 文件"

        existing = _collect_titles(docx_path, week_keyword)
        if content_title and content_title not in existing:
            existing.append(content_title)
        if existing:
            update_brief_intro(docx_path, week_keyword, existing)

    else:
        return False, f"未知材料类型：{material_type}"

    status = detect_week_status(docx_path, week_keyword)
    missing = get_missing_items(status)
    friendly = week_title.replace(DEFAULT_SEMESTER, "").strip().replace("政治学习", "")

    msg_parts = [f"✅ 已添加{friendly}「{material_type}」"]
    report = [m for m in missing if m not in ("会议记录", "标题", "简要介绍")]
    if report:
        msg_parts.append(f"该周还缺：{'、'.join(report)}")
    else:
        msg_parts.append("该周材料已齐全！")

    return True, "\n".join(msg_parts)


def _filter(paragraphs):
    """过滤二进制垃圾段落。"""
    result = []
    for p in paragraphs:
        t = p.strip()
        if not t or len(t) < 4:
            continue
        good = bad = 0
        for ch in t:
            code = ord(ch)
            if (0x4E00 <= code <= 0x9FFF or 0x3000 <= code <= 0x303F or
                0xFF00 <= code <= 0xFFEF or 0x0020 <= code <= 0x007E or
                0x2000 <= code <= 0x206F or 0x2010 <= code <= 0x2027 or
                code in (0x0009, 0x3001, 0x3002, 0x300A, 0x300B,
                         0x300C, 0x300D, 0x201C, 0x201D, 0x2014,
                         0xFF0C, 0xFF0E, 0xFF1A, 0xFF08, 0xFF09)):
                good += 1
            else:
                bad += 1
        if good > bad and good >= 2:
            result.append(t)
    return result


def _collect_titles(docx_path, week_keyword):
    """收集某周已有学习内容标题。"""
    doc = DocxCache(docx_path)
    anchor, next_start = doc.week_boundary(week_keyword)
    if anchor < 0:
        return []
    titles = []
    for i in range(anchor + 1, next_start):
        t = doc.text_at(i)
        if not t:
            continue
        if DEFAULT_SCHOOL in t and len(t) > 30:
            continue
        if len(t) > 5:
            if "《" in t or "》" in t or t.endswith("的通知") or t.endswith("的意见") or "习近平总书记" in t:
                titles.append(t)
                continue
            if not titles:
                titles.append(t)
    return titles


def main():
    parser = argparse.ArgumentParser(description="政治学习材料插入工具")
    parser.add_argument("--docx", default=None, help="总表路径（可选）")
    parser.add_argument("--week-title", required=True, help="周标题")
    parser.add_argument("--type", required=True, dest="material_type",
                        choices=MATERIAL_ORDER)
    parser.add_argument("--file", default="", help="源文件路径")

    args = parser.parse_args()
    docx_path = args.docx or get_docx_path()
    if not docx_path:
        print("错误：未配置总表路径。")
        sys.exit(1)

    source = args.file if args.file else None
    success, msg = insert_material(docx_path, args.week_title, args.material_type, source)
    print(msg)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
