from fastapi.testclient import TestClient

from app.main import app
from app.rules import parse_text_rule


client = TestClient(app)


def test_demo_state_has_separate_primary_and_middle_school_times():
    response = client.get("/api/demo-state")

    assert response.status_code == 200
    payload = response.json()
    assert payload["periods_by_stage"]["小学"][0]["time"] == "08:50-09:35"
    assert payload["periods_by_stage"]["初中"][0]["time"] == "08:00-08:45"


def test_parse_stage_start_time_rule():
    rule = parse_text_rule("小学8点50上课")

    assert rule["kind"] == "stage_start_time"
    assert rule["stage"] == "小学"
    assert rule["start_time"] == "08:50"
    assert rule["summary"] == "小学第1节从08:50开始"


def test_solve_can_change_primary_school_start_time_from_natural_language():
    response = client.post("/api/solve", json={"messages": ["小学9点上课"], "school_scope": "小学"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["periods"][0]["time"] == "09:00-09:45"
    assert payload["periods_by_stage"]["小学"][0]["time"] == "09:00-09:45"
    assert payload["periods_by_stage"]["初中"][0]["time"] == "08:00-08:45"
    assert "小学第1节从09:00开始" in payload["applied_rules"]
