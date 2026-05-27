from app.data import build_demo_school
from app.rules import parse_text_rule
from app.solver import solve_timetable


def test_demo_school_has_six_classes_per_primary_and_middle_grade():
    school = build_demo_school()

    assert school["school"]["name"] == "小学/初中智能排课演示数据"
    assert all(item["class_count"] == 6 for item in school["grade_settings"])
    assert school["stages"][0]["class_count"] == 36
    assert school["stages"][1]["class_count"] == 18
    assert len(school["classes"]) == 54
    assert "一年级(6)" in school["classes"]
    assert "九年级(6)" in school["classes"]
    assert not any(class_name.startswith("高") for class_name in school["classes"])


def test_demo_school_accepts_class_count_overrides():
    school = build_demo_school({"一年级": 2, "七年级": 1})

    assert "一年级(1)" in school["classes"]
    assert "一年级(2)" in school["classes"]
    assert "一年级(3)" not in school["classes"]
    assert "七年级(1)" in school["classes"]
    assert "七年级(2)" not in school["classes"]


def test_solver_generates_schedule_without_hard_conflicts_for_custom_small_config():
    school = build_demo_school({"一年级": 2, "七年级": 2, "八年级": 1, "九年级": 2})
    result = solve_timetable(school, [])

    assert result["status"] == "success"
    assert result["conflict_count"] == 0
    assert "九年级(1)" in result["classes"]
    assert result["classes"]["九年级(1)"]["周一"][0]["subject"] == "升旗"
    assert result["classes"]["九年级(1)"]["周五"][5]["subject"] == "班会"


def test_solver_uses_fast_path_for_large_school(monkeypatch):
    school = build_demo_school(school_scope="初中")

    def fail_if_precise_solver_runs(*args, **kwargs):
        raise AssertionError("large school should not wait for the precise solver before returning")

    monkeypatch.setattr("app.solver.cp_model.CpSolver.Solve", fail_if_precise_solver_runs)
    result = solve_timetable(school, [])

    assert result["status"] == "success"
    assert result["stats"]["classes"] == 18


def test_solver_spreads_subjects_like_a_real_timetable():
    school = build_demo_school(school_scope="初中")
    result = solve_timetable(school, [])

    assert result["status"] == "success"
    for class_name, week in result["classes"].items():
        for day, cells in week.items():
            subjects = [cell["subject"] for cell in cells if cell["subject"] not in {"自习", "升旗", "班会"}]
            for subject in set(subjects):
                assert subjects.count(subject) <= 2, f"{class_name} {day} has too many {subject}"
            for left, right in zip(cells, cells[1:]):
                if left["subject"] in {"自习", "升旗", "班会"}:
                    continue
                assert left["subject"] != right["subject"], f"{class_name} {day} has consecutive {left['subject']}"


def test_solver_respects_grade_subject_first_period_rule():
    school = build_demo_school({"九年级": 2})
    rule = parse_text_rule("九年级不要第一节体育课")
    result = solve_timetable(school, [rule])

    assert result["status"] == "success"
    for class_name, week in result["classes"].items():
        if class_name.startswith("九年级"):
            first_period_subjects = [week[day][0]["subject"] for day in school["days"]]
            assert "体育" not in first_period_subjects


def test_solver_respects_multi_day_morning_subject_rule():
    school = build_demo_school({"七年级": 2, "八年级": 0, "九年级": 0}, "初中")
    rule = parse_text_rule("周一周二的早上七年级都不能有语文课 语文老师需要去培训")
    result = solve_timetable(school, [rule])

    assert result["status"] == "success"
    assert "七年级语文课不安排在周一、周二上午" in result["applied_rules"]
    for class_name, week in result["classes"].items():
        if class_name.startswith("七年级"):
            for day in ["周一", "周二"]:
                morning_subjects = [cell["subject"] for cell in week[day][:4]]
                assert "语文" not in morning_subjects


def test_fast_solver_respects_fixed_subject_slot_rule():
    school = build_demo_school({"七年级": 9, "八年级": 0, "九年级": 0}, "初中")
    for course in school["courses"]:
        if course["grade"] == "七年级" and course["subject"] == "数学":
            course["teacher"] = f"{course['class']}数学老师"
    school["teachers"] = []
    rule = parse_text_rule("七年级数学固定安排在周五第8节")

    result = solve_timetable(school, [rule])

    assert result["status"] == "success"
    for class_name, week in result["classes"].items():
        if class_name.startswith("七年级"):
            assert week["周五"][7]["subject"] == "数学"


def test_solver_respects_teacher_unavailable_rule():
    school = build_demo_school({"九年级": 2})
    rule = parse_text_rule("王老师周三下午不能上课")
    result = solve_timetable(school, [rule])

    assert result["status"] == "success"
    for item in result["teacher_schedules"]["王老师"]:
        assert not (item["day"] == "周三" and item["period"] in [5, 6, 7, 8])


def test_solver_marks_double_lesson_rule_as_applied():
    school = build_demo_school({"七年级": 2})
    rule = parse_text_rule("七年级数学要连排两节考试")
    result = solve_timetable(school, [rule])

    assert result["status"] == "success"
    assert "七年级数学安排连续2节用于考试或检测" in result["applied_rules"]
    for class_name, week in result["classes"].items():
        if not class_name.startswith("七年级"):
            continue
        math_positions = []
        for day_index, day in enumerate(school["days"]):
            for period_index, cell in enumerate(week[day]):
                if cell["subject"] == "数学":
                    math_positions.append((day_index, period_index))
        consecutive = any(
            left_day == right_day and right_period == left_period + 1
            for left_day, left_period in math_positions
            for right_day, right_period in math_positions
        )
        assert consecutive
