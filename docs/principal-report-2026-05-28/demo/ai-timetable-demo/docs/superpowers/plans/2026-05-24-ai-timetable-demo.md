# AI Timetable Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Web demo where teachers enter natural language rules and see an automatically regenerated timetable.

**Architecture:** FastAPI serves static frontend assets and JSON APIs. Rule parsing converts common teacher phrases into structured cards. OR-Tools CP-SAT solves the timetable using built-in demo data and active rules.

**Tech Stack:** Python 3.11, FastAPI, Uvicorn, OR-Tools, openpyxl, pytest, vanilla HTML/CSS/JavaScript.

---

### Task 1: Core Tests

**Files:**
- Create: `tests/test_rules.py`
- Create: `tests/test_solver.py`
- Create: `tests/test_api.py`

- [x] **Step 1: Write failing tests**

The tests assert natural-language parsing, CP-SAT scheduling, and API behavior.

- [ ] **Step 2: Run tests to verify failure**

Run: `python -m pytest -q`

Expected: failures because `app.rules`, `app.data`, `app.solver`, and `app.main` do not exist yet.

### Task 2: Backend Implementation

**Files:**
- Create: `app/data.py`
- Create: `app/rules.py`
- Create: `app/solver.py`
- Create: `app/main.py`

- [ ] **Step 1: Implement demo data and parser**

Add built-in teachers, rooms, class course requirements, fixed events, and common Chinese phrase parsing.

- [ ] **Step 2: Implement OR-Tools solver**

Create class/teacher/room hard constraints, teacher unavailable rules, first-period subject avoidance, double lesson constraints, and a teacher-friendly result shape.

- [ ] **Step 3: Implement API**

Expose `/`, `/api/demo-state`, `/api/solve`, and `/api/import-preview`.

### Task 3: Frontend Implementation

**Files:**
- Create: `app/static/index.html`
- Create: `app/static/styles.css`
- Create: `app/static/app.js`

- [ ] **Step 1: Build three-column teacher workbench**

Left data panel, middle AI input/rule cards, right timetable and conflicts.

- [ ] **Step 2: Wire API calls**

Load demo state, solve with messages, refresh timetable, preview Excel upload.

### Task 4: Verification

- [ ] **Step 1: Install dependencies**

Run: `python -m pip install -r requirements.txt`

- [ ] **Step 2: Run tests**

Run: `python -m pytest -q`

- [ ] **Step 3: Start local server**

Run: `python -m uvicorn app.main:app --host 127.0.0.1 --port 8008`

- [ ] **Step 4: Verify endpoint**

Open: `http://127.0.0.1:8008`
