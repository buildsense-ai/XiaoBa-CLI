import React, { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type PetProcessItem = {
  detail?: string;
  time?: string;
  title: string;
};

type PetProcessPayload = {
  floatingItems?: PetProcessItem[];
  pageItems?: PetProcessItem[];
};

type PetUnlockPayload = {
  currentXp: number;
  meta: string;
  name: string;
  remaining: number;
  statLabel: string;
  tagLabel: string;
};

type PetProfilePayload = {
  floatingLevelLabel?: string;
  formLabel?: string;
  levelLabel?: string;
  name?: string;
  skillXpLabel?: string;
  titleLabel?: string;
  todayXpLabel?: string;
  xpLabel?: string;
  xpPercent?: number;
};

type PetStatePayload = {
  companionBubble?: string;
  floatingBubble?: string;
  panelState?: string;
  stateCopy?: string;
  stateLabel?: string;
};

type PetFrameStripPayload = {
  frames?: string[];
};

type PetFramePayload = {
  src?: string;
};

type PetActionUiPayload = {
  activeState?: string;
  previewState?: string;
};

type FloatingPetUiPayload = {
  bubbleVisible?: boolean;
  dragging?: boolean;
  open?: boolean;
  positioned?: boolean;
  x?: number;
  y?: number;
};

type FloatingPetUiState = {
  bubbleVisible: boolean;
  dragging: boolean;
  open: boolean;
  positioned: boolean;
  x?: number;
  y?: number;
};

type FloatingPetRect = {
  height: number;
  left: number;
  top: number;
  width: number;
};

type CompanionPageState = {
  floatingFrameSrc: string;
  floatingUi: FloatingPetUiState;
  frameStrip: PetFrameStripPayload;
  petActionUi: PetActionUiPayload;
  pageFrameSrc: string;
  petState: PetStatePayload;
  process: PetProcessPayload;
  profile: PetProfilePayload;
  unlock: PetUnlockPayload;
};

declare global {
  interface Window {
    __catscoRenderPetProfile?: (payload: PetProfilePayload) => void;
    __catscoRenderPetProcess?: (payload: PetProcessPayload) => void;
    __catscoRenderPetFrameStrip?: (payload: PetFrameStripPayload) => void;
    __catscoRenderPetFrame?: (payload: PetFramePayload) => void;
    __catscoRenderPetActionUi?: (payload: PetActionUiPayload) => void;
    __catscoRenderPetState?: (payload: PetStatePayload) => void;
    __catscoRenderPetUnlock?: (payload: PetUnlockPayload) => void;
    __catscoRenderFloatingPetUi?: (payload: FloatingPetUiPayload) => void;
    __catscoGetFloatingPetRect?: () => FloatingPetRect | null;
    clampFloatingPetToViewport?: (rect?: FloatingPetRect) => void;
    clearPetProcess?: () => void;
    closeFloatingPetMenu?: () => void;
    endFloatingPetDrag?: (event: PointerEvent, handle: HTMLElement, rect?: FloatingPetRect) => void;
    handlePetActionPreviewKey?: (event: KeyboardEvent, state: string) => void;
    moveFloatingPetDrag?: (event: PointerEvent) => void;
    previewPetAction?: (state: string) => void;
    resetFloatingPetPosition?: () => void;
    startFloatingPetDrag?: (event: PointerEvent, handle: HTMLElement, rect?: FloatingPetRect) => void;
    switchPage?: (name: string) => void;
    toggleFloatingPetMenu?: () => void;
  }
}

let companionPageRoot: Root | undefined;
let companionPageElement: HTMLElement | null = null;
let floatingPetRoot: Root | undefined;
let floatingPetElement: HTMLElement | null = null;
let companionPageState: CompanionPageState = {
  floatingFrameSrc: 'pet/idle/01.png',
  floatingUi: {
    bubbleVisible: false,
    dragging: false,
    open: false,
    positioned: false,
  },
  frameStrip: { frames: [] },
  petActionUi: { activeState: 'idle', previewState: '' },
  pageFrameSrc: 'pet/idle/01.png',
  petState: {
    companionBubble: '等待下一项任务',
    floatingBubble: '待机中',
    panelState: 'idle',
    stateCopy: '正在等待下一项任务。',
    stateLabel: '待机中',
  },
  process: { floatingItems: [], pageItems: [] },
  profile: {
    floatingLevelLabel: 'Lv.1',
    formLabel: '基础小猫',
    levelLabel: 'Lv.1',
    name: 'CatsCo',
    skillXpLabel: '0 次',
    titleLabel: '新手伙伴',
    todayXpLabel: '0 XP',
    xpLabel: '0 / 50 XP',
    xpPercent: 0,
  },
  unlock: {
    currentXp: 0,
    meta: '宠物会显示正在调用哪一个 skill。',
    name: 'Lv.2 Skill 气泡',
    remaining: 50,
    statLabel: '0 / 50 XP',
    tagLabel: 'Lv.2',
  },
};

const PET_ACTIONS = [
  { frames: '4 帧', label: '待机', state: 'idle' },
  { frames: '4 帧', label: '思考', state: 'thinking' },
  { frames: '6 帧', label: '输入', state: 'typing' },
  { frames: '4 帧', label: '成功', state: 'success' },
  { frames: '4 帧', label: '错误', state: 'error' },
];

function PetActionButton({
  active,
  action,
  previewing,
}: {
  active?: boolean;
  action: (typeof PET_ACTIONS)[number];
  previewing?: boolean;
}) {
  const className = `pet-action${active ? ' active' : ''}${previewing ? ' previewing' : ''}`;
  return (
    <div
      className={className}
      onClick={() => window.previewPetAction?.(action.state)}
      onKeyDown={event => window.handlePetActionPreviewKey?.(event.nativeEvent, action.state)}
      role="button"
      tabIndex={0}
    >
      {action.label}
      <span>{action.frames}</span>
    </div>
  );
}

function floatingPetClassName(ui: FloatingPetUiState) {
  return [
    'floating-pet',
    ui.bubbleVisible ? 'show-bubble' : '',
    ui.open ? 'open' : '',
    ui.positioned ? 'positioned' : '',
    ui.dragging ? 'dragging' : '',
  ].filter(Boolean).join(' ');
}

function floatingPetStyle(ui: FloatingPetUiState): React.CSSProperties {
  if (!ui.positioned) return {};
  return {
    bottom: 'auto',
    left: `${Number(ui.x || 0)}px`,
    right: 'auto',
    top: `${Number(ui.y || 0)}px`,
  };
}

function PetFrameStrip({ frames = [] }: PetFrameStripPayload) {
  return (
    <>
      {frames.map((src, index) => (
        <img alt="" className="pet-frame-thumb" key={`${src}-${index}`} src={src} />
      ))}
    </>
  );
}

function PetXpBar({ percent = 0 }: { percent?: number }) {
  const width = Math.max(0, Math.min(100, Number(percent || 0)));
  return <div className="companion-xp-bar" id="pet-xp-bar" style={{ width: `${width}%` }} />;
}

function PetProcessList({ items = [], variant }: { items?: PetProcessItem[]; variant: 'floating' | 'page' }) {
  if (!items.length) {
    return (
      <div className="companion-process-item">
        <span className="companion-process-dot" />
        <div>
          <div className="companion-process-title">No recent work</div>
          {variant === 'floating' ? (
            <div className="companion-process-detail">
              Short work notes will appear here when the companion starts thinking, running, or reporting issues.
            </div>
          ) : null}
        </div>
        {variant === 'floating' ? <span className="companion-process-time">--:--</span> : null}
      </div>
    );
  }

  return (
    <>
      {items.map((item, index) => (
        <div className="companion-process-item" key={`${item.title}-${item.time}-${index}`}>
          <span className="companion-process-dot" />
          <div>
            <div className="companion-process-title">
              {variant === 'page' && item.time ? <span className="companion-process-time">{item.time}</span> : null}
              {variant === 'page' && item.time ? ' ' : ''}
              {item.title}
            </div>
            {variant === 'floating' ? <div className="companion-process-detail">{item.detail || ''}</div> : null}
          </div>
          {variant === 'floating' ? <span className="companion-process-time">{item.time || '--:--'}</span> : null}
        </div>
      ))}
    </>
  );
}

function PetUnlockCard({ currentXp, meta, name, remaining, statLabel }: PetUnlockPayload) {
  return (
    <>
      <div className="companion-next-name">{name}</div>
      <div className="companion-next-copy">{meta}</div>
      <div className="companion-next-stats">
        <div className="companion-next-stat">
          <span>Current XP</span>
          <strong>{statLabel}</strong>
        </div>
        <div className="companion-next-stat">
          <span>Remaining</span>
          <strong>{remaining} XP</strong>
        </div>
      </div>
    </>
  );
}

function FloatingPet({ state }: { state: CompanionPageState }) {
  const petState = state.petState;
  const shellRef = useRef<HTMLDivElement | null>(null);
  const floatingPetRect = () => {
    const rect = shellRef.current?.getBoundingClientRect();
    return rect
      ? { height: rect.height, left: rect.left, top: rect.top, width: rect.width }
      : null;
  };

  useEffect(() => {
    window.__catscoGetFloatingPetRect = floatingPetRect;
    const closeIfOutside = (event: MouseEvent) => {
      const shell = shellRef.current;
      if (!shell || !(event.target instanceof Node) || shell.contains(event.target)) return;
      window.closeFloatingPetMenu?.();
    };
    const clampToViewport = () => {
      window.clampFloatingPetToViewport?.(floatingPetRect() || undefined);
    };
    document.addEventListener('click', closeIfOutside);
    window.addEventListener('resize', clampToViewport);
    return () => {
      document.removeEventListener('click', closeIfOutside);
      window.removeEventListener('resize', clampToViewport);
      if (window.__catscoGetFloatingPetRect === floatingPetRect) delete window.__catscoGetFloatingPetRect;
    };
  }, []);

  return (
    <div
      className={floatingPetClassName(state.floatingUi)}
      id="floating-pet"
      aria-live="polite"
      ref={shellRef}
      style={floatingPetStyle(state.floatingUi)}
    >
      <div className="floating-pet-bubble" id="floating-pet-bubble">
        {petState.floatingBubble || petState.companionBubble || petState.stateCopy || 'idle'}
      </div>
      <div className="floating-pet-panel" id="floating-pet-panel">
        <div className="floating-pet-panel-head">
          <div>
            <div className="floating-pet-panel-title">最近工作</div>
            <div className="floating-pet-panel-subtitle" id="floating-pet-panel-state">
              {petState.panelState || petState.stateLabel || 'idle'}
            </div>
          </div>
          <span className="pet-state-pill" id="floating-pet-panel-level">
            {state.profile.floatingLevelLabel || state.profile.levelLabel || 'Lv.1'}
          </span>
        </div>
        <div className="companion-process-list" data-react-pet-process="mounted" id="floating-process-list">
          <PetProcessList items={state.process.floatingItems || []} variant="floating" />
        </div>
        <div className="floating-pet-panel-actions">
          <button
            type="button"
            onClick={() => {
              window.switchPage?.('companion');
              window.closeFloatingPetMenu?.();
            }}
          >
            打开伙伴页
          </button>
          <button type="button" onClick={() => window.resetFloatingPetPosition?.()}>
            归位
          </button>
          <button type="button" onClick={() => window.clearPetProcess?.()}>
            清空
          </button>
        </div>
      </div>
      <button
        className="floating-pet-button"
        id="floating-pet-button"
        type="button"
        aria-label="CatsCo 悬浮伙伴"
        onDragStart={event => event.preventDefault()}
        onClick={() => window.toggleFloatingPetMenu?.()}
        onPointerCancel={event => window.endFloatingPetDrag?.(event.nativeEvent, event.currentTarget, floatingPetRect() || undefined)}
        onPointerDown={event => window.startFloatingPetDrag?.(event.nativeEvent, event.currentTarget, floatingPetRect() || undefined)}
        onPointerMove={event => window.moveFloatingPetDrag?.(event.nativeEvent)}
        onPointerUp={event => window.endFloatingPetDrag?.(event.nativeEvent, event.currentTarget, floatingPetRect() || undefined)}
      >
        <img className="floating-pet-frame" id="floating-pet-frame" src={state.floatingFrameSrc} alt="" draggable="false" />
      </button>
    </div>
  );
}

function renderCompanionViews() {
  if (companionPageElement) {
    companionPageRoot ??= createRoot(companionPageElement);
    companionPageRoot?.render(<CompanionPage state={companionPageState} />);
    companionPageElement.dataset.reactCompanion = 'mounted';
  }
  if (floatingPetElement) {
    floatingPetRoot ??= createRoot(floatingPetElement);
    floatingPetRoot?.render(<FloatingPet state={companionPageState} />);
    floatingPetElement.dataset.reactFloatingPet = 'mounted';
  }
}

function renderPetProfile(payload: PetProfilePayload) {
  companionPageState = { ...companionPageState, profile: { ...companionPageState.profile, ...payload } };
  renderCompanionViews();
}

function renderPetState(payload: PetStatePayload) {
  companionPageState = { ...companionPageState, petState: { ...companionPageState.petState, ...payload } };
  renderCompanionViews();
}

function renderPetFrame({ src = '' }: PetFramePayload) {
  if (!src) return;
  companionPageState = {
    ...companionPageState,
    floatingFrameSrc: src,
    pageFrameSrc: src,
  };
  renderCompanionViews();
}

function renderPetActionUi(payload: PetActionUiPayload) {
  companionPageState = {
    ...companionPageState,
    petActionUi: {
      ...companionPageState.petActionUi,
      ...payload,
    },
  };
  renderCompanionViews();
}

function renderFloatingPetUi(payload: FloatingPetUiPayload) {
  companionPageState = {
    ...companionPageState,
    floatingUi: {
      ...companionPageState.floatingUi,
      ...payload,
    },
  };
  renderCompanionViews();
}

function CompanionPage({ state }: { state: CompanionPageState }) {
  const profile = state.profile;
  const petState = state.petState;
  return (
    <>
      <div className="settings-header">
        <div className="settings-heading">
          <div className="settings-kicker">Companion Hub</div>
          <div className="section-title" style={{ marginBottom: 0 }}>
            伙伴 <span className="badge">动作库 22 帧</span>
          </div>
        </div>
      </div>

      <div className="companion-hero">
        <section className="pet-stage companion-card companion-profile-card" aria-label="CatsCo 宠物伙伴">
          <div className="companion-profile-head">
            <div>
              <div className="companion-eyebrow">CatsCo Companion</div>
              <div className="companion-name" data-react-pet-profile="mounted" id="pet-profile-name">
                {profile.name || 'CatsCo'}
              </div>
            </div>
            <span className="pet-state-pill" data-react-pet-state="mounted" id="pet-state-pill">
              {petState.stateLabel || '待机中'}
            </span>
          </div>

          <div className="companion-level-title">
            <span data-react-pet-profile="mounted" id="pet-level-label">{profile.levelLabel || 'Lv.1'}</span>
            <span data-react-pet-profile="mounted" id="pet-title-label">{profile.titleLabel || '新手伙伴'}</span>
          </div>
          <div className="companion-state-copy" data-react-pet-state="mounted" id="pet-state-copy">
            {petState.stateCopy || '正在等待下一项任务。'}
          </div>

          <div className="companion-pet-visual" id="companion-pet-visual">
            <div className="companion-pet-bubble" data-react-pet-state="mounted" id="companion-pet-bubble">
              {petState.companionBubble || petState.stateCopy || '等待下一项任务'}
            </div>
            <img className="pet-frame" id="pet-frame" src={state.pageFrameSrc} alt="CatsCo companion" />
          </div>

          <div className="companion-level">
            <div className="companion-level-meta">
              <span>等级进度</span>
              <span data-react-pet-profile="mounted" id="pet-xp-label">{profile.xpLabel || '0 / 50 XP'}</span>
            </div>
            <div className="companion-xp-track" data-react-pet-profile="mounted" id="pet-xp-track">
              <PetXpBar percent={profile.xpPercent || 0} />
            </div>
          </div>
        </section>

        <aside className="companion-side-stack">
          <section className="companion-card companion-next-card">
            <div className="companion-section-head">
              <div className="companion-section-title">下一解锁</div>
              <span className="tag" data-react-pet-unlock="mounted" id="companion-next-level-tag">
                {state.unlock.tagLabel || 'Lv.2'}
              </span>
            </div>
            <div data-react-pet-unlock="mounted" id="companion-next-unlock">
              <PetUnlockCard {...state.unlock} />
            </div>
          </section>

          <section className="companion-card companion-summary-card">
            <div className="companion-section-head">
              <div className="companion-section-title">成长摘要</div>
            </div>
            <div className="companion-metrics">
              <div className="companion-metric">
                <div className="companion-metric-label">今日成长</div>
                <div className="companion-metric-value" data-react-pet-profile="mounted" id="pet-today-xp">
                  {profile.todayXpLabel || '0 XP'}
                </div>
              </div>
              <div className="companion-metric">
                <div className="companion-metric-label">能力调用</div>
                <div className="companion-metric-value" data-react-pet-profile="mounted" id="pet-skill-xp">
                  {profile.skillXpLabel || '0 次'}
                </div>
              </div>
              <div className="companion-metric">
                <div className="companion-metric-label">当前形态</div>
                <div className="companion-metric-value" data-react-pet-profile="mounted" id="pet-form-label">
                  {profile.formLabel || '基础小猫'}
                </div>
              </div>
            </div>
          </section>

          <section className="companion-card companion-recent-card">
            <div className="companion-section-head">
              <div className="companion-section-title">最近工作</div>
              <button className="companion-text-action" type="button" onClick={() => window.clearPetProcess?.()}>
                清空
              </button>
            </div>
            <div className="companion-process-list" data-react-pet-process="mounted" id="companion-process-list">
              <PetProcessList items={state.process.pageItems || []} variant="page" />
            </div>
          </section>

          <section className="companion-card companion-actions-card">
            <div className="companion-action-library">
              <div className="companion-section-head">
                <div className="companion-section-title">当前动作库</div>
                <span className="tag">22 帧</span>
              </div>
              <div className="pet-action-grid companion-action-tags">
                {PET_ACTIONS.map(action => (
                  <PetActionButton
                    active={state.petActionUi.activeState === action.state}
                    action={action}
                    key={action.state}
                    previewing={state.petActionUi.previewState === action.state}
                  />
                ))}
              </div>
              <div className="pet-frame-strip" data-react-pet-frame-strip="mounted" id="pet-frame-strip">
                <PetFrameStrip {...state.frameStrip} />
              </div>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

function renderPetProcessLists(payload: PetProcessPayload) {
  companionPageState = { ...companionPageState, process: payload };
  renderCompanionViews();
}

function renderPetUnlock(payload: PetUnlockPayload) {
  companionPageState = { ...companionPageState, unlock: payload };
  renderCompanionViews();
}

function renderPetFrameStrip(payload: PetFrameStripPayload) {
  companionPageState = { ...companionPageState, frameStrip: payload };
  renderCompanionViews();
}

function mountFloatingPet() {
  const root = document.getElementById('floating-pet-root');
  if (!root) return;
  floatingPetElement = root;
}

export function mountCompanionPage() {
  const root = document.getElementById('companion-page-root');
  if (!root) return;
  companionPageElement = root;
  mountFloatingPet();
  renderCompanionViews();
  window.__catscoRenderPetProfile = renderPetProfile;
  window.__catscoRenderPetProcess = renderPetProcessLists;
  window.__catscoRenderPetFrameStrip = renderPetFrameStrip;
  window.__catscoRenderPetFrame = renderPetFrame;
  window.__catscoRenderPetActionUi = renderPetActionUi;
  window.__catscoRenderPetState = renderPetState;
  window.__catscoRenderPetUnlock = renderPetUnlock;
  window.__catscoRenderFloatingPetUi = renderFloatingPetUi;
}
