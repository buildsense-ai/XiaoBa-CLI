from __future__ import annotations

from collections import Counter
from copy import deepcopy

from app.data import grade_from_class, stage_for_grade


DAYS = ["周一", "周二", "周三", "周四", "周五"]
SELF_STUDY = {"", "自习"}
MAIN_SUBJECTS = {"语文", "数学", "英语"}
DOUBLE_CAPABLE_SUBJECTS = {"语文", "数学", "英语", "物理", "化学"}
FIXED_ACTIVITY_SUBJECTS = {"升旗", "班会", "班队会", "大课间", "眼保健操", "午休", "早读"}


def build_school_from_imported_state(state: dict, school_scope: str) -> dict:
    imported = state.get("imported_schedule") or {}
    class_stages = imported.get("class_stages") or {}
    imported_classes = imported.get("classes") or {}
    periods_by_stage = deepcopy(imported.get("periods_by_stage") or {})
    classes = [
        class_name
        for class_name in imported.get("class_names", imported_classes.keys())
        if class_name in imported_classes and (school_scope == "全部" or class_stages.get(class_name) == school_scope)
    ]
    if not classes:
        raise ValueError("当前资料包里没有可用于该学段重排的班级课表。")

    periods = periods_for_scope(periods_by_stage, school_scope, class_stages, classes)
    course_counts: Counter[tuple[str, str, str, str]] = Counter()
    fixed_events = []
    review_activity_count = 0
    ordinary_lesson_count = 0

    for class_name in classes:
        week = imported_classes[class_name]
        for day in DAYS:
            for period_index, cell in enumerate(week.get(day, []), start=1):
                if period_index > len(periods):
                    continue
                subject = clean_text(cell.get("subject"))
                teacher = clean_text(cell.get("teacher"))
                room = clean_text(cell.get("room"), "本班教室")
                if subject in SELF_STUDY:
                    continue
                if is_review_activity(cell):
                    review_activity_count += 1
                    fixed_events.append(fixed_event(class_name, day, period_index, subject, teacher, room, "资料包待确认并行活动"))
                    continue
                if is_fixed_activity(cell):
                    fixed_events.append(fixed_event(class_name, day, period_index, subject, teacher, room, "资料包固定活动"))
                    continue
                ordinary_lesson_count += 1
                course_counts[(class_name, subject, teacher, room)] += 1

    courses = []
    for (class_name, subject, teacher, room), weekly_hours in sorted(course_counts.items()):
        grade = grade_from_class(class_name)
        courses.append(
            {
                "class": class_name,
                "grade": grade,
                "stage": class_stages.get(class_name) or stage_for_grade(grade),
                "subject": subject,
                "teacher": teacher or "待分配",
                "weekly_hours": weekly_hours,
                "room": room,
                "can_double": subject in DOUBLE_CAPABLE_SUBJECTS,
            }
        )

    rooms = build_rooms(courses, fixed_events)
    school = {
        "school": {"name": "资料包反推排课数据", "term": "", "version": "derived-from-import"},
        "school_scope": school_scope,
        "stages": summarize_stages(classes, class_stages),
        "grade_settings": summarize_grade_settings(classes, class_stages),
        "grade_counts": summarize_grade_counts(classes),
        "days": DAYS,
        "periods": periods,
        "periods_by_stage": periods_by_stage,
        "classes": classes,
        "class_stages": {class_name: class_stages.get(class_name) or stage_for_grade(grade_from_class(class_name)) for class_name in classes},
        "teachers": summarize_teachers(courses),
        "rooms": rooms,
        "courses": courses,
        "fixed_events": fixed_events,
        "example_rules": [],
    }
    return {
        "school": school,
        "summary": {
            "class_count": len(classes),
            "ordinary_lesson_count": ordinary_lesson_count,
            "fixed_event_count": len(fixed_events),
            "review_activity_count": review_activity_count,
            "inferred_course_count": len(courses),
        },
    }


def compare_generated_to_imported(imported_schedule: dict, generated_classes: dict, school_scope: str) -> dict:
    imported_classes = imported_schedule.get("classes") or {}
    class_stages = imported_schedule.get("class_stages") or {}
    imported_lesson_count = 0
    generated_lesson_count = 0
    same_slot_count = 0
    changed_slot_count = 0
    fixed_preserved_count = 0

    for class_name, generated_week in generated_classes.items():
        if school_scope != "全部" and class_stages.get(class_name) != school_scope:
            continue
        imported_week = imported_classes.get(class_name, {})
        for day in DAYS:
            imported_cells = imported_week.get(day, [])
            generated_cells = generated_week.get(day, [])
            max_len = max(len(imported_cells), len(generated_cells))
            for index in range(max_len):
                imported_cell = imported_cells[index] if index < len(imported_cells) else {}
                generated_cell = generated_cells[index] if index < len(generated_cells) else {}
                imported_subject = clean_text(imported_cell.get("subject"))
                generated_subject = clean_text(generated_cell.get("subject"))
                if imported_subject not in SELF_STUDY:
                    imported_lesson_count += 1
                if generated_subject not in SELF_STUDY:
                    generated_lesson_count += 1
                if imported_subject in SELF_STUDY or generated_subject in SELF_STUDY:
                    continue
                if same_lesson(imported_cell, generated_cell):
                    same_slot_count += 1
                    if generated_cell.get("source") == "fixed":
                        fixed_preserved_count += 1
                else:
                    changed_slot_count += 1

    return {
        "imported_lesson_count": imported_lesson_count,
        "generated_lesson_count": generated_lesson_count,
        "same_slot_count": same_slot_count,
        "changed_slot_count": changed_slot_count,
        "fixed_preserved_count": fixed_preserved_count,
    }


def periods_for_scope(periods_by_stage: dict, school_scope: str, class_stages: dict, classes: list[str]) -> list[dict]:
    if school_scope in periods_by_stage:
        return periods_by_stage[school_scope]
    for class_name in classes:
        stage = class_stages.get(class_name)
        if stage in periods_by_stage:
            return periods_by_stage[stage]
    if periods_by_stage:
        return next(iter(periods_by_stage.values()))
    return [{"number": index, "label": f"第{index}节", "time": ""} for index in range(1, 9)]


def is_review_activity(cell: dict) -> bool:
    subject = clean_text(cell.get("subject"))
    teacher = clean_text(cell.get("teacher"))
    return (
        "/" in subject
        or "、" in teacher
        or "（1-3）" in subject
        or "（4-6）" in subject
        or "(1-3)" in subject
        or "(4-6)" in subject
    )


def is_fixed_activity(cell: dict) -> bool:
    subject = clean_text(cell.get("subject"))
    return subject in FIXED_ACTIVITY_SUBJECTS or cell.get("source") == "fixed"


def fixed_event(class_name: str, day: str, period: int, subject: str, teacher: str, room: str, note: str) -> dict:
    return {
        "class": class_name,
        "day": day,
        "period": period,
        "subject": subject,
        "teacher": teacher,
        "room": room,
        "note": note,
    }


def build_rooms(courses: list[dict], fixed_events: list[dict]) -> list[dict]:
    names = {"本班教室"}
    names.update(course.get("room") or "本班教室" for course in courses)
    names.update(event.get("room") or "本班教室" for event in fixed_events)
    return [room_row(name) for name in sorted(names)]


def room_row(name: str) -> dict:
    if name == "操场":
        return {"name": name, "type": "场地", "capacity": 8, "notes": "资料包反推"}
    if name == "机房A":
        return {"name": name, "type": "专用教室", "capacity": 2, "notes": "资料包反推"}
    if name == "实验室":
        return {"name": name, "type": "专用教室", "capacity": 2, "notes": "资料包反推"}
    return {"name": name, "type": "普通教室", "capacity": 999, "notes": "资料包反推"}


def summarize_teachers(courses: list[dict]) -> list[dict]:
    registry = {}
    for course in courses:
        teacher = course.get("teacher") or "待分配"
        registry.setdefault(teacher, {"name": teacher, "subject": course["subject"], "classes": [], "notes": "资料包反推"})
        if course["class"] not in registry[teacher]["classes"]:
            registry[teacher]["classes"].append(course["class"])
    return list(registry.values())


def summarize_stages(classes: list[str], class_stages: dict) -> list[dict]:
    grouped = {}
    for class_name in classes:
        stage = class_stages.get(class_name) or stage_for_grade(grade_from_class(class_name))
        grouped.setdefault(stage, []).append(class_name)
    return [{"name": stage, "class_count": len(items), "classes": items} for stage, items in grouped.items()]


def summarize_grade_settings(classes: list[str], class_stages: dict) -> list[dict]:
    counts = summarize_grade_counts(classes)
    return [
        {"stage": class_stages.get(f"{grade}(1)") or stage_for_grade(grade), "grade": grade, "class_count": count}
        for grade, count in counts.items()
    ]


def summarize_grade_counts(classes: list[str]) -> dict[str, int]:
    counts = {}
    for class_name in classes:
        grade = grade_from_class(class_name)
        index = int(class_name.split("(")[1].split(")")[0])
        counts[grade] = max(counts.get(grade, 0), index)
    return counts


def same_lesson(left: dict, right: dict) -> bool:
    return clean_text(left.get("subject")) == clean_text(right.get("subject")) and clean_text(left.get("teacher")) == clean_text(right.get("teacher"))


def clean_text(value, default: str = "") -> str:
    text = str(value if value is not None else default).strip()
    return text or default
