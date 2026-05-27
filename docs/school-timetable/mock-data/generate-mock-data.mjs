import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.dirname(fileURLToPath(import.meta.url));

const days = [
  { id: "mon", order: 1, name_zh: "周一" },
  { id: "tue", order: 2, name_zh: "周二" },
  { id: "wed", order: 3, name_zh: "周三" },
  { id: "thu", order: 4, name_zh: "周四" },
  { id: "fri", order: 5, name_zh: "周五" },
];

const periods = [
  { id: "p1", order: 1, name_zh: "第1节", start: "08:20", end: "09:00", segment: "morning" },
  { id: "p2", order: 2, name_zh: "第2节", start: "09:10", end: "09:50", segment: "morning" },
  { id: "p3", order: 3, name_zh: "第3节", start: "10:20", end: "11:00", segment: "morning" },
  { id: "p4", order: 4, name_zh: "第4节", start: "11:10", end: "11:50", segment: "morning" },
  { id: "p5", order: 5, name_zh: "第5节", start: "13:30", end: "14:10", segment: "afternoon", after_lunch: true },
  { id: "p6", order: 6, name_zh: "第6节", start: "14:20", end: "15:00", segment: "afternoon" },
  { id: "p7", order: 7, name_zh: "第7节", start: "15:25", end: "16:05", segment: "afternoon" },
  { id: "p8", order: 8, name_zh: "第8节", start: "16:15", end: "16:55", segment: "after_school" },
];

const gradeProfiles = {
  primary_lower_30: {
    id: "primary_lower_30",
    name_zh: "小学低段30课时",
    allowed_periods: ["p1", "p2", "p3", "p4", "p5", "p6"],
    weekly_periods: 30,
    max_daily_periods: 6,
  },
  primary_upper_35: {
    id: "primary_upper_35",
    name_zh: "小学中高段35课时",
    allowed_periods: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
    weekly_periods: 35,
    max_daily_periods: 7,
  },
  junior_40: {
    id: "junior_40",
    name_zh: "初中40课时",
    allowed_periods: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
    weekly_periods: 40,
    max_daily_periods: 8,
  },
};

const campuses = [
  {
    id: "east",
    name_zh: "东校区",
    stage_note_zh: "小学低中段校区",
    address_mock: "春晖路18号",
    grade_ids: ["P1", "P2", "P3"],
  },
  {
    id: "west",
    name_zh: "西校区",
    stage_note_zh: "小学高段与初中校区",
    address_mock: "启明路66号",
    grade_ids: ["P4", "P5", "P6", "J1"],
  },
];

const campusByGrade = Object.fromEntries(campuses.flatMap((campus) => campus.grade_ids.map((gradeId) => [gradeId, campus.id])));

const grades = [
  { id: "P1", name_zh: "小学一年级", stage: "primary", level: 1, campus_id: "east", day_profile_id: "primary_lower_30", class_count: 6 },
  { id: "P2", name_zh: "小学二年级", stage: "primary", level: 2, campus_id: "east", day_profile_id: "primary_lower_30", class_count: 6 },
  { id: "P3", name_zh: "小学三年级", stage: "primary", level: 3, campus_id: "east", day_profile_id: "primary_upper_35", class_count: 6 },
  { id: "P4", name_zh: "小学四年级", stage: "primary", level: 4, campus_id: "west", day_profile_id: "primary_upper_35", class_count: 6 },
  { id: "P5", name_zh: "小学五年级", stage: "primary", level: 5, campus_id: "west", day_profile_id: "primary_upper_35", class_count: 6 },
  { id: "P6", name_zh: "小学六年级", stage: "primary", level: 6, campus_id: "west", day_profile_id: "primary_upper_35", class_count: 6 },
  { id: "J1", name_zh: "初中一年级", stage: "junior", level: 7, campus_id: "west", day_profile_id: "junior_40", class_count: 6 },
];

const subjectDefinitions = [
  ["flag_ceremony", "升旗/晨会", "activity", "assembly_ground", { requires_teacher: false, fixed_event: true }],
  ["chinese", "语文", "core", "homeroom", { preferred_segments: ["morning"] }],
  ["math", "数学", "core", "homeroom", { preferred_segments: ["morning"] }],
  ["english", "英语", "core", "homeroom", { preferred_segments: ["morning"] }],
  ["morality", "道德与法治", "humanities", "homeroom", {}],
  ["science", "科学", "science", "science_lab", { special_room_preferred: true }],
  ["biology", "生物", "science", "biology_lab", { special_room_preferred: true }],
  ["history", "历史", "humanities", "homeroom", {}],
  ["geography", "地理", "humanities", "homeroom", {}],
  ["pe", "体育", "physical", "sports_space", { avoid_periods: ["p5"], preferred_segments: ["morning", "afternoon"] }],
  ["music", "音乐", "arts", "music_room", { special_room_preferred: true }],
  ["art", "美术", "arts", "art_room", { special_room_preferred: true }],
  ["it", "信息科技", "technology", "computer_room", { special_room_required: true }],
  ["labor", "劳动", "practice", "labor_room", { special_room_preferred: true }],
  ["class_meeting", "班会", "activity", "homeroom", { advisor_preferred: true }],
  ["reading", "阅读", "activity", "homeroom", { advisor_preferred: true }],
  ["comprehensive_practice", "综合实践", "practice", "maker_space", { special_room_preferred: true }],
  ["school_based", "校本课程", "activity", "homeroom", {}],
  ["self_study", "自习/作业整理", "activity", "homeroom", {}],
];

const subjects = subjectDefinitions.map(([id, name_zh, category, default_room_type, extra]) => ({
  id,
  name_zh,
  category,
  default_room_type,
  requires_teacher: extra.requires_teacher ?? true,
  special_room_required: extra.special_room_required ?? false,
  special_room_preferred: extra.special_room_preferred ?? false,
  advisor_preferred: extra.advisor_preferred ?? false,
  fixed_event: extra.fixed_event ?? false,
  preferred_segments: extra.preferred_segments ?? [],
  avoid_periods: extra.avoid_periods ?? [],
}));

const subjectById = Object.fromEntries(subjects.map((subject) => [subject.id, subject]));

const school = {
  id: "mock-nine-year-school-001",
  name_zh: "启航实验学校（模拟）",
  dataset_version: "2026-05-22.v1",
  locale: "zh-CN",
  timezone: "Asia/Shanghai",
  description_zh: "两校区九年一贯制学校排课模拟数据：小学6个年级、每年级6个班，初中一年级6个班。",
  assumptions: [
    "东校区承载小学一至三年级，西校区承载小学四至六年级和初中一年级。",
    "教师默认不跨校区任课，跨校区约束作为硬约束提供。",
    "基础数据尽量可排；overlays 中包含运行中新增约束和故意不可行案例。",
  ],
};

const calendar = {
  week_pattern: "five_day_school_week",
  days,
  periods,
  grade_day_profiles: Object.values(gradeProfiles),
  common_breaks: [
    { id: "morning_exercise", name_zh: "大课间", after_period: "p2", duration_minutes: 25 },
    { id: "eye_exercise_pm", name_zh: "眼保健操", after_period: "p6", duration_minutes: 10 },
    { id: "lunch", name_zh: "午餐与午休", after_period: "p4", duration_minutes: 100 },
  ],
};

function classId(gradeId, index) {
  return `${gradeId}-C${String(index).padStart(2, "0")}`;
}

function homeroomId(gradeId, index) {
  return `R-${campusByGrade[gradeId] === "east" ? "E" : "W"}-${gradeId}-C${String(index).padStart(2, "0")}`;
}

const classes = [];
for (const grade of grades) {
  for (let i = 1; i <= grade.class_count; i += 1) {
    classes.push({
      id: classId(grade.id, i),
      name_zh: `${grade.name_zh}${i}班`,
      grade_id: grade.id,
      campus_id: grade.campus_id,
      student_count: grade.stage === "junior" ? 44 + ((i + 1) % 4) : 38 + ((grade.level + i) % 6),
      homeroom_id: homeroomId(grade.id, i),
      advisor_teacher_id: null,
      notes: [],
    });
  }
}

function room(id, name_zh, campus_id, room_type, capacity, extra = {}) {
  return {
    id,
    name_zh,
    campus_id,
    room_type,
    capacity,
    available_days: extra.available_days ?? days.map((day) => day.id),
    available_periods: extra.available_periods ?? periods.map((period) => period.id),
    unavailable_slots: extra.unavailable_slots ?? [],
    compatible_subject_ids: extra.compatible_subject_ids ?? [],
    home_class_id: extra.home_class_id ?? null,
  };
}

const rooms = [];
for (const classInfo of classes) {
  const code = classInfo.campus_id === "east" ? "E" : "W";
  rooms.push(room(classInfo.homeroom_id, `${classInfo.name_zh}教室`, classInfo.campus_id, "homeroom", Math.max(48, classInfo.student_count + 4), {
    compatible_subject_ids: ["chinese", "math", "english", "morality", "history", "geography", "class_meeting", "reading", "school_based", "self_study"],
    home_class_id: classInfo.id,
    building: code === "E" ? "东校区明德楼" : "西校区致远楼",
  }));
}

rooms.push(
  room("R-E-MUSIC-01", "东校区音乐教室1", "east", "music_room", 48, { compatible_subject_ids: ["music"] }),
  room("R-E-MUSIC-02", "东校区音乐教室2", "east", "music_room", 48, { compatible_subject_ids: ["music"] }),
  room("R-E-ART-01", "东校区美术教室1", "east", "art_room", 48, { compatible_subject_ids: ["art"] }),
  room("R-E-ART-02", "东校区美术教室2", "east", "art_room", 48, { compatible_subject_ids: ["art"] }),
  room("R-E-SCI-01", "东校区科学实验室1", "east", "science_lab", 48, { compatible_subject_ids: ["science"] }),
  room("R-E-SCI-02", "东校区科学实验室2", "east", "science_lab", 48, { compatible_subject_ids: ["science"] }),
  room("R-E-COMP-01", "东校区计算机教室1", "east", "computer_room", 48, { compatible_subject_ids: ["it"] }),
  room("R-E-COMP-02", "东校区计算机教室2", "east", "computer_room", 48, {
    compatible_subject_ids: ["it"],
    unavailable_slots: [{ day: "fri", periods: ["p1", "p2", "p3", "p4"], reason_zh: "设备巡检" }],
  }),
  room("R-E-GYM-01", "东校区风雨操场", "east", "sports_space", 96, { compatible_subject_ids: ["pe"] }),
  room("R-E-FIELD-01", "东校区操场A区", "east", "sports_space", 80, { compatible_subject_ids: ["pe", "flag_ceremony"] }),
  room("R-E-FIELD-02", "东校区操场B区", "east", "sports_space", 80, { compatible_subject_ids: ["pe", "flag_ceremony"] }),
  room("R-E-MAKER-01", "东校区创客教室", "east", "maker_space", 48, { compatible_subject_ids: ["comprehensive_practice", "labor"] }),
  room("R-E-LABOR-01", "东校区劳动教室", "east", "labor_room", 48, { compatible_subject_ids: ["labor", "comprehensive_practice"] }),
  room("R-E-ASM-01", "东校区报告厅", "east", "assembly_ground", 260, { compatible_subject_ids: ["flag_ceremony", "school_based"] }),
  room("R-W-MUSIC-01", "西校区音乐教室1", "west", "music_room", 52, { compatible_subject_ids: ["music"] }),
  room("R-W-MUSIC-02", "西校区音乐教室2", "west", "music_room", 52, { compatible_subject_ids: ["music"] }),
  room("R-W-ART-01", "西校区美术教室1", "west", "art_room", 52, { compatible_subject_ids: ["art"] }),
  room("R-W-ART-02", "西校区美术教室2", "west", "art_room", 52, { compatible_subject_ids: ["art"] }),
  room("R-W-SCI-01", "西校区科学实验室1", "west", "science_lab", 52, { compatible_subject_ids: ["science"] }),
  room("R-W-SCI-02", "西校区科学实验室2", "west", "science_lab", 52, { compatible_subject_ids: ["science"] }),
  room("R-W-SCI-03", "西校区科学实验室3", "west", "science_lab", 52, { compatible_subject_ids: ["science"] }),
  room("R-W-BIO-01", "西校区生物实验室1", "west", "biology_lab", 52, { compatible_subject_ids: ["biology"] }),
  room("R-W-BIO-02", "西校区生物实验室2", "west", "biology_lab", 52, { compatible_subject_ids: ["biology"] }),
  room("R-W-COMP-01", "西校区计算机教室1", "west", "computer_room", 52, { compatible_subject_ids: ["it"] }),
  room("R-W-COMP-02", "西校区计算机教室2", "west", "computer_room", 52, { compatible_subject_ids: ["it"] }),
  room("R-W-COMP-03", "西校区计算机教室3", "west", "computer_room", 52, { compatible_subject_ids: ["it"] }),
  room("R-W-GYM-01", "西校区体育馆1", "west", "sports_space", 100, { compatible_subject_ids: ["pe"] }),
  room("R-W-GYM-02", "西校区体育馆2", "west", "sports_space", 100, { compatible_subject_ids: ["pe"] }),
  room("R-W-FIELD-01", "西校区操场A区", "west", "sports_space", 90, { compatible_subject_ids: ["pe", "flag_ceremony"] }),
  room("R-W-FIELD-02", "西校区操场B区", "west", "sports_space", 90, { compatible_subject_ids: ["pe", "flag_ceremony"] }),
  room("R-W-FIELD-03", "西校区操场C区", "west", "sports_space", 90, { compatible_subject_ids: ["pe"] }),
  room("R-W-FIELD-04", "西校区操场D区", "west", "sports_space", 90, { compatible_subject_ids: ["pe"] }),
  room("R-W-MAKER-01", "西校区创客教室1", "west", "maker_space", 52, { compatible_subject_ids: ["comprehensive_practice", "labor", "school_based"] }),
  room("R-W-MAKER-02", "西校区创客教室2", "west", "maker_space", 52, { compatible_subject_ids: ["comprehensive_practice", "labor", "school_based"] }),
  room("R-W-LABOR-01", "西校区劳动教室", "west", "labor_room", 52, { compatible_subject_ids: ["labor", "comprehensive_practice"] }),
  room("R-W-LIB-01", "西校区图书馆阅览室", "west", "library", 80, { compatible_subject_ids: ["reading", "school_based"] }),
  room("R-W-ASM-01", "西校区报告厅", "west", "assembly_ground", 360, { compatible_subject_ids: ["flag_ceremony", "school_based"] }),
);

function hard(type, params, reason_zh) {
  return { type, severity: "hard", params, reason_zh };
}

function soft(type, params, reason_zh, weight = 1) {
  return { type, severity: "soft", weight, params, reason_zh };
}

function req(grade_id, subject_id, weekly_periods, extra = {}) {
  const subject = subjectById[subject_id];
  const defaultMaxPerDay = weekly_periods > 5 ? 2 : 1;
  return {
    id: `REQ-${grade_id}-${subject_id}`,
    grade_id,
    subject_id,
    weekly_periods,
    room_type: extra.room_type ?? subject.default_room_type,
    min_distinct_days: extra.min_distinct_days ?? Math.min(weekly_periods, 5),
    max_per_day: extra.max_per_day ?? defaultMaxPerDay,
    consecutive_policy: extra.consecutive_policy ?? { mode: "none" },
    hard_constraints: extra.hard_constraints ?? [],
    soft_constraints: extra.soft_constraints ?? [],
    notes_zh: extra.notes_zh ?? "",
  };
}

const lowerPrimaryPlan = [
  ["flag_ceremony", 1],
  ["chinese", 8, { max_per_day: 2, min_distinct_days: 5, soft_constraints: [soft("prefer_morning", { target_ratio: 0.75 }, "低段语文尽量放上午", 4)] }],
  ["math", 5, { soft_constraints: [soft("prefer_morning", { target_ratio: 0.8 }, "低段数学尽量放上午", 4)] }],
  ["english", 2, { hard_constraints: [hard("forbidden_weekdays", { weekdays: ["mon"] }, "低段周一不排英语，避免开周负担过重")] }],
  ["morality", 2],
  ["science", 1, { room_type: "science_lab" }],
  ["pe", 4, { min_distinct_days: 4, soft_constraints: [soft("spread_across_week", { min_gap_days: 1 }, "体育尽量隔天分布", 3), soft("avoid_periods", { periods: ["p5"] }, "午饭后第一节尽量不排体育", 2)] }],
  ["music", 2],
  ["art", 2],
  ["labor", 1],
  ["class_meeting", 1, { hard_constraints: [hard("fixed_slot", { day: "fri", period: "p5" }, "低段班会固定周五第5节")] }],
  ["reading", 1],
];

const middlePrimaryPlan = [
  ["flag_ceremony", 1],
  ["chinese", 7, { max_per_day: 2, min_distinct_days: 5, soft_constraints: [soft("prefer_morning", { target_ratio: 0.7 }, "语文尽量上午", 4)] }],
  ["math", 5, { soft_constraints: [soft("prefer_morning", { target_ratio: 0.75 }, "数学尽量上午", 4)] }],
  ["english", 4, { soft_constraints: [soft("spread_across_week", { min_gap_days: 1 }, "英语尽量分散", 2)] }],
  ["morality", 2],
  ["science", 2, { room_type: "science_lab", hard_constraints: [hard("forbidden_weekdays", { weekdays: ["fri"] }, "三四年级科学周五不排，留给校本活动与实验室维护")] }],
  ["pe", 3, { soft_constraints: [soft("spread_across_week", { min_gap_days: 1 }, "体育尽量隔天", 3), soft("avoid_periods", { periods: ["p5"] }, "午饭后第一节尽量不排体育", 2)] }],
  ["music", 2],
  ["art", 2],
  ["it", 1, { hard_constraints: [hard("forbidden_weekdays", { weekdays: ["wed"] }, "周三机房统一维护，不排信息科技")] }],
  ["labor", 1],
  ["class_meeting", 1, { hard_constraints: [hard("fixed_slot", { day: "fri", period: "p6" }, "三至六年级班会固定周五第6节")] }],
  ["reading", 2, { hard_constraints: [hard("min_gap_days", { min_gap_days: 1 }, "两节阅读课至少隔一天")] }],
  ["comprehensive_practice", 2, { consecutive_policy: { mode: "required", session_count: 1, length: 2 }, notes_zh: "综合实践按一次连堂排课" }],
];

const upperPrimaryPlan = [
  ["flag_ceremony", 1],
  ["chinese", 6, { max_per_day: 2, min_distinct_days: 5, soft_constraints: [soft("prefer_morning", { target_ratio: 0.65 }, "语文尽量上午", 4), soft("biweekly_double_period", { length: 2 }, "作文课隔周连堂优先", 2)] }],
  ["math", 5, { soft_constraints: [soft("prefer_morning", { target_ratio: 0.75 }, "数学尽量上午", 4)] }],
  ["english", 4],
  ["morality", 2],
  ["science", 3, { room_type: "science_lab", consecutive_policy: { mode: "required", session_count: 1, length: 2 }, notes_zh: "高段科学每周一次实验连堂" }],
  ["pe", 3, { soft_constraints: [soft("spread_across_week", { min_gap_days: 1 }, "体育尽量隔天", 3), soft("avoid_periods", { periods: ["p5"] }, "午饭后第一节尽量不排体育", 2)] }],
  ["music", 1],
  ["art", 2],
  ["it", 1, { hard_constraints: [hard("forbidden_weekdays", { weekdays: ["wed"] }, "周三机房统一维护，不排信息科技")] }],
  ["labor", 1],
  ["class_meeting", 1, { hard_constraints: [hard("fixed_slot", { day: "fri", period: "p6" }, "三至六年级班会固定周五第6节")] }],
  ["reading", 2, { hard_constraints: [hard("min_gap_days", { min_gap_days: 1 }, "两节阅读课至少隔一天")] }],
  ["comprehensive_practice", 2, { consecutive_policy: { mode: "required", session_count: 1, length: 2 }, notes_zh: "综合实践按一次连堂排课" }],
  ["school_based", 1],
];

const juniorPlan = [
  ["flag_ceremony", 1],
  ["chinese", 5, { soft_constraints: [soft("prefer_morning", { target_ratio: 0.65 }, "语文尽量上午", 4)] }],
  ["math", 5, { soft_constraints: [soft("prefer_morning", { target_ratio: 0.7 }, "数学尽量上午", 4)] }],
  ["english", 5, { soft_constraints: [soft("spread_across_week", { min_gap_days: 1 }, "英语尽量分散", 3)] }],
  ["morality", 2],
  ["history", 2],
  ["geography", 2],
  ["biology", 3, { room_type: "biology_lab", hard_constraints: [hard("forbidden_weekdays", { weekdays: ["mon"] }, "初一生物实验准备周一不开放")], consecutive_policy: { mode: "required", session_count: 1, length: 2 } }],
  ["pe", 3, { soft_constraints: [soft("spread_across_week", { min_gap_days: 1 }, "体育尽量隔天", 3), soft("avoid_periods", { periods: ["p5"] }, "午饭后第一节尽量不排体育", 2)] }],
  ["music", 1],
  ["art", 1],
  ["it", 1],
  ["labor", 1],
  ["class_meeting", 1, { hard_constraints: [hard("fixed_slot", { day: "fri", period: "p7" }, "初一班会固定周五第7节")] }],
  ["reading", 2, { hard_constraints: [hard("min_gap_days", { min_gap_days: 1 }, "两节阅读课至少隔一天")] }],
  ["comprehensive_practice", 2, { consecutive_policy: { mode: "required", session_count: 1, length: 2 } }],
  ["school_based", 2],
  ["self_study", 1],
];

const curriculum_requirements = [];
for (const grade of grades) {
  const plan = grade.id === "P1" || grade.id === "P2"
    ? lowerPrimaryPlan
    : grade.id === "P3" || grade.id === "P4"
      ? middlePrimaryPlan
      : grade.id === "P5" || grade.id === "P6"
        ? upperPrimaryPlan
        : juniorPlan;
  for (const [subjectId, weeklyPeriods, extra] of plan) {
    curriculum_requirements.push(req(grade.id, subjectId, weeklyPeriods, extra ?? {}));
  }
}

const surnames = ["王", "李", "张", "刘", "陈", "杨", "赵", "黄", "周", "吴", "徐", "孙", "胡", "朱", "高", "林", "何", "郭", "马", "罗", "梁", "宋", "郑", "谢", "韩", "唐", "冯", "于", "董", "萧", "程", "曹", "袁", "邓", "许", "傅", "沈", "曾", "彭", "吕"];
const givenNames = ["一宁", "子涵", "明轩", "思远", "雅琪", "若溪", "嘉懿", "欣然", "晨曦", "梓涵", "昊然", "雨桐", "诗涵", "奕辰", "佳怡", "宇航", "文博", "静怡", "俊杰", "思源", "梦瑶", "子墨", "泽宇", "心怡", "浩然", "佳宁", "睿哲", "依诺", "景行", "书瑶"];
let nameIndex = 0;

function nextTeacherName() {
  const surname = surnames[nameIndex % surnames.length];
  const given = givenNames[(nameIndex * 7) % givenNames.length];
  nameIndex += 1;
  return `${surname}${given}`;
}

const subjectCode = {
  chinese: "CHI",
  math: "MAT",
  english: "ENG",
  morality: "MOR",
  science: "SCI",
  biology: "BIO",
  history: "HIS",
  geography: "GEO",
  pe: "PE",
  music: "MUS",
  art: "ART",
  it: "IT",
  labor: "LAB",
};

const teachers = [];
const loadByTeacher = new Map();

function availabilityFor(campusId, mainSubjectId, index) {
  const unavailable_weekdays = [];
  const unavailable_slots = [];

  if (campusId === "east" && mainSubjectId === "pe" && index === 3) {
    unavailable_weekdays.push({ day: "thu", reason_zh: "区体育教研活动" });
  }
  if (campusId === "west" && mainSubjectId === "math" && index === 4) {
    unavailable_weekdays.push({ day: "fri", reason_zh: "名师工作室活动" });
  }
  if (campusId === "west" && mainSubjectId === "geography" && index === 1) {
    unavailable_weekdays.push({ day: "wed", reason_zh: "区地理教研" });
  }
  if (campusId === "east" && mainSubjectId === "english" && index === 2) {
    unavailable_slots.push({ day: "tue", periods: ["p1", "p2", "p3", "p4"], reason_zh: "半天外出培训" });
  }
  if (campusId === "west" && mainSubjectId === "biology" && index === 2) {
    unavailable_slots.push({ day: "thu", periods: ["p5", "p6", "p7", "p8"], reason_zh: "实验材料采购" });
  }
  if (campusId === "east" && mainSubjectId === "science" && index === 1) {
    unavailable_slots.push({ day: "wed", periods: ["p7"], reason_zh: "低段科学组例会" });
  }
  if (campusId === "west" && mainSubjectId === "chinese" && index === 5) {
    unavailable_slots.push({ day: "mon", periods: ["p7", "p8"], reason_zh: "初小衔接教研" });
  }

  return { unavailable_weekdays, unavailable_slots };
}

function createTeachers(campus_id, main_subject_id, count, eligible_grade_ids, max_weekly_periods, extra_subject_ids = []) {
  const prefix = campus_id === "east" ? "E" : "W";
  const code = subjectCode[main_subject_id];
  for (let i = 1; i <= count; i += 1) {
    const id = `T-${prefix}-${code}-${String(i).padStart(2, "0")}`;
    const teacher = {
      id,
      name_zh: `${nextTeacherName()}老师`,
      campus_id,
      primary_subject_id: main_subject_id,
      qualified_subject_ids: [...new Set([main_subject_id, ...extra_subject_ids])],
      eligible_grade_ids,
      max_weekly_periods,
      availability: availabilityFor(campus_id, main_subject_id, i),
      assigned_weekly_periods: 0,
      notes_zh: [],
    };
    teachers.push(teacher);
    loadByTeacher.set(id, 0);
  }
}

createTeachers("east", "chinese", 9, ["P1", "P2", "P3"], 22, ["reading", "class_meeting", "school_based"]);
createTeachers("east", "math", 7, ["P1", "P2", "P3"], 20, ["school_based", "self_study"]);
createTeachers("east", "english", 5, ["P1", "P2", "P3"], 18);
createTeachers("east", "morality", 3, ["P1", "P2", "P3"], 16, ["class_meeting"]);
createTeachers("east", "science", 4, ["P1", "P2", "P3"], 18, ["comprehensive_practice", "labor"]);
createTeachers("east", "pe", 5, ["P1", "P2", "P3"], 18);
createTeachers("east", "music", 3, ["P1", "P2", "P3"], 16);
createTeachers("east", "art", 3, ["P1", "P2", "P3"], 16);
createTeachers("east", "it", 2, ["P3"], 14);
createTeachers("east", "labor", 2, ["P1", "P2", "P3"], 16, ["comprehensive_practice"]);

createTeachers("west", "chinese", 12, ["P4", "P5", "P6", "J1"], 22, ["reading", "class_meeting", "school_based"]);
createTeachers("west", "math", 10, ["P4", "P5", "P6", "J1"], 20, ["self_study", "school_based"]);
createTeachers("west", "english", 8, ["P4", "P5", "P6", "J1"], 18);
createTeachers("west", "morality", 4, ["P4", "P5", "P6", "J1"], 16, ["class_meeting"]);
createTeachers("west", "science", 5, ["P4", "P5", "P6"], 18, ["comprehensive_practice", "labor"]);
createTeachers("west", "biology", 3, ["J1"], 16);
createTeachers("west", "history", 2, ["J1"], 16);
createTeachers("west", "geography", 2, ["J1"], 16);
createTeachers("west", "pe", 6, ["P4", "P5", "P6", "J1"], 18);
createTeachers("west", "music", 3, ["P4", "P5", "P6", "J1"], 16);
createTeachers("west", "art", 3, ["P4", "P5", "P6", "J1"], 16);
createTeachers("west", "it", 3, ["P4", "P5", "P6", "J1"], 16);
createTeachers("west", "labor", 4, ["P4", "P5", "P6", "J1"], 18, ["comprehensive_practice"]);

const teacherById = Object.fromEntries(teachers.map((teacher) => [teacher.id, teacher]));

function gradeRequirements(gradeId) {
  return curriculum_requirements.filter((item) => item.grade_id === gradeId);
}

function assignmentId(class_id, subject_id) {
  return `TA-${class_id}-${subject_id}`;
}

function pickTeacher({ campus_id, grade_id, subject_id, weekly_periods, preferred_teacher_id = null }) {
  if (preferred_teacher_id) {
    const preferred = teacherById[preferred_teacher_id];
    if (
      preferred &&
      preferred.campus_id === campus_id &&
      preferred.eligible_grade_ids.includes(grade_id) &&
      preferred.qualified_subject_ids.includes(subject_id) &&
      loadByTeacher.get(preferred.id) + weekly_periods <= preferred.max_weekly_periods
    ) {
      return preferred;
    }
  }

  const candidates = teachers
    .filter((teacher) => (
      teacher.campus_id === campus_id &&
      teacher.eligible_grade_ids.includes(grade_id) &&
      teacher.qualified_subject_ids.includes(subject_id) &&
      loadByTeacher.get(teacher.id) + weekly_periods <= teacher.max_weekly_periods
    ))
    .sort((a, b) => {
      const loadDiff = loadByTeacher.get(a.id) - loadByTeacher.get(b.id);
      if (loadDiff !== 0) return loadDiff;
      return a.id.localeCompare(b.id);
    });

  if (candidates.length === 0) {
    throw new Error(`No teacher candidate for ${campus_id}/${grade_id}/${subject_id}/${weekly_periods}`);
  }
  return candidates[0];
}

const teacher_assignments = [];
const advisorByClass = new Map();
const assignmentByClassSubject = new Map();

function addAssignment(classInfo, requirement, teacher, role) {
  const item = {
    id: assignmentId(classInfo.id, requirement.subject_id),
    teacher_id: teacher.id,
    teacher_name_zh: teacher.name_zh,
    class_id: classInfo.id,
    grade_id: classInfo.grade_id,
    campus_id: classInfo.campus_id,
    subject_id: requirement.subject_id,
    weekly_periods: requirement.weekly_periods,
    role,
  };
  teacher_assignments.push(item);
  assignmentByClassSubject.set(`${classInfo.id}:${requirement.subject_id}`, item);
  loadByTeacher.set(teacher.id, loadByTeacher.get(teacher.id) + requirement.weekly_periods);
}

for (const classInfo of classes) {
  const requirements = gradeRequirements(classInfo.grade_id);
  for (const subjectId of ["chinese", "math", "english"]) {
    const requirement = requirements.find((item) => item.subject_id === subjectId);
    if (!requirement) continue;
    const teacher = pickTeacher({
      campus_id: classInfo.campus_id,
      grade_id: classInfo.grade_id,
      subject_id: requirement.subject_id,
      weekly_periods: requirement.weekly_periods,
    });
    addAssignment(classInfo, requirement, teacher, "subject_teacher");
    if (subjectId === "chinese") {
      advisorByClass.set(classInfo.id, teacher.id);
      classInfo.advisor_teacher_id = teacher.id;
    }
  }
}

for (const classInfo of classes) {
  const requirements = gradeRequirements(classInfo.grade_id);
  for (const requirement of requirements) {
    if (["flag_ceremony", "chinese", "math", "english"].includes(requirement.subject_id)) continue;
    const preferredAdvisorId = subjectById[requirement.subject_id].advisor_preferred ? advisorByClass.get(classInfo.id) : null;
    const teacher = pickTeacher({
      campus_id: classInfo.campus_id,
      grade_id: classInfo.grade_id,
      subject_id: requirement.subject_id,
      weekly_periods: requirement.weekly_periods,
      preferred_teacher_id: preferredAdvisorId,
    });
    addAssignment(classInfo, requirement, teacher, preferredAdvisorId === teacher.id ? "advisor_activity" : "subject_teacher");
  }
}

for (const teacher of teachers) {
  teacher.assigned_weekly_periods = loadByTeacher.get(teacher.id);
  if (teacher.assigned_weekly_periods === 0) {
    teacher.notes_zh.push("备用教师，当前基础方案未分配固定班级");
  }
}

let constraintSeq = 1;
function constraintId(prefix) {
  return `${prefix}-${String(constraintSeq++).padStart(4, "0")}`;
}

function globalConstraint(type, severity, scope, params, description_zh, weight = null) {
  return {
    id: constraintId(severity === "hard" ? "HC" : "SC"),
    type,
    severity,
    scope,
    params,
    description_zh,
    ...(weight === null ? {} : { weight }),
  };
}

const hardConstraints = [
  globalConstraint("no_time_overlap", "hard", { entity: "teacher" }, {}, "同一教师同一时间只能上一节课"),
  globalConstraint("no_time_overlap", "hard", { entity: "class" }, {}, "同一班级同一时间只能上一节课"),
  globalConstraint("no_time_overlap", "hard", { entity: "room" }, {}, "同一教室或场地同一时间只能被一个班使用"),
  globalConstraint("teacher_no_cross_campus", "hard", { entity: "teacher" }, {}, "教师排课不得跨校区"),
  globalConstraint("weekly_periods_match_curriculum", "hard", { entity: "class_subject" }, {}, "每个班每门课程周课时必须满足课程计划"),
  globalConstraint("respect_grade_day_profile", "hard", { entity: "class" }, { profiles: Object.keys(gradeProfiles) }, "各年级只能使用对应日课时模板"),
  globalConstraint("respect_room_compatibility", "hard", { entity: "room" }, {}, "需要专用场地的课程必须排入兼容教室或场地"),
  globalConstraint("fixed_flag_ceremony", "hard", { entity: "school" }, { subject_id: "flag_ceremony", day: "mon", period: "p1", applies_to_class_ids: classes.map((item) => item.id) }, "全校周一第1节固定升旗/晨会"),
];

const softConstraints = [
  globalConstraint("teacher_max_consecutive_periods", "soft", { entity: "teacher" }, { max_consecutive_periods: 3 }, "教师尽量不要连续上课超过3节", 3),
  globalConstraint("teacher_daily_load_balance", "soft", { entity: "teacher" }, { preferred_max_daily_periods: 5 }, "教师日课时尽量均衡", 2),
  globalConstraint("core_subject_morning_preference", "soft", { subject_ids: ["chinese", "math", "english"] }, { preferred_segments: ["morning"] }, "语数英尽量排在上午", 4),
  globalConstraint("avoid_after_lunch_for_pe", "soft", { subject_id: "pe" }, { avoid_periods: ["p5"] }, "体育尽量避开午饭后第一节", 2),
  globalConstraint("same_grade_parallel_subject", "soft", { entity: "grade_subject" }, { subject_ids: ["it", "science", "biology"], target_parallel_ratio: 0.5 }, "同年级专用教室课尽量平行排，便于资源调度和进度统一", 1),
];

for (const requirement of curriculum_requirements) {
  for (const item of requirement.hard_constraints) {
    hardConstraints.push(globalConstraint(`curriculum_${item.type}`, "hard", {
      grade_id: requirement.grade_id,
      subject_id: requirement.subject_id,
    }, item.params, item.reason_zh));
  }
  if (requirement.consecutive_policy.mode === "required") {
    hardConstraints.push(globalConstraint("required_consecutive_periods", "hard", {
      grade_id: requirement.grade_id,
      subject_id: requirement.subject_id,
    }, requirement.consecutive_policy, `${requirement.grade_id} ${subjectById[requirement.subject_id].name_zh}需要连堂`));
  }
  for (const item of requirement.soft_constraints) {
    softConstraints.push(globalConstraint(`curriculum_${item.type}`, "soft", {
      grade_id: requirement.grade_id,
      subject_id: requirement.subject_id,
    }, item.params, item.reason_zh, item.weight));
  }
}

for (const teacher of teachers) {
  if (teacher.availability.unavailable_weekdays.length > 0 || teacher.availability.unavailable_slots.length > 0) {
    hardConstraints.push(globalConstraint("teacher_unavailable", "hard", {
      teacher_id: teacher.id,
      teacher_name_zh: teacher.name_zh,
    }, teacher.availability, `${teacher.name_zh}存在不可排时间`));
  }
}

for (const roomInfo of rooms) {
  if (roomInfo.unavailable_slots.length > 0) {
    hardConstraints.push(globalConstraint("room_unavailable", "hard", {
      room_id: roomInfo.id,
      room_name_zh: roomInfo.name_zh,
    }, { unavailable_slots: roomInfo.unavailable_slots }, `${roomInfo.name_zh}存在不可用时段`));
  }
}

hardConstraints.push(
  globalConstraint("grade_teacher_meeting", "hard", { campus_id: "east", subject_id: "chinese" }, { day: "wed", periods: ["p7"], teacher_ids: teachers.filter((teacher) => teacher.campus_id === "east" && teacher.primary_subject_id === "chinese").map((teacher) => teacher.id) }, "东校区语文组周三第7节固定教研"),
  globalConstraint("junior_subject_meeting", "hard", { campus_id: "west", stage: "junior" }, { day: "tue", periods: ["p8"], subject_ids: ["history", "geography", "biology"], teacher_ids: teachers.filter((teacher) => teacher.campus_id === "west" && ["history", "geography", "biology"].includes(teacher.primary_subject_id)).map((teacher) => teacher.id) }, "初中文综/理综相关教师周二第8节教研"),
);

const constraints = {
  version: "2026-05-22.v1",
  hard: hardConstraints,
  soft: softConstraints,
};

const runtime_constraint_changes = {
  version: "2026-05-22.v1",
  description_zh: "模拟真实学校运行中逐步补充的约束，用于测试 agentic 排课-检查-修复循环。",
  changes: [
    {
      id: "CHG-W08-001",
      week_label_zh: "第8周",
      severity: "hard",
      type: "temporary_double_period_exam",
      scope: { grade_id: "P6", subject_id: "math", class_ids: classes.filter((item) => item.grade_id === "P6").map((item) => item.id) },
      params: { length: 2, allowed_days: ["tue", "wed", "thu"], allowed_start_periods: ["p2", "p3", "p6"], room_type: "homeroom" },
      description_zh: "六年级数学第8周增加一次单元检测，需要每班一个连堂。",
    },
    {
      id: "CHG-W08-002",
      week_label_zh: "第8周",
      severity: "hard",
      type: "lab_exam_window",
      scope: { grade_id: "J1", subject_id: "biology", class_ids: classes.filter((item) => item.grade_id === "J1").map((item) => item.id) },
      params: { length: 2, allowed_days: ["tue", "thu", "fri"], allowed_start_periods: ["p3", "p5"], room_ids: ["R-W-BIO-01", "R-W-BIO-02"] },
      description_zh: "初一生物实验操作考查，需要在生物实验室连堂完成。",
    },
    {
      id: "CHG-W08-003",
      week_label_zh: "第8周",
      severity: "hard",
      type: "room_closure",
      scope: { room_id: "R-E-SCI-01" },
      params: { closed_slots: [{ day: "tue", periods: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"] }, { day: "wed", periods: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"] }] },
      description_zh: "东校区科学实验室1临时维修两天。",
    },
    {
      id: "CHG-W08-004",
      week_label_zh: "第8周",
      severity: "hard",
      type: "teacher_temporary_unavailable",
      scope: { teacher_id: "T-W-MAT-04" },
      params: { unavailable_days: ["tue"], reason_zh: "外出参加市级展示课" },
      description_zh: "西校区数学教师临时周二全天不可排。",
    },
    {
      id: "CHG-W08-005",
      week_label_zh: "第8周",
      severity: "soft",
      type: "same_day_oral_assessment_preference",
      scope: { grade_id: "P3", subject_id: "chinese", class_ids: ["P3-C01", "P3-C02", "P3-C03"] },
      params: { preferred_day: "thu", preferred_periods: ["p2", "p3", "p4"] },
      description_zh: "三年级部分班级语文口语测评尽量安排在周四上午。",
    },
    {
      id: "CHG-W09-001",
      week_label_zh: "第9周",
      severity: "soft",
      type: "teacher_load_rebalance_request",
      scope: { teacher_id: "T-E-CHI-01" },
      params: { preferred_max_daily_periods: 4 },
      description_zh: "班主任反馈连续课过多，希望下周日课时不超过4节。",
    },
  ],
};

const infeasible_scenarios = {
  version: "2026-05-22.v1",
  description_zh: "故意构造的不可行覆盖场景，用于验证系统能解释绝对矛盾，而不是无限调整。",
  scenarios: [
    {
      id: "INF-001",
      severity: "hard",
      title_zh: "同一时间生物实验室容量不足",
      added_constraints: [
        {
          type: "fixed_slot_for_all_classes",
          scope: { grade_id: "J1", subject_id: "biology", class_ids: classes.filter((item) => item.grade_id === "J1").map((item) => item.id) },
          params: { day: "wed", periods: ["p3", "p4"], room_type: "biology_lab" },
        },
      ],
      expected_detection: ["J1共有6个班同时需要生物实验室，但西校区只有2间生物实验室", "基础课程计划又禁止初一生物周一，不影响本冲突的核心判定"],
    },
    {
      id: "INF-002",
      severity: "hard",
      title_zh: "固定班会与升旗冲突",
      added_constraints: [
        {
          type: "fixed_slot",
          scope: { class_id: "P1-C01", subject_id: "class_meeting" },
          params: { day: "mon", period: "p1" },
        },
      ],
      expected_detection: ["P1-C01周一第1节已被全校升旗/晨会硬占用", "同一班级同一时间只能上一节课"],
    },
    {
      id: "INF-003",
      severity: "hard",
      title_zh: "课程计划把信息科技所有可排日期禁用",
      added_constraints: [
        {
          type: "curriculum_forbidden_weekdays",
          scope: { grade_id: "P5", subject_id: "it" },
          params: { weekdays: ["mon", "tue", "wed", "thu", "fri"] },
        },
      ],
      expected_detection: ["P5信息科技每周必修1节", "新增约束禁止周一至周五所有日期，导致可排时间窗为空"],
    },
    {
      id: "INF-004",
      severity: "hard",
      title_zh: "教师整周不可用但仍有固定任课",
      added_constraints: [
        {
          type: "teacher_unavailable",
          scope: { teacher_id: "T-W-ENG-01" },
          params: { unavailable_days: ["mon", "tue", "wed", "thu", "fri"] },
        },
      ],
      expected_detection: ["T-W-ENG-01仍承担固定英语任课", "教师可用时段为空，无法满足任课任务"],
    },
  ],
};

const validation_expectations = {
  version: "2026-05-22.v1",
  expected_counts: {
    campuses: campuses.length,
    grades: grades.length,
    classes: classes.length,
    subjects: subjects.length,
    rooms: rooms.length,
    teachers: teachers.length,
    curriculum_requirements: curriculum_requirements.length,
    teacher_assignments: teacher_assignments.length,
    hard_constraints: hardConstraints.length,
    soft_constraints: softConstraints.length,
  },
  invariants: [
    "classes.length === 42",
    "每个年级6个班",
    "各年级课程计划周课时总数等于对应 day_profile.weekly_periods",
    "每个需要教师的 class-subject 都有 teacher_assignment",
    "teacher_assignments 中教师 campus_id 与班级 campus_id 一致",
    "teacher.assigned_weekly_periods <= teacher.max_weekly_periods",
    "infeasible_scenarios.json 中的案例应被判定为不可行",
  ],
};

const files = {
  "school.json": school,
  "campuses.json": campuses,
  "calendar.json": calendar,
  "grades.json": grades,
  "classes.json": classes,
  "subjects.json": subjects,
  "rooms.json": rooms,
  "teachers.json": teachers,
  "curriculum_requirements.json": curriculum_requirements,
  "teacher_assignments.json": teacher_assignments,
  "constraints.json": constraints,
  "runtime_constraint_changes.json": runtime_constraint_changes,
  "infeasible_scenarios.json": infeasible_scenarios,
  "validation_expectations.json": validation_expectations,
};

const manifest = {
  dataset_id: school.id,
  dataset_version: school.dataset_version,
  generated_on: "2026-05-22",
  files: Object.keys(files).map((filename) => ({
    filename,
    description_zh: {
      "school.json": "学校与数据集元信息",
      "campuses.json": "两个校区及年级分布",
      "calendar.json": "周历、节次、年级日课时模板",
      "grades.json": "7个年级定义",
      "classes.json": "42个班级、人数、班主任、行政班教室",
      "subjects.json": "课程/活动科目定义",
      "rooms.json": "普通教室与专用场地",
      "teachers.json": "教师、任教资质、校区、可用性、周课时上限",
      "curriculum_requirements.json": "每个年级每门课周课时、禁排日、连堂、隔天等课程计划条件",
      "teacher_assignments.json": "任课关系：教师-班级-科目-周课时",
      "constraints.json": "规范化硬约束和软约束",
      "runtime_constraint_changes.json": "运行中新增的临时约束",
      "infeasible_scenarios.json": "故意不可行的冲突案例",
      "validation_expectations.json": "数据集期望计数和基础校验规则",
    }[filename],
  })),
  counts: validation_expectations.expected_counts,
  recommended_agent_loop_zh: [
    "先用基础 JSON 生成初始课表。",
    "输出所有硬约束违规；硬违规必须修复或解释为不可行。",
    "再输出软约束扣分清单，按权重排序。",
    "应用 runtime_constraint_changes.json 中的增量约束，重复检查与局部修复。",
    "遇到 infeasible_scenarios.json 这类绝对矛盾时，输出最小冲突集合和原因。",
  ],
};
files["manifest.json"] = manifest;

function writeJson(filename, value) {
  fs.writeFileSync(path.join(outDir, filename), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeReadme() {
  const text = `# School Timetable Mock Data

这是一个用于小学/初中排课 agent skill 的模拟数据集。

- 学校：小学一至六年级，每个年级6个班；初中一年级6个班；共42个班。
- 校区：东校区承载小学一至三年级，西校区承载小学四至六年级和初中一年级。
- 约束：包含课程计划禁排日、教师不可用、专用教室、连堂、隔天分布、固定升旗/班会、教师不跨校区等。
- Agentic 场景：\`runtime_constraint_changes.json\` 模拟运行中新增约束；\`infeasible_scenarios.json\` 模拟绝对矛盾。

重新生成：

\`\`\`bash
node docs/school-timetable/mock-data/generate-mock-data.mjs
\`\`\`

入口文件建议先看 \`manifest.json\`，再按需读取其他 JSON。
`;
  fs.writeFileSync(path.join(outDir, "README.md"), text, "utf8");
}

function validate() {
  const errors = [];
  if (classes.length !== 42) errors.push(`Expected 42 classes, got ${classes.length}`);

  for (const grade of grades) {
    const classCount = classes.filter((item) => item.grade_id === grade.id).length;
    if (classCount !== 6) errors.push(`${grade.id} expected 6 classes, got ${classCount}`);
  }

  for (const grade of grades) {
    const total = curriculum_requirements
      .filter((item) => item.grade_id === grade.id)
      .reduce((sum, item) => sum + item.weekly_periods, 0);
    const expected = gradeProfiles[grade.day_profile_id].weekly_periods;
    if (total !== expected) errors.push(`${grade.id} curriculum total ${total}, expected ${expected}`);
  }

  for (const classInfo of classes) {
    for (const requirement of gradeRequirements(classInfo.grade_id)) {
      if (!subjectById[requirement.subject_id].requires_teacher) continue;
      if (!assignmentByClassSubject.has(`${classInfo.id}:${requirement.subject_id}`)) {
        errors.push(`Missing assignment for ${classInfo.id}/${requirement.subject_id}`);
      }
    }
  }

  for (const assignment of teacher_assignments) {
    const teacher = teacherById[assignment.teacher_id];
    if (teacher.campus_id !== assignment.campus_id) {
      errors.push(`Cross-campus assignment: ${assignment.id}`);
    }
    if (!teacher.eligible_grade_ids.includes(assignment.grade_id)) {
      errors.push(`Ineligible grade assignment: ${assignment.id}`);
    }
    if (!teacher.qualified_subject_ids.includes(assignment.subject_id)) {
      errors.push(`Unqualified subject assignment: ${assignment.id}`);
    }
  }

  for (const teacher of teachers) {
    if (teacher.assigned_weekly_periods > teacher.max_weekly_periods) {
      errors.push(`${teacher.id} overloaded ${teacher.assigned_weekly_periods}/${teacher.max_weekly_periods}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Mock data validation failed:\n${errors.join("\n")}`);
  }
}

validate();
for (const [filename, value] of Object.entries(files)) {
  writeJson(filename, value);
}
writeReadme();

console.log(JSON.stringify({
  ok: true,
  outDir,
  counts: manifest.counts,
}, null, 2));
