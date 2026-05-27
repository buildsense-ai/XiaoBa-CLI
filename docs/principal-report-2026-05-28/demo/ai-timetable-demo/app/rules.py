from __future__ import annotations

import re
from hashlib import md5


DAY_ALIASES = {
    "周一": "周一",
    "星期一": "周一",
    "礼拜一": "周一",
    "周二": "周二",
    "星期二": "周二",
    "礼拜二": "周二",
    "周三": "周三",
    "星期三": "周三",
    "礼拜三": "周三",
    "周四": "周四",
    "星期四": "周四",
    "礼拜四": "周四",
    "周五": "周五",
    "星期五": "周五",
    "礼拜五": "周五",
}
SUBJECTS = ["信息科技", "信息技术", "语文", "数学", "英语", "物理", "化学", "历史", "地理", "生物", "科学", "道法", "体育", "艺术", "美术", "音乐", "劳动"]
GRADES = ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级", "七年级", "八年级", "九年级"]
CHINESE_NUMBERS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8}


def parse_text_rule(text: str) -> dict:
    cleaned = re.sub(r"\s+", "", text or "")
    if not cleaned:
        return review_needed_rule(text)

    time_rule = try_parse_stage_start_time(cleaned)
    if time_rule:
        return time_rule

    teacher_rule = try_parse_teacher_unavailable(cleaned)
    if teacher_rule:
        return teacher_rule

    room_rule = try_parse_room_unavailable(cleaned)
    if room_rule:
        return room_rule

    double_rule = try_parse_double_lesson(cleaned)
    if double_rule:
        return double_rule

    subject_slots_rule = try_parse_subject_slots(cleaned)
    if subject_slots_rule:
        return subject_slots_rule

    subject_period_rule = try_parse_subject_period(cleaned)
    if subject_period_rule:
        return subject_period_rule

    morning_rule = try_parse_morning_preference(cleaned)
    if morning_rule:
        return morning_rule

    # 新增：支持"把XX课固定在周X第X节"格式
    fixed_rule = try_parse_fixed_subject_slot(cleaned)
    if fixed_rule:
        return fixed_rule

    return review_needed_rule(text)


def parse_teacher_rule(text: str) -> dict:
    rule = try_parse_teacher_unavailable(re.sub(r"\s+", "", text or ""))
    if not rule:
        return review_needed_rule(text)
    return rule


def try_parse_stage_start_time(text: str) -> dict | None:
    stage = None
    if "小学" in text:
        stage = "小学"
    elif "初中" in text:
        stage = "初中"
    if not stage or not any(word in text for word in ["上课", "开始", "开课"]):
        return None
    match = re.search(r"([0-2]?\d)(?:点|:|：)([0-5]?\d)?", text)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2) or 0)
    if hour > 23 or minute > 59:
        return None
    start_time = f"{hour:02d}:{minute:02d}"
    return with_id(
        {
            "kind": "stage_start_time",
            "stage": stage,
            "start_time": start_time,
            "strictness": "time",
            "summary": f"{stage}第1节从{start_time}开始",
            "source_text": text,
        }
    )


def try_parse_teacher_unavailable(text: str) -> dict | None:
    day = find_day(text)
    if not day:
        return None
    if not any(word in text for word in ["不能上课", "不排课", "请假", "禁排", "外出", "培训"]):
        return None
    if any(subject in text for subject in SUBJECTS) and not text.startswith(("王老师", "李老师", "张老师", "陈老师")):
        return None

    day_match = re.search(r"(周[一二三四五]|星期[一二三四五]|礼拜[一二三四五])", text)
    if not day_match:
        return None
    teacher = text[: day_match.start()].strip("，。,. ")
    if not teacher or any(grade in teacher for grade in GRADES):
        return None
    periods = find_periods(text) or [1, 2, 3, 4, 5, 6, 7, 8]
    return with_id(
        {
            "kind": "teacher_unavailable",
            "teacher": teacher,
            "day": day,
            "periods": periods,
            "strictness": "hard",
            "summary": f"{teacher}{day}{periods_label(periods)}不排课",
            "source_text": text,
        }
    )


def try_parse_room_unavailable(text: str) -> dict | None:
    room = None
    if "机房" in text:
        room = "机房A"
    elif "实验室" in text:
        room = "实验室"
    if not room or not any(word in text for word in ["维修", "占用", "不能用", "停用"]):
        return None
    day = find_day(text)
    periods = find_periods(text)
    if not day or not periods:
        return None
    return with_id(
        {
            "kind": "room_unavailable",
            "room": room,
            "day": day,
            "periods": periods,
            "strictness": "hard",
            "summary": f"{room}{day}第{periods[0]}-{periods[-1]}节不可用",
            "source_text": text,
        }
    )


def try_parse_double_lesson(text: str) -> dict | None:
    if not any(word in text for word in ["连排", "连续", "连上"]) or not any(word in text for word in ["两节", "2节", "二节"]):
        return None
    grade = find_grade(text)
    subject = find_subject(text)
    if not grade or not subject:
        return None
    return with_id(
        {
            "kind": "double_lesson",
            "scope": {"grade": grade, "subject": subject},
            "length": 2,
            "strictness": "hard",
            "summary": f"{grade}{subject}安排连续2节用于考试或检测",
            "source_text": text,
        }
    )


def try_parse_subject_period(text: str) -> dict | None:
    grade = find_grade(text)
    subject = find_subject(text)
    periods = find_periods(text)
    if not grade or not subject or not periods:
        return None
    if not any(word in text for word in ["不要", "不能", "不排", "禁排", "尽量不", "避免"]):
        return None
    strictness = "soft" if any(word in text for word in ["尽量", "最好", "优先"]) else "hard"
    period = periods[0]
    return with_id(
        {
            "kind": "avoid_subject_period",
            "scope": {"grade": grade, "subject": subject},
            "period": period,
            "strictness": strictness,
            "summary": f"{grade}{subject}课不安排在第{period}节",
            "source_text": text,
        }
    )


def try_parse_subject_slots(text: str) -> dict | None:
    grade = find_grade(text)
    subject = find_subject(text)
    days = find_days(text)
    periods = find_periods(text)
    if not grade or not subject or not days or not periods:
        return None
    if not any(word in text for word in ["不要", "不能", "不排", "禁排", "尽量不", "避免", "不能有"]):
        return None
    strictness = "soft" if any(word in text for word in ["尽量", "最好", "优先"]) else "hard"
    return with_id(
        {
            "kind": "avoid_subject_slots",
            "scope": {"grade": grade, "subject": subject},
            "days": days,
            "periods": periods,
            "strictness": strictness,
            "summary": f"{grade}{subject}课不安排在{days_label(days)}{periods_label(periods)}",
            "source_text": text,
        }
    )


def try_parse_morning_preference(text: str) -> dict | None:
    if "上午" not in text or not any(word in text for word in ["尽量", "优先", "最好"]):
        return None
    subjects = ["语文", "数学", "英语"] if "语数英" in text else [subject for subject in SUBJECTS if subject in text]
    if not subjects:
        return None
    return with_id(
        {
            "kind": "prefer_morning",
            "subjects": subjects,
            "strictness": "soft",
            "summary": f"{'、'.join(subjects)}尽量安排在上午",
            "source_text": text,
        }
    )


def try_parse_fixed_subject_slot(text: str) -> dict | None:
    """解析"把XX课固定在周X第X节"格式"""
    grade = find_grade(text)
    subject = find_subject(text)
    days = find_days(text)
    periods = find_periods(text)
    if not grade or not subject or not days or not periods:
        return None
    # 关键词：固定、排在、安排在、放在、调到、改到
    if not any(word in text for word in ["固定", "排在", "安排在", "放在", "调到", "改到"]):
        return None
    return with_id(
        {
            "kind": "fixed_subject_slot",
            "scope": {"grade": grade, "subject": subject},
            "days": days,
            "periods": periods,
            "strictness": "hard",
            "summary": f"{grade}{subject}课固定安排在{days_label(days)}{periods_label(periods)}",
            "source_text": text,
        }
    )


def review_needed_rule(text: str) -> dict:
    return with_id({"kind": "review_needed", "strictness": "review", "summary": "这条要求还需要补充细节才能参与排课", "source_text": text or ""})


def find_grade(text: str) -> str | None:
    for grade in GRADES:
        if grade in text:
            return grade
    return None


def find_subject(text: str) -> str | None:
    for subject in SUBJECTS:
        if subject in text:
            return "信息科技" if subject == "信息技术" else subject
    if "信息课" in text:
        return "信息科技"
    return None


def find_day(text: str) -> str | None:
    days = find_days(text)
    return days[0] if days else None


def find_days(text: str) -> list[str]:
    weekday_order = ["周一", "周二", "周三", "周四", "周五"]
    found = []
    for alias, normalized in DAY_ALIASES.items():
        if alias in text and normalized not in found:
            found.append(normalized)
    return sorted(found, key=weekday_order.index)


def find_periods(text: str) -> list[int]:
    if any(word in text for word in ["下午", "午后"]):
        return [5, 6, 7, 8]
    if any(word in text for word in ["上午", "早上", "早晨", "早间"]):
        return [1, 2, 3, 4]

    range_match = re.search(r"第?([1-8一二三四五六七八])[-到至~—]([1-8一二三四五六七八])节", text)
    if range_match:
        start = parse_number(range_match.group(1))
        end = parse_number(range_match.group(2))
        if start and end and start <= end:
            return list(range(start, end + 1))

    single_match = re.search(r"第([1-8一二三四五六七八])节", text)
    if single_match:
        number = parse_number(single_match.group(1))
        return [number] if number else []
    return []


def parse_number(value: str) -> int | None:
    if value.isdigit():
        return int(value)
    return CHINESE_NUMBERS.get(value)


def periods_label(periods: list[int]) -> str:
    if periods == [1, 2, 3, 4]:
        return "上午"
    if periods == [5, 6, 7, 8]:
        return "下午"
    if len(periods) == 1:
        return f"第{periods[0]}节"
    return f"第{periods[0]}-{periods[-1]}节"


def days_label(days: list[str]) -> str:
    return "、".join(days)


def with_id(rule: dict) -> dict:
    digest = md5(f"{rule.get('kind')}|{rule.get('source_text')}|{rule.get('summary')}".encode("utf-8")).hexdigest()
    return {"id": digest[:10], **rule}
