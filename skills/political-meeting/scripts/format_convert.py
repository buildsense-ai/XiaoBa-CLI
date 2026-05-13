"""格式判断与文本提取。"""

import os
import struct
import tempfile

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff"}


def detect_format(filepath):
    """判断文件类型。返回 'docx' | 'pdf' | 'image' | 'doc' | 'unknown'。"""
    ext = os.path.splitext(filepath)[1].lower()
    if ext == ".docx":
        return "docx"
    if ext == ".pdf":
        return "pdf"
    if ext == ".doc":
        return "doc"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    return "unknown"


def extract_doc_text(filepath):
    """从 .doc (OLE 格式) 文件中提取纯文本。
    使用连续文本段策略：只有连续 N 个以上有效字符的序列才保留，
    过滤掉随机二进制字节碰巧映射到 Unicode 的短片段垃圾。
    """
    import olefile

    ole = olefile.OleFileIO(filepath)

    if not ole.exists("WordDocument"):
        ole.close()
        raise ValueError("不是有效的 .doc 文件（缺少 WordDocument 流）")

    word_stream = ole.openstream("WordDocument").read()
    ole.close()

    MIN_RUN = 8

    def is_text_char(code):
        return (
            (0x4E00 <= code <= 0x9FFF) or   # CJK 汉字
            (0x3000 <= code <= 0x303F) or   # CJK 标点
            (0xFF00 <= code <= 0xFFEF) or   # 全角字符
            (0x0020 <= code <= 0x007E) or   # ASCII 可打印
            (0x2000 <= code <= 0x206F) or   # 通用标点
            (0x2010 <= code <= 0x2027) or   # 破折号、引号
            (code in (0x0009, 0x000A, 0x000D))  # tab, LF, CR
        )

    result = []
    run_buffer = []
    i = 0
    while i < len(word_stream) - 1:
        lo = word_stream[i]
        hi = word_stream[i + 1]
        code = lo | (hi << 8)

        if code == 0x0000:
            if len(run_buffer) >= MIN_RUN:
                result.append("".join(run_buffer))
            run_buffer = []
            i += 2
        elif is_text_char(code):
            run_buffer.append(chr(code))
            i += 2
        else:
            if len(run_buffer) >= MIN_RUN:
                result.append("".join(run_buffer))
            run_buffer = []
            i += 1

    if len(run_buffer) >= MIN_RUN:
        result.append("".join(run_buffer))

    text = "\n".join(result)

    if len(text) < 20:
        raise ValueError(
            "无法从 .doc 文件提取有效文本。请用 Word 将文件另存为 .docx 后重试。"
        )

    return text


def extract_docx_paragraphs(filepath):
    """从 .docx 文件中提取所有段落的文本列表（过滤空行）。"""
    from docx import Document
    doc = Document(filepath)
    return [p.text for p in doc.paragraphs if p.text.strip()]


def _is_readable_chinese(text):
    """判断文本段是否是真实的中文内容（过滤二进制垃圾）。"""
    if len(text) < 4:
        return False
    # 拒绝含低区控制字符的行
    for ch in text:
        code = ord(ch)
        if code < 0x20 and code not in (0x09, 0x0A, 0x0D, 0x0C):
            return False
        if code in (0xFFFD, 0xFFFE, 0xFFFF):
            return False

    # 统计中文特征
    cjk_count = 0
    punct_count = 0
    latin_count = 0
    garbage_count = 0
    for ch in text:
        code = ord(ch)
        if 0x4E00 <= code <= 0x9FFF:
            cjk_count += 1
        elif code in (0x300A, 0x300B, 0x3001, 0x3002, 0xFF0C, 0xFF0E,
                      0x201C, 0x201D, 0x300C, 0x300D, 0x2014, 0x2018,
                      0x2019, 0xFF1A, 0xFF08, 0xFF09, 0xFF01, 0xFF1F,
                      0x300E, 0x300F, 0x3010, 0x3011, 0x2013):
            punct_count += 1
        elif 0x0020 <= code <= 0x007E:
            latin_count += 1
        elif code in (0x0D, 0x0A, 0x09, 0x0C, 0x20):
            pass  # whitespace
        elif (0xFF00 <= code <= 0xFFEF or 0x3000 <= code <= 0x303F):
            punct_count += 1
        else:
            garbage_count += 1

    total = cjk_count + punct_count + latin_count + garbage_count
    if total == 0:
        return False
    good_ratio = (cjk_count + punct_count) / total
    # 真实中文文本：CJK+标点占比高，垃圾字符少
    return good_ratio > 0.6 and garbage_count < total * 0.15


def extract_first_title(filepath, fmt=None):
    """从学习内容文件中提取第一个有效标题。
    对于 .docx：取第一个非空段落
    对于 .doc：取提取文本的第一行
    """
    if fmt is None:
        fmt = detect_format(filepath)

    if fmt == "docx":
        paragraphs = extract_docx_paragraphs(filepath)
        for p in paragraphs:
            t = p.strip()
            if t:
                return t
    elif fmt == "doc":
        text = extract_doc_text(filepath)
        # .doc 中 \r 是段落分隔，\n 是行分隔
        # 先按 \r 分段，每段再按 \n 分行
        paragraphs = text.replace("\r\n", "\r").replace("\n", "\r").split("\r")
        lines = []
        for p in paragraphs:
            for sub_line in p.split("\n"):
                t = sub_line.strip()
                if t:
                    lines.append(t)
        for line in lines:
            t = line.strip()
            if t and len(t) > 2 and _is_readable_chinese(t):
                return t

    return os.path.splitext(os.path.basename(filepath))[0]


def pdf_to_images(pdf_path, output_dir=None):
    """将 PDF 每一页转为图片。返回图片路径列表。"""
    from pdf2image import convert_from_path

    dpi = 200
    if output_dir is None:
        output_dir = tempfile.mkdtemp(prefix="pdf_img_")

    images = convert_from_path(pdf_path, dpi=dpi)
    result = []
    for i, img in enumerate(images):
        img_path = os.path.join(output_dir, f"page_{i+1:03d}.jpg")
        img.save(img_path, "JPEG", quality=90)
        result.append(img_path)

    return result


def truncate_content(text, max_chars=6000):
    """截断过长内容。超过 max_chars 字时，只保留前 max_chars 字并附加提示。
    返回 (截断后的文本, 是否被截断)。
    """
    if len(text) <= max_chars:
        return text, False

    truncated = text[:max_chars]
    truncated += f"\n\n（原文共 {len(text)} 字，过长，仅收录前 {max_chars} 字）"
    return truncated, True


def count_chars(text):
    """统计文本中的有效字符数（不含空白）。"""
    return sum(1 for ch in text if ch.strip())
