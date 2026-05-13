"""OfficeCLI 命令封装 + 文档缓存层。提供 Pythonic 接口操作 docx。"""

import os
import subprocess

_OFFICECLI_DIR = os.path.join(os.environ.get("LOCALAPPDATA", ""), "OfficeCLI")
OFFICECLI = os.path.join(_OFFICECLI_DIR, "officecli.exe")
if not os.path.exists(OFFICECLI):
    OFFICECLI = "officecli"

MATERIAL_ORDER = ["会议记录", "签到表", "标题", "简要介绍", "会议照片", "学习内容"]
DEFAULT_SCHOOL = "广州市番禺区番广附万博学校"
DEFAULT_SEMESTER = "2025学年第二学期"


def _run(args, timeout=60):
    """执行 officecli 命令。"""
    cmd = [OFFICECLI] + args
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout,
        encoding="utf-8", errors="replace"
    )
    if result.returncode != 0 and result.stderr:
        raise RuntimeError(f"OfficeCLI failed: {' '.join(cmd)}\n{result.stderr}")
    return result.stdout


class DocxCache:
    """缓存文档内容，避免反复调用 OfficeCLI 读取。"""

    def __init__(self, path):
        self.path = path
        self._lines = None  # 完整文本行列表
        self._texts = None  # 纯文本列表（每段）

    def _load(self):
        if self._lines is None:
            raw = _run(["view", self.path, "text"]).strip()
            self._lines = raw.split("\n") if raw else []
            self._texts = []
            for line in self._lines:
                idx = line.find("]] ")
                self._texts.append(line[idx + 3:] if idx > 0 else line)

    def invalidate(self):
        """文档被修改后，标记缓存过期。"""
        self._lines = None
        self._texts = None

    @property
    def lines(self):
        self._load()
        return self._lines

    @property
    def texts(self):
        self._load()
        return self._texts

    def __len__(self):
        self._load()
        return len(self._texts)

    def text_at(self, i):
        self._load()
        if 0 <= i < len(self._texts):
            return self._texts[i].strip()
        return ""

    def find(self, text, exclude_if_contains=None):
        """查找第一个包含 text 的段落索引。"""
        self._load()
        for i, t in enumerate(self._texts):
            if exclude_if_contains and exclude_if_contains in t:
                continue
            if text in t:
                return i
        return -1

    def find_all_weeks(self):
        """返回所有周标题的 (索引, 文本) 列表。"""
        self._load()
        results = []
        for i, t in enumerate(self._texts):
            s = t.strip()
            if DEFAULT_SCHOOL in s:
                continue
            if "政治学习" in s and ("学期" in s or "周" in s):
                results.append((i, s))
        return results

    def week_boundary(self, week_keyword):
        """返回 (标题索引, 下一周起始索引)。"""
        anchor = self.find(week_keyword, exclude_if_contains=DEFAULT_SCHOOL)
        if anchor < 0:
            return -1, -1
        all_titles = self.find_all_weeks()
        total = len(self._texts)
        next_start = total
        for idx, _ in all_titles:
            if idx > anchor:
                next_start = idx
                break
        return anchor, next_start

    def last_content_para(self, start, end):
        """在 [start, end) 范围内最后一个非空段落索引。"""
        last = start
        for i in range(start, end):
            if self._texts[i].strip():
                last = i
        return last

    def has_marker(self, text, start, end):
        """检查 [start, end) 范围内是否存在包含 text 的段落。"""
        for i in range(max(0, start), min(end, len(self._texts))):
            if text in self._texts[i]:
                return True
        return False

    def find_marker(self, text, start, end):
        """在 [start, end) 范围内查找包含 text 的段落索引。"""
        for i in range(max(0, start), min(end, len(self._texts))):
            if text in self._texts[i]:
                return i
        return -1


def oc_add_para(docx_path, text, index=None):
    """在文档末尾或指定位置插入段落。index=None 追加到末尾。"""
    args = ["add", docx_path, "/body", "--type", "paragraph", "--prop", f"text={text}"]
    if index is not None:
        args += ["--index", str(index)]
    _run(args)


def oc_add_image(docx_path, image_path, index=None, width_inches=5.5):
    """在末尾或指定位置插入图片。"""
    width_cm = width_inches * 2.54
    args = ["add", docx_path, "/body", "--type", "image",
            "--prop", f"file={image_path}", "--prop", f"width={width_cm}cm"]
    if index is not None:
        args += ["--index", str(index)]
    _run(args)


def oc_set_format(docx_path, index, font=None, size=None, bold=None):
    """设置段落中 run 的格式。index 为 0-based。"""
    args = ["set", docx_path, f"/body/p[{index + 1}]/r[1]"]
    if font:
        args += ["--prop", f"font={font}"]
    if size:
        args += ["--prop", f"size={size}"]
    if bold is not None:
        args += ["--prop", f"bold={str(bold).lower()}"]
    _run(args)


def oc_replace_text(docx_path, index, text):
    """替换段落的全部文本。"""
    _run(["set", docx_path, f"/body/p[{index + 1}]", "--prop", f"text={text}"])


def oc_copy_paras(src_path, dst_path, start_idx, end_idx, after_idx):
    """从 src 复制 [start, end) 段落到 dst 的 after_idx 之后。"""
    from lxml import etree
    import tempfile

    # 先处理 dst 文档
    # OfficeCLI 不支持跨文档复制，改用读取文本再插入
    src_doc = DocxCache(src_path)
    insert_pos = after_idx
    for i in range(start_idx, end_idx):
        t = src_doc.text_at(i)
        if t:
            insert_pos += 1
            oc_add_para(dst_path, t, insert_pos)


# ─── 业务逻辑函数（使用缓存）─────────────────────────────


def detect_week_status(path, week_keyword):
    """扫描某周区域，返回各材料是否已插入。"""
    doc = DocxCache(path)
    anchor, next_start = doc.week_boundary(week_keyword)
    if anchor < 0:
        return {item: False for item in MATERIAL_ORDER}

    status = {item: False for item in MATERIAL_ORDER}
    status["标题"] = True
    status["会议记录"] = True

    prev_start = 0
    for idx, _ in doc.find_all_weeks():
        if idx < anchor:
            prev_start = idx

    for i in range(prev_start, anchor):
        if "会议签到表" in doc.text_at(i):
            status["签到表"] = True

    for i in range(anchor + 1, next_start):
        t = doc.text_at(i)
        if DEFAULT_SCHOOL in t and len(t) > 30:
            status["简要介绍"] = True
        if "会议照片" in t:
            status["会议照片"] = True
        if status["会议照片"] and len(t) > 20 and "会议照片" not in t:
            status["学习内容"] = True

    if not status["学习内容"]:
        for i in range(anchor + 1, next_start):
            t = doc.text_at(i)
            if DEFAULT_SCHOOL not in t and len(t) > 20 and "会议照片" not in t:
                status["学习内容"] = True
                break

    return status


def get_missing_items(status):
    return [item for item in MATERIAL_ORDER if not status[item]]


def get_inserted_items(status):
    return [item for item in MATERIAL_ORDER if status[item]]


def get_or_create_week(path, week_title):
    """获取或创建某周标题索引。"""
    doc = DocxCache(path)
    anchor = doc.find(week_title, exclude_if_contains=DEFAULT_SCHOOL)
    if anchor >= 0:
        return anchor

    keyword = week_title.replace(DEFAULT_SEMESTER, "").strip() or week_title[-20:]
    anchor = doc.find(keyword, exclude_if_contains=DEFAULT_SCHOOL)
    if anchor >= 0:
        return anchor

    # 创建新周
    total = len(doc)
    if total > 0 and doc.text_at(total - 1):
        oc_add_para(path, "", None)
        total += 1

    oc_add_para(path, "会议记录", None)
    title_idx = total + 1
    oc_add_para(path, week_title, None)
    oc_set_format(path, title_idx, font="宋体", size="20pt", bold=True)
    return title_idx


def insert_learning_content_text(path, week_keyword, paragraphs):
    """以纯文本方式插入学习内容。"""
    doc = DocxCache(path)
    anchor, next_start = doc.week_boundary(week_keyword)
    if anchor < 0:
        anchor = get_or_create_week(path, week_keyword)
        doc.invalidate()
        doc._load()
        next_start = len(doc)

    last_pos = doc.last_content_para(anchor + 1, next_start)
    insert_pos = max(last_pos, anchor)

    oc_add_para(path, "", insert_pos + 1)
    insert_pos += 1

    for p in paragraphs:
        t = p.strip()
        if t:
            insert_pos += 1
            oc_add_para(path, t, insert_pos)

    doc.invalidate()
    return detect_week_status(path, week_keyword)


def insert_photo(path, week_keyword, image_path):
    """插入会议照片。"""
    doc = DocxCache(path)
    anchor, next_start = doc.week_boundary(week_keyword)
    if anchor < 0:
        anchor = get_or_create_week(path, week_keyword)
        doc.invalidate()
        doc._load()
        next_start = len(doc)

    photo_marker = doc.find_marker("会议照片：", anchor + 1, next_start)
    if photo_marker < 0:
        brief_idx = doc.find_marker(DEFAULT_SCHOOL, anchor + 1, min(anchor + 10, next_start))
        photo_marker = brief_idx if brief_idx >= 0 else anchor
        oc_add_para(path, "会议照片：", photo_marker + 1)
        photo_marker += 1

    oc_add_image(path, image_path, photo_marker + 1)
    doc.invalidate()
    return detect_week_status(path, week_keyword)


def insert_signin_sheet(path, week_keyword, image_path):
    """插入签到表。"""
    doc = DocxCache(path)
    anchor, next_start = doc.week_boundary(week_keyword)
    if anchor < 0:
        anchor = get_or_create_week(path, week_keyword)
        doc.invalidate()
        doc._load()

    existing = doc.find_marker("会议签到表", max(0, anchor - 20), anchor)
    if existing >= 0:
        oc_add_image(path, image_path, existing + 1)
        doc.invalidate()
        return detect_week_status(path, week_keyword)

    meeting_record = -1
    for i in range(max(0, anchor - 20), anchor):
        if doc.text_at(i) == "会议记录":
            meeting_record = i
            break

    insert_pos = meeting_record if meeting_record >= 0 else anchor - 1
    if insert_pos < 0:
        oc_add_para(path, "会议记录", 0)
        insert_pos = 0

    oc_add_para(path, "会议签到表", insert_pos + 1)
    insert_pos += 1
    oc_add_image(path, image_path, insert_pos + 1)
    doc.invalidate()
    return detect_week_status(path, week_keyword)


def update_brief_intro(path, week_keyword, content_titles):
    """更新简要介绍（四号宋体）。"""
    doc = DocxCache(path)
    anchor, next_start = doc.week_boundary(week_keyword)
    if anchor < 0:
        return False

    title_text = doc.text_at(anchor)
    week_part = title_text.replace(DEFAULT_SEMESTER, "").strip()
    titles_str = "、".join(content_titles)
    brief_text = f"{DEFAULT_SCHOOL}{DEFAULT_SEMESTER}{week_part}：{titles_str}"

    brief_idx = doc.find_marker(DEFAULT_SCHOOL, anchor + 1, min(anchor + 10, next_start))
    if brief_idx >= 0:
        oc_replace_text(path, brief_idx, brief_text)
        oc_set_format(path, brief_idx, font="宋体", size="14pt")
    else:
        oc_add_para(path, brief_text, anchor + 1)
        oc_set_format(path, anchor + 1, font="宋体", size="14pt")

    return True


def copy_docx_content(path, week_keyword, source_path):
    """将源 docx 内容段落追加到指定周。"""
    src_doc = DocxCache(source_path)
    dest_doc = DocxCache(path)

    paragraphs = [t.strip() for t in src_doc.texts if t.strip()]

    anchor, next_start = dest_doc.week_boundary(week_keyword)
    if anchor < 0:
        anchor = get_or_create_week(path, week_keyword)
        dest_doc.invalidate()
        dest_doc._load()
        next_start = len(dest_doc)

    last_pos = dest_doc.last_content_para(anchor + 1, next_start)
    insert_pos = max(last_pos, anchor)

    oc_add_para(path, "", insert_pos + 1)
    insert_pos += 1

    for p in paragraphs:
        insert_pos += 1
        oc_add_para(path, p, insert_pos)
