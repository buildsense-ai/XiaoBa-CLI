#!/usr/bin/env python3
"""Skill-local Review Run/Task state-ledger prototype.

This is not integrated with the XiaoBa Agent Runtime: it does not call
RuntimeFactory, AgentSession, MessageSessionManager, or SubAgentManager, and it
does not execute an agent or specialist task. It exists to explore durable domain
state, manual approval, Envelope validation, Pool synchronization, and audit
contracts before implementing a real application-runtime adapter.
"""
import argparse
import hashlib
import importlib.util
import json
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("finding_manager", HERE / "finding_manager.py")
fm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fm)
VALIDATOR = HERE / "validate-envelope.py"

RUN_STATES = ("DRAFT", "READY", "RUNNING", "PAUSED", "AWAITING_APPROVAL", "DECIDED", "CANCELLED", "FAILED")
TASK_STATES = ("PLANNED", "APPROVED", "RUNNING", "PAUSED", "COMPLETED", "BLOCKED", "CANCELLED")
TASK_KINDS = ("PLAN", "COLLECT", "REPRODUCE", "ANALYZE", "CHALLENGE", "JUDGE")
RUN_TRANSITIONS = {
    "DRAFT": {"READY", "CANCELLED"},
    "READY": {"RUNNING", "CANCELLED"},
    "RUNNING": {"PAUSED", "AWAITING_APPROVAL", "DECIDED", "FAILED", "CANCELLED"},
    "PAUSED": {"RUNNING", "CANCELLED"},
    "AWAITING_APPROVAL": {"RUNNING", "PAUSED", "CANCELLED"},
    "DECIDED": set(), "CANCELLED": set(), "FAILED": {"RUNNING", "CANCELLED"},
}
TASK_TRANSITIONS = {
    "PLANNED": {"APPROVED", "CANCELLED"},
    "APPROVED": {"RUNNING", "CANCELLED"},
    "RUNNING": {"PAUSED", "COMPLETED", "BLOCKED", "CANCELLED"},
    "PAUSED": {"RUNNING", "CANCELLED"},
    "BLOCKED": {"RUNNING", "CANCELLED"},
    "COMPLETED": set(), "CANCELLED": set(),
}


def now():
    return datetime.now(timezone.utc).isoformat()


def stable_id(prefix, finding_id):
    return f"{prefix}-{finding_id}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"


def json_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def hash_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def connect(workspace):
    conn = fm.connect(workspace)
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS review_runs (
      run_id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      state TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      runtime_adapter TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      purpose TEXT NOT NULL,
      basis_manifest_hash TEXT NOT NULL,
      decision_state TEXT NOT NULL DEFAULT 'INCOMPLETE',
      decision_summary TEXT NOT NULL DEFAULT '',
      pause_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT,
      FOREIGN KEY (finding_id) REFERENCES findings(finding_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS review_tasks (
      task_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      task_kind TEXT NOT NULL,
      state TEXT NOT NULL,
      requires_approval INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL,
      safety_boundary TEXT NOT NULL,
      expected_artifact TEXT NOT NULL,
      stop_condition TEXT NOT NULL,
      approved_by TEXT NOT NULL DEFAULT '',
      completion_note TEXT NOT NULL DEFAULT '',
      artifact_path TEXT NOT NULL DEFAULT '',
      artifact_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (run_id) REFERENCES review_runs(run_id) ON DELETE CASCADE,
      FOREIGN KEY (finding_id) REFERENCES findings(finding_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS review_run_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      task_id TEXT,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      note TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES review_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_review_runs_finding ON review_runs(finding_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_tasks_run ON review_tasks(run_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_review_run_events_run ON review_run_events(run_id, event_id DESC);
    """)
    conn.commit()
    return conn


def event(conn, run_id, actor, event_type, note="", task_id=None, from_state=None, to_state=None, metadata=None):
    conn.execute("INSERT INTO review_run_events(run_id,task_id,event_type,actor,from_state,to_state,note,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                 (run_id, task_id, event_type, actor, from_state, to_state, note, json_text(metadata or {}), now()))


def get_run(conn, run_id):
    row = conn.execute("SELECT * FROM review_runs WHERE run_id=?", (run_id,)).fetchone()
    if not row: raise KeyError(f"unknown run: {run_id}")
    return row


def get_task(conn, task_id):
    row = conn.execute("SELECT * FROM review_tasks WHERE task_id=?", (task_id,)).fetchone()
    if not row: raise KeyError(f"unknown task: {task_id}")
    return row


def run_state(conn, run_id, target, actor, note=""):
    row = get_run(conn, run_id); current = row["state"]
    if target not in RUN_STATES or target not in RUN_TRANSITIONS[current]:
        raise ValueError(f"illegal run transition: {current} -> {target}")
    decided_at = now() if target == "DECIDED" else None
    conn.execute("UPDATE review_runs SET state=?,pause_reason=?,updated_at=?,decided_at=COALESCE(?,decided_at) WHERE run_id=?",
                 (target, note if target in {"PAUSED", "AWAITING_APPROVAL"} else "", now(), decided_at, run_id))
    event(conn, run_id, actor, "RUN_STATE_CHANGED", note, from_state=current, to_state=target)
    conn.commit()


def task_state(conn, task_id, target, actor, note="", artifact=None):
    task = get_task(conn, task_id); current = task["state"]
    if target not in TASK_STATES or target not in TASK_TRANSITIONS[current]:
        raise ValueError(f"illegal task transition: {current} -> {target}")
    if target == "RUNNING" and task["requires_approval"] and not task["approved_by"]:
        raise ValueError("task requires explicit human approval before RUNNING")
    artifact_path = task["artifact_path"]; artifact_hash = task["artifact_hash"]
    if artifact:
        p = Path(artifact).resolve()
        if not p.is_file(): raise ValueError("artifact must be an existing file")
        artifact_path, artifact_hash = str(p), hash_file(p)
    completed_at = now() if target == "COMPLETED" else None
    conn.execute("UPDATE review_tasks SET state=?,completion_note=?,artifact_path=?,artifact_hash=?,updated_at=?,completed_at=COALESCE(?,completed_at) WHERE task_id=?",
                 (target, note, artifact_path, artifact_hash, now(), completed_at, task_id))
    event(conn, task["run_id"], actor, "TASK_STATE_CHANGED", note, task_id, current, target,
          {"artifact_hash": artifact_hash} if artifact_hash else {})
    conn.commit()
    return task


def create_run(conn, finding_id, reviewer, purpose, actor):
    finding = conn.execute("SELECT envelope_path FROM findings WHERE finding_id=?", (finding_id,)).fetchone()
    if not finding: raise KeyError(f"unknown Finding: {finding_id}")
    manifest = Path(finding["envelope_path"]) / "manifest.json"
    if not manifest.is_file(): raise ValueError("Finding Envelope is missing manifest.json")
    run_id = stable_id("RUN", finding_id)
    stamp = now()
    conn.execute("INSERT INTO review_runs(run_id,finding_id,state,trigger_type,runtime_adapter,reviewer,purpose,basis_manifest_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                 (run_id, finding_id, "DRAFT", "human", "xiaoba-runtime/manual-v0.1", reviewer, purpose, hash_file(manifest), stamp, stamp))
    event(conn, run_id, actor, "RUN_CREATED", "Human-triggered Review Run created", metadata={"finding_id": finding_id, "manifest_hash": hash_file(manifest)})
    fm.event(conn, finding_id, "REVIEW_RUN_CREATED", actor, f"Review Run {run_id} created", metadata={"run_id": run_id})
    conn.commit(); return run_id


def create_task(conn, run_id, task_kind, description, safety_boundary, expected_artifact, stop_condition, actor, requires_approval=True):
    run = get_run(conn, run_id)
    if run["state"] in {"DECIDED", "CANCELLED"}: raise ValueError("cannot add task to terminal run")
    if task_kind not in TASK_KINDS: raise ValueError(f"invalid task kind: {task_kind}")
    required = bool(requires_approval)
    task_id = stable_id("TASK", run["finding_id"])
    stamp = now()
    conn.execute("INSERT INTO review_tasks(task_id,run_id,finding_id,task_kind,state,requires_approval,description,safety_boundary,expected_artifact,stop_condition,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                 (task_id, run_id, run["finding_id"], task_kind, "PLANNED", int(required), description, safety_boundary, expected_artifact, stop_condition, stamp, stamp))
    event(conn, run_id, actor, "TASK_CREATED", description, task_id, metadata={"task_kind": task_kind, "requires_approval": required})
    fm.event(conn, run["finding_id"], "REVIEW_TASK_CREATED", actor, f"Review Task {task_id}: {task_kind}", metadata={"run_id": run_id, "task_id": task_id})
    conn.commit(); return task_id


def approve_task(conn, task_id, actor, note=""):
    task = get_task(conn, task_id)
    if task["state"] != "PLANNED": raise ValueError("only PLANNED tasks can be approved")
    conn.execute("UPDATE review_tasks SET state='APPROVED',approved_by=?,updated_at=? WHERE task_id=?", (actor, now(), task_id))
    event(conn, task["run_id"], actor, "TASK_APPROVED", note, task_id, "PLANNED", "APPROVED")
    conn.commit()


def validate_and_sync(conn, finding_id, actor):
    row = conn.execute("SELECT envelope_path FROM findings WHERE finding_id=?", (finding_id,)).fetchone()
    result = __import__('subprocess').run([sys.executable, str(VALIDATOR), row["envelope_path"]], capture_output=True, text=True)
    if result.returncode: raise ValueError("Envelope validation failed: " + (result.stdout or result.stderr).strip())
    summary = fm.sync_one(conn, finding_id, actor=actor)
    return summary


def complete_task(conn, task_id, actor, note, artifact=None):
    task = get_task(conn, task_id)
    if task["state"] != "RUNNING": raise ValueError("only RUNNING tasks can be completed")
    task_state(conn, task_id, "COMPLETED", actor, note, artifact)
    summary = validate_and_sync(conn, task["finding_id"], actor)
    run = get_run(conn, task["run_id"])
    event(conn, run["run_id"], actor, "ENVELOPE_VALIDATED_AND_SYNCED", "Task completion synchronized", task_id,
          metadata={"review_state": summary["review_state"], "completeness": summary["completeness_percent"]})
    conn.commit(); return summary


def judge(conn, run_id, actor, note=""):
    run = get_run(conn, run_id)
    active = conn.execute("SELECT task_id,state FROM review_tasks WHERE run_id=? AND state NOT IN ('COMPLETED','CANCELLED')", (run_id,)).fetchall()
    if active: raise ValueError("cannot judge while tasks are active: " + ", ".join(x["task_id"] for x in active))
    summary = validate_and_sync(conn, run["finding_id"], actor)
    target = "DECIDED" if summary["review_state"] in {"COMPLETE_ISSUE", "COMPLETE_CLOSE"} else "AWAITING_APPROVAL"
    current = get_run(conn, run_id)["state"]
    if current == "READY": run_state(conn, run_id, "RUNNING", actor, "Judgment started")
    current = get_run(conn, run_id)["state"]
    if target not in RUN_TRANSITIONS[current]: raise ValueError(f"cannot apply judgment from {current}")
    conn.execute("UPDATE review_runs SET decision_state=?,decision_summary=?,updated_at=? WHERE run_id=?",
                 (summary["review_state"], summary["next_action"] if summary["review_state"] == "INCOMPLETE" else note, now(), run_id))
    run_state(conn, run_id, target, actor, note or (summary["next_action"] if target == "AWAITING_APPROVAL" else "Envelope decision complete"))
    return summary


def show(conn, run_id):
    run = dict(get_run(conn, run_id))
    run["tasks"] = [dict(x) for x in conn.execute("SELECT * FROM review_tasks WHERE run_id=? ORDER BY created_at", (run_id,))]
    run["events"] = [dict(x) for x in conn.execute("SELECT * FROM review_run_events WHERE run_id=? ORDER BY event_id DESC", (run_id,))]
    return run


def list_runs(conn, finding_id=None):
    sql = "SELECT * FROM review_runs"; args = []
    if finding_id: sql += " WHERE finding_id=?"; args.append(finding_id)
    sql += " ORDER BY updated_at DESC"
    return [dict(x) for x in conn.execute(sql, args)]


def main():
    ap = argparse.ArgumentParser(description="Human-triggered Review Agent Runtime v0.1")
    ap.add_argument("--workspace", required=True)
    sub = ap.add_subparsers(dest="command", required=True)
    p=sub.add_parser("init")
    p=sub.add_parser("create-run"); p.add_argument("finding_id"); p.add_argument("--reviewer", required=True); p.add_argument("--purpose", required=True); p.add_argument("--actor", required=True)
    p=sub.add_parser("add-task"); p.add_argument("run_id"); p.add_argument("--kind", choices=TASK_KINDS, required=True); p.add_argument("--description", required=True); p.add_argument("--safety-boundary", required=True); p.add_argument("--expected-artifact", required=True); p.add_argument("--stop-condition", required=True); p.add_argument("--actor", required=True); p.add_argument("--no-approval", action="store_true")
    p=sub.add_parser("approve"); p.add_argument("task_id"); p.add_argument("--actor", required=True); p.add_argument("--note", default="")
    p=sub.add_parser("run-state"); p.add_argument("run_id"); p.add_argument("--to", choices=RUN_STATES, required=True); p.add_argument("--actor", required=True); p.add_argument("--note", default="")
    p=sub.add_parser("task-state"); p.add_argument("task_id"); p.add_argument("--to", choices=TASK_STATES, required=True); p.add_argument("--actor", required=True); p.add_argument("--note", default="")
    p=sub.add_parser("complete"); p.add_argument("task_id"); p.add_argument("--actor", required=True); p.add_argument("--note", required=True); p.add_argument("--artifact")
    p=sub.add_parser("judge"); p.add_argument("run_id"); p.add_argument("--actor", required=True); p.add_argument("--note", default="")
    p=sub.add_parser("show"); p.add_argument("run_id")
    p=sub.add_parser("list"); p.add_argument("--finding-id")
    args=ap.parse_args(); workspace=fm.workspace_path(args.workspace); conn=connect(workspace)
    try:
        if args.command=="init": out={"workspace":str(workspace),"status":"initialized"}
        elif args.command=="create-run": out={"run_id":create_run(conn,args.finding_id,args.reviewer,args.purpose,args.actor)}
        elif args.command=="add-task": out={"task_id":create_task(conn,args.run_id,args.kind,args.description,args.safety_boundary,args.expected_artifact,args.stop_condition,args.actor,not args.no_approval)}
        elif args.command=="approve": approve_task(conn,args.task_id,args.actor,args.note); out={"task_id":args.task_id,"status":"APPROVED"}
        elif args.command=="run-state": run_state(conn,args.run_id,args.to,args.actor,args.note); out={"run_id":args.run_id,"state":args.to}
        elif args.command=="task-state": task_state(conn,args.task_id,args.to,args.actor,args.note); out={"task_id":args.task_id,"state":args.to}
        elif args.command=="complete": out={"task_id":args.task_id,"summary":complete_task(conn,args.task_id,args.actor,args.note,args.artifact)}
        elif args.command=="judge": out={"run_id":args.run_id,"summary":judge(conn,args.run_id,args.actor,args.note)}
        elif args.command=="show": out=show(conn,args.run_id)
        elif args.command=="list": out={"runs":list_runs(conn,args.finding_id)}
        print(json.dumps(out,ensure_ascii=False,indent=2))
    finally: conn.close()

if __name__=="__main__": main()
