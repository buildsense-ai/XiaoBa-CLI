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

async function copySkillsRootPath() {
  try {
    const data = await parseSimpleResponse(await fetch(API + '/api/skills-root'));
    if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持剪贴板写入');
    await navigator.clipboard.writeText(data.path || '');
    window.__catscoRenderCopySkillsRootStatus?.('Copied');
    setTimeout(() => window.__catscoRenderCopySkillsRootStatus?.('Copy Skills path'), 1400);
  } catch (e) {
    alert('Copy Skills path failed: ' + (e.message || String(e)));
  }
}

async function installSkillHubSkill(skillId, version) {
  pulsePetState('thinking', '正在安装 Skill...', 1600);
  try {
    const data = await parseSimpleResponse(await fetch(API + '/api/skillhub/install', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ skillId, version }),
    }));
    pulsePetState('success', 'Skill 已安装', 2200);
    alert('安装完成: ' + (data.skill?.name || skillId));
    await refreshSkillHubPage();
  } catch (e) {
    pulsePetState('error', '安装失败', 2600);
    alert('安装失败: ' + (e.message || String(e)));
  }
}

async function showSkillHubVersions(skillId) {
  if (!skillId) return;
  renderSkillHubVersionsState({ skillId, loading: true, message: '正在加载版本...' });
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
      message: '版本加载失败: ' + (e.message || String(e)),
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
  if (!confirm('下架这个 SkillHub 版本？下架后其他用户将无法从公开搜索安装它。')) return;
  try {
    await parseSimpleResponse(await fetch(API + '/api/skillhub/developer/package-versions/' + encodeURIComponent(packageVersionId) + '/yank', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ reason:'removed by owner from dashboard' }),
    }));
    await fetchSkillHubDeveloper();
    await refreshSkillHubPage();
  } catch (e) {
    alert('下架失败: ' + (e.message || String(e)));
  }
}

async function restoreOwnSkillHubVersion(packageVersionId) {
  if (!packageVersionId) return;
  if (!confirm('重新公开这个 SkillHub 版本？公开后其他用户可以搜索和安装它。')) return;
  try {
    await parseSimpleResponse(await fetch(API + '/api/skillhub/me/package-versions/' + encodeURIComponent(packageVersionId) + '/restore', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({}),
    }));
    await fetchSkillHubDeveloper();
    await refreshSkillHubPage();
  } catch (e) {
    alert('重新公开失败: ' + (e.message || String(e)));
  }
}

async function deleteOwnSkillHubVersion(packageVersionId) {
  if (!packageVersionId) return;
  if (!confirm('永久删除这个 SkillHub 版本？删除后其他用户将无法安装该版本。')) return;
  try {
    await parseSimpleResponse(await fetch(API + '/api/skillhub/me/package-versions/' + encodeURIComponent(packageVersionId), {
      method:'DELETE',
      headers:{'Content-Type':'application/json'},
    }));
    await fetchSkillHubDeveloper();
    await refreshSkillHubPage();
  } catch (e) {
    alert('删除失败: ' + (e.message || String(e)));
  }
}
