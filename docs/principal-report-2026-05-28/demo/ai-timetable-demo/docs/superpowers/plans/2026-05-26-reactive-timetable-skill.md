# Reactive Timetable Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the timetable skill from a long import-and-solve pipeline into a ReAct-friendly xiaoba skill that lets the agent read noisy school materials, extract/patch structured timetable facts step by step, validate after each step, and solve only when the data is good enough.

**Architecture:** Do not duplicate xiaoba's file-reading tools. The skill provides only timetable-domain commands: state summary, structured patching, validation, solving, querying, manual adjustment, and export guidance. xiaoba remains responsible for reading files, judging noisy content, asking teachers for confirmation, and deciding which small CLI command to call next.

**Tech Stack:** Python CLI/FastAPI service layer, JSON state file, OR-Tools solver, pytest, xiaoba `skills/<skill-name>/SKILL.md`.

---

### Task 1: Add ReAct-Friendly State Summary

**Files:**
- Modify: `app/services/timetable_service.py`
- Modify: `app/cli.py`
- Modify: `app/skill_cli.py`
- Test: `tests/test_reactive_skill_cli.py`

**Behavior:**

Add a safe command:

```powershell
python -m app.skill_cli state show --scope 初中
```

It returns compact JSON for the agent:

```json
{
  "ok": true,
  "status": "success",
  "source_mode": "derived_solver",
  "school_scope": "初中",
  "class_count": 6,
  "classes_sample": ["七年级(1)", "七年级(2)"],
  "teacher_count": 18,
  "course_count": 102,
  "message_count": 0,
  "manual_change_count": 0,
  "missing_information": [],
  "conflicts": [],
  "next_actions": ["可以继续补资料、校验或重新排课。"]
}
```

**Why:** xiaoba can inspect current timetable state without reading raw JSON or running a full solve blindly.

Command boundary table:

| Command | Meaning | Mutates State | Runs Solver |
|---|---|---:|---:|
| `state show` | Read current timetable data summary | No | No |
| `data patch` | Save structured facts extracted by xiaoba | Yes | No |
| `validate` | Check current timetable/schedule | No | Existing behavior may build current view, but must not change state |
| `solve` | Generate from structured/demo data | No persistent save in this phase | Yes |
| `import-package` | Load existing teacher package schedule | Yes | No |
| `resolve-imported` | Derive solver input from imported schedule and generate | Yes, saves generated result | Yes |
| `rule add` | Record a future rule/condition | Yes | Existing behavior recomputes view, but imported/resolved states need clear wording |
| `move/swap` | Directly adjust current visible timetable | Yes | No full solve |

### Task 2: Add Structured Patch Command

**Files:**
- Modify: `app/services/timetable_service.py`
- Modify: `app/cli.py`
- Modify: `app/skill_cli.py`
- Test: `tests/test_reactive_skill_cli.py`

**Behavior:**

Add:

```powershell
python -m app.skill_cli data patch --scope 初中 --json-file D:\path\patch.json
```

Patch contract:

```json
{
  "version": 1,
  "mode": "structured",
  "operation": "upsert",
  "class_counts": {"七年级": 6},
  "subject_aliases": {
    "道法": "道德与法治",
    "体健": "体育与健康"
  },
  "class_aliases": {
    "701": "七年级(1)",
    "七1": "七年级(1)",
    "初一1班": "七年级(1)"
  },
  "courses": [
    {
      "grade": "七年级",
      "subject": "心理",
      "weekly_hours": 1,
      "teacher": "张老师",
      "room": "本班教室",
      "classes": ["七年级(1)", "七年级(2)"],
      "source": "微信群补充",
      "confidence": "high",
      "evidence": "张老师：七年级心理每班一节"
    }
  ],
  "teachers": [
    {
      "name": "王老师",
      "subject": "数学",
      "classes": ["七年级(1)", "七年级(2)"],
      "source": "教师安排表",
      "confidence": "high"
    }
  ],
  "rooms": [
    {"name": "机房A", "type": "专用教室", "capacity": 2, "notes": "信息科技使用", "source": "教室表"}
  ],
  "constraints": [
    {
      "type": "teacher_unavailable",
      "teacher": "王老师",
      "day": "周三",
      "periods": [5, 6, 7, 8],
      "source": "会议纪要",
      "confidence": "high",
      "evidence": "王老师周三下午教研"
    },
    {
      "type": "double_lesson",
      "grade": "七年级",
      "subject": "数学",
      "reason": "阶段检测",
      "source": "老师补充",
      "confidence": "medium"
    }
  ],
  "review_items": [
    {
      "type": "parallel_activity",
      "label": "心理健康教育 / 舞蹈",
      "classes": ["七年级(1)", "七年级(3)"],
      "teachers": ["刘柯辰", "庄轩羽"],
      "question": "这是否是正常分组/合班活动，允许两位老师并行？",
      "source": "班级课表",
      "confidence": "medium",
      "review_required": true
    }
  ],
  "messages": [
    "王老师周三下午不能上课"
  ],
  "metadata": {
    "source": "xiaoba extraction",
    "confidence": "medium"
  }
}
```

Rules:
- This command updates structured state only; it does not silently solve.
- `operation=upsert` is the default. It is idempotent:
  - courses key: `grade + subject + sorted(classes)`.
  - when a later course row targets a subset of classes, those classes are split out of any older broader row for the same grade+subject before the new row is saved.
  - teachers key: `name + subject + sorted(classes)`.
  - rooms key: `name`.
  - constraints key: `type + subject/teacher/room + day + periods + grade/classes`.
- `operation=replace` may be used only when the patch explicitly includes a top-level `replace_scope`, such as `{"type": "grade", "grade": "七年级"}`.
- `operation=delete` is not available to teacher-facing xiaoba flows in this version; manual deletion stays an admin/developer action.
- It returns the saved summary plus validation results.
- It accepts missing teacher/room values and lets `validate` report them.
- It does not parse raw natural language. xiaoba must extract and prepare the JSON patch.
- Every low-confidence or ambiguous fact should carry `confidence` and `evidence`; if confidence is low, xiaoba should ask the teacher before patching as hard data.
- Teacher availability and double lessons must be written either as `constraints` or as `messages`; `teachers[].notes` is not treated as an active constraint.

Source mode rules:
- If state is fresh/demo/structured, `data patch` applies directly.
- If `imported_schedule` or `resolved_schedule` exists, `data patch` refuses by default and returns a next action explaining that current state came from a package/generated table.
- To patch after import, xiaoba must either:
  - use `rule add`, `move`, or `swap` for incremental edits on the current table, or
  - explicitly start a structured rebuild flow with a future `data rebuild-start` command. This avoids silent “patch saved but not visible” behavior.

**Why:** xiaoba can gradually write facts it inferred from noisy files without modifying Python code.

Implementation notes:
- Add new fields to `app/repository.py::default_state()` so they survive repository reloads: `subject_aliases`, `class_aliases`, `constraints`, `review_items`, `patch_history`.
- `state show` must read repository state directly and must not call `get_state()` or `solve_timetable()`.
- `constraints` must become active solver rules by either converting to `messages` or by constructing rule dicts before solving. If not active, the CLI must not claim they affect the timetable.
- `courses[].teacher` is authoritative for that course row. `teachers[]` can assign teachers by subject/classes, but if both are present for the same class+subject, the latest `courses[]` row wins.
- Teacher-facing `rule add` on imported/resolved states must say it records a future rule. Only `move/swap` directly changes the current visible timetable.

### Task 3: Add Noisy Input Fixtures for Agent Tests

**Files:**
- Create directory: `tests/fixtures/noisy-inputs/`
- Create files:
  - `01_meeting_notes.txt`: meeting-style free text with course and teacher constraints, including “必须/尽量/最好不要”.
  - `02_chat_rules.txt`: fragmented WeChat-style teacher messages with duplicate and contradictory statements.
  - `03_alias_subjects.txt`: subject/class aliases such as 道法/道德与法治, 体健/体育与健康, 701/七1/初一1班.
  - `04_conflicting_activity.txt`: ambiguous activity/parallel-course description with two teachers and multiple classes.
  - `05_missing_teacher.txt`: course hours with missing teacher or room.
  - `06_ocr_noise.txt`: screenshot/OCR-like text with line breaks, spacing issues, and a few wrong characters.
  - `07_version_conflict.txt`: old table plus later teacher correction, where later correction should win only after confirmation.

Expected behavior standards:
- Auto-normalize high-confidence aliases: 七1/701/初一1班 -> 七年级(1); 道法 -> 道德与法治.
- Ask for confirmation when a newer note conflicts with an older table.
- Mark multi-teacher/multi-class activity as `review_item`, not hard data.
- Report missing teacher/room instead of inventing one.
- Distinguish hard constraints (“必须/不能”) from preferences (“尽量/最好”).

**Why:** Test whether xiaoba can use its own file-reading/reasoning tools to extract patches and then call timetable CLI, instead of relying on one brittle importer.

### Task 4: Install xiaoba Skill Wrapper

**Files:**
- Create: `C:\Users\86152\AppData\Roaming\xiaoba-cli\skills\timetable-scheduling\SKILL.md`
- Optionally create: `C:\Users\86152\AppData\Roaming\xiaoba-cli\skills\timetable-scheduling\.xiaoba-bundled-skill.json`

**SKILL.md must explain:**
- Trigger phrases: 排课、课表、重新生成课表、查某班课表、查老师课表、检查冲突、换课、调课、导入资料包.
- Use xiaoba's own file tools to read noisy files; do not call a fake inspect-file command.
- Use `state show` before deciding whether to patch/solve.
- Use `data patch` to write structured facts extracted by xiaoba.
- Use `validate` after every patch and every manual change.
- Use `resolve-imported` only after `import-package`.
- Use `solve` when structured data was built from scratch.
- Never call `app.cli` directly; only call `app.skill_cli`.
- Never call `reset` for teachers.
- Parse stdout JSON even when exit code is nonzero.
- Do not expose internal words to teachers: `patch`, `state`, `validate`, `solve`, JSON, CLI, exit code, stdout, structured state.
- Teacher-facing language must use: “记录资料”, “检查问题”, “生成课表”, “调整课表”, “导出课表”, “这条需要您确认”.
- If data is insufficient, ask for the smallest missing piece instead of asking the teacher to fill a full template.

Trigger phrases must include teacher-natural wording:
- “帮我排一下”
- “按这些资料生成课表”
- “这个老师不能排”
- “这节课换一下”
- “某班周几第几节查一下”
- “老师课表发我看下”
- “这个安排有没有撞”
- “机房/实验室别冲突”
- “班会/社团/劳动课/体育课怎么放”
- “我发了几个表/截图/聊天记录”

Teacher-facing response templates:
- “我先帮您看资料，能确定的先记录，不确定的会单独列出来确认。”
- “我已记录这些排课要求：…”
- “还缺这些信息：…”
- “这里有几条要求互相冲突：…”
- “这条我不确定，需要您确认一下：…”
- “资料够了，我开始生成课表。”
- “当前要求下排不出来，主要卡在这里：…”
- “课表已生成，可以看班级课表、老师课表或导出。”

### Task 5: Verification

**Commands:**

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m compileall app
```

**Manual/agent tests:**
- Subagent A: Use clean teacher package, import, resolve, validate, query.
- Subagent B: Use noisy meeting notes, extract patch, patch data, validate.
- Subagent C: Use conflicting activity notes, mark review/ask confirmation, do not pretend certainty.
- Subagent D: Use missing teacher notes, verify missing information is returned.
- Subagent E: Use natural teacher utterances likely to trigger skill and check if `SKILL.md` trigger language is adequate.

**Pytest regression tests:**
- `import-package -> validate -> resolve-imported -> show/teacher` still works after adding state/data commands.
- `state show` does not trigger solving or mutate state.
- `data patch` on fresh structured state is idempotent.
- `data patch` refuses by default on imported/resolved state with clear next actions.
- Bad JSON returns stable JSON with `ok=false`.
- Unknown fields are ignored but reported in `warnings`.
- Missing teacher/room is returned as `missing_information`, not guessed.
- Alias normalization works for at least `七1/701/初一1班` and `道法/体健`.

**Acceptance criteria:**
- CLI commands return stable JSON fields.
- xiaoba skill instructions do not require a long pipeline.
- No duplicate inspect-file tool exists.
- Solving still works for real initial middle-school package.
- Noisy fixtures can be converted into structured patches by an agent and validated.
