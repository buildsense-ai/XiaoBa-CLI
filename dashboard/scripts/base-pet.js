const API = (() => {
  try {
    return window.location.protocol === 'file:' ? 'http://127.0.0.1:3800' : '';
  } catch (_e) {
    return '';
  }
})();
function formatDashboardApiError(error, path){
  const message=error&&error.message?String(error.message):String(error||'请求失败');
  if(/failed to fetch|networkerror|load failed|fetch/i.test(message)){
    let target=path||'/api';
    try{
      const origin=API || (window.location&&window.location.origin) || 'http://127.0.0.1:3800';
      target=new URL(path||'/api', origin).toString();
    }catch(_e){}
    return `无法连接本地 CatsCo Dashboard API（${target}）。请刷新或重启 CatsCo 后再试。`;
  }
  return message;
}
let appStatusSnapshot = {};
let appReadinessSnapshot = {};
let appReadinessLoaded = false;
let appReadinessError = '';
const pageTitles = { services:'Agent Hub', store:'SkillHub', companion:'Companion Hub', chat:'CatsCo' };
let catsAuthMode = 'login';
let catsState = {};
let catsNextAction = 'none';
let catsPollTimer = null;
let catsStatusGeneration = 0;
let catsStatusMutationInFlight = false;
let catsScrollPinnedToBottom = true;
let catsMessagesCache = [];
let catsMessagesHasOlder = true;
let catsMessagesLoading = false;
let catsMessagesLoadingOlder = false;
let catsMessagesTopicId = '';
let catsMessagesOwnerKey = '';
let catsConnectCollapsed = true;
let catsConnectManualOverride = false;
let pendingStartupSource = '';
let pendingRelayModelId = '';
const CATS_MESSAGES_PAGE_SIZE = 50;
const CATS_SCROLL_BOTTOM_THRESHOLD = 80;
const CATS_SCROLL_TOP_THRESHOLD = 96;
let catsAttachmentQueue = [];
let catsAttachmentSeq = 0;
const CATS_ATTACHMENT_BROWSER_MESSAGE = '普通浏览器不能直接上传本地附件；请在 CatsCo 桌面客户端使用 + 选择文件，或把文件路径作为文字说明发给 Agent。';
const CATS_DEFAULT_HTTP_BASE = 'https://app.catsco.cc';
const CATS_DEFAULT_WS_URL = 'wss://app.catsco.cc/v0/channels';
const CATS_WORKING_TEXT_PREFIX = 'AI文本:';
const CATS_WORKING_TYPES = new Set(['thinking', 'tool_use', 'tool_result']);
const catsRuntimePlanOpenState = new Map();
const petFrames = {
  idle: ['pet/idle/01.png', 'pet/idle/02.png', 'pet/idle/03.png', 'pet/idle/04.png'],
  thinking: ['pet/thinking/01.png', 'pet/thinking/02.png', 'pet/thinking/03.png', 'pet/thinking/04.png'],
  working: ['pet/thinking/01.png', 'pet/thinking/02.png', 'pet/thinking/03.png', 'pet/thinking/04.png'],
  typing: ['pet/typing/01.png', 'pet/typing/02.png', 'pet/typing/03.png', 'pet/typing/04.png', 'pet/typing/05.png', 'pet/typing/06.png'],
  success: ['pet/success/01.png', 'pet/success/02.png', 'pet/success/03.png', 'pet/success/04.png'],
  error: ['pet/error/01.png', 'pet/error/02.png', 'pet/error/03.png', 'pet/error/04.png'],
  level_up: ['pet/success/01.png', 'pet/success/02.png', 'pet/success/03.png', 'pet/success/04.png']
};
const petSpeeds = { idle: 520, thinking: 620, working: 520, typing: 140, success: 360, error: 420, level_up: 320 };
const petStateLabels = { idle: '待机中', thinking: '思考中', working: '工作中', typing: '输入中', success: '完成了', error: '出错了', level_up: '升级了' };
const petStateCopy = {
  idle: '正在等待下一项任务。',
  thinking: '正在整理上下文和下一步动作。',
  working: '正在执行当前任务。',
  typing: '正在处理输入或输出内容。',
  success: '刚完成了一项工作。',
  error: '遇到异常，需要你看一眼。',
  level_up: '经验提升，解锁了新等级。'
};
const petPreviewLabels = { idle: '待机', thinking: '思考', typing: '输入', success: '成功', error: '错误' };
const PET_PROFILE_KEY = 'xiaoba.petProfile';
const PET_PROCESS_KEY = 'xiaoba.petProcess';
const PET_POSITION_KEY = 'xiaoba.petPosition';
const DASHBOARD_FONT_SCALE_KEY = 'xiaoba.dashboardFontScale';
const DASHBOARD_FONT_SCALE_MIN = 85;
const DASHBOARD_FONT_SCALE_MAX = 150;
const DASHBOARD_FONT_SCALE_STEP = 5;
const DASHBOARD_FONT_SCALE_DEFAULT = 100;
const petUnlocks = [
  { level: 1, title: '基础小猫', meta: '基础待机、思考、完成、错误动作' },
  { level: 2, title: 'Skill 气泡', meta: '宠物会显示正在调用哪个 skill' },
  { level: 3, title: '专注表情包', meta: '思考和工作时动作更丰富' },
  { level: 4, title: '工作台皮肤', meta: '解锁浅色工位风格' },
  { level: 5, title: '错误解释', meta: '出错时提示可能原因' },
  { level: 6, title: '完成庆祝', meta: '任务完成后出现庆祝动作' },
  { level: 7, title: '新伙伴位', meta: '解锁第二只协作宠物' },
  { level: 8, title: 'Skill 徽章', meta: '显示最擅长的 skill 类型' },
  { level: 9, title: '工作总结', meta: '宠物总结本次任务过程' },
  { level: 10, title: '高级伙伴', meta: '高级外观和专属状态反馈' }
];
const petLevelStepXp = { 1: 50, 2: 100, 3: 200, 4: 350 };
let petState = 'idle';
let realPetState = 'idle';
let realPetMessage = petStateCopy.idle;
let previewPetState = '';
let petFrameIndex = 0;
let petTimer = null;
let petStateHoldTimer = null;
let previewPetTimer = null;
let petBubbleTimer = null;
let petAutoBaseline = 'idle';
let petDragState = null;
let petDragSuppressClick = false;
let floatingPetUiState = { bubbleVisible:false, dragging:false, open:false, positioned:false };
let petProfile = loadPetProfile();
let petProcess = loadPetProcess();
let petBackendLastEventId = '';
let lastCatsMessageSignature = '';
let catsWorkingActive = false;
let skillHubState = { authenticated:false, roles:[], permissions:[], installed:[] };
let skillHubRegistryCache = [];
let localSkillsCache = [];
let skillHubDraftManifest = null;

function renderFloatingPetUi(patch = {}) {
  floatingPetUiState = { ...floatingPetUiState, ...patch };
  window.__catscoRenderFloatingPetUi?.(floatingPetUiState);
}

function loadPetProfile() {
  try {
    return {
      name: 'CatsCo',
      level: 1,
      xp: 0,
      tokenXp: 0,
      todayXp: 0,
      skillCalls: 0,
      form: '基础小猫',
      ...JSON.parse(localStorage.getItem(PET_PROFILE_KEY) || '{}')
    };
  } catch (_error) {
    return { name: 'CatsCo', level: 1, xp: 0, tokenXp: 0, todayXp: 0, skillCalls: 0, form: '基础小猫' };
  }
}

function savePetProfile() {
  localStorage.setItem(PET_PROFILE_KEY, JSON.stringify(petProfile));
}

function xpForLevel(level) {
  const safeLevel = Number(level || 1);
  return petLevelStepXp[safeLevel] || 350;
}

function awardPetXp(amount, source) {
  const value = Number(amount || 0);
  if (!Number.isFinite(value) || value <= 0) return;
  petProfile.xp += value;
  while (petProfile.xp >= xpForLevel(petProfile.level)) {
    petProfile.xp -= xpForLevel(petProfile.level);
    petProfile.level += 1;
    recordPetProcess('升级了', '解锁进度推进到 Lv.' + petProfile.level, 'success');
  }
  if (source === 'token') petProfile.tokenXp += value;
  savePetProfile();
  renderPetProfile();
}

function loadPetProcess() {
  try {
    const items = JSON.parse(localStorage.getItem(PET_PROCESS_KEY) || '[]');
    return Array.isArray(items) ? items.slice(0, 8) : [];
  } catch (_error) {
    return [];
  }
}

function savePetProcess() {
  localStorage.setItem(PET_PROCESS_KEY, JSON.stringify(petProcess.slice(0, 8)));
}

function formatPetTime(ts) {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function recordPetProcess(title, detail, state = petState) {
  const item = { title, detail, state, ts: Date.now() };
  const prev = petProcess[0];
  if (prev && prev.title === item.title && prev.detail === item.detail && Date.now() - prev.ts < 1200) return;
  petProcess = [item, ...petProcess].slice(0, 8);
  savePetProcess();
  renderPetProcess();
}

function clearPetProcess() {
  petProcess = [];
  savePetProcess();
  renderPetProcess();
}

function renderPetProcess() {
  const pageItems = petProcess.slice(0, 3);
  const floatingItems = petProcess.slice(0, 8);
  window.__catscoRenderPetProcess?.({
    pageItems: pageItems.map(item => ({
      title: String(item.title || ''),
      time: formatPetTime(item.ts),
    })),
    floatingItems: floatingItems.map(item => ({
      title: String(item.title || ''),
      detail: String(item.detail || petStateCopy[item.state] || ''),
      time: formatPetTime(item.ts),
    })),
  });
}

function renderPetProfile() {
  const currentXp = Number.isFinite(Number(petProfile.currentLevelXp)) ? Number(petProfile.currentLevelXp) : Number(petProfile.xp || 0);
  const next = Number.isFinite(Number(petProfile.nextLevelRequiredXp)) && Number(petProfile.nextLevelRequiredXp) > 0
    ? Number(petProfile.nextLevelRequiredXp)
    : xpForLevel(petProfile.level);
  const todayXp = Number.isFinite(Number(petProfile.todayXp)) ? Number(petProfile.todayXp) : 0;
  const percent = Math.max(0, Math.min(100, Math.round((currentXp / next) * 100)));
  const legacyTestName = ['XiaoBa', 'TEST'].join(' ');
  if (petProfile.name === 'XiaoBa' || petProfile.name === legacyTestName) petProfile.name = 'CatsCo';
  window.__catscoRenderPetProfile?.({
    floatingLevelLabel:'Lv.' + petProfile.level,
    formLabel:petProfile.form || 'Basic cat',
    levelLabel:'Lv.' + petProfile.level,
    name:petProfile.name || 'CatsCo',
    skillXpLabel:String(petProfile.skillCalls || 0) + ' times',
    titleLabel:petProfile.title || 'New companion',
    todayXpLabel:todayXp + ' XP',
    xpLabel:currentXp + ' / ' + next + ' XP',
    xpPercent:percent,
  });
  renderPetUnlocks();
}

async function fetchPetStatus() {
  try {
    const res = await fetch(API + '/api/pet/status');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const status = await res.json();
    applyPetStatus(status);
  } catch (_error) {
    // Pet status is decorative runtime feedback; keep the page usable if it is unavailable.
  }
}

async function fetchPetTimeline() {
  try {
    const res = await fetch(API + '/api/pet/timeline?limit=8');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];
    petProcess = events.map(petEventToProcessItem);
    renderPetProcess();
  } catch (_error) {
    renderPetProcess();
  }
}

async function fetchPetProgress() {
  try {
    const res = await fetch(API + '/api/pet/progress');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const progress = await res.json();
    applyPetProgress(progress);
  } catch (_error) {
    // Keep the companion panel stable if growth stats are temporarily unavailable.
  }
}

function applyPetProgress(progress) {
  if (!progress || typeof progress !== 'object') return;
  const skillStats = Array.isArray(progress.skill_stats) ? progress.skill_stats : [];
  const skillCalls = skillStats.reduce((sum, stat) => {
    const count = Number(stat && stat.call_count);
    return sum + (Number.isFinite(count) && count > 0 ? count : 0);
  }, 0);
  petProfile = {
    ...petProfile,
    level: Number(progress.level || petProfile.level || 1),
    title: progress.title || petProfile.title || petProfile.form,
    totalXp: Number(progress.total_xp || petProfile.totalXp || 0),
    todayXp: Number(progress.today_xp || 0),
    skillCalls,
  };
  renderPetProfile();
}

function applyPetStatus(status) {
  if (!status || typeof status !== 'object') return;
  petProfile = {
    ...petProfile,
    level: Number(status.level || petProfile.level || 1),
    title: status.title || petProfile.title || petProfile.form,
    totalXp: Number(status.total_xp || 0),
    currentLevelXp: Number(status.current_level_xp || 0),
    nextLevelRequiredXp: Number(status.next_level_required_xp || 0) || null,
    skillCalls: Number(petProfile.skillCalls || 0),
  };
  renderPetProfile();

  const state = status.current_state || 'idle';
  const message = status.current_bubble_message || petStateCopy[state] || '';
  const eventId = status.last_event_id || '';
  const isNewEvent = Boolean(eventId && eventId !== petBackendLastEventId);
  if (isNewEvent) petBackendLastEventId = eventId;
  if (previewPetState && isNewEvent && shouldInterruptPetPreview(status)) cancelPetPreview();

  const holdMs = petHoldMsForStatus(status);
  setPetState(state, {
    message,
    holdMs,
    silent: !isNewEvent,
    record: false,
  });
}

function shouldInterruptPetPreview(status) {
  const eventType = status.last_event_type || '';
  const state = status.current_state || '';
  return eventType === 'skill_failed' || eventType === 'level_up' || eventType === 'task_completed' || state === 'error' || state === 'level_up';
}

function petHoldMsForStatus(status) {
  const eventType = status.last_event_type || '';
  if (eventType === 'level_up') return 3600;
  if (eventType === 'skill_failed') return 7000;
  if (eventType === 'skill_started') return 0;
  if (eventType === 'skill_succeeded' || eventType === 'task_completed' || eventType === 'message_completed') return 2600;
  return 0;
}

function petEventToProcessItem(event) {
  return {
    title: event.message || petEventTitle(event),
    detail: petEventDetail(event),
    state: petEventState(event),
    ts: Date.parse(event.created_at || '') || Date.now(),
  };
}

function petEventTitle(event) {
  const name = event.skill_name ? '「' + event.skill_name + '」' : '';
  if (event.event_type === 'skill_started') return name ? '正在调用' + name + 'skill' : '正在调用 skill';
  if (event.event_type === 'skill_succeeded') return name ? name + 'skill 已完成' : 'skill 已完成';
  if (event.event_type === 'skill_failed') return name ? name + 'skill 出错了' : 'skill 出错了';
  if (event.event_type === 'task_completed') return '任务完成';
  if (event.event_type === 'message_completed') return 'CatsCo 回复了';
  if (event.event_type === 'level_up') return '升级了';
  return name || '工作事件';
}

function petEventDetail(event) {
  if (event.skill_name) return 'Skill: ' + event.skill_name;
  return petStateCopy[petEventState(event)] || '';
}

function petEventState(event) {
  if (event.event_type === 'skill_started') return 'working';
  if (event.event_type === 'skill_failed') return 'error';
  if (event.event_type === 'level_up') return 'level_up';
  if (event.event_type === 'skill_succeeded' || event.event_type === 'task_completed' || event.event_type === 'message_completed') return 'success';
  return 'idle';
}

function renderPetUnlocks() {
  const level = Number(petProfile.level || 1);
  const currentXp = Number.isFinite(Number(petProfile.currentLevelXp)) ? Number(petProfile.currentLevelXp) : Number(petProfile.xp || 0);
  const next = Number.isFinite(Number(petProfile.nextLevelRequiredXp)) && Number(petProfile.nextLevelRequiredXp) > 0
    ? Number(petProfile.nextLevelRequiredXp)
    : xpForLevel(level);
  const remaining = Math.max(0, next - currentXp);
  const nextUnlock = petUnlocks.find(item => item.level > level);
  if (!nextUnlock) {
    window.__catscoRenderPetUnlock?.({
      tagLabel:'All unlocked',
      name:'Lv.10 Advanced companion',
      meta:'Advanced appearance and dedicated state feedback are unlocked.',
      currentXp,
      statLabel:currentXp + ' XP',
      remaining:0,
    });
    return;
  }
  window.__catscoRenderPetUnlock?.({
    tagLabel:'Lv.' + nextUnlock.level,
    name:'Lv.' + nextUnlock.level + ' ' + String(nextUnlock.title || ''),
    meta:String(nextUnlock.meta || ''),
    currentXp,
    statLabel:currentXp + ' / ' + next + ' XP',
    remaining,
  });
}

function preloadPetFrames() {
  Object.values(petFrames).flat().forEach(src => {
    const img = new Image();
    img.src = src;
  });
}

function renderPetFrameStrip(state) {
  window.__catscoRenderPetFrameStrip?.({frames:petFrames[state] || []});
}

function showPetFrame() {
  const frames = petFrames[petState] || petFrames.idle;
  if (!frames.length) return;
  const src = frames[petFrameIndex % frames.length];
  window.__catscoRenderPetFrame?.({src});
  petFrameIndex = (petFrameIndex + 1) % frames.length;
}

function showPetBubble(text) {
  const message = text || petStateLabels[petState] || petState;
  const stateLabel = petStateLabels[petState] || petState;
  window.__catscoRenderPetState?.({
    companionBubble:message,
    floatingBubble:message,
    panelState:stateLabel,
    stateCopy:petStateCopy[petState] || stateLabel,
    stateLabel,
  });
  renderFloatingPetUi({bubbleVisible:true});
  if (petBubbleTimer) clearTimeout(petBubbleTimer);
  petBubbleTimer = setTimeout(() => renderFloatingPetUi({bubbleVisible:false}), 2400);
}

function applyPetDisplayState(state, options = {}) {
  if (!petFrames[state]) state = 'idle';
  petState = state;
  petFrameIndex = 0;
  window.__catscoRenderPetActionUi?.({
    activeState:previewPetState?'':state,
    previewState:previewPetState || '',
  });
  const message = options.message || petStateCopy[state] || petStateLabels[state] || state;
  const stateLabel = petStateLabels[state] || state;
  window.__catscoRenderPetState?.({
    companionBubble:message,
    floatingBubble:message,
    panelState:stateLabel,
    stateCopy:message,
    stateLabel,
  });
  renderPetFrameStrip(state);
  showPetFrame();
  if (petTimer) clearInterval(petTimer);
  petTimer = setInterval(showPetFrame, petSpeeds[state] || 420);
  if (!options.silent && (options.message || options.manual || state !== 'idle')) showPetBubble(options.message || petStateLabels[state]);
}

function setPetState(state, options = {}) {
  if (!petFrames[state]) state = 'idle';
  if (petStateHoldTimer) {
    clearTimeout(petStateHoldTimer);
    petStateHoldTimer = null;
  }
  const previousState = realPetState || petState;
  const message = options.message || petStateCopy[state] || petStateLabels[state] || state;
  realPetState = state;
  realPetMessage = message;
  if (!previewPetState) applyPetDisplayState(state, options);
  if (options.record !== false && (options.message || options.manual || (previousState !== state && state !== 'idle'))) {
    recordPetProcess(petStateLabels[state] || state, options.message || petStateCopy[state] || '', state);
  }
  if (options.holdMs) {
    petStateHoldTimer = setTimeout(() => setPetState(petAutoBaseline), options.holdMs);
  }
}

function previewPetAction(state) {
  if (!petFrames[state]) return;
  if (previewPetTimer) clearTimeout(previewPetTimer);
  previewPetState = state;
  applyPetDisplayState(state, {
    message: '正在预览：' + (petPreviewLabels[state] || petStateLabels[state] || state) + '动作',
    record: false,
    manual: true,
  });
  previewPetTimer = setTimeout(restorePetRealState, 2600);
}

function handlePetActionPreviewKey(event, state) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  previewPetAction(state);
}

function cancelPetPreview() {
  if (previewPetTimer) {
    clearTimeout(previewPetTimer);
    previewPetTimer = null;
  }
  previewPetState = '';
}

function restorePetRealState() {
  cancelPetPreview();
  applyPetDisplayState(realPetState || petAutoBaseline || 'idle', {
    message: realPetMessage || petStateCopy[realPetState] || '',
    silent: true,
    record: false,
  });
}

function setPetAutoBaseline(state) {
  if (!petFrames[state]) state = 'idle';
  petAutoBaseline = state;
  if (!petStateHoldTimer) setPetState(state);
}

function resetPetAutoBaseline() {
  setPetAutoBaseline(petAutoBaseline);
}

function showCatsAttachmentBrowserMessage() {
  setCatsAction(CATS_ATTACHMENT_BROWSER_MESSAGE, true);
}

function pulsePetState(state, message, holdMs = 1800) {
  setPetState(state, { message, holdMs });
}

function inferServicePetBaseline(services) {
  if ((services || []).some(s => s.status === 'error')) return 'error';
  return 'idle';
}

function applyPetBaseline() {
  if (catsWorkingActive) {
    setPetAutoBaseline('thinking');
    return;
  }
  const services = appStatusSnapshot.services || [];
  setPetAutoBaseline(inferServicePetBaseline(services));
}

function floatingPetRect() {
  return window.__catscoGetFloatingPetRect?.() || null;
}

function clampFloatingPetPosition(x, y) {
  const rect = floatingPetRect() || { width: 112, height: 124 };
  const pad = 8;
  const width = rect.width || 112;
  const height = rect.height || 124;
  return {
    x: Math.max(pad, Math.min(window.innerWidth - width - pad, x)),
    y: Math.max(pad, Math.min(window.innerHeight - height - pad, y)),
  };
}

function applyFloatingPetPosition(position, persist = false) {
  if (!position) return;
  const next = clampFloatingPetPosition(Number(position.x) || 0, Number(position.y) || 0);
  renderFloatingPetUi({positioned:true,x:next.x,y:next.y});
  if (persist) {
    try { localStorage.setItem(PET_POSITION_KEY, JSON.stringify(next)); } catch (_e) {}
  }
}

function restoreFloatingPetPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(PET_POSITION_KEY) || 'null');
    if (saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y))) {
      applyFloatingPetPosition(saved, true);
    }
  } catch (_e) {}
}

function resetFloatingPetPosition() {
  renderFloatingPetUi({positioned:false,dragging:false,x:undefined,y:undefined,open:false});
  closeFloatingPetMenu();
  try { localStorage.removeItem(PET_POSITION_KEY); } catch (_e) {}
}

function clampFloatingPetToViewport(rect) {
  if (!floatingPetUiState.positioned) return;
  const box = rect || floatingPetRect();
  if (!box) return;
  applyFloatingPetPosition({ x: box.left, y: box.top }, true);
}

function startFloatingPetDrag(event, handle, rect) {
  if (event.button !== undefined && event.button !== 0) return;
  if (!handle) return;
  if (petDragState) return;
  const box = rect || floatingPetRect();
  if (!box) return;
  petDragState = {
    pointerId: event.pointerId ?? 'mouse',
    startX: event.clientX,
    startY: event.clientY,
    originX: box.left,
    originY: box.top,
    moved: false,
  };
  renderFloatingPetUi({dragging:true,open:false});
  closeFloatingPetMenu();
  if (event.pointerId !== undefined && handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
}

function moveFloatingPetDrag(event) {
  if (!petDragState) return;
  if (event.pointerId !== undefined && event.pointerId !== petDragState.pointerId) return;
  const dx = event.clientX - petDragState.startX;
  const dy = event.clientY - petDragState.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) petDragState.moved = true;
  applyFloatingPetPosition({ x: petDragState.originX + dx, y: petDragState.originY + dy }, false);
  event.preventDefault();
}

function endFloatingPetDrag(event, handle, rect) {
  if (!petDragState) return;
  if (event.pointerId !== undefined && event.pointerId !== petDragState.pointerId) return;
  renderFloatingPetUi({dragging:false});
  if (event.pointerId !== undefined && handle && handle.releasePointerCapture) {
    try { handle.releasePointerCapture(event.pointerId); } catch (_e) {}
  }
  if (petDragState.moved) {
    const box = rect || floatingPetRect();
    if (box) applyFloatingPetPosition({ x: box.left, y: box.top }, true);
    petDragSuppressClick = true;
    setTimeout(() => { petDragSuppressClick = false; }, 120);
  }
  petDragState = null;
}

function toggleFloatingPetMenu() {
  if (petDragSuppressClick) {
    petDragSuppressClick = false;
    return;
  }
  renderFloatingPetUi({open:!floatingPetUiState.open});
  showPetBubble(petStateLabels[petState]);
}

function closeFloatingPetMenu() {
  renderFloatingPetUi({open:false});
}
