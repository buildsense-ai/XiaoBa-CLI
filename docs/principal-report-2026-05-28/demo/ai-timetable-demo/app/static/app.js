const STORAGE_KEY = "timetable-editable-data-v3";
const LEGACY_STORAGE_KEYS = ["timetable-editable-data-v1", "timetable-editable-data-v2"];
const RULE_STORAGE_KEY = "timetable-rule-messages-v1";
const DATA_LABELS = {
  teachers: "教师",
  rooms: "教室",
  courses: "课程",
  time: "时间",
};

const state = {
  demo: null,
  result: null,
  activeTab: "teachers",
  messages: [],
  classCounts: {},
  gradeSettings: [],
  editableData: {
    teachers: [],
    rooms: [],
    courses: [],
  },
  schoolScope: "初中",
  selectedClass: "",
  drag: null,
  manualMode: false,
  confirmedReviewIds: new Set(),
  conditionImages: [],
  dataModal: { mode: "add", type: "teachers", index: null },
  solveRequestId: 0,
};

const els = {
  schoolTerm: document.querySelector("#schoolTerm"),
  schoolScope: document.querySelector("#schoolScope"),
  dataList: document.querySelector("#dataList"),
  addDataButton: document.querySelector("#addDataButton"),
  excelInput: document.querySelector("#excelInput"),
  excelPreview: document.querySelector("#excelPreview"),
  uploadMessage: document.querySelector("#uploadMessage"),
  conditionImageInput: document.querySelector("#conditionImageInput"),
  imagePreviewList: document.querySelector("#imagePreviewList"),
  classSettingsList: document.querySelector("#classSettingsList"),
  applyClassSettingsButton: document.querySelector("#applyClassSettingsButton"),
  ruleInput: document.querySelector("#ruleInput"),
  ruleTemplates: document.querySelector("#ruleTemplates"),
  solveButton: document.querySelector("#solveButton"),
  demoRuleButton: document.querySelector("#demoRuleButton"),
  clearRulesButton: document.querySelector("#clearRulesButton"),
  ruleCards: document.querySelector("#ruleCards"),
  ruleCount: document.querySelector("#ruleCount"),
  feedback: document.querySelector("#feedback"),
  classSelect: document.querySelector("#classSelect"),
  manualModeButton: document.querySelector("#manualModeButton"),
  rerunButton: document.querySelector("#rerunButton"),
  exportFormat: document.querySelector("#exportFormat"),
  exportButton: document.querySelector("#exportButton"),
  timeline: document.querySelector("#timeline"),
  conflictBanner: document.querySelector("#conflictBanner"),
  conflictAdvice: document.querySelector("#conflictAdvice"),
  missingInfo: document.querySelector("#missingInfo"),
  timetable: document.querySelector("#timetable"),
  statsText: document.querySelector("#statsText"),
  appliedRules: document.querySelector("#appliedRules"),
  dataModal: document.querySelector("#dataModal"),
  dataModalForm: document.querySelector("#dataModalForm"),
  dataModalTitle: document.querySelector("#dataModalTitle"),
  dataModalType: document.querySelector("#dataModalType"),
  dataModalFields: document.querySelector("#dataModalFields"),
  closeDataModalButton: document.querySelector("#closeDataModalButton"),
  saveDataModalButton: document.querySelector("#saveDataModalButton"),
  cancelDataModalButton: document.querySelector("#cancelDataModalButton"),
};

document.addEventListener("DOMContentLoaded", async () => {
  try {
    bindEvents();
    await loadDemoState();
    await solveTimetable();
  } catch (error) {
    showStartupError(error);
  }
});

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab;
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("is-active", item === button));
      renderDataList();
    });
  });

  on(els.solveButton, "click", async () => {
    collectPendingInputRules();
    await solveTimetable();
  });

  on(els.demoRuleButton, "click", async () => {
    addRuleMessages(["九年级不要第一节体育课", "王老师周三下午不能上课", "七年级数学要连排两节考试"]);
    await solveTimetable();
  });

  on(els.clearRulesButton, "click", async () => {
    state.messages = [];
    state.confirmedReviewIds.clear();
    persistRuleMessages();
    state.conditionImages.forEach((item) => URL.revokeObjectURL(item.url));
    state.conditionImages = [];
    renderImagePreview();
    await solveTimetable();
  });

  on(els.rerunButton, "click", async () => {
    collectPendingInputRules();
    await solveTimetable();
  });
  on(els.ruleTemplates, "click", (event) => {
    const button = event.target.closest("button[data-template]");
    if (!button) {
      return;
    }
    appendRuleTemplate(button.dataset.template);
  });
  on(els.exportButton, "click", downloadExport);
  
  // 规则输入框实时排课（防抖500ms）
  let ruleDebounceTimer = null;
  on(els.ruleInput, "input", () => {
    clearTimeout(ruleDebounceTimer);
    ruleDebounceTimer = setTimeout(async () => {
      const text = els.ruleInput.value.trim();
      if (text && !text.endsWith("\n")) {
        // 有内容时自动收集规则并排课
        collectPendingInputRules();
        await solveTimetable();
      }
    }, 500);
  });
  
  // 回车添加规则并排课
  on(els.ruleInput, "keydown", async (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      collectPendingInputRules();
      await solveTimetable();
    }
  });
  on(els.schoolScope, "change", async () => {
    state.schoolScope = els.schoolScope.value;
    renderClassSettings();
    renderDataList();
    await solveTimetable();
  });

  on(els.addDataButton, "click", () => openDataModal("add", state.activeTab));

  on(els.dataList, "click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const index = Number(button.dataset.index);
    if (button.dataset.action === "edit") {
      openDataModal("edit", state.activeTab, index);
    }
    if (button.dataset.action === "delete") {
      deleteEditableItem(index);
      await solveTimetable();
    }
  });
  on(els.applyClassSettingsButton, "click", async () => {
    readClassSettingsFromInputs();
    await solveTimetable();
  });

  on(els.classSettingsList, "click", async (event) => {
    const button = event.target.closest("button[data-grade]");
    if (!button) {
      return;
    }
    const grade = button.dataset.grade;
    const current = state.classCounts[grade] || 0;
    state.classCounts[grade] = button.dataset.action === "add" ? Math.min(12, current + 1) : Math.max(0, current - 1);
    renderClassSettings();
    await solveTimetable();
  });

  on(els.classSettingsList, "change", async (event) => {
    const input = event.target.closest("input[data-grade]");
    if (!input) {
      return;
    }
    state.classCounts[input.dataset.grade] = Math.max(0, Math.min(12, Number(input.value) || 0));
    renderClassSettings();
    await solveTimetable();
  });

  on(els.classSelect, "change", () => {
    state.selectedClass = els.classSelect.value;
    renderTimeline();
    renderTimetable();
  });
  on(els.manualModeButton, "click", () => {
    state.manualMode = !state.manualMode;
    els.manualModeButton.classList.toggle("is-active", state.manualMode);
    els.manualModeButton.setAttribute("aria-pressed", String(state.manualMode));
    renderTimetable();
  });

  on(els.ruleCards, "click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const index = Number(button.dataset.index);
    const rule = state.result.rule_cards[index];
    if (button.dataset.action === "confirm") {
      state.confirmedReviewIds.add(rule.id);
      await solveTimetable();
    }
    if (button.dataset.action === "remove") {
      state.messages.splice(index, 1);
      state.confirmedReviewIds.delete(rule.id);
      persistRuleMessages();
      await solveTimetable();
    }
  });

  on(els.excelInput, "change", previewExcel);
  on(els.conditionImageInput, "change", handleConditionImages);
  on(els.imagePreviewList, "click", async (event) => {
    const button = event.target.closest("button[data-action='remove-image']");
    if (!button) {
      return;
    }
    const index = Number(button.dataset.index);
    const [removed] = state.conditionImages.splice(index, 1);
    if (removed) {
      URL.revokeObjectURL(removed.url);
      const messageIndex = state.messages.indexOf(removed.sourceText);
      if (messageIndex >= 0) {
        state.messages.splice(messageIndex, 1);
      }
      persistRuleMessages();
      state.confirmedReviewIds.clear();
      renderImagePreview();
      await solveTimetable();
    }
  });
  on(els.dataModalType, "change", () => {
    state.dataModal.type = els.dataModalType.value;
    renderDataModalFields();
  });
  on(els.saveDataModalButton, "click", saveDataModal);
  on(els.closeDataModalButton, "click", closeDataModal);
  on(els.cancelDataModalButton, "click", closeDataModal);
  on(els.dataModalForm, "submit", (event) => {
    event.preventDefault();
    saveDataModal();
  });
}

function on(element, eventName, handler) {
  if (!element) {
    return;
  }
  element.addEventListener(eventName, handler);
}

function showStartupError(error) {
  const message = `页面初始化失败，请刷新页面后再试。\n原因：${error?.message || error}`;
  if (els.feedback) {
    els.feedback.textContent = message;
  }
  console.error(error);
}

async function loadDemoState() {
  const response = await fetch("/api/repository-demo-state?school_scope=" + encodeURIComponent(state.schoolScope));
  state.demo = await response.json();
  state.gradeSettings = state.demo.grade_settings || [];
  state.classCounts = Object.fromEntries(state.gradeSettings.map((item) => [item.grade, item.class_count]));
  const defaults = {
    teachers: state.demo.teachers.map((item) => ({ ...item })),
    rooms: state.demo.rooms.map((item) => ({ ...item })),
    courses: state.demo.courses.map((item) => ({ ...item })),
  };
  const saved = loadSavedEditableData(defaults);
  state.editableData = saved.data;
  state.messages = loadSavedRuleMessages();
  state.schoolScope = els.schoolScope.value;
  els.uploadMessage.textContent = saved.loaded
    ? "已加载本机保存的资料，后台维护记录会继续保留。"
    : "当前页面只负责查看、校验和导出。";
  renderClassSettings();
  renderClassOptions();
  renderTimeline();
  renderDataList();
}

async function solveTimetable() {
  const requestId = ++state.solveRequestId;
  const payload = buildRequestPayload();
  setFeedback("正在重新计算课表，请稍等。");
  let response;
  try {
    response = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    if (requestId !== state.solveRequestId) {
      return;
    }
    setFeedback("排课服务暂时没有响应，请确认本地服务已启动。");
    return;
  }
  if (requestId !== state.solveRequestId) {
    return;
  }
  if (!response.ok) {
    setFeedback("排课服务返回异常，请稍后再试。");
    return;
  }
  const result = await response.json();
  if (requestId !== state.solveRequestId) {
    return;
  }
  state.result = result;
  if (!state.result.class_names?.length) {
    setFeedback("当前没有可排的班级，请先检查左侧班级设置。");
    return;
  }
  if (!state.selectedClass || !state.result.class_names.includes(state.selectedClass)) {
    state.selectedClass = state.result.class_names[0];
  }
  els.schoolTerm.textContent = `${state.schoolScope} ${state.result.class_names.length}个班`;
  renderClassOptions();
  renderTimeline();
  renderDataList();
  if (state.result.status !== "success") {
    renderRules();
    renderTimetable();
    renderMissingInformation();
    renderFeedback();
    return;
  }
  renderRules();
  renderTimetable();
  renderMissingInformation();
  renderFeedback();
}

async function previewExcel() {
  const file = els.excelInput.files[0];
  if (!file) {
    return;
  }
  const form = new FormData();
  form.append("file", file);
  els.uploadMessage.textContent = "正在读取文件。";
  const response = await fetch("/api/import-preview", {
    method: "POST",
    body: form,
  });
  const payload = await response.json();
  els.uploadMessage.textContent = payload.message;
  els.excelPreview.hidden = false;
  els.excelPreview.innerHTML = payload.sheets
    .map((sheet) => {
      const rows = sheet.rows
        .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`)
        .join("");
      return `<div class="sheet-preview"><strong>${escapeHtml(sheet.sheet)}</strong><table>${rows}</table></div>`;
    })
    .join("");
}

async function downloadExport() {
  if (!state.result) {
    return;
  }
  const format = els.exportFormat.value;
  const endpoint = `/api/export/${format}`;
  const filenameMap = {
    excel: "课程表.xlsx",
    pdf: `${state.selectedClass || "班级"}-课程表.pdf`,
    csv: `${state.selectedClass || "班级"}-课程表.csv`,
  };
  setFeedback("正在生成导出文件。");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRequestPayload({ class_name: state.selectedClass })),
  });
  if (!response.ok) {
    setFeedback("导出失败，请稍后再试。");
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filenameMap[format];
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  renderFeedback();
}

function renderClassOptions() {
  const classes = state.result?.class_names || state.demo?.classes || [];
  els.classSelect.innerHTML = classes
    .map((className) => `<option value="${className}">${className}</option>`)
    .join("");
  // 确保 selectedClass 是当前学段的有效班级
  const validClass = classes.includes(state.selectedClass) ? state.selectedClass : (classes[0] || "");
  els.classSelect.value = validClass;
  if (validClass !== state.selectedClass) {
    state.selectedClass = validClass;
  }
}

function renderClassSettings() {
  els.classSettingsList.innerHTML = visibleGradeSettings()
    .map((item) => {
      const value = state.classCounts[item.grade] ?? item.class_count;
      return `
        <div class="class-setting-row">
          <strong>${escapeHtml(item.grade)}</strong>
          <button class="step-button" data-action="remove" data-grade="${escapeHtml(item.grade)}">-</button>
          <input type="number" min="0" max="12" value="${value}" data-grade="${escapeHtml(item.grade)}" aria-label="${escapeHtml(item.grade)}班级数" />
          <button class="step-button" data-action="add" data-grade="${escapeHtml(item.grade)}">+</button>
        </div>
      `;
    })
    .join("");
}

function visibleGradeSettings() {
  return state.gradeSettings.filter((item) => item.stage === state.schoolScope);
}

function readClassSettingsFromInputs() {
  els.classSettingsList.querySelectorAll("input[data-grade]").forEach((input) => {
    state.classCounts[input.dataset.grade] = Math.max(0, Math.min(12, Number(input.value) || 0));
  });
}

function renderTimeline() {
  const periods = periodsForSelectedClass();
  els.timeline.innerHTML = periods
    .map((period) => `<div class="time-chip"><strong>${period.label}</strong><span>${period.time}</span></div>`)
    .join("");
}

function renderDataList() {
  if (!state.demo) {
    return;
  }
  if (state.activeTab === "teachers") {
    const teacherRows = state.editableData.teachers
      .map((teacher, index) => ({ teacher, index, classes: classesForCurrentScope(teacher.classes || []) }))
      .filter(({ teacher, classes }) => !(teacher.classes || []).length || classes.length);
    els.dataList.innerHTML = teacherRows
      .map(({ teacher, index, classes }) => {
        const classText = classes.length ? classes.join("、") : "未填写具体班级";
        return dataRow(teacher.name, `${teacher.subject} · ${classText}`, teacher.notes, index);
      })
      .join("") || emptyDataRow("还没有教师资料，点击“新增”添加。");
  }
  if (state.activeTab === "rooms") {
    els.dataList.innerHTML = state.editableData.rooms
      .map((room, index) => dataRow(room.name, `${room.type} · 同时容量 ${room.capacity}`, room.notes, index))
      .join("") || emptyDataRow("还没有教室资料，点击“新增”添加。");
  }
  if (state.activeTab === "courses") {
    const courseRows = state.editableData.courses
      .map((course, index) => ({ course, index, classes: classesForCurrentScope(course.classes || []) }))
      .filter(({ course, classes }) => courseMatchesCurrentScope(course, classes));
    els.dataList.innerHTML = courseRows
      .map(({ course, index, classes }) => {
        const classText = classes.length ? classes.join("、") : "该年级所有班";
        return dataRow(`${course.grade} ${course.subject}`, `每周 ${course.weekly_hours} 节 · ${course.teacher}`, `${classText} · ${course.room}`, index);
      })
      .join("") || emptyDataRow("还没有课程资料，点击“新增”添加。");
  }
  if (state.activeTab === "time") {
    const source = state.result || state.demo;
    const currentPeriods = source.periods_by_stage?.[state.schoolScope] || [];
    const stageTimes = dataRow(`${state.schoolScope}时间`, currentPeriods.map((period) => `${period.label} ${period.time}`).join("；"), `可输入“${state.schoolScope}9点上课”临时修改`);
    const fixed = state.demo.fixed_events
      .filter((event) => fallbackStageForClass(event.class) === state.schoolScope)
      .slice(0, 6)
      .map((event) => dataRow(`${event.class} ${event.day} 第${event.period}节`, event.subject, event.note))
      .join("");
    els.dataList.innerHTML = stageTimes + fixed;
  }
}

function classesForCurrentScope(classes = []) {
  return classes.filter((className) => fallbackStageForClass(className) === state.schoolScope);
}

function courseMatchesCurrentScope(course, currentClasses) {
  if ((course.classes || []).length) {
    return currentClasses.length > 0;
  }
  return fallbackStageForClass(course.grade || "") === state.schoolScope;
}

function emptyDataRow(text) {
  return `<article class="data-row empty-data"><span>${escapeHtml(text)}</span></article>`;
}

function dataRow(title, subtitle, note, index = null) {
  const actions = index === null
    ? ""
    : `<div class="card-actions">
        <button class="tiny-button" data-action="edit" data-index="${index}">修改</button>
        <button class="tiny-button danger" data-action="delete" data-index="${index}">删除</button>
      </div>`;
  return `<article class="data-row"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(subtitle)}</span>${note ? `<span>${escapeHtml(note)}</span>` : ""}${actions}</article>`;
}

function deleteEditableItem(index) {
  if (state.activeTab === "time") {
    return;
  }
  state.editableData[state.activeTab].splice(index, 1);
  persistEditableData();
  renderDataList();
}

function defaultEditableItem(tab) {
  if (tab === "teachers") {
    return { name: "新老师", subject: "学科", classes: [], notes: "可继续补充任课班级和禁排要求" };
  }
  if (tab === "rooms") {
    return { name: "新教室", type: "普通教室", capacity: 1, notes: "可继续补充容量和用途" };
  }
  if (tab === "time") {
    return { stage: state.schoolScope, start_time: state.schoolScope === "小学" ? "08:50" : "08:00", notes: "" };
  }
  return { grade: "七年级", subject: "新课程", weekly_hours: 1, teacher: "待分配", room: "本班教室", classes: [] };
}

function collectPendingInputRules() {
  const rules = parseRuleInput(els.ruleInput.value);
  if (!rules.length) {
    return false;
  }
  const changed = addRuleMessages(rules);
  els.ruleInput.value = "";
  return changed;
}

function parseRuleInput(text) {
  return String(text || "")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendRuleTemplate(template) {
  const current = els.ruleInput.value.trim();
  els.ruleInput.value = current ? `${current}\n${template}` : template;
  els.ruleInput.focus();
}

function addRuleMessages(rules) {
  let changed = false;
  rules.forEach((rule) => {
    if (!state.messages.includes(rule)) {
      state.messages.push(rule);
      changed = true;
    }
  });
  if (changed) {
    state.confirmedReviewIds.clear();
    persistRuleMessages();
  }
  return changed;
}

function loadSavedRuleMessages() {
  try {
    const raw = localStorage.getItem(RULE_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const saved = JSON.parse(raw);
    return Array.isArray(saved) ? saved.map((item) => String(item).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function persistRuleMessages() {
  try {
    localStorage.setItem(RULE_STORAGE_KEY, JSON.stringify(state.messages.filter(Boolean)));
  } catch {
    setFeedback("规则已在当前页面更新，但浏览器没有允许本机保存。");
  }
}

function buildRequestPayload(extra = {}) {
  return {
    school_scope: state.schoolScope,
    ...extra,
  };
}

function coursesForPayload() {
  // 只返回当前学段的课程
  return state.editableData.courses
    .filter(course => course.stage === state.schoolScope)
    .map((course) => {
      const demoGradeClasses = (state.demo?.classes || []).filter((className) => className.startsWith(`${course.grade}(`));
      const courseClasses = (course.classes || []).filter(className => 
        state.result?.class_names?.includes(className)
      );
      const coversWholeDemoGrade = demoGradeClasses.length > 0 && demoGradeClasses.every((className) => courseClasses.includes(className));
      return {
        ...course,
        classes: coversWholeDemoGrade ? [] : courseClasses,
      };
    });
}

function loadSavedEditableData(defaults) {
  try {
    clearLegacyEditableData();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { data: cloneEditableData(defaults), loaded: false };
    }
    const saved = JSON.parse(raw);
    if (!isUsableEditableData(saved)) {
      localStorage.removeItem(STORAGE_KEY);
      return { data: cloneEditableData(defaults), loaded: false };
    }
    return {
      data: {
        teachers: usableList(saved.teachers, defaults.teachers),
        rooms: usableList(saved.rooms, defaults.rooms),
        courses: usableList(saved.courses, defaults.courses),
      },
      loaded: true,
    };
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return { data: cloneEditableData(defaults), loaded: false };
  }
}

function clearLegacyEditableData() {
  LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
}

function isUsableEditableData(saved) {
  return Array.isArray(saved?.courses) && saved.courses.length > 0 && Array.isArray(saved?.rooms) && saved.rooms.length > 0;
}

function usableList(savedList, fallbackList) {
  return Array.isArray(savedList) && savedList.length ? savedList : fallbackList;
}

function persistEditableData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.editableData));
  } catch {
    setFeedback("资料已在当前页面更新，但浏览器没有允许本机保存。");
  }
}

function cloneEditableData(data) {
  return {
    teachers: (data.teachers || []).map((item) => ({ ...item })),
    rooms: (data.rooms || []).map((item) => ({ ...item })),
    courses: (data.courses || []).map((item) => ({ ...item })),
  };
}

function openDataModal(mode = "add", type = "teachers", index = null) {
  const safeType = DATA_LABELS[type] ? type : "teachers";
  state.dataModal = { mode, type: safeType, index };
  els.dataModalTitle.textContent = mode === "edit" ? `修改${DATA_LABELS[safeType]}` : "新增资料";
  els.dataModalType.value = safeType;
  els.dataModalType.disabled = mode === "edit";
  renderDataModalFields();
  if (els.dataModal.open) {
    els.dataModal.close();
  }
  els.dataModal.showModal();
  const firstField = els.dataModalFields.querySelector("input, select, textarea");
  firstField?.focus();
}

function closeDataModal() {
  els.dataModalType.disabled = false;
  if (els.dataModal.open) {
    els.dataModal.close();
  }
}

function currentModalItem(type) {
  if (state.dataModal.mode === "edit" && type !== "time") {
    return state.editableData[type]?.[state.dataModal.index] || defaultEditableItem(type);
  }
  return defaultEditableItem(type);
}

function renderDataModalFields() {
  const type = els.dataModalType.value;
  const item = currentModalItem(type);
  if (type === "teachers") {
    els.dataModalFields.innerHTML = [
      inputField("老师姓名", "name", item.name, "text", "例如：王老师", "required"),
      inputField("任教学科", "subject", item.subject, "text", "例如：数学", "required"),
      textareaField("任课班级", "classes", (item.classes || []).join("、"), "例如：七年级(1)、七年级(2)"),
      textareaField("备注或限制", "notes", item.notes || "", "例如：周三下午教研，不排课"),
    ].join("");
  }
  if (type === "rooms") {
    els.dataModalFields.innerHTML = [
      inputField("教室或场地名称", "name", item.name, "text", "例如：机房A", "required"),
      inputField("类型", "type", item.type, "text", "例如：专用教室"),
      inputField("同一节可容纳几个班", "capacity", item.capacity, "number", "例如：2", 'min="1" max="999"'),
      textareaField("说明", "notes", item.notes || "", "例如：信息科技课使用"),
    ].join("");
  }
  if (type === "courses") {
    const gradeOptions = visibleGradeSettings().map((setting) => setting.grade);
    if (item.grade && !gradeOptions.includes(item.grade)) {
      gradeOptions.unshift(item.grade);
    }
    els.dataModalFields.innerHTML = [
      selectField("年级", "grade", item.grade, gradeOptions),
      inputField("课程名称", "subject", item.subject, "text", "例如：数学", "required"),
      inputField("每周几节", "weekly_hours", item.weekly_hours, "number", "例如：5", 'min="0" max="12"'),
      inputField("任课老师", "teacher", item.teacher, "text", "例如：王老师"),
      inputField("上课地点", "room", item.room, "text", "例如：本班教室"),
      textareaField("适用班级", "classes", (item.classes || []).join("、"), "留空表示该年级所有班"),
    ].join("");
  }
  if (type === "time") {
    els.dataModalFields.innerHTML = [
      selectField("学段", "stage", item.stage, ["小学", "初中"]),
      inputField("第1节开始时间", "start_time", item.start_time, "time", "08:50", "required"),
      textareaField("备注", "notes", item.notes || "", "例如：冬令时临时调整"),
    ].join("");
  }
}

async function saveDataModal() {
  const type = els.dataModalType.value;
  const item = readDataModalItem(type);
  if (!item) {
    return;
  }
  if (type === "time") {
    const text = `${item.stage}第1节${item.start_time}开始上课`;
    addRuleMessages([text]);
    closeDataModal();
    await solveTimetable();
    return;
  }
  if (state.dataModal.mode === "edit") {
    state.editableData[type][state.dataModal.index] = item;
  } else {
    state.editableData[type].unshift(item);
  }
  persistEditableData();
  renderDataList();
  closeDataModal();
  await solveTimetable();
}

function readDataModalItem(type) {
  const value = (field) => els.dataModalFields.querySelector(`[data-field="${field}"]`)?.value.trim() || "";
  if (type === "teachers") {
    const name = value("name");
    const subject = value("subject");
    if (!name || !subject) {
      setFeedback("请先填写老师姓名和任教学科。");
      return null;
    }
    return { name, subject, classes: splitClassText(value("classes")), notes: value("notes") };
  }
  if (type === "rooms") {
    const name = value("name");
    if (!name) {
      setFeedback("请先填写教室或场地名称。");
      return null;
    }
    return { name, type: value("type") || "普通教室", capacity: numberValue(value("capacity"), 1, 1, 999), notes: value("notes") };
  }
  if (type === "courses") {
    const grade = value("grade");
    const subject = value("subject");
    if (!grade || !subject) {
      setFeedback("请先填写年级和课程名称。");
      return null;
    }
    return {
      grade,
      subject,
      weekly_hours: numberValue(value("weekly_hours"), 1, 0, 12),
      teacher: value("teacher") || "待分配",
      room: value("room") || "本班教室",
      classes: splitClassText(value("classes")),
    };
  }
  const stage = value("stage") || state.schoolScope;
  const startTime = value("start_time");
  if (!startTime) {
    setFeedback("请先填写第1节开始时间。");
    return null;
  }
  return { stage, start_time: startTime, notes: value("notes") };
}

function inputField(label, field, value = "", type = "text", placeholder = "", attrs = "") {
  return `
    <label class="form-field">
      <span>${escapeHtml(label)}</span>
      <input data-field="${field}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${attrs} />
    </label>
  `;
}

function textareaField(label, field, value = "", placeholder = "") {
  return `
    <label class="form-field">
      <span>${escapeHtml(label)}</span>
      <textarea data-field="${field}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>
    </label>
  `;
}

function selectField(label, field, value, options) {
  return `
    <label class="form-field">
      <span>${escapeHtml(label)}</span>
      <select data-field="${field}">
        ${options.map((option) => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
      </select>
    </label>
  `;
}

function splitClassText(text) {
  return text
    .split(/[、,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberValue(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(number)));
}

async function handleConditionImages(event) {
  const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith("image/"));
  if (!files.length) {
    return;
  }
  files.forEach((file) => {
    const sourceText = `图片条件：${file.name}（待人工确认）`;
    state.conditionImages.push({
      name: file.name,
      url: URL.createObjectURL(file),
      sourceText,
    });
    addRuleMessages([sourceText]);
  });
  event.target.value = "";
  renderImagePreview();
  await solveTimetable();
}

function renderImagePreview() {
  els.imagePreviewList.innerHTML = state.conditionImages
    .map((image, index) => `
      <article class="image-preview">
        <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}" />
        <span title="${escapeHtml(image.name)}">${escapeHtml(image.name)}</span>
        <button class="tiny-button danger" data-action="remove-image" data-index="${index}">删除</button>
      </article>
    `)
    .join("");
}

function renderRules() {
  const cards = state.result?.rule_cards || [];
  els.ruleCount.textContent = `${cards.length} 条`;
  if (!cards.length) {
    els.ruleCards.innerHTML = `<article class="rule-card"><strong>暂无新增要求</strong><span>当前按左侧资料生成课表。</span></article>`;
    return;
  }
  els.ruleCards.innerHTML = cards
    .map((rule, index) => {
      const confirmed = state.confirmedReviewIds.has(rule.id);
      const type = confirmed ? "confirmed" : rule.strictness === "review" ? "review" : rule.strictness === "hard" ? "hard" : "soft";
      const labelMap = {
        hard: "必须满足",
        soft: "尽量满足",
        review: confirmed ? "已确认（备注）" : "待人工确认",
        time: "时间设置",
      };
      const label = confirmed ? labelMap.review : labelMap[rule.strictness] || "已识别";
      // 所有规则都可以删除，review 规则还有"先保留"按钮
      const actions = `<div class="rule-actions">
            ${rule.strictness === "review" && !confirmed ? `<button class="tiny-button" data-action="confirm" data-index="${index}">先保留</button>` : ""}
            <button class="tiny-button danger" data-action="remove" data-index="${index}">删除</button>
          </div>`;
      const hint = confirmed ? "这条已由人工确认，系统已重新尝试排课；如果仍未应用，请把要求写得更具体。" : `原话：${escapeHtml(rule.source_text)}`;
      return `<article class="rule-card ${type}"><strong>${escapeHtml(rule.summary)}</strong><span>${label} · ${hint}</span>${actions}</article>`;
    })
    .join("");
}

function renderTimetable() {
  if (!state.result || !state.demo) {
    return;
  }
  // 确保 selectedClass 是当前学段的班级
  if (!state.selectedClass || !state.result.class_names.includes(state.selectedClass)) {
    state.selectedClass = state.result.class_names[0];
  }
  const className = state.selectedClass;
  const schedule = state.result.classes[className];
  const periods = periodsForSelectedClass();
  const header = `<thead><tr><th class="period-cell">节次</th>${state.demo.days.map((day) => `<th>${day}</th>`).join("")}</tr></thead>`;
  const rows = periods
    .map((period, periodIndex) => {
      const cells = state.demo.days
        .map((day) => {
          const cell = schedule[day][periodIndex];
          return `<td>${lessonCell(cell, className, day, period.number)}</td>`;
        })
        .join("");
      return `<tr><th class="period-cell">${period.label}<br>${period.time}</th>${cells}</tr>`;
    })
    .join("");
  els.timetable.innerHTML = `${header}<tbody>${rows}</tbody>`;
  bindDragHandlers();
  renderConflictState();
  renderAppliedRules();
}

function lessonCell(cell, className, day, period) {
  const classes = ["lesson-cell", cell.source === "fixed" ? "fixed" : "", cell.source === "empty" ? "empty" : ""].join(" ");
  const canDrag = state.manualMode && cell.source === "solver";
  const draggable = canDrag ? "true" : "false";
  const title = canDrag ? "可调整课程" : "固定或空白节次";
  return `
    <div class="${classes}" draggable="${draggable}" title="${title}" data-class="${className}" data-day="${day}" data-period="${period}">
      <strong>${escapeHtml(cell.subject)}</strong>
      <span>${escapeHtml(cell.teacher || "可调整")}</span>
      <span>${escapeHtml(cell.room || "本班教室")}</span>
    </div>
  `;
}

function bindDragHandlers() {
  document.querySelectorAll(".lesson-cell").forEach((cell) => {
    cell.addEventListener("dragstart", (event) => {
      if (cell.getAttribute("draggable") !== "true") {
        event.preventDefault();
        return;
      }
      state.drag = {
        className: cell.dataset.class,
        day: cell.dataset.day,
        period: Number(cell.dataset.period),
      };
    });
    cell.addEventListener("dragover", (event) => event.preventDefault());
    cell.addEventListener("drop", () => {
      if (!state.drag) {
        return;
      }
      moveLesson(state.drag, {
        className: cell.dataset.class,
        day: cell.dataset.day,
        period: Number(cell.dataset.period),
      });
      state.drag = null;
    });
  });
}

function moveLesson(from, to) {
  if (from.className !== to.className) {
    return;
  }
  const schedule = state.result.classes[from.className];
  const fromCell = schedule[from.day][from.period - 1];
  const toCell = schedule[to.day][to.period - 1];
  if (toCell.source === "fixed") {
    setFeedback("固定活动不能被覆盖，请换一个时间。");
    return;
  }
  schedule[from.day][from.period - 1] = toCell;
  schedule[to.day][to.period - 1] = fromCell;
  renderTimetable();
  const conflicts = collectConflictDetails();
  setFeedback(conflicts.length ? `调整后发现 ${conflicts.length} 个冲突，提示区已有处理建议。` : "调整后没有发现硬冲突。");
}

function renderConflictState() {
  const conflicts = collectConflictDetails();
  els.conflictBanner.classList.toggle("has-conflict", conflicts.length > 0);
  els.conflictBanner.textContent = conflicts.length
    ? `发现 ${conflicts.length} 个冲突，请先处理下面的建议。`
    : "当前没有发现教师、班级、教室硬冲突。";
  renderConflictAdvice(conflicts);
}

function findConflicts() {
  return collectConflictDetails().map((conflict) => conflict.description);
}

function collectConflictDetails() {
  const conflicts = [];
  const teacherSlots = new Map();
  const roomSlots = new Map();
  const roomCapacity = roomCapacityMap();
  Object.entries(state.result.classes).forEach(([className, week]) => {
    Object.entries(week).forEach(([day, cells]) => {
      cells.forEach((cell, index) => {
        const period = index + 1;
        if (!cell.teacher || cell.subject === "自习" || cell.teacher === "班主任" || cell.teacher === "德育处") {
          return;
        }
        const teacherKey = `${day}-${period}-${cell.teacher}`;
        const teacherItems = teacherSlots.get(teacherKey) || [];
        teacherItems.push(`${className}${cell.subject}`);
        teacherSlots.set(teacherKey, teacherItems);

        if (cell.room && roomCapacity.get(cell.room) && roomCapacity.get(cell.room) < 999) {
          const roomKey = `${day}-${period}-${cell.room}`;
          const roomItems = roomSlots.get(roomKey) || [];
          roomItems.push(`${className}${cell.subject}`);
          roomSlots.set(roomKey, roomItems);
        }
      });
    });
  });

  teacherSlots.forEach((items, key) => {
    if (items.length > 1) {
      const [day, period, teacher] = key.split("-");
      conflicts.push({
        type: "teacher",
        title: `${teacher}时间冲突`,
        description: `${teacher}在${day}第${period}节同时安排了${items.join("、")}。`,
        suggestion: `建议保留一个班在这节课，把${items.slice(1).join("、")}通过后台或 CLI 调到其他空白节次；如果必须同一时间上课，就需要换一位任课老师。`,
      });
    }
  });
  roomSlots.forEach((items, key) => {
    const [day, period, room] = key.split("-");
    const limit = roomCapacity.get(room) || 1;
    if (items.length > limit) {
      conflicts.push({
        type: "room",
        title: `${room}容量冲突`,
        description: `${room}在${day}第${period}节安排了${items.length}个班，当前容量是${limit}个班。`,
        suggestion: room.includes("操场")
          ? `建议把部分体育课通过后台或 CLI 调到其他节次，或把操场容量调大后重新排课。`
          : `建议把${items.slice(limit).join("、")}调到其他节次，或补充可用教室后重新排课。`,
      });
    }
  });
  return conflicts;
}

function roomCapacityMap() {
  return new Map((state.editableData.rooms || []).map((room) => [room.name, Number(room.capacity) || 1]));
}

function renderConflictAdvice(conflicts) {
  if (!conflicts.length) {
    els.conflictAdvice.hidden = true;
    els.conflictAdvice.innerHTML = "";
    return;
  }
  els.conflictAdvice.hidden = false;
  els.conflictAdvice.innerHTML = conflicts
    .slice(0, 6)
    .map((conflict, index) => `
      <article class="advice-card ${conflict.type}">
        <strong>${index + 1}. ${escapeHtml(conflict.title)}</strong>
        <span>${escapeHtml(conflict.description)}</span>
        <span class="advice-text">建议：${escapeHtml(conflict.suggestion)}</span>
      </article>
    `)
    .join("");
  if (conflicts.length > 6) {
    els.conflictAdvice.innerHTML += `<article class="advice-more">还有 ${conflicts.length - 6} 个冲突，可先处理上面几条后重新排课。</article>`;
  }
}

function renderMissingInformation() {
  if (!els.missingInfo) {
    return;
  }
  const items = state.result?.missing_information || [];
  if (!items.length) {
    els.missingInfo.innerHTML = `<div class="info-empty">当前没有发现必填信息缺失。</div>`;
    return;
  }
  els.missingInfo.innerHTML = items
    .slice(0, 6)
    .map((item, index) => `
      <article class="info-card">
        <strong>${index + 1}. ${escapeHtml(item.message)}</strong>
        <span>${escapeHtml(item.suggestion || "请补充后刷新课表。")}</span>
      </article>
    `)
    .join("");
  if (items.length > 6) {
    els.missingInfo.innerHTML += `<article class="advice-more">还有 ${items.length - 6} 条缺失信息，建议先通过 CLI 批量补充。</article>`;
  }
}

function renderAppliedRules() {
  const ruleCards = state.result.rule_cards || [];
  const applied = [...(state.result.applied_rules || [])];
  const confirmed = ruleCards
    .filter((rule) => rule.strictness === "review" && state.confirmedReviewIds.has(rule.id))
    .map((rule) => `已确认备注：${rule.source_text}`);
  const unconfirmed = ruleCards
    .filter((rule) => rule.strictness === "review" && !state.confirmedReviewIds.has(rule.id))
    .map((rule) => `待确认：${rule.source_text}`);
  const rows = [...applied, ...confirmed, ...unconfirmed];
  const manualChanges = state.result.manual_changes || [];
  manualChanges.forEach((change) => {
    if (change.operation === "move") {
      rows.push(`手动调整：${change.class_name}${change.from_day}第${change.from_period}节 → ${change.to_day}第${change.to_period}节`);
    }
    if (change.operation === "swap") {
      rows.push(`手动交换：${change.left_class}${change.left_day}第${change.left_period}节 ↔ ${change.right_class}${change.right_day}第${change.right_period}节`);
    }
  });
  els.appliedRules.innerHTML = rows.length
    ? rows.map((rule) => `<div class="applied-rule">${escapeHtml(rule)}</div>`).join("")
    : `<div class="applied-rule">已按当前资料生成课表</div>`;
  const stats = state.result.stats;
  els.statsText.textContent = `已安排 ${stats.scheduled_lessons} 节课，覆盖 ${stats.classes} 个班。`;
}

function renderFeedback() {
  if (!state.result) {
    return;
  }
  const conflicts = findConflicts();
  if (state.result.status !== "success") {
    setFeedback(state.result.message);
    return;
  }
  const ruleCards = state.result.rule_cards || [];
  const unconfirmed = ruleCards.filter((rule) => rule.strictness === "review" && !state.confirmedReviewIds.has(rule.id));
  const confirmed = ruleCards.filter((rule) => rule.strictness === "review" && state.confirmedReviewIds.has(rule.id));
  const lines = [state.result.message];
  if (state.result.applied_rules.length) {
    lines.push(`已应用：${state.result.applied_rules.join("；")}`);
  }
  if (confirmed.length) {
    lines.push(`已人工确认备注：${confirmed.map((rule) => rule.source_text).join("；")}`);
  }
  if (unconfirmed.length) {
    lines.push(`仍需确认：${unconfirmed.map((rule) => rule.source_text).join("；")}`);
  }
  lines.push(conflicts.length ? `发现 ${conflicts.length} 个冲突。` : "没有发现硬冲突。");
  setFeedback(lines.join("\n"));
}

function periodsForSelectedClass() {
  const source = state.result || state.demo;
  if (!source) {
    return [];
  }
  const className = state.selectedClass || source.class_names?.[0] || state.demo?.classes?.[0];
  const stage = source.class_stages?.[className] || fallbackStageForClass(className);
  return source.periods_by_stage?.[stage] || source.periods || [];
}

function fallbackStageForClass(className) {
  return /^[一二三四五六]/.test(className) ? "小学" : "初中";
}

function setFeedback(text) {
  els.feedback.textContent = text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
