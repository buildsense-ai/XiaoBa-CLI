from app.repository import JsonTimetableRepository
from app.services.timetable_service import TimetableService


def test_service_initializes_default_middle_school_data(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    service = TimetableService(repo)

    state = service.get_state("初中")

    assert state["school_scope"] == "初中"
    assert len(state["class_names"]) == 18
    assert state["missing_information"] == []
    assert state["conflicts"] == []


def test_service_persists_added_rule(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    service = TimetableService(repo)

    result = service.add_rule("初中", "九年级不要第一节体育课")
    state = service.get_state("初中")

    assert result["ok"] is True
    assert "九年级不要第一节体育课" in state["messages"]
    assert "九年级体育课不安排在第1节" in state["applied_rules"]


def test_service_manual_move_persists_and_reapplies(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    service = TimetableService(repo)

    before = service.get_state("初中")
    class_name = before["class_names"][0]
    source = None
    target = None
    for day, cells in before["classes"][class_name].items():
        for index, cell in enumerate(cells, start=1):
            if cell["source"] == "solver" and source is None:
                source = (day, index, cell["subject"])
            if cell["source"] == "empty" and target is None:
                target = (day, index)
        if source and target:
            break

    result = service.manual_move("初中", class_name, source[0], source[1], target[0], target[1])
    after = service.get_state("初中")

    assert result["ok"] is True
    assert after["classes"][class_name][target[0]][target[1] - 1]["subject"] == source[2]
    assert after["manual_changes"]


def test_service_manual_move_keeps_failure_message(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    service = TimetableService(repo)

    result = service.manual_move("初中", "七年级(1)", "周一", 1, "周五", 8, force=True)

    assert result["ok"] is False
    assert "固定活动" in result["message"]
