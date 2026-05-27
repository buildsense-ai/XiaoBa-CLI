from __future__ import annotations

import json
import os
import subprocess
import sys

from app.repository import JsonTimetableRepository


def run_skill_cli(tmp_path, *args):
    env = {
        **os.environ,
        "TIMETABLE_DATA_PATH": str(tmp_path / "timetable.json"),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    result = subprocess.run(
        [sys.executable, "-m", "app.skill_cli", *args],
        cwd="D:\\ai-timetable-demo",
        text=True,
        encoding="utf-8",
        capture_output=True,
        env=env,
        check=False,
    )
    payload = json.loads(result.stdout)
    return result, payload


def write_json(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def test_state_show_does_not_solve_or_mutate_imported_state(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    repo.save(
        {
            "school_scope": "初中",
            "class_counts": {"七年级": 1},
            "teachers": [],
            "rooms": [],
            "courses": [],
            "messages": [],
            "manual_changes": [],
            "imported_schedule": {
                "class_names": ["七年级(1)"],
                "class_stages": {"七年级(1)": "初中"},
                "periods_by_stage": {"初中": [{"number": 1, "label": "第1节", "time": "8:00-8:40"}]},
                "classes": {"七年级(1)": {"周一": [], "周二": [], "周三": [], "周四": [], "周五": []}},
            },
            "resolved_schedule": None,
        }
    )

    result, payload = run_skill_cli(tmp_path, "state", "show", "--scope", "初中")

    assert result.returncode == 0
    assert payload["ok"] is True
    assert payload["source_mode"] == "imported_schedule"
    assert payload["class_count"] == 1
    assert repo.load()["resolved_schedule"] is None


def test_data_patch_upserts_structured_facts_idempotently(tmp_path):
    patch_path = write_json(
        tmp_path / "patch.json",
        {
            "version": 1,
            "operation": "upsert",
            "class_counts": {"七年级": 1},
            "subject_aliases": {"道法": "道德与法治"},
            "class_aliases": {"七1": "七年级(1)", "701": "七年级(1)"},
            "courses": [
                {
                    "grade": "七年级",
                    "subject": "道法",
                    "weekly_hours": 2,
                    "teacher": "",
                    "room": "",
                    "classes": ["七1"],
                    "source": "聊天记录",
                    "confidence": "medium",
                    "evidence": "七1道法两节",
                }
            ],
            "constraints": [
                {
                    "type": "teacher_unavailable",
                    "teacher": "王老师",
                    "day": "周三",
                    "periods": [5, 6, 7, 8],
                    "source": "会议纪要",
                    "confidence": "high",
                }
            ],
            "review_items": [
                {
                    "type": "parallel_activity",
                    "label": "心理健康教育 / 舞蹈",
                    "classes": ["七年级(1)", "七年级(3)"],
                    "teachers": ["刘柯辰", "庄轩羽"],
                    "question": "是否正常并行？",
                    "review_required": True,
                }
            ],
        },
    )

    first_result, first_payload = run_skill_cli(tmp_path, "data", "patch", "--scope", "初中", "--json-file", str(patch_path))
    second_result, second_payload = run_skill_cli(tmp_path, "data", "patch", "--scope", "初中", "--json-file", str(patch_path))
    state = JsonTimetableRepository(tmp_path / "timetable.json").load()

    assert first_result.returncode == 0
    assert second_result.returncode == 0
    assert first_payload["ok"] is True
    assert second_payload["ok"] is True
    assert state["class_counts"]["七年级"] == 1
    assert state["courses"] == [
        {
            "grade": "七年级",
            "subject": "道德与法治",
            "weekly_hours": 2,
            "teacher": "",
            "room": "",
            "classes": ["七年级(1)"],
            "source": "聊天记录",
            "confidence": "medium",
            "evidence": "七1道法两节",
        }
    ]
    assert state["messages"] == ["王老师周三下午不排课"]
    assert len(state["review_items"]) == 1
    assert first_payload["missing_information"]


def test_data_patch_refuses_to_modify_imported_state_by_default(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    repo.save(
        {
            "school_scope": "初中",
            "class_counts": {"七年级": 1},
            "teachers": [],
            "rooms": [],
            "courses": [],
            "messages": [],
            "manual_changes": [],
            "imported_schedule": {"class_names": ["七年级(1)"], "class_stages": {"七年级(1)": "初中"}, "periods_by_stage": {}, "classes": {}},
            "resolved_schedule": None,
        }
    )
    patch_path = write_json(tmp_path / "patch.json", {"courses": [{"grade": "七年级", "subject": "心理", "weekly_hours": 1}]})

    result, payload = run_skill_cli(tmp_path, "data", "patch", "--scope", "初中", "--json-file", str(patch_path))

    assert result.returncode != 0
    assert payload["ok"] is False
    assert payload["status"] == "failed"
    assert "当前课表来自资料包" in payload["message"]
    assert repo.load()["courses"] == []


def test_data_patch_refuses_to_modify_resolved_state_by_default(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    repo.save(
        {
            "school_scope": "初中",
            "class_counts": {"七年级": 1},
            "teachers": [],
            "rooms": [],
            "courses": [],
            "messages": [],
            "manual_changes": [],
            "imported_schedule": None,
            "resolved_schedule": {
                "source_mode": "derived_solver",
                "classes": {},
                "class_names": [],
                "class_stages": {},
                "periods_by_stage": {},
            },
        }
    )
    patch_path = write_json(tmp_path / "patch.json", {"courses": [{"grade": "七年级", "subject": "心理", "weekly_hours": 1}]})

    result, payload = run_skill_cli(tmp_path, "data", "patch", "--scope", "初中", "--json-file", str(patch_path))

    assert result.returncode != 0
    assert payload["ok"] is False
    assert "重新生成后的课表" in payload["message"]


def test_data_patch_constraint_participates_in_solve(tmp_path):
    patch_path = write_json(
        tmp_path / "patch.json",
        {
            "version": 1,
            "operation": "upsert",
            "class_counts": {"七年级": 1},
            "courses": [
                {
                    "grade": "七年级",
                    "subject": "数学",
                    "weekly_hours": 2,
                    "teacher": "王老师",
                    "room": "本班教室",
                    "classes": ["七年级(1)"],
                }
            ],
            "constraints": [
                {
                    "type": "teacher_unavailable",
                    "teacher": "王老师",
                    "day": "周一",
                    "periods": [1, 2, 3, 4],
                }
            ],
        },
    )

    run_skill_cli(tmp_path, "data", "patch", "--scope", "初中", "--json-file", str(patch_path))
    result, payload = run_skill_cli(tmp_path, "solve", "--scope", "初中")
    teacher_result, teacher_payload = run_skill_cli(tmp_path, "teacher", "--scope", "初中", "--name", "王老师")

    assert result.returncode == 0
    assert payload["ok"] is True
    assert any("王老师周一上午不排课" in item for item in payload["applied_rules"])
    assert teacher_result.returncode == 0
    assert all(not (lesson["day"] == "周一" and lesson["period"] in [1, 2, 3, 4]) for lesson in teacher_payload["lessons"])


def test_data_patch_more_specific_course_update_splits_existing_group(tmp_path):
    initial_patch = write_json(
        tmp_path / "initial.json",
        {
            "version": 1,
            "operation": "upsert",
            "class_counts": {"七年级": 2},
            "courses": [
                {
                    "grade": "七年级",
                    "subject": "数学",
                    "weekly_hours": 5,
                    "teacher": "王老师",
                    "room": "本班教室",
                    "classes": ["七年级(1)", "七年级(2)"],
                }
            ],
        },
    )
    correction_patch = write_json(
        tmp_path / "correction.json",
        {
            "version": 1,
            "operation": "upsert",
            "courses": [
                {
                    "grade": "七年级",
                    "subject": "数学",
                    "weekly_hours": 5,
                    "teacher": "李老师",
                    "room": "本班教室",
                    "classes": ["七年级(1)"],
                }
            ],
        },
    )

    run_skill_cli(tmp_path, "data", "patch", "--scope", "初中", "--json-file", str(initial_patch))
    result, payload = run_skill_cli(tmp_path, "data", "patch", "--scope", "初中", "--json-file", str(correction_patch))
    state = JsonTimetableRepository(tmp_path / "timetable.json").load()

    assert result.returncode == 0
    assert payload["ok"] is True
    rows = sorted(state["courses"], key=lambda row: ",".join(row["classes"]))
    assert rows == [
        {
            "grade": "七年级",
            "subject": "数学",
            "weekly_hours": 5,
            "teacher": "李老师",
            "room": "本班教室",
            "classes": ["七年级(1)"],
            "source": "",
            "confidence": "",
            "evidence": "",
        },
        {
            "grade": "七年级",
            "subject": "数学",
            "weekly_hours": 5,
            "teacher": "王老师",
            "room": "本班教室",
            "classes": ["七年级(2)"],
            "source": "",
            "confidence": "",
            "evidence": "",
        },
    ]


def test_rule_add_on_resolved_schedule_does_not_claim_immediate_resolve(tmp_path):
    repo = JsonTimetableRepository(tmp_path / "timetable.json")
    repo.save(
        {
            "school_scope": "初中",
            "class_counts": {"七年级": 1},
            "teachers": [],
            "rooms": [],
            "courses": [],
            "messages": [],
            "manual_changes": [],
            "imported_schedule": None,
            "resolved_schedule": {
                "source_mode": "derived_solver",
                "school_scope": "初中",
                "message": "已生成一版课表。",
                "days": ["周一", "周二", "周三", "周四", "周五"],
                "periods": [{"number": 1, "label": "第1节", "time": "08:00-08:45"}],
                "periods_by_stage": {"初中": [{"number": 1, "label": "第1节", "time": "08:00-08:45"}]},
                "class_names": ["七年级(1)"],
                "class_stages": {"七年级(1)": "初中"},
                "classes": {"七年级(1)": {"周一": [{"subject": "数学", "teacher": "王老师", "room": "本班教室"}]}},
            },
        }
    )

    result, payload = run_skill_cli(tmp_path, "rule", "add", "王老师周三下午不排课", "--scope", "初中")

    assert result.returncode == 0
    assert payload["ok"] is True
    assert payload["source_mode"] == "derived_solver"
    assert "规则已记录" in payload["message"]
    assert "尚未自动重排" in payload["message"]


def test_validate_returns_review_items_from_structured_state(tmp_path):
    patch_path = write_json(
        tmp_path / "review.json",
        {
            "version": 1,
            "operation": "upsert",
            "class_counts": {"七年级": 1},
            "review_items": [
                {
                    "type": "version_conflict",
                    "label": "七年级数学任课教师版本冲突",
                    "classes": ["七年级(1)"],
                    "teachers": ["王老师", "李老师"],
                    "question": "请确认七年级(1)数学最终由哪位老师任教。",
                    "review_required": True,
                }
            ],
        },
    )

    run_skill_cli(tmp_path, "data", "patch", "--scope", "初中", "--json-file", str(patch_path))
    result, payload = run_skill_cli(tmp_path, "validate", "--scope", "初中")

    assert result.returncode == 0
    assert payload["ok"] is True
    assert payload["review_items"] == [
        {
            "type": "version_conflict",
            "label": "七年级数学任课教师版本冲突",
            "classes": ["七年级(1)"],
            "teachers": ["王老师", "李老师"],
            "question": "请确认七年级(1)数学最终由哪位老师任教。",
            "review_required": True,
        }
    ]


def test_data_patch_bad_json_returns_stable_json(tmp_path):
    bad_path = tmp_path / "bad.json"
    bad_path.write_text("{bad", encoding="utf-8")

    result, payload = run_skill_cli(tmp_path, "data", "patch", "--scope", "初中", "--json-file", str(bad_path))

    assert result.returncode != 0
    assert payload["ok"] is False
    assert payload["status"] == "failed"
    assert payload["conflicts"] == []
    assert payload["missing_information"] == []
    assert payload["warnings"]
