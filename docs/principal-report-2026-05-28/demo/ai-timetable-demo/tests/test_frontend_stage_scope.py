import subprocess
import textwrap
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_app_js_assertion(assertion: str):
    app_js = (ROOT / "app" / "static" / "app.js").read_text(encoding="utf-8")
    fake_browser = r"""
const elementStore = new Map();
function fakeElement(selector) {
  if (!elementStore.has(selector)) {
    elementStore.set(selector, {
      selector,
      innerHTML: "",
      textContent: "",
      value: "",
      dataset: {},
      classList: { toggle() {} },
      addEventListener() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return null; },
    });
  }
  return elementStore.get(selector);
}
const document = {
  querySelector: fakeElement,
  querySelectorAll() { return []; },
  addEventListener() {},
};
const localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
const URL = { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} };
const window = {};
"""
    script = fake_browser + "\n" + app_js + "\n" + assertion
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".js", delete=False) as script_file:
        script_file.write(script)
        script_path = script_file.name
    try:
        result = subprocess.run(
            ["node", script_path],
            cwd=ROOT,
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
    finally:
        Path(script_path).unlink(missing_ok=True)
    assert result.returncode == 0, result.stderr


def test_teacher_maintenance_list_only_shows_selected_stage():
    run_app_js_assertion(
        textwrap.dedent(
            """
            state.demo = {
              classes: ["一年级(1)", "一年级(2)", "七年级(1)", "七年级(2)"],
              fixed_events: [],
              periods_by_stage: { "小学": [], "初中": [] },
            };
            state.schoolScope = "初中";
            state.activeTab = "teachers";
            state.editableData.teachers = [
              { name: "一年级英语1组老师", subject: "英语", classes: ["一年级(1)", "一年级(2)"], notes: "" },
              { name: "张老师", subject: "数学", classes: ["七年级(1)", "七年级(2)"], notes: "" },
            ];

            renderDataList();

            if (els.dataList.innerHTML.includes("一年级英语1组老师") || els.dataList.innerHTML.includes("一年级(1)")) {
              throw new Error("初中资料栏不应显示小学教师或小学班级");
            }
            if (!els.dataList.innerHTML.includes("张老师") || !els.dataList.innerHTML.includes("七年级(1)")) {
              throw new Error("初中资料栏应显示初中教师和初中班级");
            }
            """
        )
    )


def test_course_maintenance_list_only_shows_selected_stage():
    run_app_js_assertion(
        textwrap.dedent(
            """
            state.demo = {
              classes: ["二年级(1)", "二年级(2)", "八年级(1)", "八年级(2)"],
              fixed_events: [],
              periods_by_stage: { "小学": [], "初中": [] },
            };
            state.schoolScope = "初中";
            state.activeTab = "courses";
            state.editableData.courses = [
              { grade: "二年级", subject: "语文", weekly_hours: 7, teacher: "李老师", room: "本班教室", classes: ["二年级(1)"] },
              { grade: "八年级", subject: "英语", weekly_hours: 5, teacher: "王老师", room: "本班教室", classes: ["八年级(1)"] },
            ];

            renderDataList();

            if (els.dataList.innerHTML.includes("二年级") || els.dataList.innerHTML.includes("李老师")) {
              throw new Error("初中课程资料栏不应显示小学课程");
            }
            if (!els.dataList.innerHTML.includes("八年级") || !els.dataList.innerHTML.includes("王老师")) {
              throw new Error("初中课程资料栏应显示初中课程");
            }
            """
        )
    )


def test_solve_timetable_ignores_stale_scope_response():
    run_app_js_assertion(
        textwrap.dedent(
            """
            const onePeriod = [{ number: 1, label: "第1节", time: "08:50-09:35" }];
            const primaryResult = {
              status: "success",
              message: "小学结果",
              school_scope: "小学",
              class_names: ["一年级(1)"],
              class_stages: { "一年级(1)": "小学" },
              periods_by_stage: { "小学": onePeriod, "初中": [{ number: 1, label: "第1节", time: "08:00-08:45" }] },
              periods: onePeriod,
              classes: { "一年级(1)": { "周一": [{ subject: "语文", teacher: "陈老师", room: "本班教室", source: "solver" }] } },
              rule_cards: [],
              applied_rules: [],
              manual_changes: [],
              missing_information: [],
              stats: { scheduled_lessons: 1, classes: 1 },
            };
            const middleResult = {
              ...primaryResult,
              message: "初中旧结果",
              school_scope: "初中",
              class_names: ["七年级(1)"],
              class_stages: { "七年级(1)": "初中" },
              periods: [{ number: 1, label: "第1节", time: "08:00-08:45" }],
              classes: { "七年级(1)": { "周一": [{ subject: "数学", teacher: "王老师", room: "本班教室", source: "solver" }] } },
            };
            state.demo = {
              days: ["周一"],
              classes: ["一年级(1)", "七年级(1)"],
              class_stages: { "一年级(1)": "小学", "七年级(1)": "初中" },
              periods_by_stage: primaryResult.periods_by_stage,
              fixed_events: [],
            };
            state.editableData = { teachers: [], rooms: [], courses: [] };
            const pending = [];
            fetch = () => new Promise((resolve) => pending.push(resolve));

            state.schoolScope = "初中";
            const first = solveTimetable();
            state.schoolScope = "小学";
            const second = solveTimetable();

            pending[1]({ ok: true, json: async () => primaryResult });
            await second;
            pending[0]({ ok: true, json: async () => middleResult });
            await first;

            if (state.result.school_scope !== "小学") {
              throw new Error("旧的初中请求不应该覆盖后返回的小学课表");
            }
            """
        )
    )


def test_scope_change_refreshes_class_select_even_when_solver_falls_back():
    run_app_js_assertion(
        textwrap.dedent(
            """
            const primaryPeriods = [{ number: 1, label: "第1节", time: "08:50-09:35" }];
            const fallbackPrimaryResult = {
              status: "failed",
              message: "暂时没有找到满足全部必须条件的课表",
              school_scope: "小学",
              class_names: ["一年级(1)", "一年级(2)"],
              class_stages: { "一年级(1)": "小学", "一年级(2)": "小学" },
              periods_by_stage: { "小学": primaryPeriods, "初中": [{ number: 1, label: "第1节", time: "08:00-08:45" }] },
              periods: primaryPeriods,
              classes: {
                "一年级(1)": { "周一": [{ subject: "自习", teacher: "", room: "本班教室", source: "empty" }] },
                "一年级(2)": { "周一": [{ subject: "自习", teacher: "", room: "本班教室", source: "empty" }] },
              },
              rule_cards: [],
              applied_rules: [],
              manual_changes: [],
              missing_information: [],
              stats: { scheduled_lessons: 0, classes: 2 },
            };
            state.demo = {
              days: ["周一"],
              classes: ["一年级(1)", "一年级(2)", "七年级(1)"],
              class_stages: { "一年级(1)": "小学", "一年级(2)": "小学", "七年级(1)": "初中" },
              periods_by_stage: fallbackPrimaryResult.periods_by_stage,
              fixed_events: [],
            };
            state.result = {
              status: "success",
              school_scope: "初中",
              class_names: ["七年级(1)"],
              class_stages: { "七年级(1)": "初中" },
              periods_by_stage: fallbackPrimaryResult.periods_by_stage,
              periods: fallbackPrimaryResult.periods_by_stage["初中"],
              classes: { "七年级(1)": { "周一": [{ subject: "数学", teacher: "王老师", room: "本班教室", source: "solver" }] } },
              rule_cards: [],
              applied_rules: [],
              manual_changes: [],
              missing_information: [],
              stats: { scheduled_lessons: 1, classes: 1 },
            };
            state.selectedClass = "七年级(1)";
            state.schoolScope = "小学";
            state.editableData = { teachers: [], rooms: [], courses: [] };
            fetch = async () => ({ ok: true, json: async () => fallbackPrimaryResult });

            await solveTimetable();

            if (state.selectedClass !== "一年级(1)") {
              throw new Error(`小学降级结果也应该切换到小学班级，实际为 ${state.selectedClass}`);
            }
            if (els.classSelect.value !== "一年级(1)" || els.classSelect.innerHTML.includes("七年级")) {
              throw new Error("班级下拉仍然显示初中班级");
            }
            if (!els.schoolTerm.textContent.includes("小学")) {
              throw new Error("学段提示没有更新为小学");
            }
            if (!els.timeline.innerHTML.includes("08:50-09:35")) {
              throw new Error("小学时间轴没有更新");
            }
            """
        )
    )


def test_visual_payload_uses_repository_backed_scope_only():
    run_app_js_assertion(
        textwrap.dedent(
            """
            state.schoolScope = "小学";
            state.messages = ["旧规则不应由网页本地发送"];
            state.classCounts = { "一年级": 3 };
            state.gradeSettings = [{ stage: "小学", grade: "一年级", class_count: 3 }];
            state.editableData = {
              teachers: [{ name: "本地老师", subject: "语文", classes: ["一年级(1)"] }],
              rooms: [{ name: "本地教室", type: "普通教室", capacity: 1 }],
              courses: [{ stage: "小学", grade: "一年级", subject: "语文", weekly_hours: 1, classes: ["一年级(1)"] }],
            };

            const payload = buildRequestPayload();

            if (JSON.stringify(payload) !== JSON.stringify({ school_scope: "小学" })) {
              throw new Error(`网页可视化请求应该只提交学段，让后端读取后台数据，实际为 ${JSON.stringify(payload)}`);
            }
            """
        )
    )
