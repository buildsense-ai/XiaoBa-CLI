from __future__ import annotations

from collections import defaultdict
from copy import deepcopy

from app.data import GRADE_ORDER, apply_editable_data, apply_time_rules, build_demo_school, grade_from_class, stage_for_grade
from app.imported_schedule_planner import build_school_from_imported_state, compare_generated_to_imported
from app.manual_ops import move_lesson, swap_lessons
from app.repository import JsonTimetableRepository
from app.rules import parse_text_rule
from app.solver import solve_timetable
from app.validators import validate_schedule_conflicts, validate_school_data


class TimetableService:
    def __init__(self, repository: JsonTimetableRepository | None = None):
        self.repository = repository or JsonTimetableRepository()

    def get_state(self, school_scope: str = "初中") -> dict:
        state = self._load_for_scope(school_scope)
        return self._solve_from_state(state)

    def solve(self, school_scope: str = "初中") -> dict:
        return self.get_state(school_scope)

    def state_summary(self, school_scope: str = "初中") -> dict:
        state = self._load_for_scope(school_scope)
        source_mode = self._source_mode_for_state(state)
        class_names = self._raw_class_names_for_state(state, school_scope)
        validation = self._validate_raw_structured_state(state) if source_mode == "structured_state" else {"missing_information": [], "warnings": []}
        return {
            "ok": True,
            "status": "success",
            "message": "已读取当前排课资料状态。",
            "source_mode": source_mode,
            "school_scope": school_scope,
            "class_count": len(class_names),
            "classes_sample": class_names[:8],
            "teacher_count": len(state.get("teachers", [])),
            "course_count": len(state.get("courses", [])),
            "message_count": len(state.get("messages", [])),
            "manual_change_count": len(state.get("manual_changes", [])),
            "review_item_count": len(state.get("review_items", [])),
            "missing_information": validation["missing_information"],
            "conflicts": [],
            "warnings": validation["warnings"],
            "next_actions": ["可以继续记录资料、检查问题或生成课表。"],
        }

    def apply_data_patch(self, school_scope: str, patch: dict) -> dict:
        state = self._load_for_scope(school_scope)
        if state.get("resolved_schedule"):
            return self._patch_refused("当前课表已经是重新生成后的课表；为了避免写入后看不见，请用规则、移动或交换继续调整，或重新开始结构化建表。")
        if state.get("imported_schedule"):
            return self._patch_refused("当前课表来自资料包；为了避免写入后看不见，请先决定是继续调整当前课表，还是重新开始结构化建表。")

        operation = str(patch.get("operation") or "upsert")
        if operation != "upsert":
            return self._patch_refused("当前老师端只支持追加或更新资料，不支持替换或删除。")

        warnings = []
        allowed_keys = {"version", "mode", "operation", "class_counts", "subject_aliases", "class_aliases", "courses", "teachers", "rooms", "constraints", "review_items", "messages", "metadata"}
        unknown_keys = sorted(set(patch) - allowed_keys)
        if unknown_keys:
            warnings.append(f"已忽略暂不支持的字段：{', '.join(unknown_keys)}")

        state["subject_aliases"] = {**state.get("subject_aliases", {}), **dict(patch.get("subject_aliases") or {})}
        state["class_aliases"] = {**state.get("class_aliases", {}), **dict(patch.get("class_aliases") or {})}
        if patch.get("class_counts"):
            state["class_counts"] = self._normalized_patch_class_counts(patch["class_counts"], school_scope)
        state["rooms"] = self._upsert_rows(state.get("rooms", []), [self._clean_room_row(row) for row in patch.get("rooms", [])], lambda row: row.get("name", ""))
        state["teachers"] = self._upsert_rows(state.get("teachers", []), [self._clean_teacher_row(row, state) for row in patch.get("teachers", [])], self._teacher_patch_key)
        state["courses"] = self._upsert_course_rows(state.get("courses", []), [self._clean_course_row(row, state) for row in patch.get("courses", [])])
        state["constraints"] = self._upsert_rows(state.get("constraints", []), list(patch.get("constraints", [])), self._constraint_patch_key)
        state["review_items"] = self._upsert_rows(state.get("review_items", []), list(patch.get("review_items", [])), self._review_item_key)
        for message in list(patch.get("messages", [])) + [self._constraint_to_message(item) for item in patch.get("constraints", [])]:
            if message and message not in state["messages"]:
                state["messages"].append(message)
        state.setdefault("patch_history", []).append({"source": (patch.get("metadata") or {}).get("source", "xiaoba"), "operation": operation})

        self.repository.save(state)
        validation = self._validate_raw_structured_state(state)
        return {
            "ok": True,
            "status": "success",
            "message": "资料已记录，已完成一次检查。",
            "source_mode": "structured_state",
            "school_scope": school_scope,
            "class_count": len(self._raw_class_names_for_state(state, school_scope)),
            "course_count": len(state.get("courses", [])),
            "teacher_count": len(state.get("teachers", [])),
            "missing_information": validation["missing_information"],
            "conflicts": [],
            "warnings": warnings + validation["warnings"],
            "next_actions": ["请根据缺失信息继续补资料；资料足够后可以生成课表。"],
        }

    def resolve_imported(self, school_scope: str = "初中") -> dict:
        state = self._load_for_scope(school_scope)
        if not state.get("imported_schedule"):
            return {
                "ok": False,
                "status": "failed",
                "message": "请先导入老师资料包，再从资料包反推条件重新排课。",
                "conflicts": [],
                "missing_information": [],
                "warnings": [],
                "next_actions": ["先使用 import-package 导入老师资料包，或上传包含班级课表的 Excel。"],
            }
        try:
            derived = build_school_from_imported_state(state, school_scope)
        except ValueError as exc:
            return {
                "ok": False,
                "status": "failed",
                "message": str(exc),
                "conflicts": [],
                "missing_information": [],
                "warnings": [],
                "next_actions": ["请确认资料包里包含当前学段的班级课表。"],
            }

        school = derived["school"]
        rules = [parse_text_rule(message) for message in state.get("messages", []) if str(message).strip()]
        result = solve_timetable(school, rules)
        result["ok"] = result.get("status") != "failed"
        result["message"] = "已从资料包反推课程、教师、课时和固定活动，并重新生成一版课表。" if result["ok"] else result.get("message", "资料包反推重排失败。")
        result["source_mode"] = "derived_solver"
        result["school_scope"] = school_scope
        result["days"] = school["days"]
        result["periods"] = school["periods"]
        result["periods_by_stage"] = school["periods_by_stage"]
        result["class_names"] = school["classes"]
        result["class_stages"] = school["class_stages"]
        result["rule_cards"] = rules
        result["messages"] = list(state.get("messages", []))
        result["manual_changes"] = list(state.get("manual_changes", []))
        result["derivation_summary"] = derived["summary"]
        result["comparison_summary"] = compare_generated_to_imported(state["imported_schedule"], result.get("classes", {}), school_scope)
        result["missing_information"] = validate_school_data(school)["missing_information"]
        result["warnings"] = validate_school_data(school)["warnings"]
        result["conflicts"] = validate_schedule_conflicts(school, result.get("classes", {})) + self._validate_imported_conflicts(result.get("classes", {}))
        result["conflict_count"] = len(result["conflicts"])
        result["next_actions"] = self._next_actions(result)
        if result["ok"]:
            state["resolved_schedule"] = {
                "source_mode": "derived_solver",
                "school_scope": school_scope,
                "message": result["message"],
                "days": result["days"],
                "periods": result["periods"],
                "periods_by_stage": result["periods_by_stage"],
                "class_names": result["class_names"],
                "class_stages": result["class_stages"],
                "classes": result["classes"],
                "derivation_summary": result["derivation_summary"],
                "comparison_summary": result["comparison_summary"],
            }
            self.repository.save(state)
        return result

    def add_rule(self, school_scope: str, text: str) -> dict:
        state = self._load_for_scope(school_scope)
        rule = text.strip()
        if rule and rule not in state["messages"]:
            state["messages"].append(rule)
        self.repository.save(state)
        result = self._solve_from_state(state)
        if result.get("source_mode") == "imported_schedule":
            message = "规则已记录；当前课表来自资料包，尚未自动重排。"
        elif result.get("source_mode") == "derived_solver":
            message = "规则已记录；当前课表已经生成，尚未自动重排。要立刻改变当前课表，请使用移动或交换，或重新生成课表。"
        else:
            message = "规则已保存并重新排课。"
        return {**result, "ok": True, "message": message}

    def set_course(self, school_scope: str, grade: str, subject: str, weekly_hours: int = 1, teacher: str = "", room: str = "", classes: list[str] | None = None) -> dict:
        state = self._load_for_scope(school_scope)
        rows = [row for row in state.get("courses", []) if not (row.get("grade") == grade and row.get("subject") == subject)]
        rows.append(
            {
                "grade": grade,
                "subject": subject,
                "weekly_hours": weekly_hours,
                "teacher": teacher,
                "room": room,
                "classes": classes or [],
            }
        )
        state["courses"] = rows
        self.repository.save(state)
        result = self._solve_from_state(state)
        return {"ok": True, "message": "课程资料已保存。", **result}

    def manual_move(self, school_scope: str, class_name: str, from_day: str, from_period: int, to_day: str, to_period: int, force: bool = False) -> dict:
        state = self._load_for_scope(school_scope)
        operation = {
            "operation": "move",
            "class_name": class_name,
            "from_day": from_day,
            "from_period": from_period,
            "to_day": to_day,
            "to_period": to_period,
            "force": force,
        }
        base = self._solve_from_state(state, apply_manual=False)
        result = move_lesson(base["classes"], class_name, from_day, from_period, to_day, to_period, force)
        if result["ok"]:
            state["manual_changes"].append(operation)
            self.repository.save(state)
            updated = self._solve_from_state(state)
            return {**updated, **result}
        return {**base, **result}

    def manual_swap(self, school_scope: str, left_class: str, left_day: str, left_period: int, right_class: str, right_day: str, right_period: int) -> dict:
        state = self._load_for_scope(school_scope)
        operation = {
            "operation": "swap",
            "left_class": left_class,
            "left_day": left_day,
            "left_period": left_period,
            "right_class": right_class,
            "right_day": right_day,
            "right_period": right_period,
        }
        base = self._solve_from_state(state, apply_manual=False)
        result = swap_lessons(base["classes"], left_class, left_day, left_period, right_class, right_day, right_period)
        if result["ok"]:
            state["manual_changes"].append(operation)
            self.repository.save(state)
            updated = self._solve_from_state(state)
            return {**updated, **result}
        return {**base, **result}

    def show_class(self, school_scope: str, class_name: str) -> dict:
        result = self.get_state(school_scope)
        week = result["classes"].get(class_name)
        if not week:
            return {"ok": False, "status": "failed", "message": f"没有找到{class_name}。", "class_name": class_name}
        conflicts = self._filter_conflicts_for_class(result["conflicts"], class_name)
        return {
            "ok": True,
            "status": "success",
            "message": f"已找到{class_name}课表。",
            "class_name": class_name,
            "week": week,
            "missing_information": result["missing_information"],
            "conflicts": conflicts,
            "warnings": result.get("warnings", []),
            "next_actions": self._next_actions({**result, "conflicts": conflicts}),
        }

    def show_teacher(self, school_scope: str, teacher: str) -> dict:
        result = self.get_state(school_scope)
        schedules = result.get("teacher_schedules", {}).get(teacher, [])
        conflicts = self._filter_conflicts_for_teacher(result["conflicts"], teacher)
        return {
            "ok": True,
            "status": "success",
            "message": f"已找到{teacher}的课程安排。",
            "teacher": teacher,
            "lessons": schedules,
            "missing_information": result["missing_information"],
            "conflicts": conflicts,
            "warnings": result.get("warnings", []),
            "next_actions": self._next_actions({**result, "conflicts": conflicts}),
        }

    def reset(self) -> dict:
        self.repository.reset()
        return {"ok": True, "message": "已重置为默认演示数据。"}

    def _patch_refused(self, message: str) -> dict:
        return {
            "ok": False,
            "status": "failed",
            "message": message,
            "conflicts": [],
            "missing_information": [],
            "warnings": [],
            "next_actions": ["如果只是追加临时要求，请使用加规则、移动或交换；如果要重新建表，请先确认进入结构化建表流程。"],
        }

    def _source_mode_for_state(self, state: dict) -> str:
        if state.get("resolved_schedule"):
            return "derived_solver"
        if state.get("imported_schedule"):
            return "imported_schedule"
        return "structured_state"

    def _raw_class_names_for_state(self, state: dict, school_scope: str) -> list[str]:
        source = state.get("resolved_schedule") or state.get("imported_schedule")
        if source:
            class_stages = source.get("class_stages") or {}
            return [
                name
                for name in source.get("class_names", [])
                if school_scope == "全部" or class_stages.get(name) == school_scope
            ]
        classes = []
        for stage, grade in GRADE_ORDER:
            if school_scope != "全部" and stage != school_scope:
                continue
            count = int((state.get("class_counts") or {}).get(grade, 0) or 0)
            classes.extend(f"{grade}({index})" for index in range(1, count + 1))
        return classes

    def _validate_raw_structured_state(self, state: dict) -> dict:
        school, _ = self._build_school(state)
        return validate_school_data(school)

    def _normalized_patch_class_counts(self, class_counts: dict, school_scope: str) -> dict:
        counts = {grade: 0 for _, grade in GRADE_ORDER}
        for grade, value in class_counts.items():
            if grade in counts:
                counts[grade] = max(0, min(12, int(value)))
        if school_scope in {"小学", "初中"}:
            for stage, grade in GRADE_ORDER:
                if stage_for_grade(grade) != school_scope and grade not in class_counts:
                    counts[grade] = 0
        return counts

    def _clean_course_row(self, row: dict, state: dict) -> dict:
        grade = str(row.get("grade", "")).strip()
        subject = self._normalize_subject(row.get("subject", ""), state)
        classes = [self._normalize_class_name(item, state) for item in row.get("classes", [])]
        if not classes and grade:
            count = int((state.get("class_counts") or {}).get(grade, 0) or 0)
            classes = [f"{grade}({index})" for index in range(1, count + 1)]
        return {
            "grade": grade,
            "subject": subject,
            "weekly_hours": int(row.get("weekly_hours", row.get("hours", 1)) or 0),
            "teacher": str(row.get("teacher", "") or "").strip(),
            "room": str(row.get("room", "") or "").strip(),
            "classes": classes,
            "source": row.get("source", ""),
            "confidence": row.get("confidence", ""),
            "evidence": row.get("evidence", ""),
        }

    def _clean_teacher_row(self, row: dict, state: dict) -> dict:
        return {
            "name": str(row.get("name", "") or "").strip(),
            "subject": self._normalize_subject(row.get("subject", ""), state),
            "classes": [self._normalize_class_name(item, state) for item in row.get("classes", [])],
            "source": row.get("source", ""),
            "confidence": row.get("confidence", ""),
        }

    def _clean_room_row(self, row: dict) -> dict:
        return {
            "name": str(row.get("name", "") or "").strip(),
            "type": str(row.get("type", "普通教室") or "普通教室").strip(),
            "capacity": int(row.get("capacity", 1) or 1),
            "notes": str(row.get("notes", "") or "").strip(),
            "source": row.get("source", ""),
        }

    def _normalize_subject(self, value: str, state: dict) -> str:
        subject = str(value or "").strip()
        return (state.get("subject_aliases") or {}).get(subject, subject)

    def _normalize_class_name(self, value: str, state: dict) -> str:
        class_name = str(value or "").strip()
        return (state.get("class_aliases") or {}).get(class_name, class_name)

    def _upsert_rows(self, current: list[dict], incoming: list[dict], key_fn) -> list[dict]:
        rows = {key_fn(row): dict(row) for row in current if key_fn(row)}
        for row in incoming:
            key = key_fn(row)
            if key:
                rows[key] = dict(row)
        return list(rows.values())

    def _upsert_course_rows(self, current: list[dict], incoming: list[dict]) -> list[dict]:
        rows = [dict(row) for row in current if self._course_patch_key(row)]
        for row in incoming:
            if not self._course_patch_key(row):
                continue
            rows = self._upsert_one_course_row(rows, row)
        return rows

    def _upsert_one_course_row(self, current: list[dict], incoming: dict) -> list[dict]:
        incoming_grade = incoming.get("grade", "")
        incoming_subject = incoming.get("subject", "")
        incoming_classes = set(incoming.get("classes", []) or [])
        updated = []
        for existing in current:
            if existing.get("grade") != incoming_grade or existing.get("subject") != incoming_subject:
                updated.append(existing)
                continue

            existing_classes = set(existing.get("classes", []) or [])
            if not incoming_classes or not existing_classes:
                continue

            overlap = existing_classes & incoming_classes
            if not overlap:
                updated.append(existing)
                continue

            remaining_classes = [class_name for class_name in existing.get("classes", []) if class_name not in incoming_classes]
            if remaining_classes:
                split_row = dict(existing)
                split_row["classes"] = remaining_classes
                updated.append(split_row)

        updated.append(dict(incoming))
        return updated

    def _course_patch_key(self, row: dict) -> tuple:
        return (row.get("grade", ""), row.get("subject", ""), tuple(sorted(row.get("classes", []))))

    def _teacher_patch_key(self, row: dict) -> tuple:
        return (row.get("name", ""), row.get("subject", ""), tuple(sorted(row.get("classes", []))))

    def _constraint_patch_key(self, row: dict) -> tuple:
        return (
            row.get("type", ""),
            row.get("teacher", ""),
            row.get("room", ""),
            row.get("grade", ""),
            row.get("subject", ""),
            row.get("day", ""),
            tuple(row.get("periods", []) or []),
            tuple(sorted(row.get("classes", []) or [])),
        )

    def _review_item_key(self, row: dict) -> tuple:
        return (row.get("type", ""), row.get("label", ""), tuple(sorted(row.get("classes", []) or [])), tuple(sorted(row.get("teachers", []) or [])))

    def _constraint_to_message(self, constraint: dict) -> str:
        kind = constraint.get("type")
        if kind == "teacher_unavailable":
            return f"{constraint.get('teacher', '')}{constraint.get('day', '')}{self._periods_text(constraint.get('periods', []))}不排课"
        if kind == "double_lesson":
            reason = constraint.get("reason", "检测")
            return f"{constraint.get('grade', '')}{constraint.get('subject', '')}安排连续2节用于{reason}"
        if kind == "room_unavailable":
            return f"{constraint.get('room', '')}{constraint.get('day', '')}{self._periods_text(constraint.get('periods', []))}不可用"
        return ""

    def _periods_text(self, periods: list[int]) -> str:
        if periods == [1, 2, 3, 4]:
            return "上午"
        if periods == [5, 6, 7, 8]:
            return "下午"
        if len(periods) == 1:
            return f"第{periods[0]}节"
        if periods:
            return f"第{periods[0]}-{periods[-1]}节"
        return ""

    def _load_for_scope(self, school_scope: str) -> dict:
        state = self.repository.load()
        if school_scope:
            state["school_scope"] = school_scope
        return state

    def _build_school(self, state: dict) -> tuple[dict, list[dict]]:
        school = build_demo_school(state.get("class_counts"), state.get("school_scope", "初中"))
        school = apply_editable_data(school, state.get("teachers"), state.get("rooms"), state.get("courses"))
        rules = [parse_text_rule(message) for message in state.get("messages", []) if str(message).strip()]
        school = apply_time_rules(school, rules)
        return school, rules

    def _solve_from_state(self, state: dict, apply_manual: bool = True) -> dict:
        review_items = list(state.get("review_items", []))
        if state.get("resolved_schedule"):
            result = self._result_from_resolved_state(state)
            if apply_manual:
                self._apply_manual_changes(result["classes"], result["manual_changes"])
            result["teacher_schedules"] = self._teacher_schedules_from_classes(result["classes"])
            result["conflicts"] = self._validate_imported_conflicts(result["classes"])
            result["review_items"] = review_items
            result["conflict_count"] = len(result["conflicts"])
            result["next_actions"] = self._next_actions(result)
            return result

        if state.get("imported_schedule"):
            result = self._result_from_imported_state(state)
            if apply_manual:
                self._apply_manual_changes(result["classes"], result["manual_changes"])
            result["teacher_schedules"] = self._teacher_schedules_from_classes(result["classes"])
            result["conflicts"] = self._validate_imported_conflicts(result["classes"])
            result["review_items"] = review_items
            result["conflict_count"] = len(result["conflicts"])
            result["next_actions"] = self._next_actions(result)
            return result

        school, rules = self._build_school(state)
        data_validation = validate_school_data(school)
        result = solve_timetable(school, rules)
        result["rule_cards"] = rules
        result["days"] = school["days"]
        result["periods"] = school["periods"]
        result["periods_by_stage"] = school["periods_by_stage"]
        result["class_stages"] = school["class_stages"]
        result["class_names"] = school["classes"]
        result["school_scope"] = state.get("school_scope", "初中")
        result["messages"] = list(state.get("messages", []))
        result["manual_changes"] = list(state.get("manual_changes", []))
        result["review_items"] = review_items
        if apply_manual:
            self._apply_manual_changes(result["classes"], result["manual_changes"])
        conflicts = validate_schedule_conflicts(school, result["classes"])
        result["conflicts"] = conflicts
        result["conflict_count"] = len(conflicts)
        result["missing_information"] = data_validation["missing_information"]
        result["warnings"] = data_validation["warnings"]
        result["next_actions"] = self._next_actions(result)
        return result

    def _result_from_resolved_state(self, state: dict) -> dict:
        resolved = state["resolved_schedule"]
        school_scope = state.get("school_scope", resolved.get("school_scope", "全部"))
        class_stages = dict(resolved.get("class_stages") or {})
        source_classes = deepcopy(resolved.get("classes") or {})
        classes = {
            class_name: week
            for class_name, week in source_classes.items()
            if school_scope == "全部" or class_stages.get(class_name) == school_scope
        }
        periods_by_stage = deepcopy(resolved.get("periods_by_stage") or {})
        return {
            "status": "success",
            "message": resolved.get("message", "当前显示的是资料包反推后重新生成的课表。"),
            "school_scope": school_scope,
            "source_mode": resolved.get("source_mode", "derived_solver"),
            "class_names": list(classes.keys()),
            "class_stages": {name: class_stages.get(name, "") for name in classes},
            "days": deepcopy(resolved.get("days") or ["周一", "周二", "周三", "周四", "周五"]),
            "periods": self._periods_for_imported_scope(periods_by_stage, school_scope) or deepcopy(resolved.get("periods") or []),
            "periods_by_stage": periods_by_stage,
            "classes": classes,
            "teacher_schedules": {},
            "rule_cards": [parse_text_rule(message) for message in state.get("messages", []) if str(message).strip()],
            "applied_rules": [],
            "ignored_rules": [],
            "messages": list(state.get("messages", [])),
            "manual_changes": list(state.get("manual_changes", [])),
            "missing_information": [],
            "warnings": [],
            "stats": {"scheduled_lessons": self._count_imported_lessons(classes), "classes": len(classes)},
            "derivation_summary": deepcopy(resolved.get("derivation_summary") or {}),
            "comparison_summary": deepcopy(resolved.get("comparison_summary") or {}),
        }

    def _result_from_imported_state(self, state: dict) -> dict:
        imported = state["imported_schedule"]
        school_scope = state.get("school_scope", "全部")
        class_stages = dict(imported.get("class_stages") or {})
        source_classes = deepcopy(imported.get("classes") or {})
        classes = {
            class_name: week
            for class_name, week in source_classes.items()
            if school_scope == "全部" or class_stages.get(class_name) == school_scope
        }
        periods_by_stage = deepcopy(imported.get("periods_by_stage") or {})
        rule_cards = [parse_text_rule(message) for message in state.get("messages", []) if str(message).strip()]
        ignored_rules = [
            f"{rule['summary']}：当前课表来自资料包，规则已记录，尚未自动重排。"
            for rule in rule_cards
            if rule.get("kind") != "review_needed"
        ]
        ignored_rules.extend(rule["summary"] for rule in rule_cards if rule.get("kind") == "review_needed")
        return {
            "status": "success",
            "message": "已加载资料包里的当前课表，可查询班级和教师课表。",
            "school_scope": school_scope,
            "source_mode": "imported_schedule",
            "class_names": list(classes.keys()),
            "class_stages": {name: class_stages.get(name, "") for name in classes},
            "days": ["周一", "周二", "周三", "周四", "周五"],
            "periods": self._periods_for_imported_scope(periods_by_stage, school_scope),
            "periods_by_stage": periods_by_stage,
            "classes": classes,
            "teacher_schedules": {},
            "rule_cards": rule_cards,
            "applied_rules": [],
            "ignored_rules": ignored_rules,
            "messages": list(state.get("messages", [])),
            "manual_changes": list(state.get("manual_changes", [])),
            "missing_information": [] if classes else [{"type": "class_schedule", "message": "当前学段没有导入班级课表", "suggestion": "请确认资料包里是否包含该学段班级课表。"}],
            "warnings": [],
            "stats": {"scheduled_lessons": self._count_imported_lessons(classes), "classes": len(classes)},
        }

    def _periods_for_imported_scope(self, periods_by_stage: dict, school_scope: str) -> list[dict]:
        if school_scope in periods_by_stage:
            return periods_by_stage[school_scope]
        if "初中" in periods_by_stage:
            return periods_by_stage["初中"]
        if "小学" in periods_by_stage:
            return periods_by_stage["小学"]
        return []

    def _teacher_schedules_from_classes(self, classes: dict) -> dict:
        schedules = defaultdict(list)
        for class_name, week in classes.items():
            for day, cells in week.items():
                for index, cell in enumerate(cells, start=1):
                    subject = cell.get("subject", "")
                    if subject in {"", "自习"}:
                        continue
                    for teacher in self._split_teachers(cell.get("teacher", "")):
                        schedules[teacher].append(
                            {
                                "day": day,
                                "period": index,
                                "class": class_name,
                                "subject": subject,
                                "room": cell.get("room", "本班教室"),
                            }
                        )
        for items in schedules.values():
            items.sort(key=lambda item: (["周一", "周二", "周三", "周四", "周五"].index(item["day"]), item["period"], item["class"]))
        return dict(schedules)

    def _validate_imported_conflicts(self, classes: dict) -> list[dict]:
        conflicts = []
        seen_review_conflicts = set()
        teacher_slots = defaultdict(list)
        for class_name, week in classes.items():
            for day, cells in week.items():
                for index, cell in enumerate(cells, start=1):
                    subject = cell.get("subject", "")
                    if subject in {"", "自习"}:
                        continue
                    teachers = self._split_teachers(cell.get("teacher", ""))
                    for teacher in teachers:
                        teacher_slots[(day, index, teacher)].append(
                            {
                                "class": class_name,
                                "subject": subject,
                                "teacher": teacher,
                                "all_teachers": teachers,
                            }
                        )
        for (day, period, teacher), items in teacher_slots.items():
            if len(items) > 1:
                classes_in_conflict = self._unique(item["class"] for item in items)
                subjects = self._unique(item["subject"] for item in items)
                teachers = self._unique(teacher for item in items for teacher in item.get("all_teachers", []))
                classification = self._classify_imported_conflict(subjects, teachers)
                lesson_labels = ", ".join(f"{item['class']}{item['subject']}" for item in items)
                if classification["review_required"]:
                    review_key = (day, period, tuple(classes_in_conflict), tuple(subjects))
                    if review_key in seen_review_conflicts:
                        continue
                    seen_review_conflicts.add(review_key)
                conflicts.append(
                    {
                        "type": "teacher",
                        "severity": classification["severity"],
                        "category": classification["category"],
                        "review_required": classification["review_required"],
                        "title": classification["title"] if classification["review_required"] else f"{teacher}时间冲突",
                        "description": f"{teacher}在{day}第{period}节同时安排了{lesson_labels}。",
                        "suggestion": classification["suggestion"],
                        "day": day,
                        "period": period,
                        "classes": classes_in_conflict,
                        "teachers": teachers,
                        "subjects": subjects,
                    }
                )
        return conflicts

    def _filter_conflicts_for_class(self, conflicts: list[dict], class_name: str) -> list[dict]:
        related = []
        for conflict in conflicts:
            classes = conflict.get("classes") or []
            if class_name in classes or class_name in conflict.get("description", ""):
                related.append(conflict)
        return related

    def _filter_conflicts_for_teacher(self, conflicts: list[dict], teacher: str) -> list[dict]:
        related = []
        for conflict in conflicts:
            teachers = conflict.get("teachers") or []
            if teacher in teachers or teacher in conflict.get("title", "") or teacher in conflict.get("description", ""):
                related.append(conflict)
        return related

    def _classify_imported_conflict(self, subjects: list[str], teachers: list[str]) -> dict:
        subject_text = " ".join(subjects)
        looks_like_group_or_activity = (
            "/" in subject_text
            or "（1-3）" in subject_text
            or "（4-6）" in subject_text
            or "(1-3)" in subject_text
            or "(4-6)" in subject_text
            or len(teachers) > 1
        )
        if looks_like_group_or_activity:
            return {
                "severity": "review",
                "category": "疑似分组/合班/活动课",
                "review_required": True,
                "title": "并行活动课待确认",
                "suggestion": "这类课程可能是合班、分组、半节课或活动课并行；请先确认是否为正常安排，确认不是并行后再手动移动或交换。",
            }
        return {
            "severity": "hard",
            "category": "教师硬冲突",
            "review_required": False,
            "title": "",
            "suggestion": "同一老师同一时间只能上一节普通课；请移动、交换其中一节，或更换任课老师。",
        }

    def _unique(self, values) -> list:
        return list(dict.fromkeys(value for value in values if value))

    def _split_teachers(self, value: str) -> list[str]:
        teachers = []
        for part in str(value or "").replace("，", "、").replace(",", "、").split("、"):
            teacher = part.strip()
            if teacher:
                teachers.append(teacher)
        return teachers

    def _count_imported_lessons(self, classes: dict) -> int:
        count = 0
        for week in classes.values():
            for cells in week.values():
                count += sum(1 for cell in cells if cell.get("subject") not in {"", "自习"})
        return count

    def _apply_manual_changes(self, schedule: dict, manual_changes: list[dict]) -> None:
        for change in manual_changes:
            if change.get("operation") == "move":
                move_lesson(
                    schedule,
                    change["class_name"],
                    change["from_day"],
                    int(change["from_period"]),
                    change["to_day"],
                    int(change["to_period"]),
                    bool(change.get("force")),
                )
            elif change.get("operation") == "swap":
                swap_lessons(
                    schedule,
                    change["left_class"],
                    change["left_day"],
                    int(change["left_period"]),
                    change["right_class"],
                    change["right_day"],
                    int(change["right_period"]),
                )

    def _next_actions(self, result: dict) -> list[str]:
        actions = []
        if result.get("status") == "failed":
            actions.append("当前没有生成可用课表，请先处理失败原因或减少冲突规则。")
            return actions
        if result.get("missing_information"):
            actions.append("请先补充缺失信息，再重新校验或排课。")
        if result.get("conflicts"):
            conflicts = result.get("conflicts", [])
            hard_conflicts = [conflict for conflict in conflicts if conflict.get("severity") == "hard" or not conflict.get("review_required")]
            review_conflicts = [conflict for conflict in conflicts if conflict.get("review_required")]
            if hard_conflicts:
                actions.append("请处理硬冲突：可以移动课程、交换课程，或修改教师/教室资料。")
            if review_conflicts:
                actions.append("请先确认疑似合班、分组、半节课或活动课并行安排；确认不是正常并行后再调整。")
        if result.get("source_mode") == "imported_schedule" and result.get("messages"):
            actions.append("规则已记录；当前显示的是资料包课表，自动重排需要正式排课模型继续处理。")
        if not actions:
            if result.get("source_mode") == "imported_schedule":
                actions.append("可以查看班级课表、教师课表，或导入更新后的资料包。")
            else:
                actions.append("可以查看班级课表，或继续追加临时规则。")
        return actions


def result_for_request(
    messages: list[str] | None = None,
    class_counts: dict[str, int] | None = None,
    school_scope: str = "初中",
    teachers: list[dict] | None = None,
    rooms: list[dict] | None = None,
    courses: list[dict] | None = None,
) -> tuple[dict, dict]:
    state = {
        "school_scope": school_scope,
        "class_counts": class_counts or {},
        "teachers": deepcopy(teachers or []),
        "rooms": deepcopy(rooms or []),
        "courses": deepcopy(courses or []),
        "messages": list(messages or []),
        "manual_changes": [],
    }
    service = TimetableService(JsonTimetableRepository())
    school, _ = service._build_school(state)
    result = service._solve_from_state(state)
    return school, result
