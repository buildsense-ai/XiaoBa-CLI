from app.data import apply_editable_data, build_demo_school
from app.main import app
from fastapi.testclient import TestClient


client = TestClient(app)


def test_teacher_form_data_updates_matching_course_teacher():
    school = build_demo_school({"七年级": 1, "八年级": 0, "九年级": 0}, "初中")

    updated = apply_editable_data(
        school,
        teachers=[{"name": "赵老师", "subject": "数学", "classes": ["七年级(1)"], "notes": "周三教研"}],
        rooms=None,
        courses=None,
    )

    math_course = next(course for course in updated["courses"] if course["class"] == "七年级(1)" and course["subject"] == "数学")
    assert math_course["teacher"] == "赵老师"


def test_room_form_data_updates_room_capacity():
    school = build_demo_school({"七年级": 1, "八年级": 0, "九年级": 0}, "初中")

    updated = apply_editable_data(
        school,
        teachers=None,
        rooms=[{"name": "操场", "type": "场地", "capacity": 1, "notes": "只开放半边操场"}],
        courses=None,
    )

    playground = next(room for room in updated["rooms"] if room["name"] == "操场")
    assert playground["capacity"] == 1
    assert playground["notes"] == "只开放半边操场"


def test_solve_endpoint_uses_added_course_data():
    response = client.post(
        "/api/solve",
        json={
            "school_scope": "初中",
            "class_counts": {"七年级": 1, "八年级": 0, "九年级": 0},
            "courses": [
                {
                    "grade": "七年级",
                    "subject": "心理",
                    "weekly_hours": 1,
                    "teacher": "心理老师",
                    "room": "本班教室",
                    "classes": ["七年级(1)"],
                }
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    lessons = [cell["subject"] for cells in payload["classes"]["七年级(1)"].values() for cell in cells]
    assert "心理" in lessons
