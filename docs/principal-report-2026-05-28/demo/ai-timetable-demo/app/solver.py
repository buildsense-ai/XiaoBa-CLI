from __future__ import annotations

from collections import defaultdict

from ortools.sat.python import cp_model


MAIN_SUBJECTS = {"语文", "数学", "英语"}


def solve_timetable(school: dict, rules: list[dict]) -> dict:
    days = school["days"]
    period_count = len(school["periods"])
    total_slots = len(days) * period_count
    day_index = {day: index for index, day in enumerate(days)}

    lessons = build_lessons(school)
    if should_use_fast_path(school, lessons):
        applied_rules, ignored_rules = summarize_rules_for_fast_path(lessons, rules)
        return solve_timetable_greedy(school, lessons, rules, applied_rules, ignored_rules)

    model = cp_model.CpModel()
    slot_vars = {
        lesson["id"]: model.NewIntVar(0, total_slots - 1, f"slot_{lesson['id']}")
        for lesson in lessons
    }

    fixed_slots_by_class = defaultdict(set)
    for event in school["fixed_events"]:
        fixed_slots_by_class[event["class"]].add(slot_number(day_index[event["day"]], event["period"], period_count))

    for lesson in lessons:
        for fixed_slot in fixed_slots_by_class[lesson["class"]]:
            model.Add(slot_vars[lesson["id"]] != fixed_slot)

    lessons_by_class = defaultdict(list)
    lessons_by_teacher = defaultdict(list)
    lessons_by_room = defaultdict(list)
    for lesson in lessons:
        lessons_by_class[lesson["class"]].append(lesson)
        lessons_by_teacher[lesson["teacher"]].append(lesson)
        lessons_by_room[lesson["room"]].append(lesson)

    for grouped_lessons in lessons_by_class.values():
        model.AddAllDifferent([slot_vars[lesson["id"]] for lesson in grouped_lessons])

    for teacher, grouped_lessons in lessons_by_teacher.items():
        if teacher and teacher != "班主任":
            add_pairwise_not_equal(model, [slot_vars[lesson["id"]] for lesson in grouped_lessons])

    for room in school["rooms"]:
        room_name = room["name"]
        room_lessons = lessons_by_room.get(room_name, [])
        if not room_lessons or room["capacity"] >= len(school["classes"]):
            continue
        for slot in range(total_slots):
            present_flags = []
            for lesson in room_lessons:
                flag = model.NewBoolVar(f"{lesson['id']}_uses_{room_name}_{slot}")
                model.Add(slot_vars[lesson["id"]] == slot).OnlyEnforceIf(flag)
                model.Add(slot_vars[lesson["id"]] != slot).OnlyEnforceIf(flag.Not())
                present_flags.append(flag)
            model.Add(sum(present_flags) <= room["capacity"])

    applied_rules = []
    ignored_rules = []
    soft_preferences = []
    for rule in rules:
        if rule["kind"] == "review_needed":
            ignored_rules.append(rule["summary"])
            continue
        if rule["kind"] == "avoid_subject_period":
            apply_subject_period_rule(model, slot_vars, lessons, rule, days, period_count)
            applied_rules.append(rule["summary"])
        elif rule["kind"] == "avoid_subject_slots":
            apply_subject_slots_rule(model, slot_vars, lessons, rule, day_index, period_count)
            applied_rules.append(rule["summary"])
        elif rule["kind"] == "teacher_unavailable":
            apply_teacher_unavailable_rule(model, slot_vars, lessons, rule, day_index, period_count)
            applied_rules.append(rule["summary"])
        elif rule["kind"] == "room_unavailable":
            apply_room_unavailable_rule(model, slot_vars, lessons, rule, day_index, period_count)
            applied_rules.append(rule["summary"])
        elif rule["kind"] == "double_lesson":
            if apply_double_lesson_rule(model, slot_vars, lessons, rule, period_count):
                applied_rules.append(rule["summary"])
            else:
                ignored_rules.append(f"{rule['summary']}：没有找到足够课时")
        elif rule["kind"] == "prefer_morning":
            soft_preferences.append(rule)
            applied_rules.append(rule["summary"])
        elif rule["kind"] == "stage_start_time":
            applied_rules.append(rule["summary"])
        elif rule["kind"] == "fixed_subject_slot":
            apply_fixed_subject_slot_rule(model, slot_vars, lessons, rule, day_index, period_count)
            applied_rules.append(rule["summary"])

    penalties = []
    preference_subjects = set(MAIN_SUBJECTS)
    for rule in soft_preferences:
        preference_subjects.update(rule.get("subjects", []))
    if len(lessons) <= 500:
        for lesson in lessons:
            if lesson["subject"] in preference_subjects:
                for slot in afternoon_slots(days, period_count):
                    flag = model.NewBoolVar(f"penalty_{lesson['id']}_{slot}")
                    model.Add(slot_vars[lesson["id"]] == slot).OnlyEnforceIf(flag)
                    model.Add(slot_vars[lesson["id"]] != slot).OnlyEnforceIf(flag.Not())
                    penalties.append(flag)
    if penalties:
        model.Minimize(sum(penalties))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 8
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return solve_timetable_greedy(school, lessons, rules, applied_rules, ignored_rules)

    return build_result_schedule(school, lessons, slot_vars, solver, applied_rules, ignored_rules)


def should_use_fast_path(school: dict, lessons: list[dict]) -> bool:
    return len(school["classes"]) > 8 or len(lessons) > 260


def summarize_rules_for_fast_path(lessons: list[dict], rules: list[dict]) -> tuple[list[str], list[str]]:
    applied_rules = []
    ignored_rules = []
    for rule in rules:
        kind = rule.get("kind")
        if kind == "review_needed":
            ignored_rules.append(rule["summary"])
        elif kind == "double_lesson":
            if has_double_lesson_candidates(lessons, rule):
                applied_rules.append(rule["summary"])
            else:
                ignored_rules.append(f"{rule['summary']}：没有找到足够课时")
        elif kind in {"avoid_subject_period", "avoid_subject_slots", "teacher_unavailable", "room_unavailable", "prefer_morning", "stage_start_time", "fixed_subject_slot"}:
            applied_rules.append(rule["summary"])
    return applied_rules, ignored_rules


def has_double_lesson_candidates(lessons: list[dict], rule: dict) -> bool:
    grade = normalize_grade(rule["scope"]["grade"])
    subject = rule["scope"]["subject"]
    matching_by_class = defaultdict(list)
    for lesson in lessons:
        if lesson["grade"] == grade and lesson["subject"] == subject:
            matching_by_class[lesson["class"]].append(lesson)
    return any(len(items) >= 2 for items in matching_by_class.values())


def build_lessons(school: dict) -> list[dict]:
    lessons = []
    for course in school["courses"]:
        for index in range(course["weekly_hours"]):
            lessons.append(
                {
                    "id": f"{course['class']}_{course['subject']}_{index + 1}",
                    "class": course["class"],
                    "grade": course["grade"],
                    "subject": course["subject"],
                    "teacher": course["teacher"],
                    "room": course["room"],
                    "copy": index + 1,
                }
            )
    return lessons


def add_pairwise_not_equal(model: cp_model.CpModel, variables: list[cp_model.IntVar]) -> None:
    for left_index in range(len(variables)):
        for right_index in range(left_index + 1, len(variables)):
            model.Add(variables[left_index] != variables[right_index])


def apply_subject_period_rule(model, slot_vars, lessons, rule, days, period_count) -> None:
    grade = normalize_grade(rule["scope"]["grade"])
    subject = rule["scope"]["subject"]
    period = rule["period"]
    forbidden_slots = [slot_number(day, period, period_count) for day in range(len(days))]
    for lesson in lessons:
        if lesson["grade"] == grade and lesson["subject"] == subject:
            for slot in forbidden_slots:
                model.Add(slot_vars[lesson["id"]] != slot)


def apply_subject_slots_rule(model, slot_vars, lessons, rule, day_index, period_count) -> None:
    grade = normalize_grade(rule["scope"]["grade"])
    subject = rule["scope"]["subject"]
    forbidden_slots = [
        slot_number(day_index[day], period, period_count)
        for day in rule["days"]
        if day in day_index
        for period in rule["periods"]
    ]
    for lesson in lessons:
        if lesson["grade"] == grade and lesson["subject"] == subject:
            for slot in forbidden_slots:
                model.Add(slot_vars[lesson["id"]] != slot)


def apply_fixed_subject_slot_rule(model, slot_vars, lessons, rule, day_index, period_count) -> None:
    """将指定课程固定到特定时间段"""
    grade = normalize_grade(rule["scope"]["grade"])
    subject = rule["scope"]["subject"]
    # 获取所有匹配的课时
    matching_lessons = [l for l in lessons if l["grade"] == grade and l["subject"] == subject]
    if not matching_lessons:
        return
    
    # 计算允许的 slot 集合
    allowed_slots = set()
    for day in rule["days"]:
        if day not in day_index:
            continue
        for period in rule["periods"]:
            allowed_slots.add(slot_number(day_index[day], period, period_count))
    
    if not allowed_slots:
        return
    
    # 将课时分配到允许的 slot（每个 slot 只能放一个课时）
    # 使用 first_available 策略：按 id 顺序分配
    for idx, lesson in enumerate(sorted(matching_lessons, key=lambda x: x["id"])):
        if idx < len(allowed_slots):
            target_slot = list(sorted(allowed_slots))[idx]
            model.Add(slot_vars[lesson["id"]] == target_slot)


def apply_teacher_unavailable_rule(model, slot_vars, lessons, rule, day_index, period_count) -> None:
    day = rule["day"]
    if day not in day_index:
        return
    forbidden_slots = [slot_number(day_index[day], period, period_count) for period in rule["periods"]]
    for lesson in lessons:
        if lesson["teacher"] == rule["teacher"]:
            for slot in forbidden_slots:
                model.Add(slot_vars[lesson["id"]] != slot)


def apply_room_unavailable_rule(model, slot_vars, lessons, rule, day_index, period_count) -> None:
    day = rule["day"]
    if day not in day_index:
        return
    forbidden_slots = [slot_number(day_index[day], period, period_count) for period in rule["periods"]]
    for lesson in lessons:
        if lesson["room"] == rule["room"]:
            for slot in forbidden_slots:
                model.Add(slot_vars[lesson["id"]] != slot)


def apply_double_lesson_rule(model, slot_vars, lessons, rule, period_count) -> bool:
    grade = normalize_grade(rule["scope"]["grade"])
    subject = rule["scope"]["subject"]
    matching_by_class = defaultdict(list)
    for lesson in lessons:
        if lesson["grade"] == grade and lesson["subject"] == subject:
            matching_by_class[lesson["class"]].append(lesson)
    applied = False
    for grouped_lessons in matching_by_class.values():
        if len(grouped_lessons) < 2:
            continue
        first = grouped_lessons[0]
        second = grouped_lessons[1]
        first_slot = slot_vars[first["id"]]
        second_slot = slot_vars[second["id"]]
        model.Add(second_slot == first_slot + 1)
        for day_end_slot in range(period_count - 1, period_count * 5, period_count):
            model.Add(first_slot != day_end_slot)
        applied = True
    return applied


def build_result_schedule(school, lessons, slot_vars, solver, applied_rules, ignored_rules) -> dict:
    days = school["days"]
    period_count = len(school["periods"])
    classes = empty_schedule(school)
    teacher_schedules = defaultdict(list)

    for event in school["fixed_events"]:
        cell = {
            "subject": event["subject"],
            "teacher": event["teacher"],
            "room": event["room"],
            "note": event.get("note", ""),
            "source": "fixed",
            "movable": False,
        }
        classes[event["class"]][event["day"]][event["period"] - 1] = cell

    scheduled_count = 0
    for lesson in lessons:
        slot = solver.Value(slot_vars[lesson["id"]])
        day = days[slot // period_count]
        period = (slot % period_count) + 1
        cell = {
            "subject": lesson["subject"],
            "teacher": lesson["teacher"],
            "room": lesson["room"],
            "note": "自动排课",
            "source": "solver",
            "movable": True,
        }
        classes[lesson["class"]][day][period - 1] = cell
        teacher_schedules[lesson["teacher"]].append(
            {
                "day": day,
                "period": period,
                "class": lesson["class"],
                "subject": lesson["subject"],
                "room": lesson["room"],
            }
        )
        scheduled_count += 1

    for items in teacher_schedules.values():
        items.sort(key=lambda item: (days.index(item["day"]), item["period"]))

    return {
        "status": "success",
        "message": "已生成一版可用课表，右侧可以查看班级课表和规则应用情况。",
        "conflict_count": 0,
        "conflicts": [],
        "applied_rules": applied_rules,
        "ignored_rules": ignored_rules,
        "classes": classes,
        "teacher_schedules": dict(teacher_schedules),
        "stats": {"scheduled_lessons": scheduled_count, "classes": len(school["classes"])},
    }


def solve_timetable_greedy(school: dict, lessons: list[dict], rules: list[dict], applied_rules: list[str], ignored_rules: list[str]) -> dict:
    days = school["days"]
    period_count = len(school["periods"])
    total_slots = len(days) * period_count
    fixed_slots_by_class = defaultdict(set)
    for event in school["fixed_events"]:
        fixed_slots_by_class[event["class"]].add(slot_number(days.index(event["day"]), event["period"], period_count))

    class_busy = defaultdict(set)
    teacher_busy = defaultdict(set)
    room_usage = defaultdict(lambda: defaultdict(int))
    assignments: dict[str, int] = {}
    room_capacity = {room["name"]: room["capacity"] for room in school["rooms"]}
    placement_state = new_placement_state()

    assigned_lesson_ids = set()
    for rule in rules:
        if rule.get("kind") != "fixed_subject_slot":
            continue
        grade = normalize_grade(rule["scope"]["grade"])
        subject = rule["scope"]["subject"]
        allowed_slots = [
            slot_number(days.index(day), period, period_count)
            for day in rule.get("days", [])
            if day in days
            for period in rule.get("periods", [])
        ]
        if not allowed_slots:
            continue
        lessons_by_class = defaultdict(list)
        for lesson in lessons:
            if lesson["grade"] == grade and lesson["subject"] == subject:
                lessons_by_class[lesson["class"]].append(lesson)
        for class_lessons in lessons_by_class.values():
            fixed_lesson = sorted(class_lessons, key=lambda item: item["id"])[0]
            fixed_slot = next(
                (
                    slot
                    for slot in allowed_slots
                    if can_place(
                        fixed_lesson,
                        slot,
                        fixed_slots_by_class,
                        class_busy,
                        teacher_busy,
                        room_usage,
                        room_capacity,
                        rules,
                        period_count,
                        placement_state,
                        allow_same_subject_adjacent=True,
                        enforce_subject_day_limit=False,
                    )
                ),
                None,
            )
            if fixed_slot is None:
                return failed_greedy_result(school, applied_rules, ignored_rules, f"{fixed_lesson['class']}{subject}固定课没有可用时间")
            assign_lesson(fixed_lesson, fixed_slot, class_busy, teacher_busy, room_usage, assignments, placement_state, period_count)
            assigned_lesson_ids.add(fixed_lesson["id"])

    for rule in rules:
        if rule.get("kind") != "double_lesson":
            continue
        grade = normalize_grade(rule["scope"]["grade"])
        subject = rule["scope"]["subject"]
        lessons_by_class = defaultdict(list)
        for lesson in lessons:
            if lesson["id"] not in assigned_lesson_ids and lesson["grade"] == grade and lesson["subject"] == subject:
                lessons_by_class[lesson["class"]].append(lesson)
        for class_lessons in lessons_by_class.values():
            if len(class_lessons) < 2:
                continue
            first, second = class_lessons[0], class_lessons[1]
            pair_slot = choose_pair_slot(
                first,
                second,
                total_slots,
                period_count,
                fixed_slots_by_class,
                class_busy,
                teacher_busy,
                room_usage,
                room_capacity,
                rules,
                assignments,
                placement_state,
            )
            if pair_slot is None:
                return failed_greedy_result(school, applied_rules, ignored_rules, f"{first['class']}{subject}连堂课没有可用时间")
            assign_lesson(first, pair_slot, class_busy, teacher_busy, room_usage, assignments, placement_state, period_count)
            assign_lesson(second, pair_slot + 1, class_busy, teacher_busy, room_usage, assignments, placement_state, period_count)
            assigned_lesson_ids.update({first["id"], second["id"]})

    remaining = [lesson for lesson in lessons if lesson["id"] not in assigned_lesson_ids]
    remaining.sort(key=lesson_priority)
    for lesson in remaining:
        slot = choose_slot(
            lesson,
            total_slots,
            period_count,
            fixed_slots_by_class,
            class_busy,
            teacher_busy,
            room_usage,
            room_capacity,
            rules,
            assignments,
            placement_state,
        )
        if slot is None:
            return failed_greedy_result(school, applied_rules, ignored_rules, f"{lesson['class']}{lesson['subject']}没有可用时间")
        assign_lesson(lesson, slot, class_busy, teacher_busy, room_usage, assignments, placement_state, period_count)

    return build_result_from_assignments(school, lessons, assignments, applied_rules, ignored_rules)


def choose_pair_slot(lesson_a, lesson_b, total_slots, period_count, fixed_slots_by_class, class_busy, teacher_busy, room_usage, room_capacity, rules, assignments, placement_state):
    for slot in candidate_slots(lesson_a, total_slots, period_count):
        if slot % period_count == period_count - 1:
            continue
        if subject_day_count(lesson_a, slot, placement_state, period_count) > 0:
            continue
        if can_place(lesson_a, slot, fixed_slots_by_class, class_busy, teacher_busy, room_usage, room_capacity, rules, period_count, placement_state, allow_same_subject_adjacent=True) and can_place(
            lesson_b, slot + 1, fixed_slots_by_class, class_busy, teacher_busy, room_usage, room_capacity, rules, period_count, placement_state, allow_same_subject_adjacent=True
        ):
            return slot
    return None


def choose_slot(lesson, total_slots, period_count, fixed_slots_by_class, class_busy, teacher_busy, room_usage, room_capacity, rules, assignments, placement_state):
    for options in (
        {"allow_same_subject_adjacent": False, "enforce_subject_day_limit": True},
        {"allow_same_subject_adjacent": True, "enforce_subject_day_limit": True},
        {"allow_same_subject_adjacent": True, "enforce_subject_day_limit": False},
    ):
        feasible_slots = [
            slot
            for slot in candidate_slots(lesson, total_slots, period_count)
            if can_place(lesson, slot, fixed_slots_by_class, class_busy, teacher_busy, room_usage, room_capacity, rules, period_count, placement_state, **options)
        ]
        if feasible_slots:
            return min(feasible_slots, key=lambda slot: placement_score(lesson, slot, placement_state, period_count))
    return None


def candidate_slots(lesson: dict, total_slots: int, period_count: int) -> list[int]:
    slots = list(range(total_slots))
    if lesson["subject"] in MAIN_SUBJECTS:
        slots.sort(key=lambda slot: (slot % period_count >= 4, slot // period_count, slot % period_count))
    elif lesson["subject"] in {"体育", "音乐", "美术", "劳动"}:
        slots.sort(key=lambda slot: (slot % period_count < 4, slot // period_count, slot % period_count))
    return slots


def can_place(
    lesson,
    slot,
    fixed_slots_by_class,
    class_busy,
    teacher_busy,
    room_usage,
    room_capacity,
    rules,
    period_count,
    placement_state,
    allow_same_subject_adjacent=False,
    enforce_subject_day_limit=True,
) -> bool:
    if slot in fixed_slots_by_class[lesson["class"]]:
        return False
    if slot in class_busy[lesson["class"]]:
        return False
    if lesson["teacher"] != "班主任" and slot in teacher_busy[lesson["teacher"]]:
        return False
    if room_usage[lesson["room"]][slot] >= room_capacity.get(lesson["room"], 999):
        return False
    if enforce_subject_day_limit and subject_day_count(lesson, slot, placement_state, period_count) >= 2:
        return False
    if not allow_same_subject_adjacent and has_adjacent_same_subject(lesson, slot, placement_state, period_count):
        return False
    day_number = slot // period_count
    period = (slot % period_count) + 1
    for rule in rules:
        kind = rule.get("kind")
        if kind == "avoid_subject_period" and lesson["grade"] == normalize_grade(rule["scope"]["grade"]) and lesson["subject"] == rule["scope"]["subject"] and period == rule["period"]:
            return False
        if kind == "avoid_subject_slots" and lesson["grade"] == normalize_grade(rule["scope"]["grade"]) and lesson["subject"] == rule["scope"]["subject"]:
            if period in rule["periods"] and ["周一", "周二", "周三", "周四", "周五"][day_number] in rule["days"]:
                return False
        if kind == "teacher_unavailable" and lesson["teacher"] == rule["teacher"] and period in rule["periods"]:
            # day is checked by index to avoid localized string comparisons in the hot path.
            if rule["day"] == ["周一", "周二", "周三", "周四", "周五"][day_number]:
                return False
        if kind == "room_unavailable" and lesson["room"] == rule["room"] and period in rule["periods"]:
            if rule["day"] == ["周一", "周二", "周三", "周四", "周五"][day_number]:
                return False
    return True


def placement_score(lesson, slot, placement_state, period_count) -> int:
    day_number = slot // period_count
    period_index = slot % period_count
    score = 0
    score += subject_day_count(lesson, slot, placement_state, period_count) * 80
    score += class_day_load(lesson, day_number, placement_state) * 6
    if lesson["subject"] in MAIN_SUBJECTS:
        score += 18 if period_index >= 4 else period_index
    elif lesson["subject"] in {"体育", "音乐", "美术", "劳动"}:
        score += 10 if period_index < 4 else period_index - 4
    else:
        score += period_index
    score += subject_slot_repetition(lesson, period_index, placement_state) * 4
    return score


def subject_day_count(lesson, slot, placement_state, period_count) -> int:
    day_number = slot // period_count
    return placement_state["class_subject_day"][(lesson["class"], lesson["subject"], day_number)]


def class_day_load(lesson, day_number, placement_state) -> int:
    return placement_state["class_day_load"][(lesson["class"], day_number)]


def subject_slot_repetition(lesson, period_index, placement_state) -> int:
    return placement_state["class_subject_period"][(lesson["class"], lesson["subject"], period_index)]


def has_adjacent_same_subject(lesson, slot, placement_state, period_count) -> bool:
    adjacent_slots = []
    if slot % period_count > 0:
        adjacent_slots.append(slot - 1)
    if slot % period_count < period_count - 1:
        adjacent_slots.append(slot + 1)
    assigned_slots = placement_state["class_subject_slots"][(lesson["class"], lesson["subject"])]
    return any(assigned_slot in assigned_slots for assigned_slot in adjacent_slots)


def assign_lesson(lesson, slot, class_busy, teacher_busy, room_usage, assignments, placement_state, period_count) -> None:
    assignments[lesson["id"]] = slot
    class_busy[lesson["class"]].add(slot)
    teacher_busy[lesson["teacher"]].add(slot)
    room_usage[lesson["room"]][slot] += 1
    day_number = slot // period_count
    period_index = slot % period_count
    placement_state["class_subject_day"][(lesson["class"], lesson["subject"], day_number)] += 1
    placement_state["class_day_load"][(lesson["class"], day_number)] += 1
    placement_state["class_subject_period"][(lesson["class"], lesson["subject"], period_index)] += 1
    placement_state["class_subject_slots"][(lesson["class"], lesson["subject"])].add(slot)


def new_placement_state() -> dict:
    return {
        "class_subject_day": defaultdict(int),
        "class_day_load": defaultdict(int),
        "class_subject_period": defaultdict(int),
        "class_subject_slots": defaultdict(set),
    }


def lesson_priority(lesson: dict) -> tuple[int, str]:
    room_priority = 0 if lesson["room"] in {"机房A", "实验室", "操场"} else 1
    subject_priority = 0 if lesson["subject"] in MAIN_SUBJECTS else 1
    return (room_priority, subject_priority, lesson["id"])


def build_result_from_assignments(school, lessons, assignments, applied_rules, ignored_rules) -> dict:
    classes = empty_schedule(school)
    teacher_schedules = defaultdict(list)
    days = school["days"]
    period_count = len(school["periods"])

    for event in school["fixed_events"]:
        classes[event["class"]][event["day"]][event["period"] - 1] = {
            "subject": event["subject"],
            "teacher": event["teacher"],
            "room": event["room"],
            "note": event.get("note", ""),
            "source": "fixed",
            "movable": False,
        }

    for lesson in lessons:
        slot = assignments[lesson["id"]]
        day = days[slot // period_count]
        period = (slot % period_count) + 1
        classes[lesson["class"]][day][period - 1] = {
            "subject": lesson["subject"],
            "teacher": lesson["teacher"],
            "room": lesson["room"],
            "note": "自动排课",
            "source": "solver",
            "movable": True,
        }
        teacher_schedules[lesson["teacher"]].append({"day": day, "period": period, "class": lesson["class"], "subject": lesson["subject"], "room": lesson["room"]})

    for items in teacher_schedules.values():
        items.sort(key=lambda item: (days.index(item["day"]), item["period"]))

    return {
        "status": "success",
        "message": "已生成一版可用课表，右侧可以查看班级课表和规则应用情况。",
        "conflict_count": 0,
        "conflicts": [],
        "applied_rules": applied_rules,
        "ignored_rules": ignored_rules,
        "classes": classes,
        "teacher_schedules": dict(teacher_schedules),
        "stats": {"scheduled_lessons": len(lessons), "classes": len(school["classes"])},
    }


def failed_greedy_result(school, applied_rules, ignored_rules, reason: str) -> dict:
    """生成智能冲突建议"""
    suggestions = generate_conflict_suggestions(school, reason, applied_rules, ignored_rules)
    return {
        "status": "failed",
        "message": "暂时没有找到满足全部必须条件的课表",
        "conflict_count": 1,
        "conflicts": [reason],
        "suggestions": suggestions,
        "applied_rules": applied_rules,
        "ignored_rules": ignored_rules,
        "classes": empty_schedule(school),
        "teacher_schedules": {},
        "stats": {"scheduled_lessons": 0, "classes": len(school["classes"])},
    }


def generate_conflict_suggestions(school, reason: str, applied_rules: list, ignored_rules: list) -> list[dict]:
    """根据冲突原因生成智能建议"""
    suggestions = []
    classes = school.get("classes", [])
    teachers = {t["name"] for t in school.get("teachers", [])}
    
    # 分析固定规则冲突
    fixed_rules = [r for r in applied_rules if "固定" in r or "不能" in r]
    if fixed_rules:
        suggestions.append({
            "type": "规则冲突",
            "title": "多个固定规则可能互相冲突",
            "detail": f"当前有 {len(fixed_rules)} 条固定规则：{', '.join(fixed_rules[:3])}{'...' if len(fixed_rules) > 3 else ''}",
            "action": "建议保留最重要的1-2条固定规则，删除其他固定规则后重新排课"
        })
    
    # 分析班级数与课时
    if "没有可用时间" in reason:
        grade_match = [g for g in ["一年级", "二年级", "七年级"] if g in reason]
        if grade_match:
            grade = grade_match[0]
            suggestions.append({
                "type": "课时过多",
                "title": f"{grade}班级课时安排不下",
                "detail": f"该年级的课程数量超过了可用的时间槽位",
                "action": f"建议减少 {grade} 班级数量，或减少部分课程的每周课时数"
            })
    
    # 分析教师冲突
    teacher_rules = [r for r in applied_rules if "老师" in r and "不能" in r]
    if teacher_rules and len(teacher_rules) >= 2:
        suggestions.append({
            "type": "教师限制过多",
            "title": "多个教师有排课限制",
            "detail": f"当前有 {len(teacher_rules)} 位老师有限制条件",
            "action": "建议检查是否有老师被限制在同一天的全部节次，这会导致无法排课"
        })
    
    # 通用建议
    suggestions.append({
        "type": "通用建议",
        "title": "尝试简化规则",
        "detail": f"当前有 {len(applied_rules)} 条应用规则和 {len(ignored_rules)} 条未应用规则",
        "action": "暂时删除部分规则（如固定课、连堂课），只保留最必要的限制条件来排课"
    })
    
    suggestions.append({
        "type": "操作建议",
        "title": "分步排查",
        "detail": "建议先删除最近添加的规则，逐步排查是哪条规则导致的冲突",
        "action": "在规则列表中逐一删除规则并重新排课，直到找到冲突的规则"
    })
    
    return suggestions


def empty_schedule(school: dict) -> dict:
    return {
        class_name: {
            day: [
                {
                    "subject": "自习",
                    "teacher": "",
                    "room": "本班教室",
                    "note": "",
                    "source": "empty",
                    "movable": False,
                }
                for _ in school["periods"]
            ]
            for day in school["days"]
        }
        for class_name in school["classes"]
    }


def slot_number(day: int, period: int, period_count: int) -> int:
    return day * period_count + period - 1


def afternoon_slots(days: list[str], period_count: int) -> list[int]:
    return [
        slot_number(day_index, period, period_count)
        for day_index in range(len(days))
        for period in range(5, period_count + 1)
    ]


def normalize_grade(grade: str) -> str:
    return grade
