let dashboardActivePage = 'chat';

function isDashboardPageActive(name) {
  return dashboardActivePage === name;
}

function getDashboardActivePage() {
  return dashboardActivePage;
}

function switchPage(name) {
  dashboardActivePage = name || 'chat';
  window.__catscoApplyActivePage?.(dashboardActivePage);
  if (dashboardActivePage === 'chat') {
    fetchCatsStatus();
    if (!catsPollTimer) catsPollTimer = setInterval(fetchCatsStatus, 5000);
  } else if (dashboardActivePage === 'companion') {
    setPetState(petState);
  } else if (dashboardActivePage === 'store') {
    refreshSkillHubPage();
    fetchSkillHubDeveloper();
  } else if (dashboardActivePage === 'prompts') {
    window.refreshPromptWorkbench?.();
  } else if (dashboardActivePage === 'services') {
    fetchStatus();
    refreshSettingsPage();
  }
}

window.switchPage = switchPage;
const serviceConfigDirtyNames = new Set();

async function fetchStatus() {
  try {
    const res = await fetch(API+'/api/status');
    const data = await res.json();
    appStatusSnapshot = data || {};
    window.__catscoRenderShell?.({version:data.version || '-'});
    if(!shouldDeferServiceRender())renderServices(data.services || []);
    await fetchReadiness();
    applyPetBaseline();
  } catch (e) {
    setPetAutoBaseline('error');
  }
}

async function fetchReadiness() {
  try {
    const res = await fetch(API+'/api/readiness');
    if (!res.ok) throw new Error('HTTP '+res.status);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('Readiness API 尚未加载，请重启 Dashboard。');
    }
    const data = await res.json();
    appReadinessSnapshot = data || {};
    appReadinessLoaded = true;
    appReadinessError = '';
    if (isDashboardPageActive('chat')) renderCatsStatus();
  } catch (e) {
    appReadinessSnapshot = {};
    appReadinessLoaded = false;
    appReadinessError = e && e.message ? e.message : 'Readiness API 暂不可用';
    if (isDashboardPageActive('chat')) renderCatsStatus();
  }
}

async function fetchSkills() {
  try {
    const res = await fetch(API+'/api/skills-all');
    const skills = await res.json();
    localSkillsCache = Array.isArray(skills) ? skills : [];
    renderLocalSkillStore(localSkillsCache);
  } catch (e) {
    window.__catscoRenderLocalSkillStore?.({
      skills: [],
      targetId: 'store-grid',
      actions: true,
      message: 'Unable to load local skills: ' + (e.message || String(e)),
      tone: 'danger',
    });
  }
}

function runReadinessAction(target) {
  if (target === 'settings') return switchPage('services');
  if (target === 'catsco') return switchPage('chat');
  if (target === 'skills') return switchPage('store');
  if (target === 'prompts') return switchPage('prompts');
  if (target === 'service') return svcAction('catscompany','start');
  fetchStatus();
  fetchReadiness();
}

function readinessStatusClass(status) {
  if (status === 'ready') return 'running';
  if (status === 'warning') return 'stopped';
  return 'error';
}

function renderServices(svcs) {
  window.__catscoRenderServices?.({ services: svcs, configData, serviceConfigGroups });
}

function shouldDeferServiceRender(){
  return Boolean(window.__catscoServiceConfigHasFocus?.()) || serviceConfigDirtyNames.size>0;
}

function serviceConfigValue(key){
  if(configData && Object.prototype.hasOwnProperty.call(configData,key))return configData[key];
  const aliases={
    CATSCO_API_KEY:'CATSCOMPANY_API_KEY',
    CATSCO_HTTP_BASE_URL:'CATSCOMPANY_HTTP_BASE_URL',
    CATSCO_SERVER_URL:'CATSCOMPANY_SERVER_URL',
  };
  const alias=aliases[key];
  return alias && configData && Object.prototype.hasOwnProperty.call(configData,alias) ? configData[alias] : '';
}

function markServiceConfigDirty(name){
  if(!name)return;
  serviceConfigDirtyNames.add(name);
  window.__catscoSetServiceConfigUi?.({name,dirty:true,saved:false});
}

async function saveServiceConfig(name){
  const group=serviceConfigGroups[name];
  if(!group)return;
  if(!confirm('保存 '+group.title+'？凭证仅保存到本地 .env。'))return;
  const draft=window.__catscoGetServiceConfigDraft?.(name)||{};
  const updates={};
  group.keys.forEach(item=>{updates[item.key]=String(draft[item.key] ?? serviceConfigValue(item.key) ?? '');});
  try{
    const r=await fetch(API+'/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(updates)});
    const d=await r.json();
    if(!r.ok||d.error)throw new Error(d.error||'保存失败');
    serviceConfigDirtyNames.delete(name);
    window.__catscoSetServiceConfigUi?.({name,dirty:false,saved:true});
    setTimeout(()=>window.__catscoSetServiceConfigUi?.({name,saved:false}),2000);
    await Promise.all([fetchConfig(),fetchStatus(),fetchReadiness()]);
  }catch(e){
    alert('保存失败: '+formatDashboardApiError(e,'/api/config'));
  }
}

function cancelServiceConfig(name){
  const group=serviceConfigGroups[name];
  if(!group)return;
  const values={};
  group.keys.forEach(item=>{
    values[item.key]=String(serviceConfigValue(item.key) ?? '');
  });
  serviceConfigDirtyNames.delete(name);
  window.__catscoSetServiceConfigDraft?.({name,values,dirty:false,saved:false});
  window.__catscoSetServiceConfigUi?.({name,dirty:false,saved:false});
}

function renderLocalSkillStore(skills) {
  window.__catscoRenderLocalSkillStore?.({ skills, targetId: 'store-grid', actions: true });
}
