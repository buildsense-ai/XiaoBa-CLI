from app.validators import validate_schedule_conflicts, validate_school_data


def test_validation_reports_missing_teacher_and_room():
    school = {
        "courses": [
            {"class": "七年级(1)", "subject": "数学", "teacher": "", "room": ""},
        ],
        "rooms": [],
        "classes": ["七年级(1)"],
    }

    result = validate_school_data(school)

    assert [item["type"] for item in result["missing_information"]] == ["course_teacher", "course_room"]
    assert "七年级(1)数学" in result["missing_information"][0]["message"]


def test_validation_reports_undefined_room():
    school = {
        "courses": [
            {"class": "七年级(1)", "subject": "信息科技", "teacher": "王老师", "room": "机房B"},
        ],
        "rooms": [{"name": "机房A", "capacity": 2}],
        "classes": ["七年级(1)"],
    }

    result = validate_school_data(school)

    assert result["missing_information"][0]["type"] == "undefined_room"
    assert "机房B" in result["missing_information"][0]["message"]


def test_overlay_course_with_empty_room_keeps_defaults_and_reports_missing_room():
    from app.data import apply_editable_data, build_demo_school

    school = build_demo_school({"七年级": 1, "八年级": 1, "九年级": 0}, "初中")
    updated = apply_editable_data(
        school,
        courses=[
            {
                "grade": "七年级",
                "subject": "心理",
                "weekly_hours": 1,
                "teacher": "",
                "room": "",
                "classes": ["七年级(1)"],
            }
        ],
    )

    result = validate_school_data(updated)
    types = [item["type"] for item in result["missing_information"]]

    assert "course_teacher" in types
    assert "course_room" in types
    assert "class_courses" not in types
    assert any(course["class"] == "八年级(1)" and course["subject"] == "数学" for course in updated["courses"])


def test_schedule_conflict_validation_reports_teacher_collision():
    school = {
        "rooms": [{"name": "本班教室", "capacity": 999}],
        "days": ["周一"],
    }
    schedule = {
        "七年级(1)": {"周一": [{"subject": "数学", "teacher": "王老师", "room": "本班教室"}]},
        "七年级(2)": {"周一": [{"subject": "数学", "teacher": "王老师", "room": "本班教室"}]},
    }

    conflicts = validate_schedule_conflicts(school, schedule)

    assert conflicts[0]["type"] == "teacher"
    assert "王老师" in conflicts[0]["description"]
