let promptEditorState = null;
let promptEditorSelectedPath = '';
let promptEditorSelectedFile = null;
let promptEditorRequestSeq = 0;

async function parsePromptWorkbenchResponse(resp) {
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) throw new Error(data.error || ('HTTP ' + resp.status));
  return data;
}

function promptWorkbenchPaths(state = promptEditorState) {
  return Array.isArray(state?.files) ? state.files.map(file => String(file.path || '')).filter(Boolean) : [];
}

function renderPromptWorkbenchState(patch = {}) {
  window.__catscoRenderPromptWorkbench?.({
    dirty: false,
    draftContent: promptEditorSelectedFile?.content || '',
    error: '',
    loading: false,
    promptState: promptEditorState,
    selectedFile: promptEditorSelectedFile,
    selectedPath: promptEditorSelectedPath,
    statusText: '',
    ...patch,
  });
}

async function fetchPromptEditorFile(path) {
  if (!path) return null;
  const query = encodeURIComponent(path);
  return parsePromptWorkbenchResponse(await fetch(API + '/api/prompts/file?path=' + query));
}

async function refreshPromptWorkbench(selectPath, options = {}) {
  const requestSeq = ++promptEditorRequestSeq;
  renderPromptWorkbenchState({ loading: true, statusText: '加载提示词...' });
  try {
    const state = await parsePromptWorkbenchResponse(await fetch(API + '/api/prompts'));
    if (requestSeq !== promptEditorRequestSeq) return;

    const paths = promptWorkbenchPaths(state);
    const requestedPath = selectPath || promptEditorSelectedPath || paths[0] || '';
    promptEditorState = state;
    promptEditorSelectedPath = paths.includes(requestedPath) ? requestedPath : (paths[0] || '');
    promptEditorSelectedFile = promptEditorSelectedPath ? await fetchPromptEditorFile(promptEditorSelectedPath) : null;
    if (requestSeq !== promptEditorRequestSeq) return;
    renderPromptWorkbenchState({ dirty: false, loading: false });
  } catch (error) {
    if (requestSeq === promptEditorRequestSeq) {
      renderPromptWorkbenchState({ error: '加载提示词失败: ' + formatDashboardApiError(error, '/api/prompts'), loading: false });
    }
  }
}

async function selectPromptEditorFile(path) {
  const nextPath = String(path || '');
  if (!nextPath || nextPath === promptEditorSelectedPath) return;
  const requestSeq = ++promptEditorRequestSeq;
  promptEditorSelectedPath = nextPath;
  renderPromptWorkbenchState({ loading: true, selectedFile: null, statusText: '加载文件...' });
  try {
    promptEditorSelectedFile = await fetchPromptEditorFile(nextPath);
    if (requestSeq !== promptEditorRequestSeq) return;
    renderPromptWorkbenchState({ dirty: false, loading: false });
  } catch (error) {
    if (requestSeq === promptEditorRequestSeq) {
      renderPromptWorkbenchState({ error: '加载提示词文件失败: ' + formatDashboardApiError(error, '/api/prompts/file'), loading: false });
    }
  }
}

async function savePromptEditorFile() {
  if (!promptEditorSelectedPath) return;
  const content = String(window.__catscoGetPromptEditorDraft?.() ?? '');
  try {
    renderPromptWorkbenchState({ statusText: '保存中...' });
    const response = await fetch(API + '/api/prompts/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: promptEditorSelectedPath, content }),
    });
    promptEditorSelectedFile = await parsePromptWorkbenchResponse(response);
    await refreshPromptWorkbench(promptEditorSelectedPath, { preserveFileListScroll: true, preserveEditorScroll: true });
    renderPromptWorkbenchState({ dirty: false, statusText: '已保存，本地覆盖会在下一条用户消息前热加载。' });
  } catch (error) {
    renderPromptWorkbenchState({ statusText: '保存失败: ' + formatDashboardApiError(error, '/api/prompts/file') });
  }
}

async function resetPromptEditorFile() {
  if (!promptEditorSelectedPath) return;
  if (!confirm('重置这个 prompt 文件？本地覆盖内容会被删除。')) return;
  try {
    renderPromptWorkbenchState({ statusText: '重置中...' });
    const response = await fetch(API + '/api/prompts/file', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: promptEditorSelectedPath }),
    });
    promptEditorSelectedFile = await parsePromptWorkbenchResponse(response);
    await refreshPromptWorkbench(promptEditorSelectedPath, { preserveFileListScroll: true, preserveEditorScroll: true });
    renderPromptWorkbenchState({ dirty: false, statusText: '已恢复默认版本。' });
  } catch (error) {
    renderPromptWorkbenchState({ statusText: '重置失败: ' + formatDashboardApiError(error, '/api/prompts/file') });
  }
}

async function setBranchAgentsEnabled(enabled) {
  try {
    const data = await parsePromptWorkbenchResponse(await fetch(API + '/api/prompts/branch-agents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: Boolean(enabled) }),
    }));
    promptEditorState = {
      ...(promptEditorState || {}),
      branch_agents: {
        enabled: data.enabled,
        env_key: data.env_key,
      },
    };
    renderPromptWorkbenchState({ statusText: '分支 Agent 设置已保存。' });
  } catch (error) {
    renderPromptWorkbenchState({ statusText: '保存分支 Agent 设置失败: ' + formatDashboardApiError(error, '/api/prompts/branch-agents') });
  }
}

async function copyPromptOverridesPath() {
  try {
    if (!promptEditorState) {
      promptEditorState = await parsePromptWorkbenchResponse(await fetch(API + '/api/prompts'));
    }
    const value = promptEditorState?.overrides_dir || '';
    if (!value) throw new Error('覆盖目录暂不可用');
    if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持剪贴板写入');
    await navigator.clipboard.writeText(value);
    alert('已复制 prompt 覆盖目录');
  } catch (error) {
    alert('复制失败: ' + (error.message || String(error)));
  }
}

async function installPromptEditorSkill(overwrite = false) {
  try {
    const data = await parsePromptWorkbenchResponse(await fetch(API + '/api/prompts/editor-skill/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overwrite }),
    }));
    if (data.existing && !overwrite) {
      const disabled = data.disabled ? '，当前处于禁用状态' : '';
      if (confirm('已经安装 catsco-prompt-editor' + disabled + '，是否覆盖为内置最新版本？')) {
        return installPromptEditorSkill(true);
      }
      return;
    }
    alert(data.installed ? '已安装 catsco-prompt-editor，可在 SkillHub 中启用。' : 'catsco-prompt-editor 已存在。');
    if (typeof fetchSkills === 'function') fetchSkills();
  } catch (error) {
    alert('安装失败: ' + formatDashboardApiError(error, '/api/prompts/editor-skill/install'));
  }
}

window.refreshPromptWorkbench = refreshPromptWorkbench;
window.selectPromptEditorFile = selectPromptEditorFile;
window.savePromptEditorFile = savePromptEditorFile;
window.resetPromptEditorFile = resetPromptEditorFile;
window.setBranchAgentsEnabled = setBranchAgentsEnabled;
window.copyPromptOverridesPath = copyPromptOverridesPath;
window.installPromptEditorSkill = installPromptEditorSkill;
