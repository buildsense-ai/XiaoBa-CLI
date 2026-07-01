import React, { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type LogsBodyPayload =
  | { kind: 'text'; text: string; tone?: 'error' | 'success' | 'muted' }
  | { agentName?: string; href: string; kind: 'weixin-qr' }
  | { kind: 'weixin-success'; message?: string }
  | { kind: 'weixin-expired' };

type MediaPreviewPayload = {
  src?: string;
  title?: string;
};

type AnyRecord = Record<string, any>;

type SkillHubVersionsPayload = {
  skillId?: string;
  versions?: AnyRecord[];
  ownerVersions?: AnyRecord[];
  loading?: boolean;
  message?: string;
  tone?: string;
};

type UpdateStatusPayload = {
  availableVersion?: string;
  canCheck?: boolean;
  canDownload?: boolean;
  canInstall?: boolean;
  checkLabel?: string;
  currentVersion?: string;
  downloadLabel?: string;
  errorText?: string;
  fallbackNote?: string;
  installLabel?: string;
  manualUrl?: string;
  message?: string;
  percentLabel?: string;
  progressPercent?: number;
  releaseUrl?: string;
  showDownload?: boolean;
  showFallback?: boolean;
  showInstall?: boolean;
  sizeLabel?: string;
  speedLabel?: string;
  stageBg?: string;
  stageColor?: string;
  stageLabel?: string;
};

type GlobalModalName = 'logs' | 'skillHubVersions' | 'update' | 'mediaPreview';

type GlobalModalOpenState = Record<GlobalModalName, boolean>;

declare global {
  interface Window {
    __catscoRenderLogsBody?: (payload: LogsBodyPayload) => void;
    __catscoRenderLogsTitle?: (text: string) => void;
    __catscoRenderMediaPreview?: (payload: MediaPreviewPayload) => void;
    __catscoRenderSkillHubVersions?: (payload: SkillHubVersionsPayload) => void;
    __catscoRenderUpdateStatus?: (payload: UpdateStatusPayload) => void;
    __catscoSetGlobalModalOpen?: (name: GlobalModalName, open: boolean) => void;
    checkForUpdates?: () => void;
    closeCatsMediaPreview?: () => void;
    closeLogs?: () => void;
    closeSkillHubVersionsModal?: () => void;
    closeUpdateModal?: () => void;
    copyManualInstallerUrl?: (url: string) => void;
    copyReleasePageUrl?: (url: string) => void;
    deleteOwnSkillHubVersion?: (packageVersionId: string) => void;
    downloadUpdate?: () => void;
    installSkillHubSkill?: (skillId: string, version?: string) => void;
    installUpdate?: () => void;
    restoreOwnSkillHubVersion?: (packageVersionId: string) => void;
    yankOwnSkillHubVersion?: (packageVersionId: string) => void;
  }
}

let globalModalsRoot: Root | undefined;
let globalModalsElement: HTMLElement | undefined;
let globalModalsState: GlobalModalsState = {
  logsBody: { kind: 'text', text: '暂无日志', tone: 'muted' },
  logsTitle: '日志',
  mediaPreview: { src: '', title: '预览' },
  modalOpen: {
    logs: false,
    mediaPreview: false,
    skillHubVersions: false,
    update: false,
  },
  skillHubVersions: {},
  updateStatus: {},
};

type GlobalModalsState = {
  logsBody: LogsBodyPayload;
  logsTitle: string;
  mediaPreview: MediaPreviewPayload;
  modalOpen: GlobalModalOpenState;
  skillHubVersions: SkillHubVersionsPayload;
  updateStatus: UpdateStatusPayload;
};

const GLOBAL_MODAL_NAMES: GlobalModalName[] = ['logs', 'skillHubVersions', 'update', 'mediaPreview'];

function isGlobalModalName(name: unknown): name is GlobalModalName {
  return typeof name === 'string' && GLOBAL_MODAL_NAMES.includes(name as GlobalModalName);
}

function modalOverlayClass(open: boolean) {
  return `modal-overlay${open ? ' show' : ''}`;
}

function toText(value: unknown, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function toRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === 'object' ? (value as AnyRecord) : undefined;
}

function RuntimeNotice({ message, tone = '' }: { message?: string; tone?: string }) {
  return <div className={`runtime-note${tone ? ` ${tone}` : ''}`}>{message || ''}</div>;
}

function SkillHubVersionsList({
  skillId = '',
  versions = [],
  ownerVersions = [],
  loading = false,
  message,
  tone,
}: SkillHubVersionsPayload) {
  if (loading) {
    return <div className="loading">{message || '正在加载版本...'}</div>;
  }
  if (message && tone) {
    return <RuntimeNotice message={message} tone={tone} />;
  }
  if (!versions.length) {
    return <div className="loading">{message || '暂无版本'}</div>;
  }
  const ownerVersionByKey = new Map<string, AnyRecord>();
  for (const item of ownerVersions) {
    ownerVersionByKey.set(
      `${toText(item.skillId)}@${toText(item.latestVersion, toText(item.version))}`,
      item,
    );
  }
  return (
    <>
      {versions.map((item, index) => {
        const version = toText(item.latestVersion, toText(item.version));
        const ownerVersion = ownerVersionByKey.get(`${skillId}@${version}`);
        const packageVersionId = toText(ownerVersion?.packageVersionId, toText(ownerVersion?.id));
        const ownerStatus = toText(toRecord(ownerVersion)?.status, toText(item.status, 'published'));
        const publishedStatus = ownerStatus !== 'published' ? ownerStatus : 'published';
        return (
          <div className="portal-row" key={`${version || 'version'}-${index}`}>
            <strong>v{version || '-'}</strong>
            <div className="skill-meta">
              <span className={`tag ${publishedStatus === 'published' ? 'green' : 'warm'}`}>{publishedStatus}</span>
              {item.publishedAt ? <span className="tag">{toText(item.publishedAt)}</span> : null}
              <span className="tag">下载 {Number(item.downloadCount || 0)}</span>
            </div>
            <div className="config-actions" style={{ marginTop: 10 }}>
              <button
                className="btn btn-primary"
                disabled={!version}
                data-skillhub-install={version ? 'true' : undefined}
                data-skill-id={version ? skillId : undefined}
                data-version={version || undefined}
                onClick={() => window.installSkillHubSkill?.(skillId, version || undefined)}
              >
                安装此版本
              </button>
              {packageVersionId && ownerStatus === 'published' ? (
                <button
                  className="btn btn-danger"
                  data-skillhub-yank-version="true"
                  data-package-version-id={packageVersionId}
                  onClick={() => window.yankOwnSkillHubVersion?.(packageVersionId)}
                >
                  下架版本
                </button>
              ) : null}
              {packageVersionId && ownerStatus !== 'published' ? (
                <button
                  className="btn btn-success"
                  data-skillhub-restore-version="true"
                  data-package-version-id={packageVersionId}
                  onClick={() => window.restoreOwnSkillHubVersion?.(packageVersionId)}
                >
                  重新公开
                </button>
              ) : null}
              {packageVersionId ? (
                <button
                  className="btn btn-danger"
                  data-skillhub-delete-version="true"
                  data-package-version-id={packageVersionId}
                  onClick={() => window.deleteOwnSkillHubVersion?.(packageVersionId)}
                >
                  删除版本
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

function UpdateStatusBody({
  availableVersion = '-',
  canCheck = true,
  canDownload = true,
  canInstall = true,
  checkLabel = '检查更新',
  currentVersion = '-',
  downloadLabel = '下载更新',
  errorText = '',
  fallbackNote = '',
  installLabel = '安装并重启',
  manualUrl = '',
  message = '更新器已就绪。',
  percentLabel = '0%',
  progressPercent = 0,
  releaseUrl = '',
  showDownload = false,
  showFallback = false,
  showInstall = false,
  sizeLabel = '0 B / 0 B',
  speedLabel = '0 B/s',
  stageBg = 'rgba(30,169,113,0.15)',
  stageColor = '#1ea971',
  stageLabel = '待机',
}: UpdateStatusPayload) {
  const progress = Math.max(0, Math.min(100, Number(progressPercent || 0)));
  return (
    <>
      <div className="update-status-pill" id="update-stage" style={{ background: stageBg, color: stageColor }}>
        {stageLabel}
      </div>
      <div className="update-message" id="update-message">
        {message}
      </div>

      <div className="update-version-line">
        <span>当前版本</span>
        <code id="update-current-version">{currentVersion || '-'}</code>
      </div>
      <div className="update-version-line">
        <span>最新版本</span>
        <code id="update-available-version">{availableVersion || '-'}</code>
      </div>

      <div className="update-progress-wrap">
        <div className="update-progress-track">
          <div className="update-progress-bar" id="update-progress-bar" style={{ width: `${progress.toFixed(1)}%` }} />
        </div>
        <div className="update-progress-meta">
          <span id="update-percent">{percentLabel}</span>
          <span id="update-speed">{speedLabel}</span>
          <span id="update-size">{sizeLabel}</span>
        </div>
      </div>

      <div className="update-error-box" id="update-error-box" style={{ display: errorText ? 'block' : 'none' }}>
        {errorText}
      </div>

      <div className="update-fallback-box" id="update-fallback-box" style={{ display: showFallback ? 'block' : 'none' }}>
        <div className="update-fallback-title">自动更新失败时，可先手动获取最新安装包。</div>
        <div className="update-fallback-actions">
          <button
            className="btn btn-ghost"
            id="update-copy-manual-btn"
            onClick={() => window.copyManualInstallerUrl?.(manualUrl)}
            style={{ display: manualUrl ? 'inline-flex' : 'none' }}
          >
            复制安装包地址
          </button>
          <button
            className="btn btn-ghost"
            id="update-copy-release-btn"
            onClick={() => window.copyReleasePageUrl?.(releaseUrl)}
            style={{ display: releaseUrl ? 'inline-flex' : 'none' }}
          >
            复制 GitHub 发布页
          </button>
        </div>
        <div className="update-fallback-note" id="update-fallback-note">
          {fallbackNote}
        </div>
      </div>

      <div className="update-actions">
        <button className="btn" disabled={!canCheck} id="update-check-btn" onClick={() => window.checkForUpdates?.()}>
          {checkLabel}
        </button>
        <button
          className="btn btn-primary"
          disabled={!canDownload}
          id="update-download-btn"
          onClick={() => window.downloadUpdate?.()}
          style={{ display: showDownload ? 'inline-block' : 'none' }}
        >
          {downloadLabel}
        </button>
        <button
          className="btn btn-success"
          disabled={!canInstall}
          id="update-install-btn"
          onClick={() => window.installUpdate?.()}
          style={{ display: showInstall ? 'inline-block' : 'none' }}
        >
          {installLabel}
        </button>
      </div>
    </>
  );
}

function GlobalModals({ state }: { state: GlobalModalsState }) {
  useEffect(() => {
    const hasOpenModal = Object.values(state.modalOpen).some(Boolean);
    if (!hasOpenModal) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeGlobalModals();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [state.modalOpen.logs, state.modalOpen.mediaPreview, state.modalOpen.skillHubVersions, state.modalOpen.update]);

  return (
    <>
      <div className={modalOverlayClass(state.modalOpen.logs)} id="logs-modal">
        <div className="modal">
          <div className="modal-header">
            <h3 id="logs-title" data-react-logs-title="mounted">
              {state.logsTitle || '日志'}
            </h3>
            <button className="modal-close" onClick={() => setGlobalModalOpen('logs', false)}>
              &times;
            </button>
          </div>
          <div className="modal-body" id="logs-body" data-react-logs-body="mounted">
            <LogsBody {...state.logsBody} />
          </div>
        </div>
      </div>

      <div className={modalOverlayClass(state.modalOpen.skillHubVersions)} id="skillhub-versions-modal">
        <div className="modal">
          <div className="modal-header">
            <h3 id="skillhub-versions-title" data-react-skillhub-versions-title="mounted">
              SkillHub Versions: {state.skillHubVersions.skillId || '-'}
            </h3>
            <button className="modal-close" onClick={() => setGlobalModalOpen('skillHubVersions', false)}>
              &times;
            </button>
          </div>
          <div className="modal-body" data-react-skillhub-versions="mounted" id="skillhub-versions-body">
            <SkillHubVersionsList {...state.skillHubVersions} />
          </div>
        </div>
      </div>

      <div className={modalOverlayClass(state.modalOpen.update)} id="update-modal">
        <div className="modal">
          <div className="modal-header">
            <h3>更新中心</h3>
            <button className="modal-close" onClick={() => window.closeUpdateModal?.()}>
              &times;
            </button>
          </div>
          <div className="modal-body" id="update-body" data-react-update-status="mounted">
            <UpdateStatusBody {...state.updateStatus} />
          </div>
        </div>
      </div>

      <div className={modalOverlayClass(state.modalOpen.mediaPreview)} id="media-preview-modal">
        <div className="modal">
          <div className="modal-header">
            <h3 id="media-preview-title" data-react-media-preview-title="mounted">
              {state.mediaPreview.title || '预览'}
            </h3>
            <button className="modal-close" onClick={() => window.closeCatsMediaPreview?.()}>
              &times;
            </button>
          </div>
          <div className="modal-body" id="media-preview-body" data-react-media-preview="mounted">
            <MediaPreviewBody {...state.mediaPreview} />
          </div>
        </div>
      </div>
    </>
  );
}

function LogsBody(payload: LogsBodyPayload) {
  if (payload.kind === 'weixin-qr') {
    const agentName = payload.agentName || '当前 Agent';
    return (
      <div style={{ padding: 20, textAlign: 'center' }}>
        <p style={{ color: 'var(--text)', fontWeight: 800, marginBottom: 8 }}>绑定到 {agentName}</p>
        <p style={{ color: 'var(--text2)', marginBottom: 16 }}>
          请用微信扫描下方二维码授权。授权成功后，微信消息会进入这个 Agent。
        </p>
        <a
          href={payload.href}
          style={{
            background: 'var(--accent-gradient)',
            borderRadius: 12,
            color: 'white',
            display: 'inline-block',
            fontWeight: 700,
            padding: '12px 20px',
            textDecoration: 'none',
          }}
          target="_blank"
          rel="noopener noreferrer"
        >
          点击打开二维码
        </a>
        <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 16 }}>等待扫码中...</p>
      </div>
    );
  }

  if (payload.kind === 'weixin-success') {
    return (
      <div style={{ color: 'var(--green)', padding: 20, textAlign: 'center' }}>
        <p style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>授权成功</p>
        <p>{payload.message || '微信通道已绑定，Token 已保存到本地环境。'}</p>
      </div>
    );
  }

  if (payload.kind === 'weixin-expired') {
    return <div style={{ color: 'var(--red)', padding: 20, textAlign: 'center' }}>二维码已过期，请重新获取</div>;
  }

  const color = payload.tone === 'error' ? 'var(--red)' : payload.tone === 'success' ? 'var(--green)' : undefined;
  return <span style={color ? { color } : undefined}>{payload.text}</span>;
}

function MediaPreviewBody({ src = '', title = 'image' }: MediaPreviewPayload) {
  if (!src) return null;
  return <img className="media-preview-image" id="media-preview-image" src={src} alt={title || 'image'} />;
}

function renderGlobalModals() {
  if (!globalModalsElement) return;
  globalModalsRoot ??= createRoot(globalModalsElement);
  globalModalsRoot?.render(<GlobalModals state={globalModalsState} />);
  globalModalsElement.dataset.reactGlobalModals = 'mounted';
}

function renderLogsBody(payload: LogsBodyPayload) {
  globalModalsState = { ...globalModalsState, logsBody: payload };
  renderGlobalModals();
}

function renderLogsTitle(text: string) {
  globalModalsState = { ...globalModalsState, logsTitle: text || '日志' };
  renderGlobalModals();
}

function renderMediaPreview(payload: MediaPreviewPayload) {
  globalModalsState = { ...globalModalsState, mediaPreview: { src: payload.src || '', title: payload.title || '图片预览' } };
  renderGlobalModals();
}

function renderSkillHubVersions(payload: SkillHubVersionsPayload) {
  globalModalsState = { ...globalModalsState, skillHubVersions: payload };
  renderGlobalModals();
}

function renderUpdateStatus(payload: UpdateStatusPayload) {
  globalModalsState = { ...globalModalsState, updateStatus: payload };
  renderGlobalModals();
}

function setGlobalModalOpen(name: GlobalModalName, open: boolean) {
  if (!isGlobalModalName(name)) return;
  globalModalsState = {
    ...globalModalsState,
    modalOpen: {
      ...globalModalsState.modalOpen,
      [name]: Boolean(open),
    },
  };
  renderGlobalModals();
}

function closeGlobalModals() {
  if (globalModalsState.modalOpen.update) window.closeUpdateModal?.();
  if (globalModalsState.modalOpen.mediaPreview) window.closeCatsMediaPreview?.();
  globalModalsState = {
    ...globalModalsState,
    modalOpen: {
      logs: false,
      mediaPreview: false,
      skillHubVersions: false,
      update: false,
    },
  };
  renderGlobalModals();
}

export function mountGlobalModals() {
  const root = document.getElementById('global-modals-root');
  if (root) {
    globalModalsElement = root;
    renderGlobalModals();
  }
  window.__catscoRenderLogsBody = renderLogsBody;
  window.__catscoRenderLogsTitle = renderLogsTitle;
  window.__catscoRenderMediaPreview = renderMediaPreview;
  window.__catscoRenderSkillHubVersions = renderSkillHubVersions;
  window.__catscoRenderUpdateStatus = renderUpdateStatus;
  window.__catscoSetGlobalModalOpen = setGlobalModalOpen;
}
