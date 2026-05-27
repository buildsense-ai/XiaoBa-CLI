from fastapi.testclient import TestClient

from app.main import app
from app.repository import JsonTimetableRepository


client = TestClient(app)


def test_demo_state_returns_teacher_friendly_sections():
    response = client.get("/api/demo-state")

    assert response.status_code == 200
    payload = response.json()
    assert payload["school"]["name"] == "小学/初中智能排课演示数据"
    assert payload["stages"][0]["name"] == "小学"
    assert payload["stages"][0]["class_count"] == 36
    assert payload["stages"][1]["name"] == "初中"
    assert payload["stages"][1]["class_count"] == 18
    assert payload["grade_settings"][0] == {"stage": "小学", "grade": "一年级", "class_count": 6}
    assert "teachers" in payload
    assert "rooms" in payload
    assert "courses" in payload
    assert payload["example_rules"][0] == "九年级不要第一节体育课"


def test_demo_teacher_names_are_teacher_friendly():
    response = client.get("/api/demo-state")

    payload = response.json()
    teacher_names = [teacher["name"] for teacher in payload["teachers"]]
    assert any(name in teacher_names for name in ["陈老师", "李老师", "周老师"])
    assert not any("组老师" in name for name in teacher_names[:20])


def test_solve_endpoint_accepts_class_count_overrides():
    response = client.post(
        "/api/solve",
        json={"messages": [], "class_counts": {"一年级": 2, "七年级": 1}},
    )

    assert response.status_code == 200
    payload = response.json()
    assert "一年级(2)" in payload["class_names"]
    assert "一年级(3)" not in payload["class_names"]
    assert "七年级(1)" in payload["class_names"]
    assert "七年级(2)" not in payload["class_names"]


def test_solve_endpoint_can_schedule_primary_scope_only():
    response = client.post("/api/solve", json={"messages": [], "school_scope": "小学"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["school_scope"] == "小学"
    assert payload["periods"][0]["time"] == "08:50-09:35"
    assert len(payload["class_names"]) == 36
    assert all(name.startswith(("一年级", "二年级", "三年级", "四年级", "五年级", "六年级")) for name in payload["class_names"])


def test_solve_endpoint_can_schedule_middle_scope_only():
    response = client.post("/api/solve", json={"messages": [], "school_scope": "初中"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["school_scope"] == "初中"
    assert payload["periods"][0]["time"] == "08:00-08:45"
    assert len(payload["class_names"]) == 18
    assert all(name.startswith(("七年级", "八年级", "九年级")) for name in payload["class_names"])


def test_solve_endpoint_parses_text_rules_and_returns_schedule():
    response = client.post(
        "/api/solve",
        json={"messages": ["九年级不要第一节体育课", "王老师周三下午不能上课"], "class_counts": {"九年级": 2}},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["conflict_count"] == 0
    assert "九年级体育课不安排在第1节" in payload["applied_rules"]
    assert "王老师周三下午不排课" in payload["applied_rules"]


def test_solve_endpoint_returns_missing_information_for_agent():
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
                    "teacher": "",
                    "room": "",
                    "classes": ["七年级(1)"],
                }
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["missing_information"]
    assert payload["next_actions"][0] == "请先补充缺失信息，再重新校验或排课。"


def test_solve_endpoint_without_overrides_uses_repository_state(tmp_path, monkeypatch):
    data_path = tmp_path / "timetable.json"
    monkeypatch.setenv("TIMETABLE_DATA_PATH", str(data_path))
    repo = JsonTimetableRepository(data_path)
    state = repo.load()
    state["messages"] = ["九年级不要第一节体育课"]
    repo.save(state)

    response = client.post("/api/solve", json={"school_scope": "初中"})

    assert response.status_code == 200
    payload = response.json()
    assert "九年级不要第一节体育课" in payload["messages"]
    assert "九年级体育课不安排在第1节" in payload["applied_rules"]
