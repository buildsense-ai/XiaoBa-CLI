from app.manual_ops import move_lesson, swap_lessons


def test_move_lesson_moves_solver_cell_to_empty_slot():
    schedule = {
        "七年级(1)": {
            "周一": [
                {"subject": "数学", "teacher": "王老师", "room": "本班教室", "source": "solver", "movable": True},
                {"subject": "自习", "teacher": "", "room": "本班教室", "source": "empty", "movable": False},
            ],
        }
    }

    result = move_lesson(schedule, "七年级(1)", "周一", 1, "周一", 2)

    assert result["ok"] is True
    assert schedule["七年级(1)"]["周一"][0]["subject"] == "自习"
    assert schedule["七年级(1)"]["周一"][1]["subject"] == "数学"
    assert schedule["七年级(1)"]["周一"][1]["source"] == "manual"


def test_move_lesson_requires_force_for_occupied_target():
    schedule = {
        "七年级(1)": {
            "周一": [
                {"subject": "数学", "teacher": "王老师", "room": "本班教室", "source": "solver", "movable": True},
                {"subject": "英语", "teacher": "李老师", "room": "本班教室", "source": "solver", "movable": True},
            ],
        }
    }

    result = move_lesson(schedule, "七年级(1)", "周一", 1, "周一", 2)

    assert result["ok"] is False
    assert "已有课程" in result["message"]


def test_move_lesson_does_not_move_fixed_source_even_with_force():
    schedule = {
        "七年级(1)": {
            "周一": [
                {"subject": "升旗", "teacher": "德育处", "room": "操场", "source": "fixed", "movable": False},
                {"subject": "自习", "teacher": "", "room": "本班教室", "source": "empty", "movable": False},
            ],
        }
    }

    result = move_lesson(schedule, "七年级(1)", "周一", 1, "周一", 2, force=True)

    assert result["ok"] is False
    assert "固定活动" in result["message"]
    assert schedule["七年级(1)"]["周一"][0]["subject"] == "升旗"


def test_move_lesson_does_not_overwrite_fixed_target_even_with_force():
    schedule = {
        "七年级(1)": {
            "周一": [
                {"subject": "数学", "teacher": "王老师", "room": "本班教室", "source": "solver", "movable": True},
                {"subject": "升旗", "teacher": "德育处", "room": "操场", "source": "fixed", "movable": False},
            ],
        }
    }

    result = move_lesson(schedule, "七年级(1)", "周一", 1, "周一", 2, force=True)

    assert result["ok"] is False
    assert "固定活动" in result["message"]
    assert schedule["七年级(1)"]["周一"][1]["subject"] == "升旗"


def test_swap_lesson_swaps_two_cells():
    schedule = {
        "七年级(1)": {
            "周一": [{"subject": "数学", "teacher": "王老师", "room": "本班教室", "source": "solver", "movable": True}],
            "周二": [{"subject": "英语", "teacher": "李老师", "room": "本班教室", "source": "solver", "movable": True}],
        }
    }

    result = swap_lessons(schedule, "七年级(1)", "周一", 1, "七年级(1)", "周二", 1)

    assert result["ok"] is True
    assert schedule["七年级(1)"]["周一"][0]["subject"] == "英语"
    assert schedule["七年级(1)"]["周二"][0]["subject"] == "数学"


def test_swap_lesson_does_not_swap_fixed_activity():
    schedule = {
        "七年级(1)": {
            "周一": [{"subject": "升旗", "teacher": "德育处", "room": "操场", "source": "fixed", "movable": False}],
            "周二": [{"subject": "英语", "teacher": "李老师", "room": "本班教室", "source": "solver", "movable": True}],
        }
    }

    result = swap_lessons(schedule, "七年级(1)", "周一", 1, "七年级(1)", "周二", 1)

    assert result["ok"] is False
    assert "固定活动" in result["message"]
    assert schedule["七年级(1)"]["周一"][0]["subject"] == "升旗"
