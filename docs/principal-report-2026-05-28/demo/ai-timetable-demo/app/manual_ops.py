from __future__ import annotations

from copy import deepcopy


def move_lesson(schedule: dict, class_name: str, from_day: str, from_period: int, to_day: str, to_period: int, force: bool = False) -> dict:
    source = get_cell(schedule, class_name, from_day, from_period)
    target = get_cell(schedule, class_name, to_day, to_period)
    if source is None or target is None:
        return {"ok": False, "message": "没有找到要调整的班级或节次。", "operation": "move"}
    if is_empty_cell(source):
        return {"ok": False, "message": "原位置是空白节次，没有课程可移动。", "operation": "move"}
    if is_fixed_cell(source):
        return {"ok": False, "message": "原位置是固定活动，不能通过普通手动调整移动。", "operation": "move"}
    if is_fixed_cell(target):
        return {"ok": False, "message": "目标位置是固定活动，不能覆盖。", "operation": "move"}
    if not is_empty_cell(target) and not force:
        return {"ok": False, "message": "目标位置已有课程，如需覆盖请使用 force。", "operation": "move"}

    moved = deepcopy(source)
    moved["source"] = "manual"
    moved["movable"] = True
    schedule[class_name][to_day][to_period - 1] = moved
    schedule[class_name][from_day][from_period - 1] = empty_cell(source.get("room", "本班教室"))
    return {
        "ok": True,
        "message": f"已把{class_name}{from_day}第{from_period}节移动到{to_day}第{to_period}节。",
        "operation": "move",
        "warnings": [] if is_empty_cell(target) else ["目标节次原课程已被覆盖。"],
    }


def swap_lessons(schedule: dict, left_class: str, left_day: str, left_period: int, right_class: str, right_day: str, right_period: int) -> dict:
    left = get_cell(schedule, left_class, left_day, left_period)
    right = get_cell(schedule, right_class, right_day, right_period)
    if left is None or right is None:
        return {"ok": False, "message": "没有找到要交换的班级或节次。", "operation": "swap"}
    if is_empty_cell(left) and is_empty_cell(right):
        return {"ok": False, "message": "两个位置都是空白节次，没有课程可交换。", "operation": "swap"}
    if is_fixed_cell(left) or is_fixed_cell(right):
        return {"ok": False, "message": "固定活动不能通过普通手动调整交换。", "operation": "swap"}
    schedule[left_class][left_day][left_period - 1] = mark_manual(right)
    schedule[right_class][right_day][right_period - 1] = mark_manual(left)
    return {
        "ok": True,
        "message": f"已交换{left_class}{left_day}第{left_period}节和{right_class}{right_day}第{right_period}节。",
        "operation": "swap",
        "warnings": [],
    }


def lock_cell(schedule: dict, class_name: str, day: str, period: int, reason: str = "") -> dict:
    cell = get_cell(schedule, class_name, day, period)
    if cell is None:
        return {"ok": False, "message": "没有找到要锁定的班级或节次。", "operation": "lock"}
    cell["movable"] = False
    cell["locked"] = True
    if reason:
        cell["note"] = reason
    return {"ok": True, "message": f"已锁定{class_name}{day}第{period}节。", "operation": "lock", "warnings": []}


def get_cell(schedule: dict, class_name: str, day: str, period: int) -> dict | None:
    try:
        return schedule[class_name][day][period - 1]
    except (KeyError, IndexError, TypeError):
        return None


def is_empty_cell(cell: dict) -> bool:
    return cell.get("source") == "empty" or cell.get("subject") in {"", "自习"}


def is_fixed_cell(cell: dict) -> bool:
    return cell.get("source") == "fixed" or cell.get("movable") is False and cell.get("subject") not in {"", "自习"}


def empty_cell(room: str = "本班教室") -> dict:
    return {"subject": "自习", "teacher": "", "room": room, "note": "", "source": "empty", "movable": False}


def mark_manual(cell: dict) -> dict:
    updated = deepcopy(cell)
    updated["source"] = "manual"
    updated["movable"] = True
    return updated
