async function svcAction(n,a) {
  pulsePetState('thinking', '处理中...', 1200);
  try{
    const resp = await fetch(API+'/api/services/'+n+'/'+a,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
    const payload = await resp.json().catch(()=>({}));
    if(!resp.ok) {
      if (payload.preflight) {
        fetchReadiness();
      }
      throw new Error(formatServiceError(payload, resp.status));
    }
    pulsePetState('success', '服务已更新', 1800);
    setTimeout(fetchStatus,500);
  }catch(e){
    pulsePetState('error', '操作失败', 2600);
    alert('操作失败: '+e.message);
  }
}

function formatServiceError(payload, status) {
  if (payload && payload.preflight) {
    const blocked = (payload.preflight.checks || []).filter(check => check.status === 'fail');
    const details = blocked.map(check => check.message).slice(0, 3).join('；');
    return details ? '启动前检查未通过：' + details : '启动前检查未通过';
  }
  return (payload && payload.error) ? payload.error : 'HTTP ' + status;
}

async function showLogs(n,l) {
  const logsTitle=l+' - 日志';
  window.__catscoRenderLogsTitle?.(logsTitle);
  window.__catscoRenderLogsBody?.({kind:'text',text:'加载中...',tone:'muted'});
  window.__catscoSetGlobalModalOpen?.('logs', true);
  pulsePetState('thinking', '正在加载日志...', 1200);
  try{
    const r=await fetch(API+'/api/services/'+n+'/logs?lines=200');
    const logs=await r.json();
    const text=logs.length?logs.join('\n'):'暂无日志';
    window.__catscoRenderLogsBody?.({kind:'text',text});
    pulsePetState('success','日志已更新',1400);
  }catch(e){
    window.__catscoRenderLogsBody?.({kind:'text',text:'加载失败',tone:'error'});
    pulsePetState('error','日志加载失败',2400);
  }
}
function closeLogs(){window.__catscoSetGlobalModalOpen?.('logs', false);}
const updateUi = {
  modalOpen: false,
  pollingTimer: null,
  lastStage: null,
};

function normalizeClientUrl(value){
  if (!value) return "";
  return String(value).trim().replace(/\/+$/, "");
}

function resolveManualInstallerUrl(state){
  const baseUrl = normalizeClientUrl(state?.updateBaseUrl);
  const version = state?.availableVersion;
  const platform = appStatusSnapshot.platform || "";

  if (!baseUrl || !version || !platform) return "";

  if (platform === "win32") return `${baseUrl}/CatsCo-${version}-win.exe`;
  if (platform === "darwin") {
    const arch = appStatusSnapshot.arch || "";
    return arch ? `${baseUrl}/CatsCo-${version}-mac-${arch}.dmg` : "";
  }
  if (platform === "linux") return `${baseUrl}/CatsCo-${version}-linux.AppImage`;
  return "";
}

async function copyTextValue(value, label){
  if (!value) {
    alert(label + " \u6682\u4E0D\u53EF\u7528");
    return;
  }

  try {
    if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持剪贴板写入");
    await navigator.clipboard.writeText(value);

    alert(label + " \u5DF2\u590D\u5236");
  } catch (e) {
    alert("\u590D\u5236\u5931\u8D25: " + (e.message || String(e)));
  }
}

function copyManualInstallerUrl(url = ""){
  return copyTextValue(url, "\u5B89\u88C5\u5305\u5730\u5740");
}

function copyReleasePageUrl(url = ""){
  return copyTextValue(url, "GitHub \u53D1\u5E03\u9875\u5730\u5740");
}
function formatBytes(value){
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const fixed = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return size.toFixed(fixed) + ' ' + units[unit];
}

function formatSpeed(value){
  return formatBytes(value) + '/s';
}

function stageMeta(stage){
  const map = {
    disabled: { label: '不可用', color: '#8a8f9f', bg: 'rgba(138,143,159,0.18)' },
    idle: { label: '待机', color: '#1ea971', bg: 'rgba(30,169,113,0.15)' },
    checking: { label: '检查中', color: '#f7b955', bg: 'rgba(247,185,85,0.18)' },
    available: { label: '可更新', color: '#4f8cff', bg: 'rgba(79,140,255,0.18)' },
    downloading: { label: '下载中', color: '#4f8cff', bg: 'rgba(79,140,255,0.18)' },
    downloaded: { label: '已下载', color: '#1ea971', bg: 'rgba(30,169,113,0.15)' },
    installing: { label: '安装中', color: '#f7b955', bg: 'rgba(247,185,85,0.18)' },
    error: { label: '失败', color: '#dc5d73', bg: 'rgba(220,93,115,0.16)' },
  };
  return map[stage] || { label: stage || '未知', color: '#8a8f9f', bg: 'rgba(138,143,159,0.18)' };
}

function localizeUpdateMessage(state){
  const stage = state?.stage || 'unknown';
  const version = state?.availableVersion || '';
  if (stage === 'disabled') return '当前环境不支持自动更新。';
  if (stage === 'checking') return '正在检查更新...';
  if (stage === 'available') return version ? ('发现新版本 ' + version + '，可立即下载。') : '发现新版本，可立即下载。';
  if (stage === 'downloading') return '正在下载更新包，请稍候...';
  if (stage === 'downloaded') return version ? ('更新 ' + version + ' 已下载完成，点击“安装并重启”。') : '更新已下载完成，点击“安装并重启”。';
  if (stage === 'installing') return '正在安装更新并准备重启...';
  if (stage === 'idle') return '当前已是最新版本。';
  if (stage === 'error') {
    const reason = state?.lastError?.reason || 'UPDATE_ERROR';
    return '更新失败：' + reason;
  }
  return state?.message || '-';
}

function updateFallbackNote(manualUrl, releaseUrl) {
  if (manualUrl && releaseUrl) {
    return '\u81EA\u52A8\u66F4\u65B0\u5931\u8D25\u65F6\uFF0C\u53EF\u5148\u590D\u5236\u5F53\u524D\u5E73\u53F0\u5B89\u88C5\u5305\u5730\u5740\uFF1B\u5982\u679C\u4ECD\u4E0D\u65B9\u4FBF\uFF0C\u518D\u8D70 GitHub \u53D1\u5E03\u9875\u3002';
  }
  if (manualUrl) {
    return '\u81EA\u52A8\u66F4\u65B0\u5931\u8D25\u65F6\uFF0C\u53EF\u5148\u590D\u5236\u5F53\u524D\u5E73\u53F0\u5B89\u88C5\u5305\u5730\u5740\u624B\u52A8\u66F4\u65B0\u3002';
  }
  if (releaseUrl) {
    return '\u81EA\u52A8\u66F4\u65B0\u5931\u8D25\u65F6\uFF0C\u53EF\u5148\u590D\u5236 GitHub \u53D1\u5E03\u9875\u5730\u5740\u624B\u52A8\u66F4\u65B0\u3002';
  }
  return '';
}

async function fetchUpdateStatus(autoOpen = false){
  try{
    const r = await fetch(API + '/api/update/status');
    const data = await r.json();
    renderUpdateStatus(data, autoOpen);
  } catch (e) {
    renderUpdateStatus({
      enabled: false,
      stage: 'error',
      message: '获取更新状态失败',
      lastError: { reason: 'STATUS_REQUEST_FAILED', message: e.message || String(e) },
    }, autoOpen);
  }
}

function finishUpdateStatusRender(stage, autoOpen, state) {
  if (autoOpen && !updateUi.modalOpen && stage !== updateUi.lastStage) {
    const shouldAutoOpenError = stage === 'error' && state?.enabled !== false;
    if (stage === 'available' || stage === 'downloading' || stage === 'downloaded' || shouldAutoOpenError) {
      showUpdateModal(false);
    }
  }
  updateUi.lastStage = stage;
}

function renderUpdateStatus(state, autoOpen){
  const stage = state?.stage || 'unknown';
  const meta = stageMeta(stage);
  const percent = Math.max(0, Math.min(100, Number(state?.percent || 0)));
  const releaseUrl = normalizeClientUrl(state?.releasePageUrl);
  const manualUrl = resolveManualInstallerUrl(state);
  const showFallback = stage === 'error' && Boolean(releaseUrl || manualUrl);
  const errorText = state?.lastError?.message
    ? '\u5931\u8D25\u539F\u56E0: ' + (state?.lastError?.reason || 'UPDATE_ERROR') + '\n' + state.lastError.message
    : '';

  window.__catscoRenderUpdateStatus?.({
    availableVersion: state?.availableVersion || '-',
    canCheck: Boolean(state?.enabled) && stage !== 'checking' && stage !== 'downloading' && stage !== 'installing',
    canDownload: Boolean(state?.enabled) && stage !== 'downloading' && stage !== 'installing',
    canInstall: Boolean(state?.enabled) && stage !== 'installing',
    checkLabel: stage === 'checking' ? '检查中...' : '检查更新',
    currentVersion: state?.currentVersion || '-',
    downloadLabel: stage === 'downloading' ? '下载中...' : '下载更新',
    errorText,
    fallbackNote: showFallback ? updateFallbackNote(manualUrl, releaseUrl) : '',
    installLabel: stage === 'installing' ? '安装中...' : '安装并重启',
    manualUrl,
    message: localizeUpdateMessage(state),
    percentLabel: percent.toFixed(1) + '%',
    progressPercent: percent,
    releaseUrl,
    showDownload: stage === 'available' || stage === 'downloading',
    showFallback,
    showInstall: stage === 'downloaded' || stage === 'installing',
    sizeLabel: formatBytes(state?.transferred || 0) + ' / ' + formatBytes(state?.total || 0),
    speedLabel: formatSpeed(state?.bytesPerSecond || 0),
    stageBg: meta.bg,
    stageColor: meta.color,
    stageLabel: meta.label,
  });
  finishUpdateStatusRender(stage, autoOpen, state);
}

function showUpdateModal(triggerCheck){
  updateUi.modalOpen = true;
  window.__catscoSetGlobalModalOpen?.('update', true);
  fetchUpdateStatus(false);
  if (updateUi.pollingTimer) clearInterval(updateUi.pollingTimer);
  updateUi.pollingTimer = setInterval(() => fetchUpdateStatus(false), 1000);
  if (triggerCheck) checkForUpdates();
}

function closeUpdateModal(){
  window.__catscoSetGlobalModalOpen?.('update', false);
  updateUi.modalOpen = false;
  if (updateUi.pollingTimer) {
    clearInterval(updateUi.pollingTimer);
    updateUi.pollingTimer = null;
  }
}

async function parseUpdateResponse(resp){
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const reason = data?.reason || 'UPDATE_REQUEST_FAILED';
    const message = data?.error || ('HTTP ' + resp.status);
    throw new Error(reason + ': ' + message);
  }
  return data;
}

async function checkForUpdates(){
  pulsePetState('thinking', '检查更新...', 1400);
  try {
    await parseUpdateResponse(await fetch(API + '/api/update/check', { method: 'POST' }));
    pulsePetState('success', '检查完成', 1800);
  } catch (e) {
    pulsePetState('error', '更新检查失败', 2600);
    alert('检查更新失败: ' + (e.message || String(e)));
  } finally {
    fetchUpdateStatus(false);
  }
}

async function downloadUpdate(){
  pulsePetState('typing', '下载更新...', 1400);
  try {
    await parseUpdateResponse(await fetch(API + '/api/update/download', { method: 'POST' }));
    pulsePetState('success', '下载完成', 1800);
  } catch (e) {
    pulsePetState('error', '下载失败', 2600);
    alert('下载更新失败: ' + (e.message || String(e)));
  } finally {
    fetchUpdateStatus(false);
  }
}

async function installUpdate(){
  if (!confirm('是否立即安装已下载更新并重启？')) return;
  pulsePetState('thinking', '准备安装...', 1600);
  try {
    await parseUpdateResponse(await fetch(API + '/api/update/install', { method: 'POST' }));
  } catch (e) {
    pulsePetState('error', '安装失败', 2600);
    alert('安装更新失败: ' + (e.message || String(e)));
  }
}
async function toggleSkill(n,c){
  const r=await fetch(API+'/api/skills/'+encodeURIComponent(n)+'/'+(c?'disable':'enable'),{method:'POST'});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){alert('操作失败: '+(d.error||('HTTP '+r.status)));return;}
  fetchSkills();
}
async function deleteSkill(n){
  if(!confirm('确定要卸载 skill "'+n+'" 吗？此操作不可恢复。'))return;
  const r=await fetch(API+'/api/skills/'+encodeURIComponent(n),{method:'DELETE'});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){alert('卸载失败: '+(d.error||('HTTP '+r.status)));return;}
  fetchSkills();
}
function formatUptime(s){if(s<60)return Math.floor(s)+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
