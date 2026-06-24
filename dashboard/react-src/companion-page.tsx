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

type PromptCompanionSignals = {
  recent_events?: number;
  recent_runtime_errors?: number;
  recent_runtime_warnings?: number;
  recent_session_turns?: number;
};

type PromptCompanionAdvisor = {
  evidence?: string;
  issue?: string;
  message?: string;
  suggestion?: string;
};

type PromptCompanionProposal = {
  change_summary?: string;
  evidence?: string;
  id?: string;
  issue?: string;
  operation?: string;
  path?: string;
  preview?: string;
  proposed_content?: string;
  reason?: string;
  risk?: string;
  signals?: PromptCompanionSignals;
  title?: string;
};

type PromptCompanionPayload = {
  advisor?: PromptCompanionAdvisor | null;
  advisorNotice?: string;
  error?: string;
  loading?: boolean;
  proposal?: PromptCompanionProposal | null;
  signals?: PromptCompanionSignals | null;
};

type PromptCompanionState = PromptCompanionPayload & {
  note: string;
};

type CompanionPageState = {
  floatingFrameSrc: string;
  floatingUi: FloatingPetUiState;
  frameStrip: PetFrameStripPayload;
  petActionUi: PetActionUiPayload;
  pageFrameSrc: string;
  petState: PetStatePayload;
  promptCompanion: PromptCompanionState;
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
    __catscoRenderPromptCompanion?: (payload: PromptCompanionPayload) => void;
    __catscoGetPromptCompanionNote?: () => string;
    __catscoClearPromptCompanionNote?: () => void;
    __catscoGetFloatingPetRect?: () => FloatingPetRect | null;
    clampFloatingPetToViewport?: (rect?: FloatingPetRect) => void;
    clearPetProcess?: () => void;
    closeFloatingPetMenu?: () => void;
    applyPromptCompanionProposal?: () => void;
    dismissPromptCompanionProposal?: () => void;
    endFloatingPetDrag?: (event: PointerEvent, handle: HTMLElement, rect?: FloatingPetRect) => void;
    fetchPromptCompanionProposal?: (manual?: boolean) => void;
    handlePetActionPreviewKey?: (event: KeyboardEvent, state: string) => void;
    moveFloatingPetDrag?: (event: PointerEvent) => void;
    openPromptCompanionPanel?: () => void;
    previewPromptCompanionProposal?: () => void;
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
  promptCompanion: {
    advisor: null,
    advisorNotice: '',
    error: '',
    loading: false,
    note: '',
    proposal: null,
    signals: null,
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

function promptSignalCount(signals: PromptCompanionSignals | null | undefined, key: keyof PromptCompanionSignals) {
  const value = Number(signals?.[key] || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function buildPromptCompanionNoProposalCopy(signals?: PromptCompanionSignals | null) {
  const turns = promptSignalCount(signals, 'recent_session_turns');
  const runtimeErrors = promptSignalCount(signals, 'recent_runtime_errors');
  const runtimeWarnings = promptSignalCount(signals, 'recent_runtime_warnings');
  const events = promptSignalCount(signals, 'recent_events');
  const checked = `Checked ${turns} recent turns, ${runtimeErrors} runtime errors, ${runtimeWarnings} runtime warnings, and ${events} companion events`;
  if (runtimeErrors > 0 || runtimeWarnings > 0 || events > 0) {
    return `${checked}. Runtime signals exist, but there is no safe prompt patch yet. Ask a more specific question below to help the advisor localize it.`;
  }
  return `${checked}. No stable prompt issue was found yet.`;
}

function promptOperationLabel(operation?: string) {
  if (operation === 'replace') return 'replace';
  if (operation === 'delete') return 'delete';
  return 'append';
}

function PromptCompanionLine({ label, value }: { label: string; value?: string }) {
  const text = String(value || '').trim();
  if (!text) return null;
  return (
    <div>
      <strong>{label}: </strong>
      {text}
    </div>
  );
}

function PromptCompanionStage({ title, children }: { children?: React.ReactNode; title: string }) {
  if (!children) return null;
  return (
    <div className="companion-prompt-stage">
      <div className="companion-prompt-stage-title">{title}</div>
      <div className="companion-prompt-stage-body">{children}</div>
    </div>
  );
}

function PromptCompanionAdvisorNotice({ advisor, notice }: { advisor?: PromptCompanionAdvisor | null; notice?: string }) {
  const message = String(advisor?.message || notice || '').trim();
  const issue = String(advisor?.issue || '').trim();
  const evidence = String(advisor?.evidence || '').trim();
  const suggestion = String(advisor?.suggestion || '').trim();
  if (!message && !issue && !evidence && !suggestion) return null;
  if (!advisor) {
    return (
      <div className="runtime-note">
        <strong>Advisor reply:</strong>
        <br />
        {message}
      </div>
    );
  }
  return (
    <>
      <PromptCompanionStage title="1. Issue">
        <PromptCompanionLine label="Issue" value={issue} />
        <PromptCompanionLine label="Evidence" value={evidence} />
        {message ? <div>{message}</div> : null}
      </PromptCompanionStage>
      {suggestion ? (
        <PromptCompanionStage title="Next question">
          <div>{suggestion}</div>
        </PromptCompanionStage>
      ) : null}
    </>
  );
}

function PromptCompanionProposalView({
  advisor,
  notice,
  proposal,
  signals,
}: {
  advisor?: PromptCompanionAdvisor | null;
  notice?: string;
  proposal: PromptCompanionProposal;
  signals?: PromptCompanionSignals | null;
}) {
  const mergedSignals = proposal.signals || signals || {};
  const signalCopy = `Signals: ${promptSignalCount(mergedSignals, 'recent_session_turns')} turns, ${promptSignalCount(
    mergedSignals,
    'recent_runtime_errors',
  )} runtime errors, ${promptSignalCount(mergedSignals, 'recent_runtime_warnings')} runtime warnings, ${promptSignalCount(
    mergedSignals,
    'recent_events',
  )} companion events`;
  const issue = proposal.issue || proposal.reason || 'The advisor found a prompt issue that can be improved with a small patch.';
  const evidence = proposal.evidence || signalCopy.replace(/^Signals: /, '');
  const changeSummary = proposal.change_summary || proposal.reason || 'Generated a small previewable diff.';
  return (
    <>
      <PromptCompanionAdvisorNotice advisor={advisor} notice={notice} />
      <div className="companion-prompt-title">{proposal.title || 'Prompt tuning suggestion'}</div>
      <PromptCompanionStage title="1. Issue">
        <PromptCompanionLine label="Issue" value={issue} />
        <PromptCompanionLine label="Evidence" value={evidence} />
        <div>{signalCopy}</div>
      </PromptCompanionStage>
      <PromptCompanionStage title="2. Proposed change">
        <div>
          Target: <code>{proposal.path || 'system-prompt.md'}</code> - {promptOperationLabel(proposal.operation)}
        </div>
        <PromptCompanionLine label="Change" value={changeSummary} />
        <PromptCompanionLine label="Reason" value={proposal.reason || 'The advisor proposed a small prompt change.'} />
        <div className="companion-prompt-preview">{proposal.preview || ''}</div>
      </PromptCompanionStage>
      <PromptCompanionStage title="3. Confirm">
        <PromptCompanionLine label="Risk" value={proposal.risk || 'Preview before applying.'} />
        <div className="companion-prompt-actions">
          <button className="btn btn-primary" type="button" onClick={() => window.applyPromptCompanionProposal?.()}>
            Apply
          </button>
          <button className="btn" type="button" onClick={() => window.previewPromptCompanionProposal?.()}>
            Preview
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => window.dismissPromptCompanionProposal?.()}>
            Dismiss
          </button>
        </div>
      </PromptCompanionStage>
    </>
  );
}

function PromptCompanionCard({ state }: { state: PromptCompanionState }) {
  const hasProposal = Boolean(state.proposal);
  const defaultCopy = 'The companion watches recent runtime and session signals, then suggests a small prompt patch only when it is safe.';
  return (
    <section className={`companion-card companion-prompt-card${hasProposal ? '' : ' empty'}`} id="companion-prompt-card">
      <div className="companion-section-head">
        <div className="companion-section-title">Prompt tuning suggestion</div>
        <button className="companion-text-action" type="button" onClick={() => window.fetchPromptCompanionProposal?.(true)}>
          Refresh
        </button>
      </div>
      <div id="companion-prompt-proposal" data-react-prompt-companion="mounted">
        {state.loading ? <div className="companion-prompt-copy">Checking recent session and runtime signals...</div> : null}
        {state.error ? <div className="runtime-note danger">Prompt suggestion failed: {state.error}</div> : null}
        {!state.loading && !state.error && state.proposal ? (
          <PromptCompanionProposalView
            advisor={state.advisor}
            notice={state.advisorNotice}
            proposal={state.proposal}
            signals={state.signals}
          />
        ) : null}
        {!state.loading && !state.error && !state.proposal ? (
          <>
            <PromptCompanionAdvisorNotice advisor={state.advisor} notice={state.advisorNotice} />
            <div className="companion-prompt-copy">
              {state.signals ? buildPromptCompanionNoProposalCopy(state.signals) : defaultCopy}
            </div>
          </>
        ) : null}
      </div>
      <form
        className="companion-prompt-chat"
        onSubmit={event => {
          event.preventDefault();
          window.fetchPromptCompanionProposal?.(true);
        }}
      >
        <textarea
          id="companion-prompt-note"
          maxLength={600}
          onChange={event => setPromptCompanionNote(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
            event.preventDefault();
            window.fetchPromptCompanionProposal?.(true);
          }}
          placeholder="Ask the side advisor what to inspect before proposing a tiny prompt patch."
          value={state.note}
        />
        <div className="companion-prompt-chat-row">
          <div className="companion-prompt-copy">Only previewable small diffs are proposed. Applying asks for confirmation.</div>
          <button className="btn" type="submit">
            Ask
          </button>
        </div>
      </form>
    </section>
  );
}

function FloatingPromptProposal({ prompt }: { prompt: PromptCompanionState }) {
  if (!prompt.proposal) return null;
  return (
    <div id="floating-prompt-proposal">
      <div className="floating-prompt-proposal">
        <div className="floating-prompt-proposal-title">{prompt.proposal.title || 'Prompt suggestion available'}</div>
        <div className="floating-pet-panel-actions">
          <button
            type="button"
            onClick={() => {
              window.previewPromptCompanionProposal?.();
              window.closeFloatingPetMenu?.();
            }}
          >
            Preview
          </button>
          <button type="button" onClick={() => window.openPromptCompanionPanel?.()}>
            Open
          </button>
        </div>
      </div>
    </div>
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
        <FloatingPromptProposal prompt={state.promptCompanion} />
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

function renderPromptCompanion(payload: PromptCompanionPayload) {
  companionPageState = {
    ...companionPageState,
    promptCompanion: {
      ...companionPageState.promptCompanion,
      ...payload,
    },
  };
  renderCompanionViews();
}

function setPromptCompanionNote(note: string) {
  companionPageState = {
    ...companionPageState,
    promptCompanion: {
      ...companionPageState.promptCompanion,
      note,
    },
  };
  renderCompanionViews();
}

function getPromptCompanionNote() {
  return companionPageState.promptCompanion.note || '';
}

function clearPromptCompanionNote() {
  setPromptCompanionNote('');
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
        <div className="companion-left-stack">
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

          <PromptCompanionCard state={state.promptCompanion} />
        </div>

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
  window.__catscoRenderPromptCompanion = renderPromptCompanion;
  window.__catscoGetPromptCompanionNote = getPromptCompanionNote;
  window.__catscoClearPromptCompanionNote = clearPromptCompanionNote;
}
