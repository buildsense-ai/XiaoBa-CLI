from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from math import ceil
import re


GRADE_ORDER = [
    ("小学", "一年级"),
    ("小学", "二年级"),
    ("小学", "三年级"),
    ("小学", "四年级"),
    ("小学", "五年级"),
    ("小学", "六年级"),
    ("初中", "七年级"),
    ("初中", "八年级"),
    ("初中", "九年级"),
]
DEFAULT_CLASS_COUNTS = {grade: 6 for _, grade in GRADE_ORDER}
DEFAULT_GRADE_COUNTS = DEFAULT_CLASS_COUNTS

COURSE_HOURS = {
    "一年级": {"语文": 6, "数学": 4, "英语": 2, "道法": 1, "科学": 1, "体育": 3, "音乐": 2, "美术": 2, "劳动": 1},
    "二年级": {"语文": 6, "数学": 4, "英语": 2, "道法": 1, "科学": 1, "体育": 3, "音乐": 2, "美术": 2, "劳动": 1},
    "三年级": {"语文": 5, "数学": 5, "英语": 3, "道法": 2, "科学": 2, "体育": 3, "音乐": 1, "美术": 1, "信息科技": 1, "劳动": 1},
    "四年级": {"语文": 5, "数学": 5, "英语": 3, "道法": 2, "科学": 2, "体育": 3, "音乐": 1, "美术": 1, "信息科技": 1, "劳动": 1},
    "五年级": {"语文": 5, "数学": 5, "英语": 3, "道法": 2, "科学": 2, "体育": 3, "音乐": 1, "美术": 1, "信息科技": 1, "劳动": 1},
    "六年级": {"语文": 5, "数学": 5, "英语": 3, "道法": 2, "科学": 2, "体育": 3, "音乐": 1, "美术": 1, "信息科技": 1, "劳动": 1},
    "七年级": {"语文": 5, "数学": 5, "英语": 5, "道法": 2, "历史": 2, "地理": 2, "生物": 2, "体育": 3, "信息科技": 1, "音乐": 1, "美术": 1, "劳动": 1},
    "八年级": {"语文": 5, "数学": 5, "英语": 5, "物理": 3, "道法": 2, "历史": 2, "地理": 2, "生物": 2, "体育": 3, "信息科技": 1, "音乐": 1, "美术": 1, "劳动": 1},
    "九年级": {"语文": 5, "数学": 5, "英语": 5, "物理": 3, "化学": 3, "道法": 2, "历史": 2, "体育": 3, "信息科技": 1, "劳动": 1},
}

TEACHER_SURNAMES = [
    "陈",
    "李",
    "周",
    "赵",
    "刘",
    "黄",
    "吴",
    "郑",
    "孙",
    "何",
    "郭",
    "马",
    "胡",
    "林",
    "罗",
    "梁",
    "宋",
    "唐",
    "许",
    "邓",
    "冯",
    "曹",
    "彭",
    "曾",
    "田",
    "董",
    "袁",
    "潘",
    "杜",
    "叶",
]
TEACHER_GIVEN_NAMES = ["", "", "", "明", "芳", "静", "华", "敏", "强", "丽", "军", "霞", "磊", "娜", "杰", "梅"]


def build_demo_school(class_counts: dict[str, int] | None = None, school_scope: str = "全部") -> dict:
    """Build configurable primary/middle-school data for the demo."""
    # 构建所有学段的课时时间（始终包含小学和初中，即使该学段没有班级）
    periods_by_stage = {"小学": build_periods_from_start("08:50"), "初中": build_periods_from_start("08:00")}
    counts = normalized_class_counts(class_counts)
    counts = apply_school_scope(counts, school_scope)
    classes = build_classes(counts)
    class_stages = class_stage_map(classes)
    courses = build_courses(classes)
    teachers = summarize_teachers(courses, classes)
    fixed_events = build_fixed_events(classes)

    return {
        "school": {"name": "小学/初中智能排课演示数据", "term": "2026 春季学期", "version": "Web 演示版"},
        "school_scope": school_scope,
        "stages": summarize_stages(classes),
        "grade_settings": [
            {"stage": stage, "grade": grade, "class_count": counts[grade]}
            for stage, grade in GRADE_ORDER
        ],
        "grade_counts": counts,
        "days": ["周一", "周二", "周三", "周四", "周五"],
        "periods": periods_for_scope(periods_by_stage, school_scope),
        "periods_by_stage": periods_by_stage,
        "classes": classes,
        "class_stages": class_stages,
        "teachers": teachers,
        "rooms": build_rooms(),
        "courses": courses,
        "fixed_events": fixed_events,
        "example_rules": [
            "九年级不要第一节体育课",
            "王老师周三下午不能上课",
            "七年级数学要连排两节考试",
            "小学9点上课",
            "语数英尽量排上午",
            "机房周四第3-4节维修",
        ],
    }


def apply_editable_data(
    school: dict,
    teachers: list[dict] | None = None,
    rooms: list[dict] | None = None,
    courses: list[dict] | None = None,
) -> dict:
    """Apply data maintained from the page without requiring teachers to edit JSON."""
    if rooms is not None:
        school["rooms"] = normalize_room_rows(rooms, school["rooms"])
    if courses is not None:
        school["courses"] = expand_course_rows(courses, school)
    if teachers is not None:
        apply_teacher_rows(school, teachers)
    school["teachers"] = summarize_teachers(school["courses"], school["classes"])
    return school


def normalize_room_rows(rows: list[dict], fallback_rooms: list[dict]) -> list[dict]:
    fallback_by_name = {room["name"]: room for room in fallback_rooms}
    rooms = []
    for row in rows:
        name = clean_text(row.get("name"))
        if not name:
            continue
        fallback = fallback_by_name.get(name, {})
        rooms.append(
            {
                "name": name,
                "type": clean_text(row.get("type"), fallback.get("type", "普通教室")),
                "capacity": bounded_int(row.get("capacity"), fallback.get("capacity", 1), minimum=1, maximum=999),
                "notes": clean_text(row.get("notes"), fallback.get("notes", "")),
            }
        )
    return rooms or fallback_rooms


def expand_course_rows(rows: list[dict], school: dict) -> list[dict]:
    if not rows:
        return school["courses"]
    existing = {(course["class"], course["subject"]): dict(course) for course in school["courses"]}
    course_order = [(course["class"], course["subject"]) for course in school["courses"]]
    valid_classes = set(school["classes"])
    for row in rows:
        grade = clean_text(row.get("grade"))
        subject = clean_text(row.get("subject"))
        if not grade or not subject:
            continue
        target_classes = clean_classes(row.get("classes"))
        if target_classes:
            target_classes = [class_name for class_name in target_classes if class_name in valid_classes]
        else:
            target_classes = [class_name for class_name in school["classes"] if grade_from_class(class_name) == grade]
        for class_name in target_classes:
            fallback = existing.get((class_name, subject), {})
            weekly_hours = bounded_int(row.get("weekly_hours"), fallback.get("weekly_hours", 1), minimum=0, maximum=12)
            key = (class_name, subject)
            if key not in existing:
                course_order.append(key)
            existing[key] = {
                "class": class_name,
                "grade": grade_from_class(class_name),
                "stage": stage_for_grade(grade_from_class(class_name)),
                "subject": subject,
                "teacher": row_text(row, "teacher", fallback.get("teacher", "待分配")),
                "weekly_hours": weekly_hours,
                "room": row_text(row, "room", fallback.get("room", room_for_subject(subject))),
                "can_double": bool(fallback.get("can_double", subject in {"语文", "数学", "英语", "物理", "化学"})),
            }
    return [existing[key] for key in course_order if key in existing]


def apply_teacher_rows(school: dict, rows: list[dict]) -> None:
    for row in rows:
        name = clean_text(row.get("name"))
        subject = clean_text(row.get("subject"))
        classes = set(clean_classes(row.get("classes")))
        if not name or not subject or not classes:
            continue
        for course in school["courses"]:
            if course["subject"] == subject and course["class"] in classes:
                course["teacher"] = name


def clean_classes(value) -> list[str]:
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = re.split(r"[、,，;；\s]+", str(value or ""))
    return [clean_text(item) for item in raw_items if clean_text(item)]


def clean_text(value, default: str = "") -> str:
    text = str(value if value is not None else default).strip()
    return text or default


def row_text(row: dict, key: str, default: str = "") -> str:
    if key not in row:
        return default
    return str(row.get(key) or "").strip()


def bounded_int(value, default: int, minimum: int = 0, maximum: int = 999) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = int(default)
    return max(minimum, min(maximum, number))


def normalized_class_counts(class_counts: dict[str, int] | None = None) -> dict[str, int]:
    counts = dict(DEFAULT_CLASS_COUNTS)
    for grade, value in (class_counts or {}).items():
        if grade in counts:
            counts[grade] = max(0, min(12, int(value)))
    return counts


def apply_school_scope(counts: dict[str, int], school_scope: str) -> dict[str, int]:
    if school_scope not in {"小学", "初中"}:
        return counts
    filtered = dict(counts)
    for _, grade in GRADE_ORDER:
        if stage_for_grade(grade) != school_scope:
            filtered[grade] = 0
    return filtered


def build_classes(counts: dict[str, int]) -> list[str]:
    classes = []
    for _, grade in GRADE_ORDER:
        count = max(0, counts.get(grade, 0))
        classes.extend(f"{grade}({index})" for index in range(1, count + 1))
    return classes


def build_courses(classes: list[str]) -> list[dict]:
    courses = []
    for class_name in classes:
        grade = grade_from_class(class_name)
        stage = stage_for_grade(grade)
        class_index = class_index_from_class(class_name)
        for subject, hours in COURSE_HOURS[grade].items():
            courses.append(
                {
                    "class": class_name,
                    "grade": grade,
                    "stage": stage,
                    "subject": subject,
                    "teacher": teacher_for(grade, subject, class_name, class_index),
                    "weekly_hours": hours,
                    "room": room_for_subject(subject),
                    "can_double": subject in {"语文", "数学", "英语", "物理", "化学"},
                }
            )
    return courses


def teacher_for(grade: str, subject: str, class_name: str, class_index: int) -> str:
    if subject == "劳动":
        return f"{class_name}班主任"
    if grade == "九年级" and subject == "数学" and class_index <= 2:
        return "王老师"
    group = ceil(class_index / 2)
    return realistic_teacher_name(grade, subject, group)


def realistic_teacher_name(grade: str, subject: str, group: int) -> str:
    grade_index = [grade for _, grade in GRADE_ORDER].index(grade)
    subjects = list(COURSE_HOURS[grade].keys())
    subject_index = subjects.index(subject)
    index = grade_index * 31 + subject_index * 3 + group - 1
    surname = TEACHER_SURNAMES[index % len(TEACHER_SURNAMES)]
    given = TEACHER_GIVEN_NAMES[(index // len(TEACHER_SURNAMES)) % len(TEACHER_GIVEN_NAMES)]
    return f"{surname}{given}老师"


def summarize_teachers(courses: list[dict], classes: list[str]) -> list[dict]:
    registry: dict[str, dict] = {}
    for course in courses:
        teacher = course["teacher"]
        if teacher not in registry:
            registry[teacher] = {"name": teacher, "subject": course["subject"], "classes": [], "notes": teacher_note(course)}
        if course["class"] not in registry[teacher]["classes"]:
            registry[teacher]["classes"].append(course["class"])
    return list(registry.values())


def teacher_note(course: dict) -> str:
    subject = course["subject"]
    if subject in {"语文", "数学", "英语"}:
        return "主科尽量排上午，检测可连排"
    if subject == "信息科技":
        return "使用机房，同一时间受机房容量限制"
    if subject == "体育":
        return "操场同一节可安排多个班，但有容量限制"
    if subject in {"物理", "化学"}:
        return "实验相关课程可使用实验室"
    return "可按学校实际教研时间继续补充"


def build_fixed_events(classes: list[str]) -> list[dict]:
    fixed_events = []
    for class_name in classes:
        fixed_events.append({"class": class_name, "day": "周一", "period": 1, "subject": "升旗", "teacher": "德育处", "room": "操场", "note": "固定活动"})
        fixed_events.append({"class": class_name, "day": "周五", "period": 6, "subject": "班会", "teacher": f"{class_name}班主任", "room": "本班教室", "note": "固定活动"})
    return fixed_events


def build_rooms() -> list[dict]:
    return [
        {"name": "本班教室", "type": "普通教室", "capacity": 999, "notes": "每个班默认自己的教室"},
        {"name": "机房A", "type": "专用教室", "capacity": 2, "notes": "信息科技课使用，可按学校机房数量调整"},
        {"name": "实验室", "type": "专用教室", "capacity": 2, "notes": "初中物理、化学和小学科学活动可使用"},
        {"name": "操场", "type": "场地", "capacity": 8, "notes": "体育课可多个班同时上，容量可配置"},
    ]


def summarize_stages(classes: list[str]) -> list[dict]:
    by_stage = defaultdict(list)
    for class_name in classes:
        by_stage[stage_for_grade(grade_from_class(class_name))].append(class_name)
    return [
        {"name": "小学", "class_count": len(by_stage["小学"]), "classes": by_stage["小学"]},
        {"name": "初中", "class_count": len(by_stage["初中"]), "classes": by_stage["初中"]},
    ]


def class_stage_map(classes: list[str]) -> dict[str, str]:
    return {class_name: stage_for_grade(grade_from_class(class_name)) for class_name in classes}


def apply_time_rules(school: dict, rules: list[dict]) -> dict:
    for rule in rules:
        if rule.get("kind") == "stage_start_time":
            school["periods_by_stage"][rule["stage"]] = build_periods_from_start(rule["start_time"])
    school["periods"] = periods_for_scope(school["periods_by_stage"], school.get("school_scope", "全部"))
    return school


def periods_for_scope(periods_by_stage: dict[str, list[dict]], school_scope: str) -> list[dict]:
    if school_scope in periods_by_stage:
        return periods_by_stage[school_scope]
    return periods_by_stage["初中"]


def build_periods_from_start(start_time: str) -> list[dict]:
    start = datetime.strptime(start_time, "%H:%M")
    morning_offsets = [0, 55, 120, 175]
    afternoon_starts = ["14:00", "14:55", "15:50", "16:45"]
    starts = [start + timedelta(minutes=offset) for offset in morning_offsets]
    starts.extend(datetime.strptime(value, "%H:%M") for value in afternoon_starts)
    periods = []
    for index, period_start in enumerate(starts, start=1):
        period_end = period_start + timedelta(minutes=45)
        periods.append({"number": index, "label": f"第{index}节", "time": f"{period_start:%H:%M}-{period_end:%H:%M}"})
    return periods


def grade_from_class(class_name: str) -> str:
    return class_name.split("(")[0]


def class_index_from_class(class_name: str) -> int:
    return int(class_name.split("(")[1].split(")")[0])


def stage_for_grade(grade: str) -> str:
    return "小学" if grade in {"一年级", "二年级", "三年级", "四年级", "五年级", "六年级"} else "初中"


def room_for_subject(subject: str) -> str:
    if subject == "信息科技":
        return "机房A"
    if subject == "体育":
        return "操场"
    if subject in {"物理", "化学"}:
        return "实验室"
    return "本班教室"
