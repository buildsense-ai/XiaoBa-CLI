# Timetable CLI Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move timetable editing/querying into a CLI-friendly service layer so an agent can query, validate, solve, and manually adjust timetables while the web page becomes a focused visualization surface.

**Architecture:** Add a JSON-backed repository and a `timetable_service` module that both FastAPI and CLI use. The CLI returns structured JSON for agent skills, including conflicts, missing information, applied changes, and suggested next actions. The web page keeps visualization, selection, export, and refresh while data maintenance moves out of the browser.

**Tech Stack:** Python 3.11, FastAPI, OR-Tools CP-SAT, existing greedy solver, JSON file storage, pytest, vanilla HTML/CSS/JS.

---

### Task 1: Repository And Service Layer

**Files:**
- Create: `app/repository.py`
- Create: `app/services/__init__.py`
- Create: `app/services/timetable_service.py`
- Create: `data/.gitkeep`
- Test: `tests/test_timetable_service.py`

- [ ] **Step 1: Write failing tests for service defaults and persistence**

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.\.venv\Scripts\python.exe -m pytest tests\test_timetable_service.py -q`

Expected: import errors for missing repository/service modules.

- [ ] **Step 3: Implement JSON repository**

Create `JsonTimetableRepository` with:

```python
DEFAULT_DATA_PATH = Path("data/timetable.json")

class JsonTimetableRepository:
    def __init__(self, path: str | Path = DEFAULT_DATA_PATH): ...
    def load(self) -> dict: ...
    def save(self, state: dict) -> None: ...
    def reset(self) -> dict: ...
```

Stored state must include:

```python
{
    "school_scope": "初中",
    "class_counts": {},
    "teachers": [],
    "rooms": [],
    "courses": [],
    "messages": [],
    "manual_changes": []
}
```

- [ ] **Step 4: Implement TimetableService basics**

Add methods:

```python
get_state(school_scope: str = "初中") -> dict
solve(school_scope: str = "初中") -> dict
add_rule(school_scope: str, text: str) -> dict
```

Use existing `build_demo_school`, `apply_editable_data`, `apply_time_rules`, `parse_text_rule`, and `solve_timetable`.

- [ ] **Step 5: Run tests**

Run: `.\.venv\Scripts\python.exe -m pytest tests\test_timetable_service.py -q`

Expected: all new tests pass.

### Task 2: Validation For Missing Information And Conflicts

**Files:**
- Create: `app/validators.py`
- Modify: `app/services/timetable_service.py`
- Test: `tests/test_timetable_validation.py`

- [ ] **Step 1: Write failing tests for missing information**

```python
from app.validators import validate_school_data


def test_validation_reports_missing_teacher_and_room():
    school = {
        "courses": [
            {"class": "七年级(1)", "subject": "数学", "teacher": "", "room": ""},
        ],
        "rooms": [],
        "classes": ["七年级(1)"],
    }

    result = validate_school_data(school)

    assert result["missing_information"]
    assert result["missing_information"][0]["type"] == "course_teacher"
    assert result["missing_information"][1]["type"] == "course_room"
```

- [ ] **Step 2: Run test to verify failure**

Run: `.\.venv\Scripts\python.exe -m pytest tests\test_timetable_validation.py -q`

Expected: import error for `app.validators`.

- [ ] **Step 3: Implement validator**

Return structured data:

```python
{
    "missing_information": [
        {
            "type": "course_teacher",
            "message": "七年级(1)数学缺少任课老师",
            "suggestion": "请补充数学任课老师，或让系统先标记为待分配"
        }
    ],
    "warnings": []
}
```

Check at least:
- course teacher empty or `待分配`
- course room empty
- room referenced by course but not defined and not `本班教室`
- class has no courses
- grade class count is zero for selected scope

- [ ] **Step 4: Include validation in service JSON**

`TimetableService.solve()` and `get_state()` must include `missing_information`, `warnings`, `conflicts`, and `next_actions`.

- [ ] **Step 5: Run validation tests**

Run: `.\.venv\Scripts\python.exe -m pytest tests\test_timetable_validation.py tests\test_timetable_service.py -q`

Expected: pass.

### Task 3: Manual Adjustment Operations

**Files:**
- Create: `app/manual_ops.py`
- Modify: `app/services/timetable_service.py`
- Test: `tests/test_manual_ops.py`

- [ ] **Step 1: Write failing tests for move and swap**

```python
from app.manual_ops import move_lesson, swap_lessons


def test_move_lesson_moves_solver_cell_to_empty_slot():
    schedule = {
        "七年级(1)": {
            "周一": [{"subject": "数学", "teacher": "王老师", "room": "本班教室", "source": "solver", "movable": True}, {"subject": "", "teacher": "", "room": "", "source": "empty", "movable": False}],
        }
    }

    result = move_lesson(schedule, "七年级(1)", "周一", 1, "周一", 2)

    assert result["ok"] is True
    assert schedule["七年级(1)"]["周一"][0]["subject"] == ""
    assert schedule["七年级(1)"]["周一"][1]["subject"] == "数学"


def test_swap_lesson_swaps_two_cells():
    schedule = {
        "七年级(1)": {
            "周一": [{"subject": "数学", "teacher": "王老师", "room": "本班教室", "source": "solver", "movable": True}],
            "周二": [{"subject": "英语", "teacher": "李老师", "room": "本班教室", "source": "solver", "movable": True}],
        }
    }

    result = swap_lessons(schedule, "七年级(1)", "周一", 1, "七年级(1)", "周二", 1)

    assert result["ok"] is True
    assert schedule["七年级(1)"]["周一"][0]["subject"] == "英语"
    assert schedule["七年级(1)"]["周二"][0]["subject"] == "数学"
```

- [ ] **Step 2: Run tests to verify failure**

Run: `.\.venv\Scripts\python.exe -m pytest tests\test_manual_ops.py -q`

Expected: import error for `app.manual_ops`.

- [ ] **Step 3: Implement manual ops**

Implement:

```python
move_lesson(schedule, class_name, from_day, from_period, to_day, to_period, force=False) -> dict
swap_lessons(schedule, left_class, left_day, left_period, right_class, right_day, right_period) -> dict
lock_cell(schedule, class_name, day, period, reason="") -> dict
```

Return `ok`, `message`, `operation`, and `warnings`.

- [ ] **Step 4: Apply manual changes in service**

`TimetableService.manual_move()` and `manual_swap()` should:
- solve current timetable
- apply operation
- validate resulting schedule
- persist manual operation record
- return updated schedule and validation summary

- [ ] **Step 5: Run tests**

Run: `.\.venv\Scripts\python.exe -m pytest tests\test_manual_ops.py tests\test_timetable_service.py -q`

Expected: pass.

### Task 4: CLI Entry Point For Agent Skill

**Files:**
- Create: `app/cli.py`
- Test: `tests/test_cli.py`

- [ ] **Step 1: Write failing CLI tests**

```python
import json
import subprocess


def run_cli(*args):
    result = subprocess.run(
        [".\\.venv\\Scripts\\python.exe", "-m", "app.cli", *args],
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_cli_show_class_returns_json():
    payload = run_cli("show", "--scope", "初中", "--class", "七年级(1)")

    assert payload["ok"] is True
    assert payload["class_name"] == "七年级(1)"
    assert "week" in payload


def test_cli_add_rule_returns_next_actions():
    payload = run_cli("rule", "add", "九年级不要第一节体育课", "--scope", "初中")

    assert payload["ok"] is True
    assert payload["next_actions"]
```

- [ ] **Step 2: Run tests to verify failure**

Run: `.\.venv\Scripts\python.exe -m pytest tests\test_cli.py -q`

Expected: module `app.cli` missing.

- [ ] **Step 3: Implement argparse CLI**

Commands:

```text
show --scope 初中 --class 七年级(1)
teacher --scope 初中 --name 王老师
validate --scope 初中
solve --scope 初中
rule add "九年级不要第一节体育课" --scope 初中
move --scope 初中 --class 七年级(1) --from 周二:3 --to 周四:5
swap --scope 初中 --left 七年级(1):周二:3 --right 七年级(1):周四:5
reset
```

Every command prints UTF-8 JSON only.

- [ ] **Step 4: Run tests**

Run: `.\.venv\Scripts\python.exe -m pytest tests\test_cli.py -q`

Expected: pass.

### Task 5: FastAPI Uses The Service Layer

**Files:**
- Modify: `app/main.py`
- Test: `tests/test_api.py`

- [ ] **Step 1: Add/adjust API tests**

Assert `/api/solve` still returns `class_names`, `rule_cards`, `missing_information`, `conflicts`, and `next_actions`.

- [ ] **Step 2: Refactor `build_result_for_export`**

Use `TimetableService` for solve path where possible while preserving export behavior.

- [ ] **Step 3: Run API/export tests**

Run: `.\.venv\Scripts\python.exe -m pytest tests\test_api.py tests\test_export.py -q`

Expected: pass.

### Task 6: Simplify Web Into Visualization Workbench

**Files:**
- Modify: `app/static/index.html`
- Modify: `app/static/app.js`
- Modify: `app/static/styles.css`
- Test: `tests/test_frontend_stage_scope.py`

- [ ] **Step 1: Keep only visual controls on page**

Keep:
- scope select
- class select
- teacher/class/room view selector
- timetable grid
- conflict/missing info panel
- applied rules/manual change history
- export buttons
- refresh button

Remove or hide from primary view:
- teacher/course/room edit cards
- rule textarea
- data modal
- image upload
- Excel preview editing controls

- [ ] **Step 2: Make web read service output**

Use `/api/solve` or a new `/api/state` endpoint for visualization. Do not depend on browser `localStorage` for authoritative course data.

- [ ] **Step 3: Keep visual conflict and missing-info panels**

The page must show both:
- conflicts: teacher/room/class collisions
- missing information: missing teacher, missing room, undefined room, empty course set

- [ ] **Step 4: Run frontend syntax and tests**

Run:

```powershell
node --check app\static\app.js
.\.venv\Scripts\python.exe -m pytest tests\test_frontend_stage_scope.py -q
```

Expected: pass.

### Task 7: Natural-Language Operation Testing With Independent Agents

**Files:**
- No production files unless failures require fixes.

- [ ] **Step 1: Dispatch agent as 教务主任**

Test natural-language-like CLI sequence:
- add rule: “九年级第一节不要体育”
- solve 初中
- show 九年级(1)
- validate

- [ ] **Step 2: Dispatch agent as 临时调课老师**

Test:
- move 七年级(1) 周二第3节 to 周四第5节
- validate
- inspect returned conflicts/missing info

- [ ] **Step 3: Dispatch agent as 数据维护人员**

Test:
- intentionally create missing teacher or room
- validate
- confirm CLI returns supplement prompts

- [ ] **Step 4: Summarize**

Report whether CLI JSON matches expectations, whether agent would know next action, and which flows still feel too technical.
