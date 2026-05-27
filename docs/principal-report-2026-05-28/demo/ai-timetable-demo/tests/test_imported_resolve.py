from __future__ import annotations

import json
import os
import subprocess
import sys

from app.imported_schedule_planner import build_school_from_imported_state
from app.repository import JsonTimetableRepository
from app.services.timetable_service import TimetableService


def imported_state() -> dict:
    return {
        "school_scope": "初中",
        "class_counts": {"七年级": 2},
        "teachers": [],
        "rooms": [],
        "courses": [],
        "messages": [],
        "manual_changes": [],
        "imported_schedule": {
            "class_names": ["七年级(1)", "七年级(2)"],
            "class_stages": {"七年级(1)": "初中", "七年级(2)": "初中"},
            "periods_by_stage": {
                "初中": [
                    {"number": 1, "label": "第1节", "time": "8:00-8:40"},
                    {"number": 2, "label": "第2节", "time": "8:50-9:30"},
                    {"number": 3, "label": "第3节", "time": "9:45-10:25"},
                    {"number": 4, "label": "第4节", "time": "10:40-11:20"},
                ]
            },
            "classes": {
                "七年级(1)": {
                    "周一": [
                        {"subject": "班队会", "teacher": "黄梓琪", "room": "本班教室", "source": "imported"},
                        {"subject": "英语", "teacher": "黄梓琪", "room": "本班教室", "source": "imported"},
                        {"subject": "数学", "teacher": "陈老师", "room": "本班教室", "source": "imported"},
                        {"subject": "舞蹈 / 心理健康教育", "teacher": "刘老师、庄老师", "room": "本班教室", "source": "imported"},
                    ],
                    "周二": [
                        {"subject": "语文", "teacher": "金婷", "room": "本班教室", "source": "imported"},
                        {"subject": "英语", "teacher": "黄梓琪", "room": "本班教室", "source": "imported"},
                        {"subject": "数学", "teacher": "陈老师", "room": "本班教室", "source": "imported"},
                        {"subject": "自习", "teacher": "", "room": "本班教室", "source": "empty"},
                    ],
                    "周三": [],
                    "周四": [],
                    "周五": [],
                },
                "七年级(2)": {
                    "周一": [
                        {"subject": "班队会", "teacher": "李老师", "room": "本班教室", "source": "imported"},
                        {"subject": "语文", "teacher": "金婷", "room": "本班教室", "source": "imported"},
                        {"subject": "英语", "teacher": "赵老师", "room": "本班教室", "source": "imported"},
                        {"subject": "心理健康教育 / 舞蹈", "teacher": "庄老师、刘老师", "room": "本班教室", "source": "imported"},
                    ],
                    "周二": [
                        {"subject": "数学", "teacher": "王老师", "room": "本班教室", "source": "imported"},
                        {"subject": "语文", "teacher": "金婷", "room": "本班教室", "source": "imported"},
                        {"subject": "英语", "teacher": "赵老师", "room": "本班教室", "source": "imported"},
                        {"subject": "数学", "teacher": "王老师", "room": "本班教室", "source": "imported"},
                    ],
                    "周三": [],
                    "周四": [],
                    "周五": [],
                },
            },
        },
    }


def test_build_school_from_imported_state_derives_courses_and_fixed_events():
    derived = build_school_from_imported_state(imported_state(), "初中")
    school = derived["school"]

    assert school["classes"] == ["七年级(1)", "七年级(2)"]
    assert school["periods"][0]["time"] == "8:00-8:40"
    assert any(course["class"] == "七年级(1)" and course["subject"] == "英语" and course["weekly_hours"] == 2 for course in school["courses"])
    assert any(event["class"] == "七年级(1)" and event["subject"] == "班队会" for event in school["fixed_events"])
    assert any(event["class"] == "七年级(1)" and "舞蹈" in event["subject"] for event in school["fixed_events"])
    assert derived["summary"]["ordinary_lesson_count"] == 11
    assert derived["summary"]["fixed_event_count"] == 4
    assert derived["summary"]["review_activity_count"] == 2


def test_service_resolves_imported_schedule_with_solver(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    repo.save(imported_state())

    payload = TimetableService(repo).resolve_imported("初中")

    assert payload["ok"] is True
    assert payload["source_mode"] == "derived_solver"
    assert payload["status"] == "success"
    assert payload["classes"]["七年级(1)"]["周一"][0]["subject"] == "班队会"
    assert payload["derivation_summary"]["ordinary_lesson_count"] == 11
    assert payload["comparison_summary"]["imported_lesson_count"] >= 11
    assert "重新生成" in payload["message"]
    assert repo.load()["resolved_schedule"]["source_mode"] == "derived_solver"
    assert payload["conflict_count"] == 1
    assert payload["conflicts"][0]["severity"] == "review"


def test_show_class_uses_saved_resolved_schedule_after_resolve(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    repo.save(imported_state())
    service = TimetableService(repo)
    service.resolve_imported("初中")

    payload = service.show_class("初中", "七年级(1)")

    assert payload["ok"] is True
    assert payload["week"]["周一"][0]["subject"] == "班队会"
    assert any(cell.get("source") == "solver" for day in payload["week"].values() for cell in day)


def test_resolve_imported_requires_imported_schedule(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    repo.save({"school_scope": "初中", "class_counts": {"七年级": 1}, "messages": [], "manual_changes": []})

    payload = TimetableService(repo).resolve_imported("初中")

    assert payload["ok"] is False
    assert payload["status"] == "failed"
    assert "先导入" in payload["message"]


def test_skill_cli_resolve_imported_command_returns_json(tmp_path):
    state_path = tmp_path / "timetable.json"
    JsonTimetableRepository(state_path).save(imported_state())
    env = {
        **os.environ,
        "TIMETABLE_DATA_PATH": str(state_path),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }

    result = subprocess.run(
        [sys.executable, "-m", "app.skill_cli", "resolve-imported", "--scope", "初中"],
        cwd="D:\\ai-timetable-demo",
        text=True,
        encoding="utf-8",
        capture_output=True,
        env=env,
        check=False,
    )
    payload = json.loads(result.stdout)

    assert result.returncode == 0
    assert payload["ok"] is True
    assert payload["status"] == "success"
    assert payload["source_mode"] == "derived_solver"


def test_validate_after_resolve_reports_source_mode(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    repo.save(imported_state())
    service = TimetableService(repo)
    service.resolve_imported("初中")

    state = service.get_state("初中")

    assert state["source_mode"] == "derived_solver"
