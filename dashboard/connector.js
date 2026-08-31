(() => {
  'use strict';

  const API = '/api';
  const DASHBOARD_API_KEY_STORAGE_KEY = 'catsco.dashboardApiKey';
  let dashboardApiKeyPromptInFlight = null;

  function getFetchUrl(input) {
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
    return input?.url || '';
  }

  function isDashboardApiUrl(input) {
    try {
      const raw = getFetchUrl(input);
      if (!raw) return false;
      const url = new URL(raw, window.location.href);
      const apiBase = new URL(API || '/', window.location.href);
      return url.origin === apiBase.origin && url.pathname.startsWith('/api/');
    } catch (_error) {
      return false;
    }
  }

  function getDashboardStoredApiKey() {
    try { return window.sessionStorage.getItem(DASHBOARD_API_KEY_STORAGE_KEY) || ''; } catch (_error) { return ''; }
  }

  function setDashboardStoredApiKey(key) {
    try {
      if (key) window.sessionStorage.setItem(DASHBOARD_API_KEY_STORAGE_KEY, key);
      else window.sessionStorage.removeItem(DASHBOARD_API_KEY_STORAGE_KEY);
    } catch (_error) {}
  }

  function promptForDashboardApiKey(message) {
    if (!dashboardApiKeyPromptInFlight) {
      dashboardApiKeyPromptInFlight = Promise.resolve().then(() => {
        const key = window.prompt(message || '请输入 Dashboard API Key');
        const trimmed = key?.trim() || '';
        if (trimmed) setDashboardStoredApiKey(trimmed);
        return trimmed;
      }).finally(() => {
        dashboardApiKeyPromptInFlight = null;
      });
    }
    return dashboardApiKeyPromptInFlight;
  }

  async function ensureDashboardApiKey(message) {
    return getDashboardStoredApiKey() || promptForDashboardApiKey(message);
  }

  function withDashboardApiKey(input, init) {
    if (!isDashboardApiUrl(input)) return { input, init, dashboardApiKey: '' };
    const key = getDashboardStoredApiKey();
    if (!key) return { input, init, dashboardApiKey: '' };
    const nextInit = { ...(init || {}) };
    const sourceHeaders = nextInit.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : {});
    const headers = new Headers(sourceHeaders || {});
    if (!headers.has('Authorization') && !headers.has('X-API-Key')) headers.set('X-API-Key', key);
    nextInit.headers = headers;
    return { input, init: nextInit, dashboardApiKey: key };
  }

  async function isDashboardAuthFailure(response) {
    if (response.status !== 401 && response.status !== 403 && response.status !== 429) return false;
    try {
      const data = await response.clone().json();
      return data && [
        'dashboard_auth_required',
        'dashboard_auth_invalid',
        'dashboard_auth_rate_limited',
      ].includes(data.code);
    } catch (_error) {
      return false;
    }
  }

  function cloneFetchInput(input) {
    return typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function dashboardAuthenticatedFetch(input, init) {
    const firstInput = cloneFetchInput(input);
    const retryInput = cloneFetchInput(input);
    let authRequest = withDashboardApiKey(firstInput, init);
    let response = await nativeFetch(authRequest.input, authRequest.init);
    if (isDashboardApiUrl(input) && await isDashboardAuthFailure(response)) {
      if (response.status === 429) return response;
      if (getDashboardStoredApiKey() === authRequest.dashboardApiKey) setDashboardStoredApiKey('');
      const key = await ensureDashboardApiKey('Dashboard API Key 无效或缺失，请重新输入');
      if (key) {
        authRequest = withDashboardApiKey(retryInput, init);
        response = await nativeFetch(authRequest.input, authRequest.init);
      }
    }
    return response;
  };

  const state = {
    app: {},
    cats: {},
    bootstrap: {},
    services: [],
    update: {},
    refreshInFlight: null,
    loginBusy: false,
    openWebAppAfterLogin: false,
    logoutBusy: false,
    actionBusy: false,
    fullPollTimer: null,
    bootstrapPollTimer: null,
    managementOpen: false,
    managementTab: 'services',
    config: {},
    weixinBinding: {},
    agents: [],
    selectedAgentUid: '',
    agentListLoading: false,
    agentSwitchBusy: false,
    agentSwitchError: '',
    serviceActionBusy: new Set(),
    logPollTimer: null,
    weixinPollTimer: null,
    updatePollTimer: null,
    updateStatusInFlight: null,
    updateActionBusy: false,
  };

  const $ = (id) => document.getElementById(id);
  const setText = (id, value) => {
    const node = $(id);
    if (node) node.textContent = value == null || value === '' ? '—' : String(value);
  };

  async function request(path, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'application/json');
    if (init.body != null) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${API}${path}`, { ...init, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error || data?.data?.error || `HTTP ${response.status}`;
      const error = new Error(String(message));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function settled(path) {
    try {
      return { ok: true, value: await request(path) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function refresh(options = {}) {
    if (state.refreshInFlight && !options.force) return state.refreshInFlight;
    const run = (async () => {
      const [app, cats, bootstrap, services, update] = await Promise.all([
        settled('/status'),
        settled('/cats/status'),
        settled('/cats/bootstrap/status'),
        settled('/services'),
        settled('/update/status'),
      ]);
      if (app.ok) state.app = app.value;
      if (cats.ok) state.cats = cats.value;
      else state.cats = { loadError: cats.error?.message || '无法读取 CatsCo 状态' };
      if (bootstrap.ok) state.bootstrap = bootstrap.value;
      if (services.ok) state.services = Array.isArray(services.value) ? services.value : [];
      if (update.ok) state.update = update.value;
      render();
      if (state.managementOpen) renderChannels();
    })();
    state.refreshInFlight = run;
    try {
      await run;
    } finally {
      if (state.refreshInFlight === run) state.refreshInFlight = null;
    }
  }

  async function refreshBootstrap() {
    const result = await settled('/cats/bootstrap/status');
    if (result.ok) {
      const previous = state.bootstrap.stage;
      state.bootstrap = result.value;
      render();
      if (previous === 'connecting' && result.value.stage !== 'connecting') {
        await refresh({ force: true });
      }
    }
  }

  function connectorService() {
    return state.cats.service || state.services.find((service) => service.name === 'catscompany') || {};
  }

  function deriveView() {
    const cats = state.cats || {};
    const bootstrap = state.bootstrap || {};
    const service = connectorService();
    const bodyState = cats.bodyStatus?.state;
    const ready = Boolean(
      cats.connected
      && cats.chatReady
      && service.status === 'running'
      && cats.bodyStatus?.state !== 'offline',
    );
    if (ready) return { key: 'ready' };
    if (cats.loadError) return { key: 'error', title: '无法读取本地状态', error: cats.loadError };
    if (!cats.connected || cats.authStatus === 'missing' || cats.authStatus === 'invalid' || bootstrap.stage === 'waiting_for_login') {
      return { key: 'auth', error: cats.authError || (bootstrap.stage === 'waiting_for_login' ? bootstrap.error : '') };
    }
    if (bodyState === 'conflict') {
      return {
        key: 'error',
        title: '当前 Agent 正在另一台设备上运行',
        error: '为了避免两台电脑同时接管同一个 Agent，本机暂时没有启动 Connector。请先退出另一台设备，或稍后重试。',
      };
    }
    if (bodyState === 'auth_error') {
      return { key: 'error', title: 'Agent 绑定需要重新确认', error: cats.bodyStatus?.error || '当前账号无法使用这个 Agent。' };
    }
    if (bootstrap.stage === 'error' || service.status === 'error') {
      return {
        key: 'error',
        title: '自动连接未完成',
        error: bootstrap.error || service.lastError || 'Connector 启动失败，请重试。',
      };
    }
    return { key: 'connecting' };
  }

  function render() {
    const view = deriveView();
    const cats = state.cats || {};
    const service = connectorService();
    document.body.dataset.view = view.key;

    const accountName = cats.user?.display_name || cats.user?.username || '—';
    const accountMeta = cats.user?.username || (cats.connected ? `UID ${cats.user?.uid || ''}` : '等待登录');
    const agentName = cats.bot?.name || cats.bot?.username || (cats.botUid ? `Agent ${shortId(cats.botUid)}` : '—');
    const agentMeta = cats.bot?.username || (cats.botUid ? shortId(cats.botUid) : '登录后自动准备');
    const deviceName = cats.device?.name || (cats.device?.deviceId ? '这台电脑' : '—');
    setText('account-name', accountName);
    setText('account-meta', accountMeta);
    setText('agent-name', agentName);
    setText('agent-meta', agentMeta);
    setText('device-name', deviceName);
    setText('device-meta', cats.device?.bodyId ? `设备 ${shortId(cats.device.bodyId)}` : '本地工具与文件');
    setText('app-version', state.app.version || '—');
    const switchButton = $('agent-switch-open');
    switchButton.disabled = !cats.connected || state.agentSwitchBusy;

    $('login-form').hidden = view.key !== 'auth';
    $('progress-list').hidden = view.key !== 'connecting';
    $('error-card').hidden = view.key !== 'error';
    $('webapp-button').hidden = view.key !== 'ready';
    $('logout-button').hidden = view.key === 'auth' || (!cats.connected && !cats.tokenPresent);
    $('retry-button').hidden = view.key !== 'error';
    $('close-hint').hidden = view.key !== 'ready';

    if (view.key === 'auth') renderAuth(view);
    if (view.key === 'connecting') renderConnecting(cats, service);
    if (view.key === 'ready') renderReady(cats);
    if (view.key === 'error') renderError(view);
    renderUpdate();
    syncPolling(view.key);
    maybeOpenWebAppAfterLogin(view.key);
  }

  function maybeOpenWebAppAfterLogin(viewKey) {
    if (viewKey !== 'ready' || !state.openWebAppAfterLogin) return;
    state.openWebAppAfterLogin = false;
    window.setTimeout(() => {
      void openWebAppFromDashboard();
    }, 250);
  }

  async function openWebAppFromDashboard() {
    try {
      if (window.catscoDesktop?.openWebApp) {
        await window.catscoDesktop.openWebApp();
      } else {
        window.open('https://app.catsco.cc', '_blank', 'noopener,noreferrer');
      }
    } finally {
      await window.catscoDesktop?.hideWindow?.();
    }
  }

  function renderAuth(view) {
    setText('status-label', '等待登录 CatsCo');
    setText('hero-title', '登录 CatsCo');
    setText('hero-copy', '无需在本地创建或选择 Bot。登录成功后，CatsCo 会自动准备 Agent 并启动 Connector。');
    setNotice(view.error || '首次使用需要登录 CatsCo 账号。', view.error ? 'error' : 'normal');
    if (view.error) setText('login-error', view.error);
  }

  function renderConnecting(cats, service) {
    setText('status-label', 'Connector 正在启动');
    setText('hero-title', '正在连接这台电脑');
    setText('hero-copy', state.bootstrap.message || '正在同步 Agent 配置并启动 Connector，请稍候。');
    setNotice('请保持 CatsCo Desktop 运行，连接完成后即可关闭此窗口。', 'normal');
    const accountDone = Boolean(cats.connected);
    const agentDone = Boolean(cats.bodyConfigured || cats.botUid);
    const connectorDone = service.status === 'running';
    markStep('account', accountDone ? 'done' : 'active');
    markStep('agent', agentDone ? 'done' : accountDone ? 'active' : '');
    markStep('connector', connectorDone ? 'done' : agentDone ? 'active' : '');
  }

  function renderReady(cats) {
    setText('status-label', 'Connector 正常运行');
    setText('hero-title', '这台电脑已连接');
    setText('hero-copy', 'CatsCo WebApp 可以使用本机 Agent、本地工具和文件。');
    setNotice('连接已建立。关闭此窗口后，Connector 会继续在后台运行。', 'success');
  }

  function renderError(view) {
    const title = view.title || '自动连接未完成';
    const detail = humanError(view.error || '请重新连接，或打开本地管理查看日志。');
    setText('status-label', 'Connector 需要处理');
    setText('hero-title', '连接未完成');
    setText('hero-copy', '本地资料没有被删除。处理下面的问题后可以继续重试。');
    setText('error-title', title);
    setText('error-copy', detail);
    setNotice(`${title}：${detail}`, 'error');
  }

  function markStep(name, status) {
    const item = document.querySelector(`[data-step="${name}"]`);
    if (!item) return;
    item.classList.toggle('active', status === 'active');
    item.classList.toggle('done', status === 'done');
    if (status === 'active') item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }

  function setNotice(message, tone) {
    setText('notice-text', message);
    $('notice').className = `notice${tone === 'success' ? ' success' : tone === 'error' ? ' error' : ''}`;
  }

  function renderUpdate() {
    const button = $('update-button');
    const update = state.update || {};
    if (!button) return;
    const stage = update.stage || 'idle';
    const percent = clampUpdatePercent(update.percent);
    button.classList.toggle('update-active', stage === 'checking' || stage === 'downloading');
    button.classList.toggle('update-error', stage === 'error');
    button.disabled = update.enabled === false || stage === 'installing';
    if (stage === 'available') button.textContent = `下载 ${update.availableVersion || '新版本'}`;
    else if (stage === 'downloaded') button.textContent = '安装更新';
    else if (stage === 'checking') button.textContent = '检查中…';
    else if (stage === 'downloading') button.textContent = `下载 ${Math.round(percent)}%`;
    else if (stage === 'installing') button.textContent = '安装中…';
    else if (stage === 'error') button.textContent = '重试更新';
    else if (update.enabled === false) button.textContent = '开发版本';
    else button.textContent = '检查更新';
    button.setAttribute('aria-label', updateButtonAriaLabel(update, percent));
    renderUpdateDialog();
    syncUpdatePolling();
  }

  function updateButtonAriaLabel(update, percent) {
    if (update.stage === 'downloading') return `更新下载进度 ${Math.round(percent)}%`;
    if (update.stage === 'available') return `下载 CatsCo ${update.availableVersion || '新版本'}`;
    if (update.stage === 'downloaded') return '更新已下载，打开安装确认';
    if (update.stage === 'error') return '更新失败，打开详情并重试';
    return $('update-button')?.textContent || '检查更新';
  }

  function clampUpdatePercent(value) {
    const percent = Number(value || 0);
    if (!Number.isFinite(percent)) return 0;
    return Math.max(0, Math.min(100, percent));
  }

  function formatUpdateBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(digits)} ${units[unit]}`;
  }

  function formatUpdateRemaining(update) {
    const total = Number(update.total || 0);
    const transferred = Number(update.transferred || 0);
    const speed = Number(update.bytesPerSecond || 0);
    if (!(total > transferred) || !(speed > 0)) return '正在计算剩余时间';
    const seconds = Math.max(1, Math.ceil((total - transferred) / speed));
    if (seconds < 60) return `预计还需 ${seconds} 秒`;
    const minutes = Math.ceil(seconds / 60);
    return `预计还需 ${minutes} 分钟`;
  }

  function updateDialogMeta(update) {
    const version = update.availableVersion || '新版本';
    switch (update.stage) {
      case 'checking':
        return {
          title: '检查更新',
          subtitle: '正在连接更新服务，请稍候。',
          label: '正在检查可用版本',
          note: '通常只需要几秒钟。如果网络异常，会在这里显示明确的失败原因。',
          footer: `当前版本 ${update.currentVersion || state.app.version || '—'}`,
          secondary: '隐藏到后台',
          primary: '检查中…',
          primaryDisabled: true,
          tone: 'active',
        };
      case 'available':
        return {
          title: '发现 CatsCo 更新',
          subtitle: `${version} 已可以下载。`,
          label: `可以更新到 ${version}`,
          note: '下载期间可以继续使用 CatsCo，Connector 会保持连接。',
          footer: '下载完成后将提示你安装',
          secondary: '稍后',
          primary: '下载更新',
          primaryDisabled: false,
          tone: 'active',
        };
      case 'downloading':
        return {
          title: '正在更新 CatsCo',
          subtitle: '更新包正在后台下载，Connector 会保持连接。',
          label: '正在下载更新包',
          note: '下载期间可以继续使用 CatsCo。请不要退出应用；关闭此弹窗后，可在右下角继续查看进度。',
          footer: '校验完成后将提示你安装',
          secondary: '隐藏到后台',
          primary: '下载中…',
          primaryDisabled: true,
          tone: 'active',
        };
      case 'downloaded':
        return {
          title: '更新已准备好',
          subtitle: `${version} 已下载并通过完整性校验。`,
          label: '下载完成',
          note: '安装会关闭并重新启动 CatsCo，Connector 将在重启后自动恢复连接。',
          footer: '建议保存正在进行的工作',
          secondary: '稍后安装',
          primary: '安装并重启',
          primaryDisabled: false,
          tone: 'success',
        };
      case 'installing':
        return {
          title: '正在安装更新',
          subtitle: 'CatsCo 即将退出并重新启动。',
          label: '正在准备安装',
          note: '请稍候，不要手动结束 CatsCo 进程。',
          footer: 'Connector 会在重启后自动恢复',
          secondary: '隐藏到后台',
          primary: '安装中…',
          primaryDisabled: true,
          tone: 'active',
        };
      case 'error':
        return {
          title: '更新没有完成',
          subtitle: '当前版本没有受到影响，你可以直接重试。',
          label: '更新失败',
          note: '失败不会影响当前版本，Connector 会继续正常运行。',
          footer: `错误代码：${update.lastError?.reason || update.reason || 'UPDATE_ERROR'}`,
          secondary: '关闭',
          primary: '重新检查',
          primaryDisabled: false,
          tone: 'error',
        };
      case 'disabled':
        return {
          title: '当前环境不支持自动更新',
          subtitle: '开发环境或当前安装方式没有启用更新器。',
          label: '自动更新不可用',
          note: '打包安装版会在这里显示可用更新与下载进度。',
          footer: '无需进行任何操作',
          secondary: '关闭',
          primary: '不可用',
          primaryDisabled: true,
          tone: 'error',
        };
      default:
        return {
          title: 'CatsCo 已是最新版本',
          subtitle: '当前没有需要安装的更新。',
          label: '已经是最新版本',
          note: 'CatsCo 仍会在启动后自动检查更新。',
          footer: `当前版本 ${update.currentVersion || state.app.version || '—'}`,
          secondary: '关闭',
          primary: '再次检查',
          primaryDisabled: false,
          tone: 'success',
        };
    }
  }

  function renderUpdateDialog() {
    const dialog = $('update-dialog');
    if (!dialog) return;
    const update = state.update || {};
    const stage = update.stage || (update.enabled === false ? 'disabled' : 'idle');
    const normalized = { ...update, stage };
    const meta = updateDialogMeta(normalized);
    const percent = stage === 'downloaded' || stage === 'installing' ? 100 : clampUpdatePercent(update.percent);
    const progressVisible = ['checking', 'downloading', 'downloaded', 'installing'].includes(stage)
      || (stage === 'error' && Number(update.transferred || 0) > 0);
    const versionVisible = Boolean(update.availableVersion) || ['available', 'downloading', 'downloaded', 'installing'].includes(stage);

    setText('update-title', meta.title);
    setText('update-subtitle', meta.subtitle);
    setText('update-stage-label', meta.label);
    setText('update-current-version', update.currentVersion || state.app.version || '—');
    setText('update-available-version', update.availableVersion || '—');
    setText('update-note', meta.note);
    setText('update-footer-hint', meta.footer);
    $('update-version-flow').hidden = !versionVisible;
    $('update-progress-section').hidden = !progressVisible;

    const dot = $('update-stage-dot');
    const percentNode = $('update-stage-percent');
    const bar = $('update-progress-bar');
    dot.className = `update-stage-dot${meta.tone === 'success' ? ' success' : meta.tone === 'error' ? ' error' : ''}`;
    percentNode.className = `update-stage-percent${meta.tone === 'success' ? ' success' : meta.tone === 'error' ? ' error' : ''}`;
    percentNode.textContent = progressVisible && stage !== 'checking' ? `${Math.round(percent)}%` : '';
    bar.className = `update-progress-bar${meta.tone === 'success' ? ' success' : meta.tone === 'error' ? ' error' : ''}`;
    bar.style.width = `${percent}%`;
    const track = $('update-progress-track');
    track.classList.toggle('indeterminate', stage === 'checking');
    track.setAttribute('aria-valuenow', String(Math.round(percent)));

    if (stage === 'checking') {
      $('update-size').textContent = '正在获取版本信息';
      $('update-speed').textContent = '';
      $('update-remaining').textContent = '';
    } else {
      const transferred = Number(update.transferred || 0);
      const total = Number(update.total || 0);
      $('update-size').textContent = total > 0 ? `${formatUpdateBytes(transferred)} / ${formatUpdateBytes(total)}` : '等待下载信息';
      $('update-speed').textContent = Number(update.bytesPerSecond || 0) > 0 ? `${formatUpdateBytes(update.bytesPerSecond)}/s` : '';
      $('update-remaining').textContent = stage === 'downloading' ? formatUpdateRemaining(update) : stage === 'downloaded' ? '可以安装' : '';
    }

    const error = $('update-error-box');
    const errorMessage = update.lastError?.message || update.error || '';
    error.hidden = stage !== 'error';
    error.textContent = stage === 'error'
      ? [update.lastError?.reason || update.reason || 'UPDATE_ERROR', errorMessage].filter(Boolean).join('\n')
      : '';

    $('update-secondary-action').textContent = meta.secondary;
    $('update-primary-action').textContent = meta.primary;
    $('update-primary-action').disabled = meta.primaryDisabled || state.updateActionBusy;
  }

  function openUpdateDialog() {
    const dialog = $('update-dialog');
    renderUpdateDialog();
    if (!dialog.open) dialog.showModal();
  }

  function closeUpdateDialog() {
    const dialog = $('update-dialog');
    if (dialog.open) dialog.close();
  }

  function isUpdatePollingStage(stage) {
    return stage === 'checking' || stage === 'downloading' || stage === 'installing';
  }

  function syncUpdatePolling() {
    if (isUpdatePollingStage(state.update?.stage)) {
      if (!state.updatePollTimer) {
        state.updatePollTimer = setInterval(() => { void refreshUpdateStatus(); }, 1000);
      }
      return;
    }
    if (state.updatePollTimer) clearInterval(state.updatePollTimer);
    state.updatePollTimer = null;
  }

  async function refreshUpdateStatus() {
    if (state.updateStatusInFlight) return state.updateStatusInFlight;
    const previousStage = state.update?.stage;
    const run = (async () => {
      const result = await settled('/update/status');
      if (!result.ok) return;
      state.update = result.value || {};
      renderUpdate();
      if (!($('update-dialog')?.open) && previousStage === 'downloading' && ['downloaded', 'error'].includes(state.update.stage)) {
        openUpdateDialog();
      }
    })();
    state.updateStatusInFlight = run;
    try {
      await run;
    } finally {
      if (state.updateStatusInFlight === run) state.updateStatusInFlight = null;
    }
  }

  function syncPolling(view) {
    if (state.bootstrapPollTimer) clearInterval(state.bootstrapPollTimer);
    state.bootstrapPollTimer = null;
    if (view === 'connecting') {
      state.bootstrapPollTimer = setInterval(refreshBootstrap, 1200);
    }
    if (!state.fullPollTimer) {
      state.fullPollTimer = setInterval(() => refresh(), view === 'ready' ? 12000 : 6000);
    }
  }

  async function login(event) {
    event.preventDefault();
    if (state.loginBusy) return;
    const account = $('login-account').value.trim();
    const password = $('login-password').value;
    if (!account || !password) return;
    state.loginBusy = true;
    $('login-button').disabled = true;
    $('login-button').textContent = '正在登录…';
    setText('login-error', '');
    try {
      await request('/cats/auth/login', { method: 'POST', body: JSON.stringify({ account, password }) });
      $('login-password').value = '';
      await request('/cats/bootstrap', { method: 'POST', body: JSON.stringify({ trigger: 'login' }) });
      state.openWebAppAfterLogin = true;
      state.bootstrap = { stage: 'connecting', message: '登录成功，正在自动连接这台电脑' };
      await refresh({ force: true });
    } catch (error) {
      setText('login-error', humanError(error));
    } finally {
      state.loginBusy = false;
      $('login-button').disabled = false;
      $('login-button').textContent = '登录并连接';
    }
  }

  async function retry() {
    if (state.actionBusy) return;
    state.actionBusy = true;
    setBusyButtons(true);
    try {
      await request('/cats/bootstrap', { method: 'POST', body: JSON.stringify({ trigger: 'manual' }) });
      state.bootstrap = { stage: 'connecting', message: '正在重新连接这台电脑' };
      render();
      await refreshBootstrap();
      showToast('已开始重新连接');
    } catch (error) {
      showToast(`重新连接失败：${humanError(error)}`);
    } finally {
      state.actionBusy = false;
      setBusyButtons(false);
    }
  }

  async function openAgentSwitch() {
    if (!state.cats?.connected || state.agentSwitchBusy) return;
    const dialog = $('agent-switch-dialog');
    state.agentListLoading = true;
    state.agentSwitchError = '';
    state.agents = [];
    state.selectedAgentUid = state.cats.botUid || '';
    renderAgentSwitch();
    dialog.showModal();
    const [agents, binding] = await Promise.all([
      settled('/cats/bots'),
      settled('/weixin/channel-binding'),
    ]);
    state.agentListLoading = false;
    if (agents.ok) {
      state.agents = Array.isArray(agents.value?.bots) ? agents.value.bots : [];
      state.selectedAgentUid = agents.value?.currentBotUid || state.cats.botUid || '';
    } else {
      state.agentSwitchError = `无法读取 Agent：${humanError(agents.error)}`;
    }
    if (binding.ok) state.weixinBinding = binding.value || {};
    renderAgentSwitch();
  }

  function closeAgentSwitch() {
    if (state.agentSwitchBusy) return;
    const dialog = $('agent-switch-dialog');
    if (dialog.open) dialog.close();
    state.agentSwitchError = '';
  }

  function renderAgentSwitch() {
    const list = $('agent-list');
    const currentUid = String(state.cats?.botUid || '');
    if (state.agentListLoading) {
      list.innerHTML = '<div class="agent-list-state">正在读取 Agent……</div>';
    } else if (state.agents.length === 0 && !state.agentSwitchError) {
      list.innerHTML = '<div class="agent-list-state">当前账号下没有可切换的 Agent。</div>';
    } else {
      list.innerHTML = state.agents.map((agent) => {
        const uid = String(agent.uid || '');
        const selected = uid === state.selectedAgentUid;
        const current = uid === currentUid;
        const name = agent.display_name || agent.username || `Agent ${shortId(uid)}`;
        const meta = agent.username || shortId(uid);
        return `<label class="agent-option${selected ? ' selected' : ''}">
          <input type="radio" name="agent-switch" value="${escapeHtml(uid)}" ${selected ? 'checked' : ''} ${state.agentSwitchBusy ? 'disabled' : ''}>
          <span class="agent-option-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(meta)}</small></span>
          ${current ? '<span class="current-badge">当前</span>' : ''}
        </label>`;
      }).join('');
    }

    const selected = state.agents.find((agent) => String(agent.uid || '') === state.selectedAgentUid);
    const selectedName = selected?.display_name || selected?.username || '所选 Agent';
    const boundWeixinUid = String(state.weixinBinding?.binding?.agentUid || '');
    const needsWeixinRebind = Boolean(boundWeixinUid && state.selectedAgentUid && boundWeixinUid !== state.selectedAgentUid);
    const warning = $('agent-switch-warning');
    warning.hidden = !needsWeixinRebind;
    if (needsWeixinRebind) {
      warning.textContent = `微信当前绑定在其他 Agent。切换到“${selectedName}”后，微信服务会停止；如需使用微信，请为新 Agent 重新扫码。`;
    }

    const error = $('agent-switch-error');
    error.hidden = !state.agentSwitchError;
    error.textContent = state.agentSwitchError;
    const confirm = $('agent-switch-confirm');
    confirm.disabled = state.agentListLoading || state.agentSwitchBusy || !selected || state.selectedAgentUid === currentUid;
    confirm.textContent = state.agentSwitchBusy ? '正在切换…' : '切换并重新连接';
    $('agent-switch-close').disabled = state.agentSwitchBusy;
    $('agent-switch-cancel').disabled = state.agentSwitchBusy;
  }

  async function switchAgent() {
    const targetUid = String(state.selectedAgentUid || '');
    if (!targetUid || targetUid === String(state.cats?.botUid || '') || state.agentSwitchBusy) return;
    const target = state.agents.find((agent) => String(agent.uid || '') === targetUid);
    state.agentSwitchBusy = true;
    state.agentSwitchError = '';
    renderAgentSwitch();
    render();
    try {
      const result = await request('/cats/switch-bot', {
        method: 'POST',
        body: JSON.stringify({ botUid: targetUid }),
      });
      state.bootstrap = { stage: 'connecting', message: `正在连接 Agent“${target?.display_name || target?.username || shortId(targetUid)}”` };
      if ($('agent-switch-dialog').open) $('agent-switch-dialog').close();
      render();
      await new Promise((resolve) => setTimeout(resolve, 700));
      await refresh({ force: true });
      showToast(result.weixinStopped ? 'Agent 已切换；微信服务已停止，请重新扫码后启动' : 'Agent 已切换并重新连接');
    } catch (error) {
      state.agentSwitchError = `切换失败：${humanError(error)}`;
      renderAgentSwitch();
    } finally {
      state.agentSwitchBusy = false;
      renderAgentSwitch();
      render();
    }
  }

  const channelDefinitions = {
    feishu: {
      label: '飞书',
      copy: '使用飞书 App 接入当前 CatsCo Agent。',
      fields: [
        ['FEISHU_APP_ID', 'App ID', false],
        ['FEISHU_APP_SECRET', 'App Secret', true],
        ['FEISHU_BOT_OPEN_ID', 'Bot Open ID', false],
        ['FEISHU_BOT_ALIASES', '唤醒别名', false],
      ],
    },
    weixin: {
      label: '微信',
      copy: '扫码授权后，将微信消息转交给当前 CatsCo Agent。',
      fields: [['WEIXIN_TOKEN', 'Token', true]],
    },
  };

  async function openManagement(tab = 'services') {
    state.managementOpen = true;
    $('connection-view').hidden = true;
    $('management-open').hidden = true;
    $('management-view').hidden = false;
    $('management-view').closest('.primary-panel')?.classList.add('management-open');
    switchManagementTab(tab);
    await refreshManagementData();
  }

  function closeManagement() {
    state.managementOpen = false;
    $('management-view').hidden = true;
    $('connection-view').hidden = false;
    $('management-open').hidden = false;
    $('management-view').closest('.primary-panel')?.classList.remove('management-open');
    stopLogPolling();
    stopWeixinPolling();
  }

  function switchManagementTab(tab) {
    if (!['services', 'logs', 'recovery'].includes(tab)) return;
    state.managementTab = tab;
    document.querySelectorAll('[data-management-tab]').forEach((button) => {
      const active = button.dataset.managementTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-management-page]').forEach((page) => {
      const active = page.dataset.managementPage === tab;
      page.hidden = !active;
      page.classList.toggle('active', active);
    });
    if (tab === 'logs') {
      void loadLogs();
      startLogPolling();
    } else {
      stopLogPolling();
    }
  }

  async function refreshManagementData() {
    const [config, binding, services] = await Promise.all([
      settled('/config'),
      settled('/weixin/channel-binding'),
      settled('/services'),
    ]);
    if (config.ok) state.config = config.value || {};
    if (binding.ok) state.weixinBinding = binding.value || {};
    if (services.ok) state.services = Array.isArray(services.value) ? services.value : [];
    renderChannels({ force: true });
  }

  function renderChannels(options = {}) {
    const root = $('channel-list');
    if (!root) return;
    const editing = document.activeElement?.closest?.('.channel-config') || root.querySelector('.channel-config.dirty');
    if (editing && !options.force) return;
    const services = ['feishu', 'weixin'].map((name) => {
      return state.services.find((service) => service.name === name) || { name, label: channelDefinitions[name].label, status: 'stopped' };
    });
    root.innerHTML = services.map(renderChannelCard).join('');
  }

  function renderChannelCard(service) {
    const definition = channelDefinitions[service.name];
    const running = service.status === 'running';
    const busy = state.serviceActionBusy.has(service.name);
    const statusText = running ? '运行中' : service.status === 'error' ? '异常' : '未运行';
    const binding = service.name === 'weixin' && state.weixinBinding?.configured
      ? `已绑定 ${state.weixinBinding.agentName || state.weixinBinding.agentUid || '当前 Agent'}`
      : definition.copy;
    const primaryAction = running ? 'stop' : 'start';
    const primaryLabel = running ? '停止' : '启动';
    return `<article class="channel-card ${escapeHtml(service.status || 'stopped')}" data-channel="${service.name}">
      <div class="channel-main">
        <div class="channel-identity">
          <span class="channel-dot"></span>
          <div><strong class="channel-name">${escapeHtml(definition.label)}</strong><small class="channel-meta">${escapeHtml(statusText)} · ${escapeHtml(binding)}</small></div>
        </div>
        <div class="channel-actions">
          <button class="button button-small ${running ? 'button-quiet' : 'button-primary'}" type="button" data-service-action="${primaryAction}" data-service-name="${service.name}" ${busy ? 'disabled' : ''}>${busy ? '处理中…' : primaryLabel}</button>
          ${running ? `<button class="button button-small button-quiet" type="button" data-service-action="restart" data-service-name="${service.name}" ${busy ? 'disabled' : ''}>重启</button>` : ''}
          <button class="button button-small button-quiet" type="button" data-service-log="${service.name}">日志</button>
        </div>
      </div>
      ${service.lastError ? `<p class="channel-error">${escapeHtml(service.lastError)}</p>` : ''}
      ${renderChannelConfig(service.name)}
    </article>`;
  }

  function renderChannelConfig(name) {
    const definition = channelDefinitions[name];
    const fields = definition.fields.map(([key, label, sensitive]) => {
      const value = state.config?.[key] || '';
      return `<label><span>${escapeHtml(label)}</span><input data-config-key="${key}" type="${sensitive ? 'password' : 'text'}" value="${escapeHtml(value)}" autocomplete="off"></label>`;
    }).join('');
    return `<details class="channel-config">
      <summary>连接配置</summary>
      <div class="channel-config-body">
        ${fields}
        ${name === 'weixin' ? '<div class="weixin-authorize" id="weixin-authorize" hidden></div>' : ''}
        <div class="channel-config-actions">
          <span class="channel-config-note">凭证仅保存在本机</span>
          <div class="channel-actions">
            ${name === 'weixin' ? '<button class="button button-small button-secondary" type="button" data-weixin-authorize>微信扫码授权</button>' : ''}
            <button class="button button-small button-secondary" type="button" data-config-save="${name}">保存配置</button>
          </div>
        </div>
      </div>
    </details>`;
  }

  async function serviceAction(name, action) {
    if (!channelDefinitions[name] || state.serviceActionBusy.has(name)) return;
    state.serviceActionBusy.add(name);
    renderChannels({ force: true });
    try {
      await request(`/services/${encodeURIComponent(name)}/${action}`, { method: 'POST', body: '{}' });
      showToast(`${channelDefinitions[name].label}服务已${action === 'stop' ? '停止' : action === 'restart' ? '重启' : '启动'}`);
    } catch (error) {
      const failedChecks = error?.data?.preflight?.checks?.filter((check) => check.status === 'fail') || [];
      const detail = failedChecks.map((check) => check.message).slice(0, 2).join('；');
      showToast(`${channelDefinitions[name].label}操作失败：${detail || humanError(error)}`);
    } finally {
      state.serviceActionBusy.delete(name);
      await refreshManagementData();
    }
  }

  async function saveChannelConfig(name, button) {
    const card = document.querySelector(`[data-channel="${name}"]`);
    if (!card) return;
    const updates = {};
    card.querySelectorAll('[data-config-key]').forEach((input) => { updates[input.dataset.configKey] = input.value.trim(); });
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      await request('/config', { method: 'PUT', body: JSON.stringify(updates) });
      showToast(`${channelDefinitions[name].label}配置已保存到本机`);
      await refreshManagementData();
    } catch (error) {
      showToast(`保存失败：${humanError(error)}`);
    } finally {
      button.disabled = false;
      button.textContent = '保存配置';
    }
  }

  async function beginWeixinAuthorization() {
    stopWeixinPolling();
    const panel = $('weixin-authorize');
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = '<span>正在获取微信二维码……</span>';
    try {
      const data = await request('/weixin/qrcode');
      const imageUrl = String(data.qrcode_img_content || '');
      panel.innerHTML = `${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="微信授权二维码">` : ''}<div><strong>请使用微信扫码授权</strong><small>授权将绑定到 ${escapeHtml(data.agent?.name || data.agent?.username || data.agent_uid || '当前 Agent')}</small></div>`;
      state.weixinPollTimer = setInterval(() => pollWeixinAuthorization(data.qrcode, data.agent_uid), 2000);
    } catch (error) {
      panel.innerHTML = `<span class="channel-error">获取二维码失败：${escapeHtml(humanError(error))}</span>`;
    }
  }

  async function pollWeixinAuthorization(qrcode, agentUid) {
    try {
      const data = await request(`/weixin/qrcode-status?qrcode=${encodeURIComponent(qrcode)}&agent_uid=${encodeURIComponent(agentUid || '')}`);
      if (data.status === 'confirmed' && data.token_saved) {
        stopWeixinPolling();
        showToast('微信授权成功');
        await refreshManagementData();
      } else if (data.status === 'expired') {
        stopWeixinPolling();
        const panel = $('weixin-authorize');
        if (panel) panel.innerHTML = '<span class="channel-error">二维码已过期，请重新获取。</span>';
      }
    } catch (error) {
      stopWeixinPolling();
      const panel = $('weixin-authorize');
      if (panel) panel.innerHTML = `<span class="channel-error">微信授权失败：${escapeHtml(humanError(error))}</span>`;
    }
  }

  function stopWeixinPolling() {
    if (state.weixinPollTimer) clearInterval(state.weixinPollTimer);
    state.weixinPollTimer = null;
  }

  async function loadLogs() {
    const output = $('service-logs');
    if (!output) return;
    const service = $('log-service-select')?.value || 'catscompany';
    output.textContent = '正在读取日志…';
    try {
      const logs = await request(`/services/${encodeURIComponent(service)}/logs?lines=300`);
      const text = Array.isArray(logs) && logs.length ? logs.map(sanitizeLogLine).join('\n') : '暂时没有运行日志。';
      output.textContent = text;
      if ($('log-auto-scroll')?.checked) output.scrollTop = output.scrollHeight;
    } catch (error) {
      output.textContent = `日志读取失败：${humanError(error)}`;
    }
  }

  function sanitizeLogLine(line) {
    return String(line == null ? '' : line)
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '');
  }

  function startLogPolling() {
    stopLogPolling();
    state.logPollTimer = setInterval(loadLogs, 3000);
  }

  function stopLogPolling() {
    if (state.logPollTimer) clearInterval(state.logPollTimer);
    state.logPollTimer = null;
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText($('service-logs')?.textContent || '');
      showToast('日志已复制');
    } catch (_error) {
      showToast('复制失败，请在日志框中手动选择复制');
    }
  }

  function openLogoutDialog() {
    if (state.logoutBusy) return;
    $('logout-dialog').showModal();
  }

  async function logout() {
    if (state.logoutBusy) return;
    state.logoutBusy = true;
    $('logout-confirm').disabled = true;
    $('logout-confirm').textContent = '正在退出…';
    try {
      await request('/cats/auth/logout', { method: 'POST', body: '{}' });
      $('logout-dialog').close();
      closeManagement();
      state.cats = {};
      state.bootstrap = { stage: 'waiting_for_login' };
      await refresh({ force: true });
      window.requestAnimationFrame(() => {
        $('login-account')?.focus({ preventScroll: true });
      });
    } catch (error) {
      showToast(`退出失败：${humanError(error)}`);
    } finally {
      state.logoutBusy = false;
      $('logout-confirm').disabled = false;
      $('logout-confirm').textContent = '退出账号';
    }
  }

  function setUpdateActionError(error, fallbackReason) {
    state.update = {
      ...(state.update || {}),
      stage: 'error',
      message: humanError(error),
      lastError: {
        reason: error?.data?.reason || fallbackReason,
        message: humanError(error),
      },
    };
    renderUpdate();
    openUpdateDialog();
  }

  async function startUpdateCheck() {
    if (state.updateActionBusy) return;
    state.updateActionBusy = true;
    state.update = {
      ...(state.update || {}),
      stage: 'checking',
      message: 'Checking for updates...',
      lastError: null,
    };
    renderUpdate();
    openUpdateDialog();
    try {
      state.update = await request('/update/check', { method: 'POST', body: '{}' });
      renderUpdate();
    } catch (error) {
      setUpdateActionError(error, 'UPDATE_CHECK_FAILED');
    } finally {
      state.updateActionBusy = false;
      renderUpdate();
    }
  }

  async function startUpdateDownload() {
    if (state.updateActionBusy) return;
    state.updateActionBusy = true;
    state.update = {
      ...(state.update || {}),
      stage: 'downloading',
      message: 'Starting update download...',
      percent: Number(state.update?.percent || 0),
      bytesPerSecond: 0,
      transferred: Number(state.update?.transferred || 0),
      total: Number(state.update?.total || 0),
      lastError: null,
    };
    renderUpdate();
    openUpdateDialog();
    try {
      state.update = await request('/update/download', { method: 'POST', body: '{}' });
      renderUpdate();
      openUpdateDialog();
    } catch (error) {
      setUpdateActionError(error, 'UPDATE_DOWNLOAD_FAILED');
    } finally {
      state.updateActionBusy = false;
      renderUpdate();
    }
  }

  async function installUpdate() {
    if (state.updateActionBusy || state.update?.stage !== 'downloaded') return;
    state.updateActionBusy = true;
    state.update = { ...(state.update || {}), stage: 'installing', message: 'Quitting and installing update...' };
    renderUpdate();
    try {
      await request('/update/install', { method: 'POST', body: '{}' });
    } catch (error) {
      setUpdateActionError(error, 'UPDATE_INSTALL_FAILED');
      state.updateActionBusy = false;
      renderUpdate();
    }
  }

  function handleUpdateButton() {
    const stage = state.update?.stage || 'idle';
    openUpdateDialog();
    if (stage === 'available') void startUpdateDownload();
    else if (stage === 'idle' || stage === 'error') void startUpdateCheck();
  }

  function handleUpdatePrimaryAction() {
    const stage = state.update?.stage || 'idle';
    if (stage === 'available') void startUpdateDownload();
    else if (stage === 'downloaded') void installUpdate();
    else if (stage === 'idle' || stage === 'error') void startUpdateCheck();
  }

  function setBusyButtons(busy) {
    ['retry-button', 'diagnostic-retry'].forEach((id) => { if ($(id)) $(id).disabled = busy; });
  }

  function humanError(error) {
    const message = String(error?.message || error || '未知错误');
    if (/password mismatch/i.test(message)) return '账号或密码错误，请重试。';
    if (/user not found/i.test(message)) return '没有找到这个 CatsCo 账号。';
    if (/not your bot/i.test(message)) return '当前账号无权使用原 Agent（not your bot），请切换到当前账号拥有的 Agent。';
    if (/failed to fetch|network/i.test(message)) return '暂时无法连接 CatsCo，请检查网络。';
    return message;
  }

  function shortId(value) {
    const text = String(value || '');
    return text.length > 18 ? `${text.slice(0, 9)}…${text.slice(-5)}` : text;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  let toastTimer;
  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
  }

  $('login-form').addEventListener('submit', login);
  $('webapp-button').addEventListener('click', (event) => {
    event.preventDefault();
    void openWebAppFromDashboard();
  });
  $('refresh-button').addEventListener('click', () => refresh({ force: true }));
  $('retry-button').addEventListener('click', retry);
  $('diagnostic-retry').addEventListener('click', retry);
  $('logout-button').addEventListener('click', openLogoutDialog);
  $('logout-confirm').addEventListener('click', () => { void logout(); });
  $('logout-dialog').addEventListener('cancel', (event) => {
    if (state.logoutBusy) event.preventDefault();
  });
  $('update-button').addEventListener('click', handleUpdateButton);
  $('update-close').addEventListener('click', closeUpdateDialog);
  $('update-secondary-action').addEventListener('click', closeUpdateDialog);
  $('update-primary-action').addEventListener('click', handleUpdatePrimaryAction);
  $('update-dialog').addEventListener('cancel', (event) => {
    if (state.update?.stage === 'installing') event.preventDefault();
  });
  $('management-open').addEventListener('click', () => { void openManagement(); });
  $('agent-switch-open').addEventListener('click', () => { void openAgentSwitch(); });
  $('agent-switch-close').addEventListener('click', (event) => {
    event.preventDefault();
    closeAgentSwitch();
  });
  $('agent-switch-confirm').addEventListener('click', () => { void switchAgent(); });
  $('agent-list').addEventListener('change', (event) => {
    if (event.target?.name !== 'agent-switch') return;
    state.selectedAgentUid = event.target.value;
    state.agentSwitchError = '';
    renderAgentSwitch();
  });
  $('agent-switch-dialog').addEventListener('cancel', (event) => {
    if (state.agentSwitchBusy) event.preventDefault();
  });
  $('management-back').addEventListener('click', closeManagement);
  $('services-refresh').addEventListener('click', refreshManagementData);
  $('logs-refresh').addEventListener('click', loadLogs);
  $('logs-copy').addEventListener('click', copyLogs);
  $('log-service-select').addEventListener('change', loadLogs);
  document.querySelectorAll('[data-management-tab]').forEach((button) => {
    button.addEventListener('click', () => switchManagementTab(button.dataset.managementTab));
  });
  $('channel-list').addEventListener('click', (event) => {
    const actionButton = event.target.closest('[data-service-action]');
    if (actionButton) {
      void serviceAction(actionButton.dataset.serviceName, actionButton.dataset.serviceAction);
      return;
    }
    const logButton = event.target.closest('[data-service-log]');
    if (logButton) {
      $('log-service-select').value = logButton.dataset.serviceLog;
      switchManagementTab('logs');
      return;
    }
    const saveButton = event.target.closest('[data-config-save]');
    if (saveButton) {
      void saveChannelConfig(saveButton.dataset.configSave, saveButton);
      return;
    }
    if (event.target.closest('[data-weixin-authorize]')) void beginWeixinAuthorization();
  });
  $('channel-list').addEventListener('input', (event) => {
    event.target.closest('.channel-config')?.classList.add('dirty');
  });

  void refresh({ force: true });
})();
