from __future__ import annotations

import sys

from app.cli import build_parser, handle_command, print_json
from app.services.timetable_service import TimetableService


TEACHER_SAFE_COMMANDS = {"solve", "resolve-imported", "state", "data", "show", "teacher", "validate", "rule", "course", "move", "swap", "import-package"}


def main(argv: list[str] | None = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    configure_utf8_stdio()
    if not argv:
        print_json({"ok": False, "message": "请提供排课命令。", "next_actions": ["可用命令：state、data、solve、show、teacher、validate、rule、course、move、swap、import-package。"]})
        return 2
    if argv[0] not in TEACHER_SAFE_COMMANDS:
        print_json(
            {
                "ok": False,
                "message": f"{argv[0]} 不能通过老师端排课助手执行。",
                "next_actions": ["请使用查询、校验、加规则、补资料或手动调整命令；如确需重置数据，请联系管理员。"],
            }
        )
        return 2

    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        payload = handle_command(TimetableService(), args)
    except SystemExit:
        print_json(
            {
                "ok": False,
                "status": "failed",
                "message": "命令参数不正确，请检查班级、老师、日期节次或多余参数。",
                "next_actions": ["请按排课助手给出的固定模板重新调用；不要直接拼接老师的原话为命令参数。"],
            }
        )
        return 2
    except Exception as exc:
        payload = {"ok": False, "message": str(exc), "warnings": [str(exc)], "next_actions": ["请检查命令参数，或运行 validate 查看当前数据状态。"]}
        print_json(payload)
        return 1

    print_json(payload)
    return 0 if payload.get("ok", True) else 2


def configure_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
