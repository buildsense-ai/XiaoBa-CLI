function renderSkillHubRegistryState(payload = {}) {
  window.__catscoRenderSkillHubRegistry?.(payload);
}

function renderSkillHubAccountState(payload = {}) {
  window.__catscoRenderSkillHubAccount?.(payload);
}

function renderSkillHubDeveloperState(payload = {}) {
  window.__catscoRenderSkillHubDeveloper?.(payload);
}

function renderSkillHubVersionsState(payload = {}) {
  window.__catscoRenderSkillHubVersions?.(payload);
}

function skillHubStoreDraft(){
  return window.__catscoGetStoreDraft?.()||{};
}

function skillHubDraftValue(id){
  return String(skillHubStoreDraft()[id]||'');
}

async function shareLocalSkillToSkillHub(skillName) {
  if (!skillName) return;
  if (!confirm('Share this local Skill to SkillHub?\n\n' + skillName)) return;
  try {
    let data = await parseSimpleResponse(await fetch(API + '/api/skillhub/developer/share-local-skill', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ skillName }),
    }));
    if (data.requiresConfirmation) {
      const latest = data.latestVersion ? ('\nLatest version: ' + data.latestVersion) : '';
      if (!confirm('A SkillHub skill with the same name already exists, but the local content is different.' + latest + '\n\nPublish this as a new patch version?')) return;
      data = await parseSimpleResponse(await fetch(API + '/api/skillhub/developer/share-local-skill', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ skillName, confirmVersionPublish: true }),
      }));
    }
    if (data.existing) {
      alert('SkillHub already has this exact Skill content: ' + (data.latestVersion || skillName));
      await refreshSkillHubPage();
      return;
    }
    const submission = data.submission || {};
    alert('SkillHub share submitted: ' + (submission.id || submission.submissionId || skillName));
    await Promise.allSettled([fetchSkillHubDeveloper(), refreshSkillHubPage()]);
  } catch (e) {
    alert('SkillHub share failed: ' + (e.message || String(e)));
  }
}

async function refreshSkillHubPage() {
  await Promise.allSettled([fetchSkills(), fetchSkillHubStatus()]);
  await searchSkillHub('', true);
}

async function fetchSkillHubStatus() {
  try {
    const data = await parseSimpleResponse(await fetch(API + '/api/skillhub/status'));
    skillHubState = data || { authenticated:false, roles:[], permissions:[], installed:[] };
    renderSkillHubAccount();
  } catch (e) {
    renderSkillHubAccountState({
      message: 'SkillHub status failed: ' + (e.message || String(e)),
      tone: 'danger',
    });
  }
}

function renderSkillHubAccount() {
  renderSkillHubAccountState({ skillHubState });
}

async function connectSkillHubWithCatsCo() {
  try {
    skillHubState = await parseSimpleResponse(await fetch(API + '/api/skillhub/auth/catsco', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({}),
    }));
    renderSkillHubAccount();
    await fetchSkillHubDeveloper();
    await searchSkillHub('', true);
  } catch (e) {
    const message = e.message || String(e);
    const loginHint = /catsco.*login|required|token|401|登录/i.test(message) ? '\n\n请先在 CatsCo 页面完成登录。' : '';
    alert('连接 SkillHub 失败：' + message + loginHint);
  }
}

async function loginSkillHub() {
  const email = skillHubDraftValue('skillhub-login-email').trim();
  const password = skillHubDraftValue('skillhub-login-password');
  if (!email || !password) return alert('请输入邮箱和密码');
  try {
    skillHubState = await parseSimpleResponse(await fetch(API + '/api/skillhub/auth/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ email, password }),
    }));
    renderSkillHubAccount();
    await searchSkillHub('', true);
  } catch (e) {
    alert('SkillHub 登录失败：' + (e.message || String(e)));
  }
}

async function registerSkillHub() {
  const email = skillHubDraftValue('skillhub-login-email').trim();
  const password = skillHubDraftValue('skillhub-login-password');
  const displayName = skillHubDraftValue('skillhub-register-name').trim() || email;
  if (!email || !password) return alert('请输入邮箱和密码');
  try {
    skillHubState = await parseSimpleResponse(await fetch(API + '/api/skillhub/auth/register', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ email, password, displayName }),
    }));
    renderSkillHubAccount();
    await searchSkillHub('', true);
  } catch (e) {
    alert('SkillHub 注册失败：' + (e.message || String(e)));
  }
}

async function logoutSkillHub() {
  try {
    await parseSimpleResponse(await fetch(API + '/api/skillhub/auth/logout', { method:'POST' }));
    skillHubState = { authenticated:false, roles:[], permissions:[], installed:[] };
    renderSkillHubAccount();
    await searchSkillHub('', true);
  } catch (e) {
    alert('退出失败：' + (e.message || String(e)));
  }
}

async function searchSkillHub(queryOverride, quiet) {
  const query = queryOverride !== undefined ? queryOverride : skillHubDraftValue('skillhub-search-input').trim();
  if (!quiet) {
    renderSkillHubRegistryState({
      loading: true,
      message: 'Searching SkillHub...',
      skillHubState,
      localSkills: localSkillsCache || [],
    });
  }
  try {
    const data = await parseSimpleResponse(await fetch(API + '/api/skillhub/search?q=' + encodeURIComponent(query || '')));
    skillHubRegistryCache = data.skills || [];
    skillHubState.installed = data.installed || skillHubState.installed || [];
    renderSkillHubRegistry(skillHubRegistryCache);
  } catch (e) {
    renderSkillHubRegistryState({
      message: 'SkillHub search failed: ' + (e.message || String(e)),
      tone: 'danger',
      skillHubState,
      localSkills: localSkillsCache || [],
    });
  }
}

function renderSkillHubRegistry(items) {
  renderSkillHubRegistryState({ items, skillHubState, localSkills: localSkillsCache || [] });
}

async function installSkillHubSkill(skillId, version) {
  pulsePetState('thinking', 'Installing Skill...', 1600);
  try {
    const data = await parseSimpleResponse(await fetch(API + '/api/skillhub/install', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ skillId, version }),
    }));
    pulsePetState('success', 'Skill installed', 2200);
    alert('Install complete: ' + (data.skill?.name || skillId));
    await refreshSkillHubPage();
  } catch (e) {
    pulsePetState('error', 'Install failed', 2600);
    alert('Install failed: ' + (e.message || String(e)));
  }
}

async function showSkillHubVersions(skillId) {
  if (!skillId) return;
  renderSkillHubVersionsState({ skillId, loading: true, message: 'Loading versions...' });
  window.__catscoSetGlobalModalOpen?.('skillHubVersions', true);
  try {
    const [data, ownerData] = await Promise.all([
      parseSimpleResponse(await fetch(API + '/api/skillhub/versions?skillId=' + encodeURIComponent(skillId))),
      skillHubState.authenticated
        ? parseSimpleResponse(await fetch(API + '/api/skillhub/developer')).catch(() => ({ packageVersions: [] }))
        : Promise.resolve({ packageVersions: [] }),
    ]);
    renderSkillHubVersionsState({
      skillId,
      versions: data.versions || [],
      ownerVersions: ownerData.packageVersions || [],
    });
  } catch (e) {
    renderSkillHubVersionsState({
      skillId,
      message: 'Load versions failed: ' + (e.message || String(e)),
      tone: 'danger',
    });
  }
}

function closeSkillHubVersionsModal() {
  window.__catscoSetGlobalModalOpen?.('skillHubVersions', false);
}

async function fetchSkillHubDeveloper() {
  try {
    const data = await parseSimpleResponse(await fetch(API + '/api/skillhub/developer'));
    renderSkillHubDeveloper(data);
  } catch (e) {
    renderSkillHubDeveloperState({
      message: 'Developer Hub failed: ' + (e.message || String(e)),
      tone: 'danger',
      authenticated: false,
      roles: [],
      submissions: [],
      packageVersions: [],
    });
  }
}

function renderSkillHubDeveloper(data) {
  renderSkillHubDeveloperState(data);
}

async function yankOwnSkillHubVersion(packageVersionId) {
  if (!packageVersionId) return;
  if (!confirm('Remove this published SkillHub version from public search and downloads?')) return;
  try {
    await parseSimpleResponse(await fetch(API + '/api/skillhub/developer/package-versions/' + encodeURIComponent(packageVersionId) + '/yank', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ reason:'removed by owner from dashboard' }),
    }));
    await fetchSkillHubDeveloper();
    await refreshSkillHubPage();
  } catch (e) {
    alert('Remove failed: ' + (e.message || String(e)));
  }
}
