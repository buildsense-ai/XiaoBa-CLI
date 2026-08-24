#!/usr/bin/env python3
"""Zero-dependency local web app for the Finding registry."""
import argparse
import importlib.util
import json
import sys
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote, urlparse

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("finding_manager", HERE / "finding_manager.py")
fm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fm)
INDEX = HERE.parent / "webapp" / "index.html"


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def pick(value, fields):
    """Return only explicitly approved keys from a mapping."""
    return {key: value[key] for key in fields if key in value}


def shared_dashboard(conn):
    """Build the strict, non-sensitive projection used by shared read-only deployments.

    Keep this as an allowlist. In particular, do not expose envelope_path,
    source_hash, raw Envelope JSON, global event history, or event notes.
    """
    value = fm.dashboard(conn)
    finding_fields = (
        "finding_id", "title", "observation", "impact", "owner", "priority",
        "stage", "review_state", "completeness_percent", "updated_at",
        "evidence_count", "failed_gate_count",
    )
    evidence_fields = (
        "evidence_id", "evidence_type", "title", "acquisition_method",
        "collected_at", "redaction", "limitations_json",
    )
    event_fields = ("event_type", "actor", "created_at")
    findings = []
    for raw in value.get("findings", []):
        item = pick(raw, finding_fields)
        item["evidence"] = [pick(ev, evidence_fields) for ev in raw.get("evidence", [])]
        item["latest_event"] = pick(raw.get("latest_event", {}), event_fields)
        findings.append(item)
    return {
        "counts": pick(value.get("counts", {}), ("total", "active", "issue", "close")),
        "findings": findings,
        "generated_at": value.get("generated_at", ""),
        "read_only": True,
    }


def shared_review_approvals(workspace):
    """Return the strict public projection of Tasks awaiting human approval.

    The Review Run store is an execution handoff ledger, not a public data
    source. Deliberately read only the few fields below and never return a
    whole Run/Task object: those contain Session keys, objectives, boundaries,
    result summaries, artifact paths and internal failure details.
    """
    store_path = Path(workspace) / "review-runs.json"
    result = {"approvals": [], "generated_at": ""}
    if not store_path.exists():
        return result
    try:
        value = json.loads(store_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("schemaVersion") != 1:
            return result
        runs = value.get("runs")
        if not isinstance(runs, dict):
            return result
        for raw_run_id, raw_run in runs.items():
            if not isinstance(raw_run_id, str) or not isinstance(raw_run, dict):
                continue
            finding_id = raw_run.get("findingId")
            tasks = raw_run.get("tasks")
            if not isinstance(finding_id, str) or not isinstance(tasks, dict):
                continue
            for raw_task_id, raw_task in tasks.items():
                if not isinstance(raw_task_id, str) or not isinstance(raw_task, dict):
                    continue
                status = raw_task.get("status")
                if status not in {"proposed", "interrupted"}:
                    continue
                if status == "proposed" and raw_task.get("approvalRequired") is not True:
                    continue
                risk = raw_task.get("risk")
                proposed_at = raw_task.get("proposedAt")
                if risk not in {"low", "medium", "high"} or not isinstance(proposed_at, str):
                    continue
                result["approvals"].append({
                    "run_id": raw_run_id,
                    "finding_id": finding_id,
                    "task_id": raw_task_id,
                    "status": status,
                    "risk": risk,
                    "approval_required": True,
                    "proposed_at": proposed_at,
                })
        result["approvals"].sort(key=lambda item: (item["proposed_at"], item["task_id"]))
        result["generated_at"] = str(value.get("generatedAt", ""))[:40]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError):
        # A public view fails closed: callers see no approval rows rather than
        # a storage error or any internal diagnostic detail.
        return {"approvals": [], "generated_at": ""}
    return result


def shared_detail(conn, finding_id):
    """Return a safe detail assembled only from the shared SQLite projection."""
    board = shared_dashboard(conn)
    item = next((row for row in board["findings"] if row.get("finding_id") == finding_id), None)
    if item is None:
        raise KeyError(f"unknown Finding: {finding_id}")
    result = dict(item)
    result["finding"] = {
        "actualBehavior": item.get("observation", ""),
        "impact": item.get("impact", ""),
    }
    result["read_only"] = True
    return result


def handler_factory(workspace, read_only=False):
    class Handler(BaseHTTPRequestHandler):
        server_version = "EvidenceReview/1.0"

        def send_json(self, status, value):
            body = json_bytes(value)
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def send_index(self):
            body = INDEX.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def parse_body(self):
            size = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(size).decode("utf-8") or "{}")

        def do_GET(self):
            path = unquote(urlparse(self.path).path)
            conn = fm.connect(workspace)
            try:
                if path == "/api/review/approvals":
                    # This endpoint is intentionally read-only in every deployment.
                    self.send_json(200, shared_review_approvals(workspace))
                elif path == "/api/dashboard":
                    if read_only:
                        self.send_json(200, shared_dashboard(conn))
                    else:
                        value = fm.dashboard(conn)
                        value["read_only"] = False
                        self.send_json(200, value)
                elif path.startswith("/api/findings/"):
                    finding_id = path.split("/", 3)[3]
                    value = shared_detail(conn, finding_id) if read_only else fm.detail(conn, finding_id)
                    self.send_json(200, value)
                elif path in {"/", "/index.html"}:
                    self.send_index()
                else:
                    self.send_json(404, {"error": "not found"})
            except KeyError as exc:
                self.send_json(404, {"error": str(exc)})
            except Exception as exc:
                if read_only:
                    sys.stderr.write(f"webapp internal error: {exc}\n")
                    self.send_json(500, {"error": "internal server error"})
                else:
                    self.send_json(500, {"error": str(exc)})
            finally:
                conn.close()

        def do_POST(self):
            if read_only:
                self.send_json(403, {"error": "read-only deployment"})
                return
            path = unquote(urlparse(self.path).path)
            conn = fm.connect(workspace)
            try:
                data = self.parse_body()
                parts = path.strip("/").split("/")
                if len(parts) == 4 and parts[:2] == ["api", "findings"] and parts[3] == "transition":
                    finding_id = parts[2]
                    fm.transition(conn, finding_id, data.get("to", ""), data.get("actor", "human"), data.get("note", ""), bool(data.get("reopen")))
                    self.send_json(200, fm.detail(conn, finding_id))
                elif len(parts) == 4 and parts[:2] == ["api", "findings"] and parts[3] == "update":
                    finding_id = parts[2]
                    fm.update_fields(conn, finding_id, data.get("actor", "human"), data.get("owner"), data.get("priority"), data.get("next_action"), data.get("stop_condition"), data.get("note", ""))
                    self.send_json(200, fm.detail(conn, finding_id))
                elif len(parts) == 4 and parts[:2] == ["api", "findings"] and parts[3] == "sync":
                    finding_id = parts[2]
                    fm.sync_one(conn, finding_id, data.get("actor", "human"))
                    self.send_json(200, fm.detail(conn, finding_id))
                else:
                    self.send_json(404, {"error": "not found"})
            except (ValueError, KeyError, json.JSONDecodeError) as exc:
                self.send_json(400, {"error": str(exc)})
            except Exception as exc:
                if read_only:
                    sys.stderr.write(f"webapp internal error: {exc}\n")
                    self.send_json(500, {"error": "internal server error"})
                else:
                    self.send_json(500, {"error": str(exc)})
            finally:
                conn.close()

        def log_message(self, fmt, *args):
            sys.stderr.write("webapp " + (fmt % args) + "\n")

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Serve the Evidence Envelope Finding workbench")
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--read-only", action="store_true", help="disable all write APIs for shared/LAN deployments")
    args = ap.parse_args()
    workspace = fm.workspace_path(args.workspace)
    fm.connect(workspace).close()
    server = ThreadingHTTPServer((args.host, args.port), handler_factory(workspace, args.read_only))
    print(f"http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
