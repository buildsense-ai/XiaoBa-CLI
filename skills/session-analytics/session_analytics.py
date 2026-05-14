#!/usr/bin/env python3
"""
Session Analytics - 会话数据分析工具

分析 CatsCo 的 JSONL 会话日志，输出统计报告。

用法:
  python3 session_analytics.py                    # 分析今天
  python3 session_analytics.py --date 2026-05-10  # 指定日期
  python3 session_analytics.py --range 7          # 最近 N 天
  python3 session_analytics.py --session usr2     # 指定会话
  python3 session_analytics.py --top-tools 5      # 工具 top N
  python3 session_analytics.py --errors           # 只看错误
  python3 session_analytics.py --format markdown  # Markdown 输出
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional


def _resolve_default_log_dir() -> Path:
    """Resolve session log directory with fallback chain."""
    if env_dir := os.environ.get("CATSCO_SESSIONS_DIR"):
        return Path(env_dir)
    cwd_logs = Path.cwd() / "logs" / "sessions"
    if cwd_logs.is_dir():
        return cwd_logs
    return Path.home() / "Documents" / "xiaoba" / "logs" / "sessions"


DEFAULT_LOG_DIR = _resolve_default_log_dir()


def find_session_files(
    log_dir: Path,
    date: Optional[str] = None,
    date_range: int = 1,
    session_filter: Optional[str] = None,
) -> List[Path]:
    """Find JSONL session files matching criteria."""
    files = []

    if date:
        dates = [date]
    else:
        today = datetime.now()
        dates = [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(date_range)]

    for d in dates:
        for subdir in log_dir.iterdir():
            if not subdir.is_dir():
                continue
            date_dir = subdir / d
            if date_dir.exists():
                for f in sorted(date_dir.glob("*.jsonl")):
                    if session_filter and session_filter not in f.stem:
                        continue
                    files.append(f)

        top_date_dir = log_dir / d
        if top_date_dir.exists() and top_date_dir.is_dir():
            for f in sorted(top_date_dir.glob("*.jsonl")):
                if session_filter and session_filter not in f.stem:
                    continue
                if f not in files:
                    files.append(f)

    if not files:
        flat_files = sorted(log_dir.glob("*.jsonl"))
        for f in flat_files:
            if session_filter and session_filter not in f.stem:
                continue
            files.append(f)

    return files


def parse_records(files: List[Path]) -> List[Dict[str, Any]]:
    """Load all records from JSONL files."""
    records = []
    for f in files:
        try:
            with open(f, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except (OSError, IOError):
            continue
    return records


def analyze(records: List[Dict[str, Any]], top_n: int = 10, errors_only: bool = False) -> Dict[str, Any]:
    """Analyze records and produce statistics."""
    if not records:
        return {"error": "No records found", "summary": {}}

    total_turns = len(records)
    sessions: Dict[str, List[Dict]] = defaultdict(list)
    tool_calls: List[Dict] = []
    hourly: Counter = Counter()
    total_input_tokens = 0
    total_output_tokens = 0
    errors: List[Dict] = []

    for record in records:
        session_id = record.get("session_id", "unknown")
        sessions[session_id].append(record)

        timestamp = record.get("timestamp", "")
        if len(timestamp) >= 13:
            hour = timestamp[11:13]
            hourly[hour] += 1

        tokens_field = record.get("tokens", {})
        usage_field = record.get("usage", {})
        if isinstance(tokens_field, dict) and ("prompt" in tokens_field or "completion" in tokens_field):
            total_input_tokens += tokens_field.get("prompt", 0)
            total_output_tokens += tokens_field.get("completion", 0)
        elif isinstance(usage_field, dict):
            total_input_tokens += usage_field.get("prompt_tokens", 0) or usage_field.get("input_tokens", 0)
            total_output_tokens += usage_field.get("completion_tokens", 0) or usage_field.get("output_tokens", 0)

        assistant = record.get("assistant", {})
        if not isinstance(assistant, dict):
            continue

        for tc in assistant.get("tool_calls", []):
            tool_name = tc.get("name", "unknown")
            result = tc.get("result", "")
            is_error = _is_tool_error(result)
            tool_calls.append({
                "name": tool_name,
                "success": not is_error,
                "session_id": session_id,
            })
            if is_error:
                errors.append({
                    "tool": tool_name,
                    "session_id": session_id,
                    "timestamp": timestamp,
                    "error_preview": str(result)[:100] if result else "",
                })

    if errors_only:
        return _build_error_report(errors, tool_calls)

    tool_counter = Counter(tc["name"] for tc in tool_calls)
    tool_success = defaultdict(lambda: {"calls": 0, "success": 0})
    for tc in tool_calls:
        tool_success[tc["name"]]["calls"] += 1
        if tc["success"]:
            tool_success[tc["name"]]["success"] += 1

    tool_usage = {}
    for name, count in tool_counter.most_common(top_n):
        stats = tool_success[name]
        tool_usage[name] = {
            "calls": count,
            "success_rate": round(stats["success"] / stats["calls"], 2) if stats["calls"] > 0 else 0,
        }

    session_summaries = []
    for sid, recs in sorted(sessions.items(), key=lambda x: -len(x[1])):
        timestamps = [r.get("timestamp", "") for r in recs if r.get("timestamp")]
        duration_min = 0
        if len(timestamps) >= 2:
            try:
                t_start = datetime.fromisoformat(timestamps[0])
                t_end = datetime.fromisoformat(timestamps[-1])
                duration_min = round((t_end - t_start).total_seconds() / 60, 1)
            except (ValueError, TypeError):
                pass
        tools_in_session = sum(
            len(r.get("assistant", {}).get("tool_calls", []))
            for r in recs if isinstance(r.get("assistant"), dict)
        )
        session_summaries.append({
            "id": sid,
            "turns": len(recs),
            "duration_min": duration_min,
            "tools_used": tools_in_session,
        })

    hourly_dist = {h: hourly.get(h, 0) for h in [f"{i:02d}" for i in range(24)] if hourly.get(h, 0) > 0}

    active_hours = ""
    if hourly_dist:
        sorted_hours = sorted(hourly_dist.keys())
        active_hours = f"{sorted_hours[0]}:00-{sorted_hours[-1]}:59"

    error_rate = round(len(errors) / len(tool_calls), 3) if tool_calls else 0

    return {
        "summary": {
            "total_sessions": len(sessions),
            "total_turns": total_turns,
            "total_tokens": {
                "input": total_input_tokens,
                "output": total_output_tokens,
                "total": total_input_tokens + total_output_tokens,
            },
            "active_hours": active_hours,
            "total_tool_calls": len(tool_calls),
        },
        "tool_usage": tool_usage,
        "hourly_distribution": hourly_dist,
        "sessions": session_summaries[:20],
        "errors": {
            "total": len(errors),
            "rate": error_rate,
            "recent": errors[-5:] if errors else [],
        },
    }


def _is_tool_error(result) -> bool:
    """Check if a tool result indicates an error."""
    if not result:
        return False
    text = str(result).lower()
    false_positives = ["no errors", "0 errors", "error-free"]
    if any(fp in text for fp in false_positives):
        return False
    error_indicators = ["error", "failed", "not found", "permission denied", "timeout", "traceback"]
    return any(indicator in text for indicator in error_indicators)


def _build_error_report(errors: List[Dict], tool_calls: List[Dict]) -> Dict[str, Any]:
    """Build error-focused report."""
    error_by_tool = Counter(e["tool"] for e in errors)
    return {
        "total_errors": len(errors),
        "error_rate": round(len(errors) / len(tool_calls), 3) if tool_calls else 0,
        "by_tool": dict(error_by_tool.most_common(10)),
        "recent_errors": errors[-10:],
    }


def format_markdown(report: Dict[str, Any]) -> str:
    """Format report as readable Markdown."""
    lines = ["# Session Analytics Report", ""]

    summary = report.get("summary", {})
    if not summary:
        return "No data found."

    lines.append("## Overview")
    lines.append(f"- Sessions: {summary.get('total_sessions', 0)}")
    lines.append(f"- Total turns: {summary.get('total_turns', 0)}")
    tokens = summary.get("total_tokens", {})
    lines.append(f"- Tokens: {tokens.get('input', 0):,} input / {tokens.get('output', 0):,} output")
    lines.append(f"- Active hours: {summary.get('active_hours', 'N/A')}")
    lines.append(f"- Tool calls: {summary.get('total_tool_calls', 0)}")
    lines.append("")

    tool_usage = report.get("tool_usage", {})
    if tool_usage:
        lines.append("## Tool Usage (Top)")
        lines.append("| Tool | Calls | Success Rate |")
        lines.append("|------|-------|-------------|")
        for name, stats in tool_usage.items():
            rate = f"{stats['success_rate']:.0%}"
            lines.append(f"| {name} | {stats['calls']} | {rate} |")
        lines.append("")

    hourly = report.get("hourly_distribution", {})
    if hourly:
        lines.append("## Hourly Activity")
        max_val = max(hourly.values()) if hourly else 1
        for hour, count in sorted(hourly.items()):
            bar = "█" * int(count / max_val * 20)
            lines.append(f"  {hour}:00  {bar} {count}")
        lines.append("")

    sessions = report.get("sessions", [])
    if sessions:
        lines.append("## Sessions")
        lines.append("| Session | Turns | Duration | Tools |")
        lines.append("|---------|-------|----------|-------|")
        for s in sessions[:10]:
            dur = f"{s['duration_min']}min" if s["duration_min"] else "-"
            lines.append(f"| {s['id']} | {s['turns']} | {dur} | {s['tools_used']} |")
        lines.append("")

    errors = report.get("errors", {})
    if errors.get("total", 0) > 0:
        lines.append("## Errors")
        lines.append(f"- Total: {errors['total']} ({errors['rate']:.1%} of tool calls)")
        for e in errors.get("recent", []):
            lines.append(f"  - [{e.get('tool')}] {e.get('error_preview', '')[:60]}")
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="CatsCo Session Analytics - analyze conversation data"
    )
    parser.add_argument("--log-dir", type=str, default=None,
                        help="Session logs directory (default: ~/Documents/xiaoba/logs/sessions)")
    parser.add_argument("--date", type=str, default=None,
                        help="Analyze specific date (YYYY-MM-DD)")
    parser.add_argument("--range", type=int, default=1,
                        help="Analyze last N days (default: 1 = today)")
    parser.add_argument("--session", type=str, default=None,
                        help="Filter by session ID")
    parser.add_argument("--top-tools", type=int, default=10,
                        help="Show top N tools (default: 10)")
    parser.add_argument("--errors", action="store_true",
                        help="Show only error analysis")
    parser.add_argument("--format", choices=["json", "markdown"], default="json",
                        help="Output format (default: json)")

    args = parser.parse_args()

    log_dir = Path(args.log_dir) if args.log_dir else DEFAULT_LOG_DIR

    if not log_dir.exists():
        print(json.dumps({"error": f"Log directory not found: {log_dir}"}, ensure_ascii=False))
        sys.exit(1)

    files = find_session_files(log_dir, args.date, args.range, args.session)

    if not files:
        print(json.dumps({"error": "No session files found", "log_dir": str(log_dir)}, ensure_ascii=False))
        sys.exit(0)

    records = parse_records(files)
    report = analyze(records, top_n=args.top_tools, errors_only=args.errors)

    if args.format == "markdown":
        print(format_markdown(report))
    else:
        print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
