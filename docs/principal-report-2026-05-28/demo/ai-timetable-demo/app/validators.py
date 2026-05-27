from __future__ import annotations

from collections import defaultdict


SELF_STUDY = {"", "自习"}


def validate_school_data(school: dict) -> dict:
    missing = []
    warnings = []
    rooms = {room.get("name") for room in school.get("rooms", []) if room.get("name")}
    courses_by_class = defaultdict(list)

    for course in school.get("courses", []):
        class_name = course.get("class", "")
        subject = course.get("subject", "")
        label = f"{class_name}{subject}"
        courses_by_class[class_name].append(course)
        teacher = str(course.get("teacher") or "").strip()
        room = str(course.get("room") or "").strip()
        if not teacher or teacher == "待分配":
            missing.append(
                {
                    "type": "course_teacher",
                    "message": f"{label}缺少任课老师",
                    "suggestion": f"请补充{label}的任课老师，或明确标记为临时代课。",
                }
            )
        if not room:
            missing.append(
                {
                    "type": "course_room",
                    "message": f"{label}缺少上课地点",
                    "suggestion": f"请补充{label}的上课地点，例如本班教室、操场、实验室。",
                }
            )
        elif room != "本班教室" and room not in rooms:
            missing.append(
                {
                    "type": "undefined_room",
                    "message": f"{label}使用的{room}还没有在教室资料中定义",
                    "suggestion": f"请新增{room}，或把该课程地点改为已有教室。",
                }
            )

    for class_name in school.get("classes", []):
        if not courses_by_class[class_name]:
            missing.append(
                {
                    "type": "class_courses",
                    "message": f"{class_name}没有课程数据",
                    "suggestion": f"请补充{class_name}的课程课时，或检查班级数量是否设置过多。",
                }
            )

    return {"missing_information": missing, "warnings": warnings}


def validate_schedule_conflicts(school: dict, schedule: dict) -> list[dict]:
    conflicts = []
    teacher_slots = defaultdict(list)
    room_slots = defaultdict(list)
    room_capacity = {room.get("name"): int(room.get("capacity") or 1) for room in school.get("rooms", [])}

    for class_name, week in schedule.items():
        for day, cells in week.items():
            for index, cell in enumerate(cells, start=1):
                subject = cell.get("subject", "")
                teacher = cell.get("teacher", "")
                room = cell.get("room", "")
                if cell.get("source") == "fixed":
                    continue
                if subject in SELF_STUDY:
                    continue
                if teacher and teacher not in {"班主任", "德育处"}:
                    teacher_slots[(day, index, teacher)].append(f"{class_name}{subject}")
                if room and room_capacity.get(room, 999) < 999:
                    room_slots[(day, index, room)].append(f"{class_name}{subject}")

    for (day, period, teacher), items in teacher_slots.items():
        if len(items) > 1:
            conflicts.append(
                {
                    "type": "teacher",
                    "title": f"{teacher}时间冲突",
                    "description": f"{teacher}在{day}第{period}节同时安排了{', '.join(items)}。",
                    "suggestion": f"保留一个班在该节次，把其余课程移动到空白节次，或更换任课老师。",
                }
            )

    for (day, period, room), items in room_slots.items():
        limit = room_capacity.get(room, 1)
        if len(items) > limit:
            conflicts.append(
                {
                    "type": "room",
                    "title": f"{room}容量冲突",
                    "description": f"{room}在{day}第{period}节安排了{len(items)}个班，容量是{limit}个班。",
                    "suggestion": f"移动部分课程到其他节次，或调整{room}容量。",
                }
            )

    return conflicts
