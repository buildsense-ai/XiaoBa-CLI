# Real Package Resolve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a first real-data automatic scheduling path that derives standard solver input from an imported teacher package and generates a fresh timetable for the imported middle-school classes.

**Architecture:** Keep the solver generic. Add a small adapter that converts `imported_schedule` facts into the existing `school` shape (`classes`, `periods`, `courses`, `rooms`, `fixed_events`) so `solve_timetable` can run without depending on demo data. Expose this through a safe CLI command so xiaoba skill can call it naturally.

**Tech Stack:** Python, FastAPI service layer, OR-Tools CP-SAT/greedy solver, pytest, JSON CLI contracts.

---

### Task 1: Derive Standard Solver Input

**Files:**
- Create: `app/imported_schedule_planner.py`
- Test: `tests/test_imported_resolve.py`

- [ ] Write tests that build a tiny imported schedule and assert the adapter returns classes, periods, inferred courses, rooms, fixed activities, skipped review activities, and source summary.
- [ ] Implement `build_school_from_imported_schedule(state, scope)` to filter classes by scope, infer course weekly hours from existing timetable cells, preserve imported periods, infer rooms, and skip review-only cells such as combined subjects or multi-teacher activities.
- [ ] Run `pytest tests/test_imported_resolve.py -q` and make the adapter tests pass.

### Task 2: Solve From Derived Input

**Files:**
- Modify: `app/services/timetable_service.py`
- Modify: `app/cli.py`
- Modify: `app/skill_cli.py`
- Test: `tests/test_imported_resolve.py`

- [ ] Add service method `resolve_imported(school_scope)` that derives a school from the imported schedule, calls `solve_timetable`, attaches derivation metadata, and compares generated lessons with the imported timetable by class/day/period.
- [ ] Add safe CLI command `resolve-imported --scope 小学|初中|全部`.
- [ ] Ensure `app.skill_cli` allowlist includes `resolve-imported`.
- [ ] Run targeted tests for success, missing imported schedule, and stable JSON output.

### Task 3: Real Package Smoke Tests

**Files:**
- Test only through CLI and temporary `TIMETABLE_DATA_PATH`.

- [ ] Import `D:\xwechat_files\wxid_yilnth25khpn22_5102\msg\file\2026-05\0排课资料包.zip`.
- [ ] Run `resolve-imported --scope 初中`.
- [ ] Verify the result is a newly generated timetable (`source_mode=derived_solver`), not just the imported schedule.
- [ ] Verify the output reports skipped review activities and a comparison summary against the original imported timetable.

### Task 4: Documentation and Regression

**Files:**
- Modify: `docs/xiaoba-agent-skill.md`

- [ ] Document the distinction between `import-package`, `solve`, and `resolve-imported`.
- [ ] Document that original zip can be discarded after import if the normalized state file is retained.
- [ ] Run full `pytest -q` and `python -m compileall app`.
