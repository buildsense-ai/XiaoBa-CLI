from app.rules import parse_teacher_rule, parse_text_rule


def test_parse_middle_school_pe_first_period_rule_as_teacher_friendly_card():
    rule = parse_text_rule("九年级不要第一节体育课")

    assert rule["kind"] == "avoid_subject_period"
    assert rule["scope"]["grade"] == "九年级"
    assert rule["scope"]["subject"] == "体育"
    assert rule["period"] == 1
    assert rule["strictness"] == "hard"
    assert rule["summary"] == "九年级体育课不安排在第1节"


def test_parse_primary_school_pe_first_period_rule():
    rule = parse_text_rule("五年级不要第一节体育课")

    assert rule["kind"] == "avoid_subject_period"
    assert rule["scope"]["grade"] == "五年级"
    assert rule["scope"]["subject"] == "体育"
    assert rule["summary"] == "五年级体育课不安排在第1节"


def test_parse_teacher_unavailable_afternoon_rule():
    rule = parse_text_rule("王老师周三下午不能上课")

    assert rule["kind"] == "teacher_unavailable"
    assert rule["teacher"] == "王老师"
    assert rule["day"] == "周三"
    assert rule["periods"] == [5, 6, 7, 8]
    assert rule["summary"] == "王老师周三下午不排课"


def test_parse_multi_day_morning_subject_rule_as_hard_constraint():
    rule = parse_text_rule("周一周二的早上七年级都不能有语文课 语文老师需要去培训")

    assert rule["kind"] == "avoid_subject_slots"
    assert rule["scope"]["grade"] == "七年级"
    assert rule["scope"]["subject"] == "语文"
    assert rule["days"] == ["周一", "周二"]
    assert rule["periods"] == [1, 2, 3, 4]
    assert rule["strictness"] == "hard"
    assert rule["summary"] == "七年级语文课不安排在周一、周二上午"


def test_parse_exam_double_period_rule():
    rule = parse_text_rule("七年级数学要连排两节考试")

    assert rule["kind"] == "double_lesson"
    assert rule["scope"]["grade"] == "七年级"
    assert rule["scope"]["subject"] == "数学"
    assert rule["length"] == 2
    assert rule["summary"] == "七年级数学安排连续2节用于考试或检测"


def test_unknown_text_becomes_review_needed_card():
    rule = parse_text_rule("下周安排一下比较轻松的课程")

    assert rule["kind"] == "review_needed"
    assert rule["summary"] == "这条要求还需要补充细节才能参与排课"


def test_teacher_rule_accepts_common_name_without_teacher_suffix():
    rule = parse_teacher_rule("王明周五下午请假")

    assert rule["teacher"] == "王明"
    assert rule["day"] == "周五"
    assert rule["periods"] == [5, 6, 7, 8]
