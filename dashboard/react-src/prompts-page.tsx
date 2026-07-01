import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

declare global {
  interface Window {
    __catscoRenderPromptWorkbench?: (payload: PromptWorkbenchPayload) => void;
    __catscoGetPromptEditorDraft?: () => string;
    __catscoSetPromptEditorDraft?: (value: string) => void;
    copyPromptOverridesPath?: () => void;
    installPromptEditorSkill?: () => void;
    refreshPromptWorkbench?: (selectPath?: string, options?: Record<string, unknown>) => void;
    resetPromptEditorFile?: () => void;
    savePromptEditorFile?: () => void;
    selectPromptEditorFile?: (path: string) => void;
    setBranchAgentsEnabled?: (enabled: boolean) => void;
  }
}

type PromptDigest = {
  chars?: number;
  lines?: number;
  short_hash?: string;
};

type PromptEditorFile = {
  base?: PromptDigest;
  effective?: PromptDigest;
  overridden?: boolean;
  path: string;
};

type PromptEditorFileDetail = PromptEditorFile & {
  base_content?: string;
  content?: string;
};

type PromptTrace = {
  bundle?: {
    file_count?: number;
    short_hash?: string;
  };
  generated_at?: string;
  loaded_files?: string[];
  prompt_version?: string;
  prompts_dir?: string;
  source?: string;
  system?: PromptDigest;
};

type PromptBranchAgentsState = {
  enabled?: boolean;
  env_key?: string;
};

type PromptEditorState = {
  base_dir?: string;
  branch_agents?: PromptBranchAgentsState;
  files?: PromptEditorFile[];
  overrides_dir?: string;
  trace?: PromptTrace;
  writable?: boolean;
};

type PromptWorkbenchPayload = {
  dirty?: boolean;
  draftContent?: string;
  error?: string;
  loading?: boolean;
  promptState?: PromptEditorState | null;
  selectedFile?: PromptEditorFileDetail | null;
  selectedPath?: string;
  statusText?: string;
};

type PromptPageState = {
  dirty: boolean;
  draftContent: string;
  error: string;
  groupOpen: Record<string, boolean>;
  loading: boolean;
  promptState?: PromptEditorState;
  selectedFile?: PromptEditorFileDetail;
  selectedPath: string;
  statusText: string;
};

let promptsPageRoot: Root | null = null;
let promptsPageElement: HTMLElement | null = null;
let promptPageState: PromptPageState = {
  dirty: false,
  draftContent: '',
  error: '',
  groupOpen: {},
  loading: true,
  selectedPath: '',
  statusText: '',
};

function fileBaseName(path: string) {
  const parts = String(path || '').split('/');
  return parts[parts.length - 1] || path;
}

function promptFileGroup(path: string) {
  const value = String(path || '');
  if (!value.includes('/')) return 'core';
  if (value.startsWith('agents/')) return 'agents';
  if (value.startsWith('tools/')) return 'tools';
  return value.split('/')[0] || 'other';
}

function promptGroupLabel(group: string) {
  const labels: Record<string, string> = {
    agents: '分支 Agent',
    core: '核心提示词',
    tools: '工具提示词',
  };
  return labels[group] || group;
}

function promptFileMeta(file: PromptEditorFile) {
  const digest = file.effective || file.base || {};
  const stats = [`${Number(digest.chars || 0)} chars`, `${Number(digest.lines || 0)} lines`];
  if (digest.short_hash) stats.push(String(digest.short_hash));
  return stats.join(' · ');
}

function traceTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function setPromptEditorDraft(value: string) {
  promptPageState = {
    ...promptPageState,
    dirty: true,
    draftContent: value,
    statusText: '未保存的覆盖内容会在保存后热加载。',
  };
  renderPromptsPage();
}

function togglePromptFileGroup(group: string) {
  const current = promptPageState.groupOpen[group];
  promptPageState = {
    ...promptPageState,
    groupOpen: {
      ...promptPageState.groupOpen,
      [group]: current === false,
    },
  };
  renderPromptsPage();
}

function TraceCard({ label, meta, value }: { label: string; meta?: string; value: string }) {
  return (
    <div className="prompt-trace-card">
      <div className="prompt-trace-label">{label}</div>
      <div className="prompt-trace-value">{value || '-'}</div>
      {meta ? <div className="settings-meta">{meta}</div> : null}
    </div>
  );
}

function PromptTraceGrid({ promptState }: { promptState: PromptEditorState }) {
  const trace = promptState.trace || {};
  const bundle = trace.bundle || {};
  const system = trace.system || {};
  return (
    <div className="prompt-trace-grid">
      <TraceCard label="System hash" meta={`${Number(system.chars || 0)} chars · ${Number(system.lines || 0)} lines`} value={system.short_hash || '-'} />
      <TraceCard label="Bundle hash" meta={`${Number(bundle.file_count || 0)} files`} value={bundle.short_hash || '-'} />
      <TraceCard label="版本" meta={trace.source || 'prompt-editor'} value={trace.prompt_version || 'local'} />
      <TraceCard label="覆盖目录" meta={traceTime(trace.generated_at)} value={promptState.overrides_dir || '未配置'} />
    </div>
  );
}

function PromptBranchAgentControls({ branchAgents }: { branchAgents?: PromptBranchAgentsState }) {
  if (!branchAgents) return null;
  return (
    <div className="runtime-note prompt-branch-agents">
      <label className="prompt-branch-toggle">
        <input
          checked={branchAgents.enabled !== false}
          onChange={event => window.setBranchAgentsEnabled?.(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>启用分支 Agent 提示词</span>
      </label>
      <span>{branchAgents.env_key || 'XIAOBA_BRANCH_AGENTS_ENABLED'}</span>
    </div>
  );
}

function PromptFileTree({ files, selectedPath }: { files: PromptEditorFile[]; selectedPath: string }) {
  if (!files.length) return <div className="prompt-file-list"><div className="loading">暂无可编辑提示词</div></div>;
  const groups = new Map<string, PromptEditorFile[]>();
  files.forEach(file => {
    const group = promptFileGroup(file.path);
    groups.set(group, [...(groups.get(group) || []), file]);
  });

  return (
    <div className="prompt-file-list">
      {[...groups.entries()].map(([group, groupFiles]) => {
        const open = promptPageState.groupOpen[group] !== false;
        return (
          <div className="prompt-file-group" key={group}>
            <button className="prompt-file-group-title" type="button" onClick={() => togglePromptFileGroup(group)}>
              <span className="chevron">{open ? 'v' : '>'}</span>
              <span>{promptGroupLabel(group)}</span>
              <span className="prompt-file-count">{groupFiles.length}</span>
            </button>
            {open
              ? groupFiles.map(file => (
                  <button
                    className={`prompt-file-item${file.path === selectedPath ? ' active' : ''}${group === 'core' ? '' : ' nested'}`}
                    key={file.path}
                    onClick={() => window.selectPromptEditorFile?.(file.path)}
                    type="button"
                  >
                    <span className="prompt-file-name">{fileBaseName(file.path)}</span>
                    <span className="prompt-file-meta">
                      {file.overridden ? '已覆盖 · ' : ''}
                      {promptFileMeta(file)}
                    </span>
                  </button>
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}

function PromptEditorPane({ state }: { state: PromptPageState }) {
  const file = state.selectedFile;
  const writable = state.promptState?.writable !== false;
  if (!file) {
    return (
      <div className="prompt-editor-pane">
        <div className="loading">选择一个提示词文件开始编辑</div>
      </div>
    );
  }

  return (
    <div className="prompt-editor-pane">
      <div className="prompt-editor-head">
        <div>
          <div className="prompt-editor-title">{file.path}</div>
          <div className="prompt-editor-meta">
            effective {file.effective?.short_hash || '-'} · base {file.base?.short_hash || '-'} · {Number(file.effective?.chars || 0)} chars
          </div>
        </div>
        <span className={`tag ${file.overridden ? 'green' : 'gray'}`}>{file.overridden ? '本地覆盖' : '默认版本'}</span>
      </div>
      {!writable ? (
        <div className="runtime-note warning">未配置安全的提示词覆盖目录，当前文件只能查看。</div>
      ) : null}
      <textarea
        className="prompt-editor-textarea"
        disabled={!writable}
        id="prompt-editor-textarea"
        onChange={event => setPromptEditorDraft(event.currentTarget.value)}
        spellCheck={false}
        value={state.draftContent}
      />
      <div className="prompt-editor-actions">
        <div className="prompt-editor-status" id="prompt-editor-status">
          {state.statusText || (state.dirty ? '未保存' : '已同步')}
        </div>
        <div className="settings-actions">
          <button className="btn btn-primary" disabled={!writable || !state.dirty} onClick={() => window.savePromptEditorFile?.()} type="button">
            保存覆盖
          </button>
          <button className="btn" disabled={!writable || !file.overridden} onClick={() => window.resetPromptEditorFile?.()} type="button">
            重置为默认
          </button>
        </div>
      </div>
    </div>
  );
}

function PromptWorkbench({ state }: { state: PromptPageState }) {
  if (state.loading && !state.promptState) {
    return <div className="prompt-workbench" id="prompt-workbench"><div className="loading">加载提示词...</div></div>;
  }

  if (state.error) {
    return (
      <div className="prompt-workbench" id="prompt-workbench">
        <div className="runtime-note danger">{state.error}</div>
      </div>
    );
  }

  const promptState = state.promptState;
  if (!promptState) {
    return <div className="prompt-workbench" id="prompt-workbench"><div className="loading">加载提示词...</div></div>;
  }

  const files = promptState.files || [];
  return (
    <div className="prompt-workbench" data-react-prompt-workbench="mounted" id="prompt-workbench">
      <PromptTraceGrid promptState={promptState} />
      <PromptBranchAgentControls branchAgents={promptState.branch_agents} />
      <div className="runtime-note">
        编辑本地覆盖版本，保存后会在下一条用户消息开始前热加载。默认目录：{promptState.base_dir || '-'}
      </div>
      <div className="prompt-editor-layout">
        <PromptFileTree files={files} selectedPath={state.selectedPath} />
        <PromptEditorPane state={state} />
      </div>
    </div>
  );
}

function PromptsPage({ state }: { state: PromptPageState }) {
  return (
    <>
      <div className="settings-header">
        <div className="settings-heading">
          <div className="settings-kicker">Prompt Lab</div>
          <div className="section-title" style={{ marginBottom: 0 }}>
            提示词调试
          </div>
          <div className="settings-meta">编辑本地覆盖版本，下一条用户消息开始前热加载；日志会记录 system 和 bundle hash。</div>
        </div>
        <div className="settings-actions">
          <button className="btn" onClick={() => window.copyPromptOverridesPath?.()} type="button">
            复制覆盖目录
          </button>
          <button className="btn" onClick={() => window.installPromptEditorSkill?.()} type="button">
            安装编辑 Skill
          </button>
          <button className="btn btn-primary" onClick={() => window.refreshPromptWorkbench?.()} type="button">
            刷新
          </button>
        </div>
      </div>
      <PromptWorkbench state={state} />
    </>
  );
}

function renderPromptsPage() {
  if (!promptsPageElement) return;
  promptsPageRoot ||= createRoot(promptsPageElement);
  promptsPageRoot.render(<PromptsPage state={promptPageState} />);
  promptsPageElement.dataset.reactPrompts = 'mounted';
}

function renderPromptWorkbench(payload: PromptWorkbenchPayload = {}) {
  const hasPromptState = Object.prototype.hasOwnProperty.call(payload, 'promptState');
  const hasSelectedFile = Object.prototype.hasOwnProperty.call(payload, 'selectedFile');
  const selectedFile = hasSelectedFile ? payload.selectedFile || undefined : promptPageState.selectedFile;
  const draftContent =
    payload.draftContent !== undefined ? String(payload.draftContent ?? '') : hasSelectedFile ? String(selectedFile?.content || '') : promptPageState.draftContent;

  promptPageState = {
    ...promptPageState,
    ...(hasPromptState ? { promptState: payload.promptState || undefined } : {}),
    ...(payload.selectedPath === undefined ? {} : { selectedPath: String(payload.selectedPath || '') }),
    ...(payload.loading === undefined ? {} : { loading: Boolean(payload.loading) }),
    ...(payload.error === undefined ? {} : { error: String(payload.error || '') }),
    ...(payload.statusText === undefined ? {} : { statusText: String(payload.statusText || '') }),
    ...(payload.dirty === undefined ? {} : { dirty: Boolean(payload.dirty) }),
    selectedFile,
    draftContent,
  };
  renderPromptsPage();
}

function getPromptEditorDraft() {
  return promptPageState.draftContent;
}

export function mountPromptsPage() {
  const root = document.getElementById('prompts-page-root');
  if (!root) return;
  promptsPageElement = root;
  renderPromptsPage();
  window.__catscoRenderPromptWorkbench = renderPromptWorkbench;
  window.__catscoGetPromptEditorDraft = getPromptEditorDraft;
  window.__catscoSetPromptEditorDraft = setPromptEditorDraft;
}
