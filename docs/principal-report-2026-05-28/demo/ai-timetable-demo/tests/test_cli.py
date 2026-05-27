import json
import os
import subprocess
import sys


def run_cli(tmp_path, *args):
    env = {
        **os.environ,
        "TIMETABLE_DATA_PATH": str(tmp_path / "timetable.json"),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    result = subprocess.run(
        [sys.executable, "-m", "app.cli", *args],
        cwd="D:\\ai-timetable-demo",
        text=True,
        encoding="utf-8",
        capture_output=True,
        env=env,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def run_skill_cli(tmp_path, *args):
    env = {
        **os.environ,
        "TIMETABLE_DATA_PATH": str(tmp_path / "timetable.json"),
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
    return result, json.loads(result.stdout)


def test_cli_show_class_returns_json(tmp_path):
    payload = run_cli(tmp_path, "show", "--scope", "初中", "--class", "七年级(1)")

    assert payload["ok"] is True
    assert payload["class_name"] == "七年级(1)"
    assert "week" in payload


def test_cli_add_rule_returns_next_actions(tmp_path):
    payload = run_cli(tmp_path, "rule", "add", "九年级不要第一节体育课", "--scope", "初中")

    assert payload["ok"] is True
    assert payload["next_actions"]
    assert "九年级不要第一节体育课" in payload["messages"]


def test_cli_validate_reports_missing_information(tmp_path):
    run_cli(
        tmp_path,
        "course",
        "set",
        "--scope",
        "初中",
        "--grade",
        "七年级",
        "--subject",
        "心理",
        "--teacher",
        "",
        "--room",
        "",
    )

    payload = run_cli(tmp_path, "validate", "--scope", "初中")

    assert payload["ok"] is True
    assert payload["missing_information"]


def test_cli_course_set_accepts_empty_option_without_value(tmp_path):
    run_cli(
        tmp_path,
        "course",
        "set",
        "--scope",
        "初中",
        "--grade",
        "七年级",
        "--subject",
        "心理",
        "--teacher",
        "--room",
    )

    payload = run_cli(tmp_path, "validate", "--scope", "初中")

    types = [item["type"] for item in payload["missing_information"]]
    assert "course_teacher" in types
    assert "course_room" in types


def test_skill_cli_allows_teacher_safe_commands(tmp_path):
    result, payload = run_skill_cli(tmp_path, "show", "--scope", "初中", "--class", "七年级(1)")

    assert result.returncode == 0
    assert payload["ok"] is True
    assert payload["class_name"] == "七年级(1)"


def test_skill_cli_rejects_reset_for_normal_teacher(tmp_path):
    result, payload = run_skill_cli(tmp_path, "reset")

    assert result.returncode != 0
    assert payload["ok"] is False
    assert "不能通过老师端" in payload["message"]


def test_skill_cli_error_payload_keeps_stable_fields(tmp_path):
    result, payload = run_skill_cli(tmp_path, "reset")

    assert result.returncode != 0
    assert payload["status"] == "failed"
    assert payload["conflicts"] == []
    assert payload["missing_information"] == []
    assert payload["warnings"] == []
    assert payload["next_actions"]


def test_skill_cli_returns_nonzero_when_json_ok_is_false(tmp_path):
    result, payload = run_skill_cli(tmp_path, "show", "--scope", "小学", "--class", "九年级(1)")

    assert result.returncode != 0
    assert payload["ok"] is False
    assert "没有找到" in payload["message"]


def test_skill_cli_argument_error_returns_json(tmp_path):
    result, payload = run_skill_cli(tmp_path, "show", "--scope", "初中", "--class", "七年级(1)", "--unexpected", "x")

    assert result.returncode != 0
    assert payload["ok"] is False
    assert payload["status"] == "failed"
    assert "命令参数" in payload["message"]


def test_validate_includes_source_mode(tmp_path):
    payload = run_cli(tmp_path, "validate", "--scope", "初中")

    assert payload["source_mode"]
