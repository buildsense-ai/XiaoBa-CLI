import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

type AnyRecord = Record<string, any>;

type SkillHubRegistryPayload = {
  items?: AnyRecord[];
  skillHubState?: AnyRecord;
  localSkills?: AnyRecord[];
  loading?: boolean;
  message?: string;
  tone?: string;
};

type LocalSkillStorePayload = {
  skills?: AnyRecord[];
  targetId?: string;
  actions?: boolean;
  loading?: boolean;
  message?: string;
  tone?: string;
};

type SkillHubAccountPayload = {
  skillHubState?: AnyRecord;
  message?: string;
  tone?: string;
  loading?: boolean;
};

type StorePageState = {
  accountPayload?: SkillHubAccountPayload;
  copySkillsRootLabel?: string;
  developerData?: AnyRecord;
  localSkillStorePayload?: LocalSkillStorePayload;
  registryPayload?: SkillHubRegistryPayload;
  storeDraft: Record<string, string>;
};

declare global {
  interface Window {
    __catscoGetStoreDraft?: () => Record<string, string>;
    __catscoRenderSkillHubRegistry?: (payload: SkillHubRegistryPayload) => void;
    __catscoRenderLocalSkillStore?: (payload: LocalSkillStorePayload) => void;
    __catscoRenderSkillHubAccount?: (payload: SkillHubAccountPayload) => void;
    __catscoRenderSkillHubDeveloper?: (payload: AnyRecord) => void;
    __catscoRenderCopySkillsRootStatus?: (label: string) => void;
    __catscoSetStoreDraft?: (payload: Record<string, string>) => void;
    connectSkillHubWithCatsCo?: () => void;
    copySkillsRootPath?: () => void;
    deleteOwnSkillHubVersion?: (packageVersionId: string) => void;
    deleteSkill?: (name: string) => void;
    fetchSkillHubDeveloper?: () => void;
    installSkillHubSkill?: (skillId: string, version?: string) => void;
    loginSkillHub?: () => void;
    logoutSkillHub?: () => void;
    refreshSkillHubPage?: () => void;
    registerSkillHub?: () => void;
    restoreOwnSkillHubVersion?: (packageVersionId: string) => void;
    searchSkillHub?: (queryOverride?: string, quiet?: boolean) => void;
    shareLocalSkillToSkillHub?: (name: string) => void;
    showSkillHubVersions?: (skillId: string) => void;
    toggleSkill?: (name: string, enabled: boolean) => void;
    yankOwnSkillHubVersion?: (packageVersionId: string) => void;
  }
}

let storePageRoot: Root | undefined;
let storePageElement: HTMLElement | undefined;
let storePageState: StorePageState = {
  storeDraft: {
    'skillhub-permissions': 'filesystem.read.user_selected',
    'skillhub-version': '1.0.0',
  },
};

function toText(value: unknown, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function asList(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function toRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === 'object' ? (value as AnyRecord) : undefined;
}

function RuntimeNotice({ message, tone = '' }: { message?: string; tone?: string }) {
  return <div className={`runtime-note${tone ? ` ${tone}` : ''}`}>{message || ''}</div>;
}

function setStoreDraftField(id: string, value: string) {
  storePageState = {
    ...storePageState,
    storeDraft: {
      ...storePageState.storeDraft,
      [id]: value,
    },
  };
  renderStorePage();
}

function storeDraftFieldProps(id: string, fallback = '') {
  return {
    value: storePageState.storeDraft[id] ?? fallback,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setStoreDraftField(id, event.currentTarget.value),
  };
}

function StorePage({ state }: { state: StorePageState }) {
  const developerData = state.developerData;

  return (
    <>
      <div id="skillhub-section">
        <div className="settings-header">
          <div className="settings-heading">
            <div className="settings-kicker">SkillHub</div>
            <div className="section-title" style={{ marginBottom: 0 }}>
              Skills
            </div>
            <div className="settings-meta">
              公开 Skill 无需登录即可搜索和安装；登录后可分享本地 Skill 并管理已发布版本。
            </div>
          </div>
          <button className="btn" type="button" onClick={() => window.refreshSkillHubPage?.()}>
            刷新
          </button>
        </div>

        <div className="companion-skill-toolbar">
          <input
            className="config-input"
            id="skillhub-search-input"
            {...storeDraftFieldProps('skillhub-search-input')}
            placeholder="搜索合同审查、PPT、工程量清单..."
            onKeyDown={event => {
              if (event.key === 'Enter') window.searchSkillHub?.();
            }}
          />
          <button className="btn btn-primary" type="button" onClick={() => window.searchSkillHub?.()}>
            搜索
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              window.__catscoSetStoreDraft?.({ 'skillhub-search-input': '' });
              window.searchSkillHub?.('', true);
            }}
          >
            清空
          </button>
        </div>

        <details className="config-section" open>
          <summary className="settings-advanced-summary">
            <span>发现技能</span>
            <span className="tag">cloud registry</span>
          </summary>
          <div className="settings-advanced-body">
            <div className="skills-grid" data-react-skillhub-registry="mounted" id="skillhub-registry-grid">
              {state.registryPayload ? (
                <SkillHubRegistryGrid {...state.registryPayload} />
              ) : (
                <div className="loading">搜索云端已审核 Skill。</div>
              )}
            </div>
          </div>
        </details>

        <details className="config-section" open>
          <summary className="settings-advanced-summary">
            <span>已安装技能</span>
            <span style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
              <span className="tag">local</span>
              <button
                className="btn"
                id="copy-skills-root-btn"
                type="button"
                onClick={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  window.copySkillsRootPath?.();
                }}
              >
                {state.copySkillsRootLabel || 'Copy Skills path'}
              </button>
            </span>
          </summary>
          <div className="settings-advanced-body">
            <div className="skills-grid" data-react-local-skill-store="mounted" id="store-grid">
              {state.localSkillStorePayload ? (
                <LocalSkillGrid {...state.localSkillStorePayload} />
              ) : (
                <div className="loading">加载中...</div>
              )}
            </div>
          </div>
        </details>
      </div>

      <div className="config-section" data-react-skillhub-account="mounted" id="skillhub-account-card">
        {state.accountPayload ? (
          <SkillHubAccountCard {...state.accountPayload} />
        ) : (
          <div className="loading">正在检查 SkillHub 登录状态...</div>
        )}
      </div>

      <div className="config-section">
        <div className="config-group-title-main">我的发布</div>
        <div className="settings-meta" style={{ marginBottom: 14 }}>
          管理你发布到 SkillHub 的 Skill 和版本。下架会隐藏公开安装；删除会移除服务器版本和包文件。
        </div>
        <div className="portal-list" data-react-skillhub-package-versions="mounted" id="skillhub-package-versions-list">
          {developerData ? (
            <SkillHubPackageVersionsList versions={developerData.packageVersions || []} />
          ) : (
            <div className="loading">暂无发布版本</div>
          )}
        </div>
      </div>
    </>
  );
}
function roleList(value: unknown) {
  const roles = asList(value).map(item => toText(item)).filter(Boolean);
  return roles.length ? roles.join(', ') : 'user';
}

function SkillHubAccountCard({ skillHubState = {}, message, tone, loading = false }: SkillHubAccountPayload) {
  if (loading) {
    return <div className="loading">{message || 'Checking SkillHub status...'}</div>;
  }
  if (message) {
    return <RuntimeNotice message={message} tone={tone} />;
  }
  const user = toRecord(skillHubState.user) || {};
  const roles = roleList(skillHubState.roles);
  const authenticated = Boolean(skillHubState.authenticated);
  if (authenticated) {
    return (
      <>
        <div className="settings-setup-head">
          <div>
            <div className="settings-setup-title">Signed in to SkillHub</div>
            <div className="settings-setup-copy">
              {toText(user.displayName, toText(user.email, 'CatsCo user'))} · {roles}
            </div>
          </div>
          <span className="tag green">connected</span>
        </div>
        <div className="config-actions" style={{ marginTop: 14 }}>
          <button className="btn" type="button" onClick={() => window.fetchSkillHubDeveloper?.()}>
            Refresh developer status
          </button>
          <button className="btn" type="button" onClick={() => window.logoutSkillHub?.()}>
            Logout
          </button>
        </div>
        {!skillHubState.trustReady ? (
          <div className="runtime-note warning" style={{ marginTop: 12 }}>
            This Agent build does not include the SkillHub root public key yet. Run the trust-root setup before
            production release.
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="settings-setup-head">
        <div>
          <div className="settings-setup-title">Connect SkillHub</div>
          <div className="settings-setup-copy">
            Public Skills can be searched and installed directly. Publishing and version management reuse the
            current CatsCo account.
          </div>
        </div>
        <span className="tag warm">catsco login</span>
      </div>
      <div className="config-actions" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" type="button" onClick={() => window.connectSkillHubWithCatsCo?.()}>
          Connect with CatsCo
        </button>
        <button className="btn" type="button" onClick={() => window.fetchSkillHubDeveloper?.()}>
          Refresh status
        </button>
      </div>
      <details style={{ marginTop: 14 }}>
        <summary className="settings-meta">Fallback: SkillHub email/password login</summary>
        <div className="chat-form-row" style={{ marginTop: 14, marginBottom: 10 }}>
          <input className="config-input" id="skillhub-login-email" {...storeDraftFieldProps('skillhub-login-email')} placeholder="Email" />
          <input className="config-input" id="skillhub-login-password" {...storeDraftFieldProps('skillhub-login-password')} type="password" placeholder="Password" />
        </div>
        <div className="chat-form-row">
          <input className="config-input" id="skillhub-register-name" {...storeDraftFieldProps('skillhub-register-name')} placeholder="Display name for registration" />
          <button className="btn" type="button" onClick={() => window.loginSkillHub?.()}>
            Login
          </button>
          <button className="btn" type="button" onClick={() => window.registerSkillHub?.()}>
            Register
          </button>
        </div>
      </details>
    </>
  );
}

function SkillHubPackageVersionsList({ versions = [] }: { versions?: AnyRecord[] }) {
  if (!versions.length) {
    return <div className="loading">暂无发布版本</div>;
  }
  return (
    <>
      {versions.map((item, index) => {
        const author = toText(toRecord(item.author)?.name);
        const downloads = Number(item.downloadCount || 0);
        const packageVersionId = toText(item.packageVersionId, toText(item.id));
        const status = toText(item.status, 'published');
        const version = toText(item.latestVersion, toText(item.version, '-'));
        return (
          <div className="portal-row" key={`${toText(item.skillId, toText(item.name, 'version'))}-${index}`}>
            <strong>{toText(item.skillId, toText(item.name, '-'))}</strong>
            <div className="settings-meta">
              v{version} · {status} · 下载 {downloads}
              {item.publishedAt ? ` · ${toText(item.publishedAt)}` : ''}
            </div>
            <div className="settings-meta">
              {author ? `作者 ${author}` : ''} · 当前账号可管理
            </div>
            {packageVersionId ? (
              <div className="config-actions" style={{ marginTop: 8 }}>
                {status === 'published' ? (
                  <button
                    className="btn btn-danger"
                    data-skillhub-yank-version="true"
                    type="button"
                    onClick={() => window.yankOwnSkillHubVersion?.(packageVersionId)}
                  >
                    下架
                  </button>
                ) : (
                  <button
                    className="btn btn-success"
                    data-skillhub-restore-version="true"
                    type="button"
                    onClick={() => window.restoreOwnSkillHubVersion?.(packageVersionId)}
                  >
                    重新公开
                  </button>
                )}
                <button
                  className="btn btn-danger"
                  data-skillhub-delete-version="true"
                  type="button"
                  onClick={() => window.deleteOwnSkillHubVersion?.(packageVersionId)}
                >
                  删除
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function buildInstalledSkillIds(skillHubState: AnyRecord = {}, localSkills: AnyRecord[] = []) {
  const installedIds = new Set<string>();
  for (const item of asList(skillHubState.installed)) {
    const installed = toRecord(item);
    if (!installed) continue;
    installedIds.add(`${toText(installed.skillId)}@${toText(installed.version)}`);
  }
  for (const skill of localSkills) {
    const hub = toRecord(skill.skillHub);
    if (hub?.author && hub?.version) {
      installedIds.add(`${toText(hub.author)}/${toText(skill.name)}@${toText(hub.version)}`);
    }
  }
  return installedIds;
}

function SkillHubRegistryGrid({
  items = [],
  skillHubState = {},
  localSkills = [],
  loading = false,
  message,
  tone,
}: SkillHubRegistryPayload) {
  if (loading) {
    return <div className="loading">{message || 'Searching SkillHub...'}</div>;
  }
  if (message) {
    return <RuntimeNotice message={message} tone={tone} />;
  }
  if (!items.length) {
    return <div className="loading">No matching Skills found.</div>;
  }
  const installedIds = buildInstalledSkillIds(skillHubState, localSkills);
  return (
    <>
      {items.map((item, index) => (
        <SkillHubRegistryCard
          key={`${toText(item.skillId, toText(item.name, 'skill'))}-${index}`}
          item={item}
          installedIds={installedIds}
        />
      ))}
    </>
  );
}

function SkillHubRegistryCard({
  item,
  installedIds,
}: {
  item: AnyRecord;
  installedIds: Set<string>;
}) {
  const skillId = toText(item.skillId);
  const latestVersion = toText(item.latestVersion);
  const installed = installedIds.has(`${skillId}@${latestVersion}`);
  const authorName = toText(toRecord(item.author)?.name);
  const tagLabels = [
    authorName ? `by ${authorName}` : '',
    ...asList(item.categories).map(value => toText(value)),
    ...asList(item.tags).map(value => toText(value)),
  ].filter(Boolean).slice(0, 5);
  const triggerExamples = asList(item.triggerExamples).slice(0, 3).map(value => toText(value)).filter(Boolean);
  const canInstall = Boolean(skillId) && !installed;

  return (
    <div className="skill-card">
      <div className="skill-name">
        {toText(item.displayName, toText(item.name, skillId))} <span className="tag green">SkillHub</span>
      </div>
      <div className="skill-desc">{toText(item.description)}</div>
      <div className="skill-meta">
        {tagLabels.map((tag, index) => (
          <span className="tag" key={`${tag}-${index}`}>
            {tag}
          </span>
        ))}
        <span className="tag">v{latestVersion || '-'}</span>
      </div>
      <div className="skill-files">{triggerExamples.join(', ')}</div>
      <div className="skill-actions">
        <button
          className="btn btn-primary"
          disabled={!canInstall}
          data-skillhub-install={canInstall ? 'true' : undefined}
          type="button"
          onClick={() => window.installSkillHubSkill?.(skillId, latestVersion || undefined)}
        >
          {installed ? 'Installed' : 'Install'}
        </button>
        <button className="btn" disabled={!skillId} data-skillhub-versions="true" type="button" onClick={() => window.showSkillHubVersions?.(skillId)}>
          Versions
        </button>
      </div>
    </div>
  );
}

function getSkillCompanionStats(name: string) {
  try {
    const stats = JSON.parse(localStorage.getItem('xiaoba.skillStats') || '{}');
    return stats[name] || {};
  } catch (_error) {
    return {};
  }
}

function SkillGrowth({ name }: { name: string }) {
  const stats = getSkillCompanionStats(name);
  const calls = Number(stats.calls || 0);
  const successes = Number(stats.successes || 0);
  const successRate = calls > 0 ? `${Math.round((successes / calls) * 100)}%` : '--';
  const level = Number(stats.level || Math.max(1, Math.floor(calls / 10) + 1));
  return (
    <div className="skill-growth">
      <div className="skill-growth-stat">
        <div className="skill-growth-label">calls</div>
        <div className="skill-growth-value">{calls}</div>
      </div>
      <div className="skill-growth-stat">
        <div className="skill-growth-label">success</div>
        <div className="skill-growth-value">{successRate}</div>
      </div>
      <div className="skill-growth-stat">
        <div className="skill-growth-label">level</div>
        <div className="skill-growth-value">Lv.{level}</div>
      </div>
    </div>
  );
}

function SkillSourceTag({ skill }: { skill: AnyRecord }) {
  if (skill.skillHub) {
    return <span className="tag green" title="SkillHub shared skill">SkillHub</span>;
  }
  if (skill.source === 'system') {
    return <span className="tag" title="System skill">system</span>;
  }
  return null;
}

function SkillHubLocalMeta({ skill }: { skill: AnyRecord }) {
  const hub = toRecord(skill.skillHub);
  if (!hub) return null;
  const modifiedTag = hub.modified === true
    ? <span className="tag warm">local changes</span>
    : hub.modified === false
      ? <span className="tag green">synced</span>
      : <span className="tag">not checked</span>;
  return (
    <div className="skill-meta">
      {hub.author ? <span className="tag">by {toText(hub.author)}</span> : null}
      {hub.version ? <span className="tag">v{toText(hub.version)}</span> : null}
      {modifiedTag}
    </div>
  );
}

function SkillActionButtons({ skill, name }: { skill: AnyRecord; name: string }) {
  return (
    <div className="skill-actions">
      {skill.canDisable === false ? (
        <button className="btn" disabled>
          Protected
        </button>
      ) : (
        <button
          className="btn"
          type="button"
          onClick={() => window.toggleSkill?.(name, skill.enabled !== false)}
        >
          {skill.enabled === false ? 'Enable' : 'Disable'}
        </button>
      )}
      {skill.canShare ? (
        <button className="btn btn-primary" type="button" onClick={() => window.shareLocalSkillToSkillHub?.(name)}>
          Share
        </button>
      ) : null}
      {skill.canDelete ? (
        <button className="btn btn-danger" type="button" onClick={() => window.deleteSkill?.(name)}>
          Delete
        </button>
      ) : null}
    </div>
  );
}

function LocalSkillGrid({ skills = [], actions = true, loading = false, message, tone }: LocalSkillStorePayload) {
  if (loading) {
    return <div className="loading">{message || 'Loading skills...'}</div>;
  }
  if (message) {
    return <RuntimeNotice message={message} tone={tone} />;
  }
  if (!skills.length) {
    return <div className="loading">No Skills</div>;
  }
  return (
    <>
      {skills.map((skill, index) => (
        <LocalSkillCard
          key={`${toText(skill.name, 'skill')}-${index}`}
          skill={skill}
          actions={actions}
        />
      ))}
    </>
  );
}

function LocalSkillCard({ skill, actions }: { skill: AnyRecord; actions: boolean }) {
  const name = toText(skill.name);
  const files = asList(skill.files).map(value => toText(value)).filter(Boolean);
  return (
    <div className={`skill-card${skill.enabled === false ? ' disabled' : ''}`}>
      <div className="skill-name">
        {name}
        {' '}
        <SkillSourceTag skill={skill} />
        {skill.enabled === false ? (
          <>
            {' '}
            <span className="tag" style={{ background: 'rgba(220,93,115,0.12)', color: 'var(--red)' }}>
              disabled
            </span>
          </>
        ) : null}
      </div>
      <div className="skill-desc">{toText(skill.description)}</div>
      <div className="skill-meta">
        {skill.userInvocable ? <span className="tag active">user</span> : null}
        {skill.autoInvocable ? <span className="tag active">auto</span> : null}
        {skill.maxTurns ? <span className="tag">max {toText(skill.maxTurns)} turns</span> : null}
      </div>
      <SkillHubLocalMeta skill={skill} />
      <SkillGrowth name={name} />
      {files.length ? <div className="skill-files">{files.join(', ')}</div> : null}
      {actions ? <SkillActionButtons skill={skill} name={name} /> : null}
    </div>
  );
}

function renderStorePage() {
  if (!storePageElement) return;
  storePageRoot ??= createRoot(storePageElement);
  storePageRoot?.render(<StorePage state={storePageState} />);
  storePageElement.dataset.reactStore = 'mounted';
}

function renderSkillHubRegistryGrid(payload: SkillHubRegistryPayload) {
  storePageState = { ...storePageState, registryPayload: payload };
  renderStorePage();
}

function renderLocalSkillStoreGrid(payload: LocalSkillStorePayload) {
  storePageState = { ...storePageState, localSkillStorePayload: payload };
  renderStorePage();
}

function renderSkillHubAccountCard(payload: SkillHubAccountPayload) {
  storePageState = { ...storePageState, accountPayload: payload };
  renderStorePage();
}

function renderSkillHubDeveloperPanel(data: AnyRecord) {
  storePageState = { ...storePageState, developerData: data };
  renderStorePage();
}

function renderCopySkillsRootStatus(label: string) {
  storePageState = { ...storePageState, copySkillsRootLabel: label || 'Copy Skills path' };
  renderStorePage();
}

function getStoreDraft() {
  return { ...storePageState.storeDraft };
}

function setStoreDraft(payload: Record<string, string>) {
  storePageState = {
    ...storePageState,
    storeDraft: {
      ...storePageState.storeDraft,
      ...Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, String(value ?? '')])),
    },
  };
  renderStorePage();
}

if (typeof window !== 'undefined') {
  window.__catscoGetStoreDraft = getStoreDraft;
  window.__catscoRenderSkillHubRegistry = renderSkillHubRegistryGrid;
  window.__catscoRenderLocalSkillStore = renderLocalSkillStoreGrid;
  window.__catscoRenderSkillHubAccount = renderSkillHubAccountCard;
  window.__catscoRenderSkillHubDeveloper = renderSkillHubDeveloperPanel;
  window.__catscoRenderCopySkillsRootStatus = renderCopySkillsRootStatus;
  window.__catscoSetStoreDraft = setStoreDraft;
}

export function mountStorePage() {
  const root = document.getElementById('store-page-root');
  if (!root) return;
  storePageElement = root;
  renderStorePage();
}
