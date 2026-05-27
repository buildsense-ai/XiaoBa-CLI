from __future__ import annotations

import argparse
import json
import sys

from app.services.timetable_service import TimetableService
from app.teacher_package_importer import import_teacher_package


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    service = TimetableService()
    try:
        payload = handle_command(service, args)
    except Exception as exc:
        payload = {"ok": False, "message": str(exc), "next_actions": ["请检查命令参数，或运行 validate 查看当前数据状态。"]}
        print_json(payload)
        return 1
    print_json(payload)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="timetable", description="课程表 CLI，供 agent skill 调用。")
    subparsers = parser.add_subparsers(dest="command", required=True)

    solve = subparsers.add_parser("solve")
    add_scope_argument(solve)

    resolve_imported = subparsers.add_parser("resolve-imported")
    add_scope_argument(resolve_imported)

    state = subparsers.add_parser("state")
    state_subparsers = state.add_subparsers(dest="state_command", required=True)
    state_show = state_subparsers.add_parser("show")
    add_scope_argument(state_show)

    data = subparsers.add_parser("data")
    data_subparsers = data.add_subparsers(dest="data_command", required=True)
    data_patch = data_subparsers.add_parser("patch")
    add_scope_argument(data_patch)
    data_patch.add_argument("--json-file", required=True)

    show = subparsers.add_parser("show")
    add_scope_argument(show)
    show.add_argument("--class", dest="class_name", required=True)

    teacher = subparsers.add_parser("teacher")
    add_scope_argument(teacher)
    teacher.add_argument("--name", required=True)

    validate = subparsers.add_parser("validate")
    add_scope_argument(validate)

    reset = subparsers.add_parser("reset")
    reset.set_defaults(scope="初中")

    import_package = subparsers.add_parser("import-package")
    import_package.add_argument("--path", required=True)
    import_package.add_argument("--scope", default="全部", choices=["小学", "初中", "全部"])

    rule = subparsers.add_parser("rule")
    rule_subparsers = rule.add_subparsers(dest="rule_command", required=True)
    rule_add = rule_subparsers.add_parser("add")
    rule_add.add_argument("text")
    add_scope_argument(rule_add)

    course = subparsers.add_parser("course")
    course_subparsers = course.add_subparsers(dest="course_command", required=True)
    course_set = course_subparsers.add_parser("set")
    add_scope_argument(course_set)
    course_set.add_argument("--grade", required=True)
    course_set.add_argument("--subject", required=True)
    course_set.add_argument("--hours", type=int, default=1)
    course_set.add_argument("--teacher", nargs="?", const="", default="")
    course_set.add_argument("--room", nargs="?", const="", default="")
    course_set.add_argument("--classes", nargs="?", const="", default="")

    move = subparsers.add_parser("move")
    add_scope_argument(move)
    move.add_argument("--class", dest="class_name", required=True)
    move.add_argument("--from", dest="from_slot", required=True)
    move.add_argument("--to", dest="to_slot", required=True)
    move.add_argument("--force", action="store_true")

    swap = subparsers.add_parser("swap")
    add_scope_argument(swap)
    swap.add_argument("--left", required=True)
    swap.add_argument("--right", required=True)

    return parser


def add_scope_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--scope", default="初中", choices=["小学", "初中", "全部"])


def handle_command(service: TimetableService, args: argparse.Namespace) -> dict:
    if args.command == "reset":
        return service.reset()
    if args.command == "import-package":
        state = import_teacher_package(args.path)
        service.repository.save(state)
        return compact_result({"ok": True, "message": "已导入资料包里的当前课表。", **service.get_state(args.scope)})
    if args.command == "solve":
        return compact_result({"ok": True, **service.solve(args.scope)})
    if args.command == "resolve-imported":
        return compact_result(service.resolve_imported(args.scope))
    if args.command == "state" and args.state_command == "show":
        return service.state_summary(args.scope)
    if args.command == "data" and args.data_command == "patch":
        patch = load_json_patch(args.json_file)
        return service.apply_data_patch(args.scope, patch)
    if args.command == "show":
        return service.show_class(args.scope, args.class_name)
    if args.command == "teacher":
        return service.show_teacher(args.scope, args.name)
    if args.command == "validate":
        state = service.get_state(args.scope)
        return {
            "ok": True,
            "status": "success",
            "message": "已完成当前课表校验。",
            "school_scope": state["school_scope"],
            "source_mode": state.get("source_mode", "demo_solver"),
            "missing_information": state["missing_information"],
            "conflicts": state["conflicts"],
            "review_items": state.get("review_items", []),
            "warnings": state["warnings"],
            "next_actions": state["next_actions"],
        }
    if args.command == "rule" and args.rule_command == "add":
        return compact_result(service.add_rule(args.scope, args.text))
    if args.command == "course" and args.course_command == "set":
        classes = [item.strip() for item in args.classes.replace(",", "、").split("、") if item.strip()]
        return compact_result(service.set_course(args.scope, args.grade, args.subject, args.hours, args.teacher, args.room, classes))
    if args.command == "move":
        from_day, from_period = parse_day_period(args.from_slot)
        to_day, to_period = parse_day_period(args.to_slot)
        return compact_result(service.manual_move(args.scope, args.class_name, from_day, from_period, to_day, to_period, args.force))
    if args.command == "swap":
        left_class, left_day, left_period = parse_class_day_period(args.left)
        right_class, right_day, right_period = parse_class_day_period(args.right)
        return compact_result(service.manual_swap(args.scope, left_class, left_day, left_period, right_class, right_day, right_period))
    return {"ok": False, "message": "未知命令。", "next_actions": ["请检查 CLI 命令。"]}


def load_json_patch(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as file:
            payload = json.load(file)
    except json.JSONDecodeError as exc:
        raise ValueError(f"资料补丁 JSON 格式不正确：{exc.msg}")
    if not isinstance(payload, dict):
        raise ValueError("资料补丁必须是一个 JSON 对象。")
    return payload


def compact_result(payload: dict) -> dict:
    ok = payload.get("ok", True)
    if payload.get("status") == "failed":
        ok = False
    status = payload.get("status")
    if not ok:
        status = "failed"
    elif not status:
        status = "success"
    compact = {
        "ok": ok,
        "status": status,
        "message": payload.get("message", ""),
        "conflict_count": len(payload.get("conflicts", [])),
        "conflicts": payload.get("conflicts", []),
        "review_items": payload.get("review_items", []),
        "missing_information": payload.get("missing_information", []),
        "warnings": payload.get("warnings", []),
        "next_actions": payload.get("next_actions", []),
    }
    optional = {
        "operation": payload.get("operation"),
        "school_scope": payload.get("school_scope"),
        "class_count": len(payload.get("class_names", [])),
        "applied_rules": payload.get("applied_rules", []),
        "ignored_rules": payload.get("ignored_rules", []),
        "messages": payload.get("messages", []),
        "manual_changes": payload.get("manual_changes", []),
        "source_mode": payload.get("source_mode"),
        "derivation_summary": payload.get("derivation_summary", {}),
        "comparison_summary": payload.get("comparison_summary", {}),
    }
    compact.update({key: value for key, value in optional.items() if value not in (None, "", [])})
    return compact


def stable_cli_payload(payload: dict) -> dict:
    stable = dict(payload)
    ok = stable.get("ok", True)
    status = stable.get("status")
    if status == "failed" or ok is False:
        ok = False
        status = "failed"
    elif not status:
        status = "success"

    stable["ok"] = ok
    stable["status"] = status
    stable.setdefault("message", "")
    stable.setdefault("conflicts", [])
    stable.setdefault("missing_information", [])
    stable.setdefault("warnings", [])
    stable.setdefault("next_actions", [])
    return stable


def parse_day_period(value: str) -> tuple[str, int]:
    day, period = value.split(":", 1)
    return day, int(period)


def parse_class_day_period(value: str) -> tuple[str, str, int]:
    class_name, day, period = value.split(":", 2)
    return class_name, day, int(period)


def print_json(payload: dict) -> None:
    print(json.dumps(stable_cli_payload(payload), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
