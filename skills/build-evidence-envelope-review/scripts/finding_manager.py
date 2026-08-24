#!/usr/bin/env python3
"""Operational registry and lifecycle manager for Evidence Envelope Findings."""
import argparse
import json
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCAFFOLD = HERE / "scaffold-envelope.py"
VALIDATOR = HERE / "validate-envelope.py"
MANIFEST = HERE / "build-manifest.py"
STAGES = ("INTAKE", "MAPPING", "COLLECTING", "CHALLENGING", "JUDGING", "TERMINAL")
REVIEW_STATES = ("INCOMPLETE", "COMPLETE_ISSUE", "COMPLETE_CLOSE")
PRIORITIES = ("P0", "P1", "P2", "P3")
TRANSITIONS = {
    "INTAKE": {"MAPPING"},
    "MAPPING": {"INTAKE", "COLLECTING"},
    "COLLECTING": {"MAPPING", "CHALLENGING"},
    "CHALLENGING": {"COLLECTING", "JUDGING"},
    "JUDGING": {"COLLECTING", "CHALLENGING", "TERMINAL"},
    "TERMINAL": set(),
}


def now():
    return datetime.now(timezone.utc).isoformat()


def workspace_path(value):
    return Path(value).expanduser().resolve()


def db_path(workspace):
    return workspace / "registry.sqlite3"


def connect(workspace):
    workspace.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path(workspace))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS findings (
      finding_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      observation TEXT NOT NULL DEFAULT '',
      impact TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT 'unassigned',
      priority TEXT NOT NULL DEFAULT 'P2',
      stage TEXT NOT NULL DEFAULT 'INTAKE',
      review_state TEXT NOT NULL DEFAULT 'INCOMPLETE',
      completeness_percent INTEGER NOT NULL DEFAULT 0,
      next_action TEXT NOT NULL DEFAULT '',
      stop_condition TEXT NOT NULL DEFAULT '',
      envelope_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    );
    CREATE TABLE IF NOT EXISTS evidence_items (
      finding_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      acquisition_method TEXT NOT NULL DEFAULT '',
      collected_at TEXT NOT NULL DEFAULT '',
      redaction TEXT NOT NULL DEFAULT '',
      limitations_json TEXT NOT NULL DEFAULT '[]',
      source_hash TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (finding_id, evidence_id),
      FOREIGN KEY (finding_id) REFERENCES findings(finding_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS gates (
      finding_id TEXT NOT NULL,
      gate_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (finding_id, gate_id),
      FOREIGN KEY (finding_id) REFERENCES findings(finding_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      finding_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_value TEXT,
      to_value TEXT,
      actor TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (finding_id) REFERENCES findings(finding_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_findings_stage ON findings(stage);
    CREATE INDEX IF NOT EXISTS idx_findings_review_state ON findings(review_state);
    CREATE INDEX IF NOT EXISTS idx_evidence_items_finding ON evidence_items(finding_id, collected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_finding_time ON events(finding_id, created_at DESC);
    """)
    # Lightweight, backward-compatible projection columns for existing registries.
    columns = {row[1] for row in conn.execute("PRAGMA table_info(findings)")}
    for name in ("observation", "impact"):
        if name not in columns:
            conn.execute(f"ALTER TABLE findings ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
    conn.commit()
    return conn


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {} if default is None else default


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def rebuild_manifest(envelope):
    subprocess.run([sys.executable, str(MANIFEST), str(envelope)], check=True, capture_output=True, text=True)


def reopen_envelope(envelope, actor, reason):
    finding = read_json(envelope / "finding.json")
    completeness = read_json(envelope / "completeness.json")
    decision = read_json(envelope / "decision.json")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    notes = envelope / "review-notes"
    notes.mkdir(exist_ok=True)
    write_json(notes / f"reopen-{stamp}.json", {
        "reopenedAt": now(), "actor": actor, "reason": reason,
        "previousFindingState": finding.get("reviewState"),
        "previousCompleteness": completeness,
        "previousDecision": decision,
    })
    finding["reviewState"] = "INCOMPLETE"
    completeness["reviewState"] = "INCOMPLETE"
    for gate in completeness.get("gates", []):
        if gate.get("id") in {"G9", "G10"}:
            gate["status"] = "FAIL"
            gate["notes"] = "Reopened; challenge and decision must be rerun."
    decision.update({
        "reviewState": "INCOMPLETE", "recommendation": None,
        "rationale": f"Reopened by {actor}: {reason}", "decisiveEvidenceIds": [],
        "nextEvidenceAction": f"Incorporate the reopening evidence and rerun challenge: {reason}",
        "stopCondition": "A new challenge pass and completeness judgment are recorded.",
    })
    write_json(envelope / "finding.json", finding)
    write_json(envelope / "completeness.json", completeness)
    write_json(envelope / "decision.json", decision)
    rebuild_manifest(envelope)


def envelope_summary(envelope):
    finding = read_json(envelope / "finding.json")
    decision = read_json(envelope / "decision.json")
    completeness = read_json(envelope / "completeness.json")
    hypotheses = read_json(envelope / "hypotheses.json", {"hypotheses": []})
    evidence = read_json(envelope / "evidence-index.json", {"evidence": []})
    gates = completeness.get("gates", [])
    applicable = [g for g in gates if g.get("status") != "N/A"]
    passed = sum(1 for g in applicable if g.get("status") == "PASS")
    percent = round(100 * passed / len(applicable)) if applicable else 0
    unresolved = [h for h in hypotheses.get("hypotheses", []) if h.get("status") == "UNRESOLVED"]
    return {
        "finding_id": finding.get("findingId", envelope.name),
        "title": finding.get("title", envelope.name),
        "observation": finding.get("observation", finding.get("actualBehavior", "")),
        "impact": finding.get("impact", ""),
        "review_state": decision.get("reviewState", finding.get("reviewState", "INCOMPLETE")),
        "next_action": decision.get("nextEvidenceAction", ""),
        "stop_condition": decision.get("stopCondition", ""),
        "completeness_percent": percent,
        "gates": gates,
        # This is a searchable Pool projection only. Raw source paths and full
        # evidence records remain authoritative in evidence-index.json.
        "evidence_items": [{
            "evidence_id": item.get("id") or "",
            "evidence_type": item.get("type") or "",
            "title": item.get("title") or "",
            "acquisition_method": item.get("acquisitionMethod") or "",
            "collected_at": item.get("collectedAt") or "",
            "redaction": item.get("redaction") or "",
            "limitations": item.get("limitations") or [],
            "source_hash": item.get("hash") or "",
        } for item in evidence.get("evidence", [])],
        "unresolved_count": len(unresolved),
        "evidence_count": len(evidence.get("evidence", [])),
    }


def event(conn, finding_id, event_type, actor, note="", from_value=None, to_value=None, metadata=None):
    conn.execute(
        "INSERT INTO events(finding_id,event_type,from_value,to_value,actor,note,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
        (finding_id, event_type, from_value, to_value, actor, note, json.dumps(metadata or {}, ensure_ascii=False), now()),
    )


def register(conn, envelope, owner="unassigned", priority="P2", actor="system", stage="INTAKE"):
    envelope = envelope.resolve()
    summary = envelope_summary(envelope)
    fid = summary["finding_id"]
    if not fid:
        raise ValueError("finding.json is missing findingId")
    if priority not in PRIORITIES or stage not in STAGES:
        raise ValueError("invalid priority or stage")
    if stage == "TERMINAL" and summary["review_state"] == "INCOMPLETE":
        raise ValueError("cannot register an incomplete Envelope as TERMINAL")
    ts = now()
    existing = conn.execute("SELECT * FROM findings WHERE finding_id=?", (fid,)).fetchone()
    if existing:
        conn.execute(
            "UPDATE findings SET title=?,observation=?,impact=?,owner=?,priority=?,envelope_path=?,updated_at=? WHERE finding_id=?",
            (summary["title"], summary["observation"], summary["impact"], owner or existing["owner"], priority or existing["priority"], str(envelope), ts, fid),
        )
        event(conn, fid, "REGISTER_REFRESH", actor, "Envelope registration refreshed")
    else:
        conn.execute(
            "INSERT INTO findings(finding_id,title,observation,impact,owner,priority,stage,review_state,completeness_percent,next_action,stop_condition,envelope_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (fid, summary["title"], summary["observation"], summary["impact"], owner, priority, stage, summary["review_state"], summary["completeness_percent"], summary["next_action"], summary["stop_condition"], str(envelope), ts, ts),
        )
        event(conn, fid, "CREATED", actor, "Finding registered", to_value=stage)
    sync_one(conn, fid, actor=actor, emit_event=False)
    conn.commit()
    return fid


def sync_one(conn, finding_id, actor="system", emit_event=True):
    row = conn.execute("SELECT * FROM findings WHERE finding_id=?", (finding_id,)).fetchone()
    if not row:
        raise KeyError(f"unknown Finding: {finding_id}")
    summary = envelope_summary(Path(row["envelope_path"]))
    state = summary["review_state"]
    if state not in REVIEW_STATES:
        raise ValueError(f"invalid review state: {state}")
    old_state = row["review_state"]
    conn.execute(
        "UPDATE findings SET title=?,observation=?,impact=?,review_state=?,completeness_percent=?,next_action=?,stop_condition=?,updated_at=? WHERE finding_id=?",
        (summary["title"], summary["observation"], summary["impact"], state, summary["completeness_percent"], summary["next_action"], summary["stop_condition"], now(), finding_id),
    )
    conn.execute("DELETE FROM gates WHERE finding_id=?", (finding_id,))
    conn.execute("DELETE FROM evidence_items WHERE finding_id=?", (finding_id,))
    for item in summary["evidence_items"]:
        conn.execute(
            "INSERT INTO evidence_items(finding_id,evidence_id,evidence_type,title,acquisition_method,collected_at,redaction,limitations_json,source_hash) VALUES(?,?,?,?,?,?,?,?,?)",
            (finding_id, item["evidence_id"], item["evidence_type"], item["title"], item["acquisition_method"], item["collected_at"], item["redaction"], json.dumps(item["limitations"], ensure_ascii=False), item["source_hash"]),
        )
    for gate in summary["gates"]:
        conn.execute(
            "INSERT INTO gates(finding_id,gate_id,name,status,notes,evidence_ids_json) VALUES(?,?,?,?,?,?)",
            (finding_id, gate.get("id", ""), gate.get("name", ""), gate.get("status", "FAIL"), gate.get("notes", ""), json.dumps(gate.get("evidenceIds", []), ensure_ascii=False)),
        )
    if emit_event:
        event(conn, finding_id, "SYNCED", actor, "Envelope facts synchronized", from_value=old_state, to_value=state, metadata={"completeness": summary["completeness_percent"]})
    conn.commit()
    return summary


def transition(conn, finding_id, target, actor, note="", reopen=False):
    if target not in STAGES:
        raise ValueError(f"invalid stage: {target}")
    row = conn.execute("SELECT * FROM findings WHERE finding_id=?", (finding_id,)).fetchone()
    if not row:
        raise KeyError(f"unknown Finding: {finding_id}")
    current = row["stage"]
    if current == "TERMINAL":
        if not reopen or target != "INTAKE" or not note.strip():
            raise ValueError("terminal Finding requires --reopen, target INTAKE, and a reason")
        reopen_envelope(Path(row["envelope_path"]), actor, note.strip())
        sync_one(conn, finding_id, actor=actor, emit_event=False)
    elif target not in TRANSITIONS[current]:
        raise ValueError(f"illegal transition: {current} -> {target}")
    if target == "TERMINAL":
        sync_one(conn, finding_id, actor=actor, emit_event=False)
        row = conn.execute("SELECT * FROM findings WHERE finding_id=?", (finding_id,)).fetchone()
        if row["review_state"] not in {"COMPLETE_ISSUE", "COMPLETE_CLOSE"}:
            raise ValueError("cannot enter TERMINAL while envelope is INCOMPLETE")
        result = subprocess.run([sys.executable, str(VALIDATOR), row["envelope_path"]], capture_output=True, text=True)
        if result.returncode:
            raise ValueError("envelope validation failed: " + result.stdout.strip())
    terminal_at = now() if target == "TERMINAL" else None
    conn.execute("UPDATE findings SET stage=?,updated_at=?,terminal_at=? WHERE finding_id=?", (target, now(), terminal_at, finding_id))
    event(conn, finding_id, "REOPENED" if current == "TERMINAL" else "STAGE_CHANGED", actor, note, current, target)
    conn.commit()


def update_fields(conn, finding_id, actor, owner=None, priority=None, next_action=None, stop_condition=None, note=""):
    row = conn.execute("SELECT * FROM findings WHERE finding_id=?", (finding_id,)).fetchone()
    if not row:
        raise KeyError(f"unknown Finding: {finding_id}")
    if priority is not None and priority not in PRIORITIES:
        raise ValueError("priority must be P0, P1, P2, or P3")
    if row["stage"] == "TERMINAL" and (next_action is not None or stop_condition is not None):
        raise ValueError("reopen a terminal Finding before changing evidence actions")
    changes = {}
    if next_action is not None or stop_condition is not None:
        envelope = Path(row["envelope_path"])
        path = envelope / "decision.json"
        decision = read_json(path)
        original = json.loads(json.dumps(decision))
        new_next = decision.get("nextEvidenceAction", "") if next_action is None else next_action.strip()
        new_stop = decision.get("stopCondition", "") if stop_condition is None else stop_condition.strip()
        if row["review_state"] == "INCOMPLETE" and (not new_next or not new_stop):
            raise ValueError("an incomplete Finding requires a next action and stop condition")
        decision["nextEvidenceAction"] = new_next
        decision["stopCondition"] = new_stop
        write_json(path, decision)
        try:
            rebuild_manifest(envelope)
            result = subprocess.run([sys.executable, str(VALIDATOR), str(envelope)], capture_output=True, text=True)
            if result.returncode:
                raise ValueError("envelope validation failed: " + result.stdout.strip())
        except Exception:
            write_json(path, original)
            rebuild_manifest(envelope)
            raise
    for key, value in (("owner", owner), ("priority", priority), ("next_action", next_action), ("stop_condition", stop_condition)):
        if value is not None and value != row[key]:
            changes[key] = {"from": row[key], "to": value}
            conn.execute(f"UPDATE findings SET {key}=? WHERE finding_id=?", (value, finding_id))
    conn.execute("UPDATE findings SET updated_at=? WHERE finding_id=?", (now(), finding_id))
    event(conn, finding_id, "METADATA_UPDATED", actor, note, metadata=changes)
    conn.commit()


def rows_as_dicts(rows):
    return [dict(r) for r in rows]


def dashboard(conn):
    """Return a Finding Pool from SQLite projections only.

    The Pool intentionally exposes concise problem and evidence metadata. The
    Envelope JSON remains the authority for full evidence provenance and claims.
    """
    findings = rows_as_dicts(conn.execute("SELECT * FROM findings ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, updated_at DESC"))
    for item in findings:
        fid = item["finding_id"]
        item["evidence"] = rows_as_dicts(conn.execute(
            "SELECT evidence_id,evidence_type,title,acquisition_method,collected_at,redaction,limitations_json,source_hash FROM evidence_items WHERE finding_id=? ORDER BY collected_at DESC,evidence_id",
            (fid,),
        ))
        item["evidence_count"] = len(item["evidence"])
        item["failed_gate_count"] = conn.execute("SELECT COUNT(*) FROM gates WHERE finding_id=? AND status='FAIL'", (fid,)).fetchone()[0]
        item["latest_event"] = dict(conn.execute("SELECT event_type,actor,note,created_at FROM events WHERE finding_id=? ORDER BY event_id DESC LIMIT 1", (fid,)).fetchone() or {})
    events = rows_as_dicts(conn.execute("SELECT * FROM events ORDER BY event_id DESC LIMIT 30"))
    counts = {"total": len(findings), "active": sum(f["stage"] != "TERMINAL" for f in findings), "issue": sum(f["review_state"] == "COMPLETE_ISSUE" for f in findings), "close": sum(f["review_state"] == "COMPLETE_CLOSE" for f in findings)}
    return {"counts": counts, "findings": findings, "events": events, "generated_at": now()}


def detail(conn, finding_id):
    row = conn.execute("SELECT * FROM findings WHERE finding_id=?", (finding_id,)).fetchone()
    if not row:
        raise KeyError(f"unknown Finding: {finding_id}")
    envelope = Path(row["envelope_path"])
    result = dict(row)
    for name in ("finding", "claims", "hypotheses", "evidence-index", "completeness", "decision"):
        result[name.replace("-", "_")] = read_json(envelope / f"{name}.json")
    result["events"] = rows_as_dicts(conn.execute("SELECT * FROM events WHERE finding_id=? ORDER BY event_id DESC LIMIT 100", (finding_id,)))
    return result


def main():
    ap = argparse.ArgumentParser(description="Manage Finding lifecycle and Evidence Envelope registry")
    ap.add_argument("--workspace", required=True)
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("init")
    p = sub.add_parser("create"); p.add_argument("--id", required=True); p.add_argument("--title", required=True); p.add_argument("--owner", default="unassigned"); p.add_argument("--priority", choices=PRIORITIES, default="P2"); p.add_argument("--actor", default="system")
    p = sub.add_parser("register"); p.add_argument("--envelope", required=True); p.add_argument("--owner", default="unassigned"); p.add_argument("--priority", choices=PRIORITIES, default="P2"); p.add_argument("--stage", choices=STAGES, default="INTAKE"); p.add_argument("--actor", default="system")
    p = sub.add_parser("sync"); p.add_argument("id"); p.add_argument("--actor", default="system")
    p = sub.add_parser("transition"); p.add_argument("id"); p.add_argument("--to", choices=STAGES, required=True); p.add_argument("--actor", required=True); p.add_argument("--note", default=""); p.add_argument("--reopen", action="store_true")
    p = sub.add_parser("update"); p.add_argument("id"); p.add_argument("--actor", required=True); p.add_argument("--owner"); p.add_argument("--priority", choices=PRIORITIES); p.add_argument("--next-action"); p.add_argument("--stop-condition"); p.add_argument("--note", default="")
    p = sub.add_parser("list"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("show"); p.add_argument("id")
    args = ap.parse_args()
    workspace = workspace_path(args.workspace)
    conn = connect(workspace)
    try:
        if args.command == "init":
            print(db_path(workspace))
        elif args.command == "create":
            envelope = workspace / "findings" / args.id
            subprocess.run([sys.executable, str(SCAFFOLD), "--finding-id", args.id, "--title", args.title, "--output", str(envelope)], check=True)
            print(register(conn, envelope, args.owner, args.priority, args.actor))
        elif args.command == "register":
            print(register(conn, Path(args.envelope), args.owner, args.priority, args.actor, args.stage))
        elif args.command == "sync":
            print(json.dumps(sync_one(conn, args.id, args.actor), ensure_ascii=False, indent=2))
        elif args.command == "transition":
            transition(conn, args.id, args.to, args.actor, args.note, args.reopen); print("OK")
        elif args.command == "update":
            update_fields(conn, args.id, args.actor, args.owner, args.priority, args.next_action, args.stop_condition, args.note); print("OK")
        elif args.command == "list":
            data = dashboard(conn)
            print(json.dumps(data, ensure_ascii=False, indent=2) if args.json else "\n".join(f"{x['finding_id']}  {x['stage']}  {x['review_state']}  {x['completeness_percent']}%  {x['title']}" for x in data["findings"]))
        elif args.command == "show":
            print(json.dumps(detail(conn, args.id), ensure_ascii=False, indent=2))
    except (ValueError, KeyError, subprocess.CalledProcessError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
