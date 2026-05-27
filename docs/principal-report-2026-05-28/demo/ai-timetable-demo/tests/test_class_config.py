from fastapi.testclient import TestClient

from app.data import DEFAULT_GRADE_COUNTS, build_demo_school
from app.main import app


client = TestClient(app)


def test_default_grade_counts_are_six_classes_per_grade():
    school = build_demo_school()

    assert DEFAULT_GRADE_COUNTS == {
        "一年级": 6,
        "二年级": 6,
        "三年级": 6,
        "四年级": 6,
        "五年级": 6,
        "六年级": 6,
        "七年级": 6,
        "八年级": 6,
        "九年级": 6,
    }
    assert school["grade_counts"]["一年级"] == 6
    assert school["grade_counts"]["九年级"] == 6
    assert "一年级(6)" in school["classes"]
    assert "九年级(6)" in school["classes"]


def test_demo_state_returns_editable_grade_counts():
    response = client.get("/api/demo-state")

    assert response.status_code == 200
    payload = response.json()
    assert payload["grade_counts"]["一年级"] == 6
    assert payload["grade_counts"]["九年级"] == 6
    assert payload["stages"][0]["class_count"] == 36
    assert payload["stages"][1]["class_count"] == 18


def test_solve_accepts_changed_class_counts():
    response = client.post(
        "/api/solve",
        json={
            "messages": [],
            "class_counts": {
                "一年级": 2,
                "二年级": 1,
                "三年级": 1,
                "四年级": 1,
                "五年级": 1,
                "六年级": 1,
                "七年级": 3,
                "八年级": 1,
                "九年级": 1,
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["class_names"] == [
        "一年级(1)",
        "一年级(2)",
        "二年级(1)",
        "三年级(1)",
        "四年级(1)",
        "五年级(1)",
        "六年级(1)",
        "七年级(1)",
        "七年级(2)",
        "七年级(3)",
        "八年级(1)",
        "九年级(1)",
    ]
