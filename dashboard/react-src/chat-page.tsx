import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

type RelayModelChoice = {
  active?: boolean;
  disabled?: boolean;
  id: string;
  label: string;
  meta: string;
  modelName: string;
};

type CustomModelChoice = {
  active?: boolean;
  configured?: boolean;
  disabled?: boolean;
  meta: string;
  modelName: string;
};

type CatsRelayModelPanelPayload = {
  activationCopy?: string;
  customChoice: CustomModelChoice;
  models?: RelayModelChoice[];
  tagLabel?: string;
  tagTone?: string;
};

type CatsChecklistPayload = {
  connected?: boolean;
  steps?: Array<{
    label: string;
    meta?: string;
    status: string;
  }>;
};

type CatsStatusPayload = {
  errorText?: string;
  rows?: Array<{
    label: string;
    tone?: string;
    value: string;
  }>;
};

type CatsGatePayload = {
  actionLabel?: string;
  badge?: string;
  compact?: boolean;
  copy?: string;
  showAction?: boolean;
  stateClass?: string;
  status?: string;
  title?: string;
};

type CatsComposerPayload = {
  attachDisabled?: boolean;
  attachNoteHidden?: boolean;
  attachNoteText?: string;
  attachTitle?: string;
  currentValue?: string;
  inputHeight?: number;
  inputKey?: number;
  inputDisabled?: boolean;
  inputOverflowY?: 'auto' | 'hidden';
  inputPlaceholder?: string;
  locked?: boolean;
  sendDisabled?: boolean;
};

type CatsLayoutPayload = {
  connectExpanded?: boolean;
  connectNeedsAuth?: boolean;
  connectNeedsSetup?: boolean;
  shellCollapsed?: boolean;
};

type CatsConnectedPayload = {
  copy?: string;
  setupDisabled?: boolean;
  setupLabel?: string;
  showSetup?: boolean;
  visible?: boolean;
};

type CatsConnectTogglePayload = {
  collapsed?: boolean;
  title?: string;
  visible?: boolean;
};

type CatsAuthPanelPayload = {
  loginCopy?: string;
  mode?: 'login' | 'register';
  visible?: boolean;
};

type CatsAuthButtonsPayload = {
  authDisabled?: boolean;
  authLabel?: string;
  codeDisabled?: boolean;
  codeLabel?: string;
  registerDisabled?: boolean;
  registerLabel?: string;
};

type CatsConnectionMetaPayload = {
  detailsOpen?: boolean;
  detailsSummary?: string;
  diagnosticsVisible?: boolean;
  topicLabel?: string;
};

type CatsAuthDraft = {
  account: string;
  code: string;
  email: string;
  password: string;
  registerPassword: string;
  username: string;
};

type CatsEndpointDraft = {
  httpBaseUrl: string;
  serverUrl: string;
};

type CatsActionStatusPayload = {
  isError?: boolean;
  text?: string;
};

type BotInfo = {
  display_name?: string;
  isCurrent?: boolean;
  uid?: string;
  username?: string;
};

type BotSelectorPayload = {
  bots?: BotInfo[];
  busyBotUid?: string;
  message?: string;
  state: 'empty' | 'error' | 'loading' | 'ready';
};

type CatsAttachmentChip = {
  error?: string;
  id: string | number;
  kind: string;
  meta: string;
  name: string;
  removable?: boolean;
  status?: string;
};

type CatsAttachmentsPayload = {
  items?: CatsAttachmentChip[];
};

type MarkdownInline =
  | { kind: 'code'; text: string }
  | { href: string; kind: 'link'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'text'; text: string };

type MarkdownBlock =
  | { kind: 'codeBlock'; lang?: string; text: string }
  | { inlines: MarkdownInline[]; kind: 'heading'; level: number }
  | { kind: 'list'; items: MarkdownInline[][]; ordered?: boolean }
  | { kind: 'paragraph'; lines: MarkdownInline[][] }
  | { kind: 'quote'; lines: MarkdownInline[][] }
  | { header: MarkdownInline[][]; kind: 'table'; rows: MarkdownInline[][][] };

type RichBodyBlock = {
  desc?: string;
  icon?: string;
  kind: 'rich';
  meta?: string;
  name?: string;
  richType: 'card' | 'file' | 'image' | 'link_preview';
  src?: string;
  title?: string;
  url?: string;
};

type RuntimePlanBodyBlock = {
  done: number;
  kind: 'runtimePlan';
  open?: boolean;
  planKey: string;
  steps: Array<{ label: string; status: string; text: string }>;
  total: number;
};

type WorkingStepBody =
  | { kind: 'code'; text: string }
  | { blocks: MarkdownBlock[]; kind: 'markdown' };

type WorkingStep = {
  body?: WorkingStepBody;
  codeBlocks?: Array<{ note?: string; text: string }>;
  note?: string;
  summaryMeta?: string;
  title: string;
  titleMeta?: string;
};

type WorkingBodyBlock = {
  countLabel: string;
  detailKey: string;
  kind: 'working';
  steps: WorkingStep[];
};

type MarkdownBodyBlock = {
  blocks: MarkdownBlock[];
  kind: 'markdown';
};

type CatsMessageBodyBlock = MarkdownBodyBlock | RichBodyBlock | RuntimePlanBodyBlock | WorkingBodyBlock;

type CatsTimelineMessage = {
  bodyBlocks: CatsMessageBodyBlock[];
  isConsecutive?: boolean;
  key: string;
  mine?: boolean;
  time?: string;
  who: string;
  working?: boolean;
};

type CatsMessagesPayload = {
  empty?: boolean;
  emptyText?: string;
  groups?: CatsTimelineMessage[];
  historyState?: 'end' | 'loading' | '';
};

type ChatConnectPanelState = {
  actionStatus: CatsActionStatusPayload;
  authButtons: CatsAuthButtonsPayload;
  authPanel: CatsAuthPanelPayload;
  checklist: CatsChecklistPayload;
  connectedCard: CatsConnectedPayload;
  connectionMeta: CatsConnectionMetaPayload;
  connectToggle: CatsConnectTogglePayload;
  gate: CatsGatePayload;
  relayModelPanel?: CatsRelayModelPanelPayload;
  statusList: CatsStatusPayload;
};

type ChatPageState = {
  attachments: CatsAttachmentsPayload;
  authDraft: CatsAuthDraft;
  botSelector: BotSelectorPayload;
  botSelectorCreateBusy: boolean;
  botSelectorOpen: boolean;
  composer: CatsComposerPayload;
  composerInputKey: number;
  connectClassName: string;
  connectPanel: ChatConnectPanelState;
  endpointDraft: CatsEndpointDraft;
  messages: CatsMessagesPayload;
  shellClassName: string;
  topicLabel: string;
  workingDetailOpen: Record<string, boolean>;
  workingScrollTop: Record<string, number>;
  windowLocked: boolean;
};

declare global {
  interface Window {
    __catscoRenderCatsRelayModelPanel?: (payload: CatsRelayModelPanelPayload) => void;
    __catscoRenderCatsChecklist?: (payload: CatsChecklistPayload) => void;
    __catscoRenderCatsConnectToggle?: (payload: CatsConnectTogglePayload) => void;
    __catscoRenderCatsConnectedCard?: (payload: CatsConnectedPayload) => void;
    __catscoRenderCatsAuthPanel?: (payload: CatsAuthPanelPayload) => void;
    __catscoRenderCatsAuthButtons?: (payload: CatsAuthButtonsPayload) => void;
    __catscoRenderCatsActionStatus?: (payload: CatsActionStatusPayload) => void;
    __catscoRenderCatsConnectionMeta?: (payload: CatsConnectionMetaPayload) => void;
    __catscoGetCatsAuthDraft?: () => CatsAuthDraft;
    __catscoGetCatsEndpointDraft?: () => CatsEndpointDraft;
    __catscoRenderCatsLayout?: (payload: CatsLayoutPayload) => void;
    __catscoClearCatsComposerInput?: () => void;
    __catscoRenderCatsComposer?: (payload: CatsComposerPayload) => void;
    __catscoRenderCatsGate?: (payload: CatsGatePayload) => void;
    __catscoRenderCatsStatusList?: (payload: CatsStatusPayload) => void;
    __catscoSetBotSelectorCreateBusy?: (busy: boolean) => void;
    __catscoSetBotSelectorOpen?: (open: boolean) => void;
    __catscoSetCatsAuthDraft?: (payload: Partial<CatsAuthDraft>) => void;
    __catscoSetCatsConnectionDetailsOpen?: (open: boolean) => void;
    __catscoSetCatsEndpointDraft?: (payload: Partial<CatsEndpointDraft>) => void;
    setCatsRuntimePlanOpen?: (key: string, open: boolean) => void;
    __catscoRenderBotSelectorList?: (payload: BotSelectorPayload) => void;
    __catscoRenderCatsAttachments?: (payload: CatsAttachmentsPayload) => void;
    __catscoRenderCatsMessages?: (payload: CatsMessagesPayload) => void;
    __catscoGetCatsMessagesBox?: () => HTMLDivElement | null;
    __catscoGetCatsComposerDraft?: () => string;
    __catscoSetCatsComposerDraft?: (value: string) => void;
    __catscoFocusCatsAccount?: () => void;
    __catscoFocusCatsMessageInput?: () => void;
    __catscoResizeCatsComposerInput?: (source?: HTMLTextAreaElement | null) => void;
    bindCatsBot?: (botUid?: string, botName?: string, button?: HTMLElement, options?: { confirm?: boolean }) => void;
    chooseCatsFiles?: () => void;
    closeBotSelector?: () => void;
    createCatsBotAndBind?: (button: HTMLElement) => void;
    enableCatsRelayModelFromButton?: (button: HTMLElement) => void;
    enableCustomStartupModelFromButton?: (button: HTMLElement) => void;
    handleCatsMessagesScroll?: (box: HTMLDivElement) => void;
    loadCatsMessages?: () => void;
    removeCatsAttachment?: (id: number) => void;
    resetPetAutoBaseline?: () => void;
    resetCatsAuth?: () => void;
    runCatsNextAction?: () => void;
    sendCatsMessage?: () => void;
    sendCatsCode?: () => void;
    setPetState?: (state: string, options?: { holdMs?: number; message?: string }) => void;
    setCatsAuthMode?: (mode: string) => void;
    showCatsAttachmentBrowserMessage?: () => void;
    showBotSelector?: () => void;
    showCatsMediaPreview?: (src: string, title: string) => void;
    setupCatsBot?: () => void;
    submitCatsAuth?: () => void;
    toggleCatsConnectPanel?: () => void;
  }
}

let chatPageRoot: Root | undefined;
let chatPageElement: HTMLElement | null = null;
let catsAccountInputElement: HTMLInputElement | null = null;
let catsMessageInputElement: HTMLTextAreaElement | null = null;
let catsMessagesElement: HTMLDivElement | null = null;
let chatPageState: ChatPageState = {
  attachments: { items: [] },
  authDraft: {
    account: '',
    code: '',
    email: '',
    password: '',
    registerPassword: '',
    username: '',
  },
  botSelector: { state: 'loading' },
  botSelectorCreateBusy: false,
  botSelectorOpen: false,
  composer: {},
  composerInputKey: 0,
  connectClassName: 'chat-panel chat-connect',
  connectPanel: {
    actionStatus: {},
    authButtons: {},
    authPanel: {
      loginCopy: '使用 CatsCo webapp（CatsCompany）同一账号登录。',
      mode: 'login',
      visible: true,
    },
    checklist: {},
    connectedCard: { visible: false },
    connectionMeta: {
      detailsSummary: 'account / agent / connector',
      diagnosticsVisible: false,
      topicLabel: '尚未绑定会话',
    },
    connectToggle: {
      collapsed: false,
      title: '收起连接面板',
      visible: false,
    },
    gate: {
      actionLabel: '查看',
      copy: '检查模型、账号和 connector。',
      showAction: true,
      stateClass: 'stopped',
      status: 'warning',
      title: '正在检查 CatsCo Chat',
    },
    statusList: {},
  },
  endpointDraft: {
    httpBaseUrl: '',
    serverUrl: '',
  },
  messages: { empty: true, emptyText: '连接 CatsCo 后开始对话' },
  shellClassName: 'chat-shell',
  workingDetailOpen: {},
  workingScrollTop: {},
  topicLabel: '尚未绑定会话',
  windowLocked: true,
};

function RelayModelButton({ choice }: { choice: RelayModelChoice }) {
  return (
    <button
      className={`relay-model-choice${choice.active ? ' active' : ''}`}
      data-relay-model-context="chat"
      data-relay-model-id={choice.id}
      disabled={Boolean(choice.disabled)}
      onClick={event => window.enableCatsRelayModelFromButton?.(event.currentTarget)}
      type="button"
    >
      <span className="relay-model-label">{choice.label}</span>
      <span className="relay-model-name">{choice.modelName}</span>
      <span className="relay-model-meta">{choice.meta}</span>
    </button>
  );
}

function CustomModelButton({ choice }: { choice: CustomModelChoice }) {
  return (
    <button
      className={`relay-model-choice ${choice.active ? ' active' : ''}${choice.configured ? '' : ' needs-config'}`}
      data-custom-startup-action="true"
      data-custom-startup-context="chat"
      disabled={Boolean(choice.disabled)}
      onClick={event => window.enableCustomStartupModelFromButton?.(event.currentTarget)}
      type="button"
    >
      <span className="relay-model-label">自定义模型</span>
      <span className="relay-model-name">{choice.modelName}</span>
      <span className="relay-model-meta">{choice.meta}</span>
    </button>
  );
}

function CatsRelayModelPanel({
  activationCopy = '',
  customChoice,
  models = [],
  tagLabel = 'available',
  tagTone = 'warm',
}: CatsRelayModelPanelPayload) {
  return (
    <>
      <div className="chat-relay-model-head">
        <div>
          <div className="chat-relay-model-title">启动模型</div>
          <div className="chat-muted">{activationCopy}</div>
        </div>
        <span className={`tag ${tagTone}`}>{tagLabel}</span>
      </div>
      <div className="relay-model-list">
        <CustomModelButton choice={customChoice} />
        {models.map(choice => (
          <RelayModelButton choice={choice} key={choice.id} />
        ))}
      </div>
      {!models.length ? (
        <div className="runtime-note warning" style={{ marginTop: 8 }}>
          CatsCo relay does not currently expose an available model catalog.
        </div>
      ) : null}
    </>
  );
}

function CatsChecklist({ steps = [] }: CatsChecklistPayload) {
  if (!steps.length) return null;
  return (
    <>
      {steps.map((step, index) => (
        <div className={`chat-step-row ${step.status}`} key={`${step.label}-${index}`}>
          <strong>{step.label}</strong>
          <span>{step.meta || ''}</span>
        </div>
      ))}
    </>
  );
}

function CatsStatusList({ errorText = '', rows = [] }: CatsStatusPayload) {
  if (errorText) return <div className="chat-muted" style={{ color: 'var(--red)' }}>{errorText}</div>;
  return (
    <>
      {rows.map((row, index) => (
        <div className="chat-status-row" key={`${row.label}-${index}`}>
          <span>{row.label}</span>
          <strong
            style={row.tone === 'green' ? { color: 'var(--green)' } : row.tone === 'orange' ? { color: 'var(--orange)' } : undefined}
          >
            {row.value}
          </strong>
        </div>
      ))}
    </>
  );
}

function CatsGateCard({
  actionLabel = '查看',
  copy = '检查模型、账号和 connector。',
  showAction = true,
  title = '正在检查 CatsCo Chat',
}: CatsGatePayload) {
  return (
    <>
      <div>
        <div className="chat-state-title" id="cats-state-title">
          {title}
        </div>
        <div className="chat-muted" id="cats-state-copy">
          {copy}
        </div>
      </div>
      {showAction ? (
        <button className="btn btn-primary" id="cats-state-action" type="button" onClick={() => window.runCatsNextAction?.()}>
          {actionLabel}
        </button>
      ) : null}
    </>
  );
}

function CatsComposer({
  attachDisabled = true,
  attachNoteHidden = true,
  attachNoteText = '普通浏览器不能直接上传本地附件；请在 CatsCo 桌面客户端使用 + 选择文件，或把文件路径作为文字说明发给 Agent。',
  attachTitle = '添加本地文件',
  currentValue = '',
  inputHeight,
  inputKey = 0,
  inputDisabled = true,
  inputOverflowY = 'hidden',
  inputPlaceholder = '等待 CatsCo Chat 检查完成',
  sendDisabled = true,
}: CatsComposerPayload) {
  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.currentTarget.value;
    setCatsComposerDraft(nextValue);
    resizeCatsComposerInput(event.currentTarget);
    if (nextValue.trim()) window.setPetState?.('typing', { message: '输入中...' });
    else window.resetPetAutoBaseline?.();
  };
  const handleBlur = (event: React.FocusEvent<HTMLTextAreaElement>) => {
    if (!event.currentTarget.value.trim()) window.resetPetAutoBaseline?.();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      window.sendCatsMessage?.();
    }
  };
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = event.clipboardData?.files;
    if (files && files.length) {
      event.preventDefault();
      window.showCatsAttachmentBrowserMessage?.();
    }
  };

  React.useLayoutEffect(() => {
    resizeCatsComposerInput(catsMessageInputElement);
  }, [currentValue, inputDisabled, inputKey]);

  return (
    <>
      <div className="chat-attach-note" id="cats-attach-note" hidden={Boolean(attachNoteHidden)}>
        {attachNoteText}
      </div>
      <div className="chat-input-bar">
        <button
          className="btn chat-attach-btn"
          type="button"
          id="cats-attach-btn"
          title={attachTitle}
          disabled={Boolean(attachDisabled)}
          onClick={() => window.chooseCatsFiles?.()}
        >
          +
        </button>
        <textarea
          className="config-input"
          id="cats-message-input"
          key={inputKey}
          ref={element => {
            catsMessageInputElement = element;
          }}
          placeholder={inputPlaceholder}
          disabled={Boolean(inputDisabled)}
          value={currentValue}
          onBlur={handleBlur}
          onChange={handleChange}
          onFocus={() => window.setPetState?.('typing', { message: '准备输入' })}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          style={{ height: inputHeight ? `${inputHeight}px` : undefined, overflowY: inputOverflowY }}
        />
        <button className="btn btn-primary" id="cats-send-btn" type="button" disabled={Boolean(sendDisabled)} onClick={() => window.sendCatsMessage?.()}>
          发送
        </button>
      </div>
    </>
  );
}

function CatsConnectedCard({
  copy = '可以直接开始对话。',
  setupDisabled = false,
  setupLabel = '重新检查',
  showSetup = false,
}: CatsConnectedPayload) {
  return (
    <>
      <div className="chat-connected-title">CatsCo 已连接</div>
      <div className="chat-muted" id="cats-connected-copy">
        {copy}
      </div>
      <div className="chat-connected-actions">
        <button className="btn" type="button" onClick={() => window.showBotSelector?.()}>
          选择机器人
        </button>
        <button
          className="btn btn-success"
          disabled={setupDisabled}
          id="cats-setup-btn"
          type="button"
          onClick={() => window.setupCatsBot?.()}
          style={{ display: showSetup ? 'inline-flex' : 'none' }}
        >
          {setupLabel}
        </button>
        <button className="btn" type="button" onClick={() => window.resetCatsAuth?.()}>
          切换账号
        </button>
      </div>
    </>
  );
}

function BotSelectorList({ bots = [], busyBotUid = '', message = '', state }: BotSelectorPayload) {
  if (state === 'loading') return <div className="loading">Loading...</div>;
  if (state === 'empty') return <div className="empty">{message || 'No bots available.'}</div>;
  if (state === 'error') return <div className="error">{message || 'Load failed'}</div>;
  return (
    <>
      {bots.map(bot => {
        const botName = bot.display_name || bot.username || bot.uid || 'Unnamed bot';
        const username = bot.username || bot.uid || '';
        const botUid = bot.uid || '';
        const busy = Boolean(busyBotUid && botUid === busyBotUid);
        return (
          <div className={`bot-item ${bot.isCurrent ? 'current' : ''}`} key={botUid || botName}>
            <div className="bot-info">
              <div className="bot-name">{botName}</div>
              <div className="bot-username">@{username}</div>
            </div>
            <button
              className="btn-sm"
              disabled={!botUid || busy}
              type="button"
              onClick={event =>
                window.bindCatsBot?.(botUid, botName, event.currentTarget, {
                  confirm: !bot.isCurrent,
                })
              }
            >
              {busy ? 'Binding...' : bot.isCurrent ? 'Rebind' : 'Bind'}
            </button>
          </div>
        );
      })}
    </>
  );
}

function CatsAttachments({ items = [] }: CatsAttachmentsPayload) {
  return (
    <>
      {items.map(item => (
        <div className={`chat-upload-chip ${item.status || 'queued'}`} key={item.id}>
          <span className="chat-upload-icon">{item.kind}</span>
          <span className="chat-upload-info">
            <strong>{item.name}</strong>
            <small title={item.error || item.name || ''}>{item.meta}</small>
          </span>
          {item.removable ? (
            <button
              className="btn chat-upload-remove"
              type="button"
              onClick={() => window.removeCatsAttachment?.(Number(item.id))}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
    </>
  );
}

function MarkdownInlines({ items = [] }: { items?: MarkdownInline[] }) {
  return (
    <>
      {items.map((item, index) => {
        const key = `${item.kind}-${index}`;
        if (item.kind === 'code') return <code key={key}>{item.text}</code>;
        if (item.kind === 'link') {
          return (
            <a href={item.href} key={key} rel="noopener noreferrer" target="_blank">
              {item.text}
            </a>
          );
        }
        if (item.kind === 'strong') return <strong key={key}>{item.text}</strong>;
        if (item.kind === 'em') return <em key={key}>{item.text}</em>;
        return <React.Fragment key={key}>{item.text}</React.Fragment>;
      })}
    </>
  );
}

function MarkdownLineBreaks({ lines = [] }: { lines?: MarkdownInline[][] }) {
  return (
    <>
      {lines.map((line, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <br /> : null}
          <MarkdownInlines items={line} />
        </React.Fragment>
      ))}
    </>
  );
}

function MarkdownBlockView({ block }: { block: MarkdownBlock }) {
  if (block.kind === 'codeBlock') {
    return (
      <>
        {block.lang ? <div className="chat-code-label">{block.lang}</div> : null}
        <pre>
          <code>{block.text}</code>
        </pre>
      </>
    );
  }
  if (block.kind === 'heading') {
    if (block.level === 1) return <h1><MarkdownInlines items={block.inlines} /></h1>;
    if (block.level === 2) return <h2><MarkdownInlines items={block.inlines} /></h2>;
    return <h3><MarkdownInlines items={block.inlines} /></h3>;
  }
  if (block.kind === 'quote') {
    return (
      <blockquote>
        <MarkdownLineBreaks lines={block.lines} />
      </blockquote>
    );
  }
  if (block.kind === 'list') {
    const ListTag = block.ordered ? 'ol' : 'ul';
    return (
      <ListTag>
        {block.items.map((item, index) => (
          <li key={index}>
            <MarkdownInlines items={item} />
          </li>
        ))}
      </ListTag>
    );
  }
  if (block.kind === 'table') {
    return (
      <div className="chat-table-wrap">
        <table>
          <thead>
            <tr>
              {block.header.map((cell, index) => (
                <th key={index}>
                  <MarkdownInlines items={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>
                    <MarkdownInlines items={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <p>
      <MarkdownLineBreaks lines={block.lines} />
    </p>
  );
}

function MarkdownBody({ blocks = [] }: { blocks?: MarkdownBlock[] }) {
  if (!blocks.length) return null;
  return (
    <div className="chat-markdown">
      {blocks.map((block, index) => (
        <MarkdownBlockView block={block} key={index} />
      ))}
    </div>
  );
}

function AttachmentContent({ block }: { block: RichBodyBlock }) {
  return (
    <>
      <span className="chat-attachment-icon">{block.icon || (block.richType === 'link_preview' ? 'URL' : block.richType === 'card' ? 'CARD' : 'FILE')}</span>
      <span>
        <div className="chat-attachment-name">{block.title || block.name || 'Attachment'}</div>
        <div className="chat-attachment-meta">{block.meta || block.desc || ''}</div>
      </span>
    </>
  );
}

function RichBody({ block }: { block: RichBodyBlock }) {
  if (block.richType === 'image') {
    if (!block.src) return null;
    return (
      <button className="chat-rich-image-button" type="button" onClick={() => window.showCatsMediaPreview?.(block.src || '', block.title || 'image')}>
        <img alt={block.title || 'image'} className="chat-rich-image" src={block.src} />
      </button>
    );
  }
  if (block.url) {
    return (
      <a className="chat-attachment" href={block.url} rel="noopener noreferrer" target="_blank">
        <AttachmentContent block={block} />
      </a>
    );
  }
  return (
    <div className="chat-attachment">
      <AttachmentContent block={block} />
    </div>
  );
}

function RuntimePlanBody({ block }: { block: RuntimePlanBodyBlock }) {
  return (
    <details
      className="chat-runtime-plan"
      data-cats-runtime-plan="true"
      data-plan-key={block.planKey}
      open={Boolean(block.open)}
      onToggle={event => window.setCatsRuntimePlanOpen?.(block.planKey, (event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="chat-runtime-plan-chevron">&gt;</span>
        <span>Plan</span>
        <span className="chat-runtime-plan-hint">
          {block.done}/{block.total} 已完成
        </span>
      </summary>
      <div className="chat-runtime-plan-body">
        {block.steps.map((step, index) => (
          <div className="chat-runtime-plan-step" key={index}>
            <span className={`chat-runtime-plan-status ${step.status}`}>{step.label}</span>
            <span className="chat-runtime-plan-text">{step.text}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function WorkingStepBodyView({ body }: { body?: WorkingStepBody }) {
  if (!body) return null;
  if (body.kind === 'code') {
    return (
      <div className="chat-working-code">
        <pre>{body.text}</pre>
      </div>
    );
  }
  return <MarkdownBody blocks={body.blocks} />;
}

function WorkingBody({ block }: { block: WorkingBodyBlock }) {
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const open = Boolean(chatPageState.workingDetailOpen[block.detailKey]);
  const scrollTop = chatPageState.workingScrollTop[block.detailKey];

  React.useLayoutEffect(() => {
    if (typeof scrollTop !== 'number' || !bodyRef.current) return;
    bodyRef.current.scrollTop = scrollTop;
  }, [block.detailKey, scrollTop]);

  return (
    <details
      className="chat-working"
      data-cats-detail-key={block.detailKey}
      open={open}
      onToggle={event => setCatsWorkingDetailOpen(block.detailKey, (event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="chat-working-chevron">&gt;</span>
        <span>WORKING...</span>
        <span className="chat-working-hint">{block.countLabel}</span>
      </summary>
      <div
        className="chat-working-body"
        data-cats-scroll-key={block.detailKey}
        onScroll={event => setCatsWorkingScrollTop(block.detailKey, event.currentTarget.scrollTop)}
        ref={bodyRef}
      >
        {block.steps.map((step, index) => (
          <div className="chat-working-step" key={index}>
            <div className="chat-working-step-title">
              {step.title}
              {step.titleMeta ? <span className="chat-working-step-meta">{step.titleMeta}</span> : null}
            </div>
            {step.summaryMeta ? <div className="chat-working-summary-meta">{step.summaryMeta}</div> : null}
            {step.codeBlocks?.map((code, codeIndex) => (
              <React.Fragment key={codeIndex}>
                <div className="chat-working-code">
                  <pre>{code.text}</pre>
                </div>
                {code.note ? <div className="chat-working-note">{code.note}</div> : null}
              </React.Fragment>
            ))}
            <WorkingStepBodyView body={step.body} />
            {step.note ? <div className="chat-working-note">{step.note}</div> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function MessageBody({ blocks = [] }: { blocks?: CatsMessageBodyBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'markdown') return <MarkdownBody blocks={block.blocks} key={index} />;
        if (block.kind === 'rich') return <RichBody block={block} key={index} />;
        if (block.kind === 'runtimePlan') return <RuntimePlanBody block={block} key={index} />;
        return <WorkingBody block={block} key={index} />;
      })}
    </>
  );
}

function CatsMessagesTimeline({ empty = false, emptyText = 'No messages', groups = [], historyState = '' }: CatsMessagesPayload) {
  if (empty) return <div className="loading">{emptyText}</div>;
  return (
    <div className="chat-timeline-inner">
      {historyState === 'loading' ? <div className="chat-history-note">正在加载更早消息...</div> : null}
      {historyState === 'end' ? <div className="chat-history-note">已到最早消息</div> : null}
      {groups.map(group => (
        <div
          className={`chat-message ${group.mine ? 'mine' : 'peer'}${group.working ? ' has-working' : ''}${group.isConsecutive ? ' grouped' : ''}`}
          key={group.key}
        >
          <div className="chat-avatar" aria-hidden="true">
            {group.mine ? '我' : 'C'}
          </div>
          <div className="chat-message-body">
            <div className="chat-message-meta">
              <span>{group.who}</span>
              {group.time ? <span>{group.time}</span> : null}
            </div>
            <div className="chat-message-content">
              <MessageBody blocks={group.bodyBlocks} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function BotSelectorModal({
  createBusy = false,
  open = false,
  selector,
}: {
  createBusy?: boolean;
  open?: boolean;
  selector: BotSelectorPayload;
}) {
  const handleBotSelectorBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      window.__catscoSetBotSelectorOpen?.(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      data-react-bot-selector-modal="mounted"
      id="bot-selector-modal"
      onClick={handleBotSelectorBackdropClick}
      style={{ display: open ? 'flex' : 'none' }}
    >
      <div className="modal-content">
        <div className="modal-header">
          <h3>Select bot</h3>
          <button className="close-btn" type="button" onClick={() => window.closeBotSelector?.()}>
            &times;
          </button>
        </div>
        <div className="bot-selector-toolbar">
          <div className="bot-selector-note">One local CatsCo/XiaoBa process binds to one bot identity.</div>
          <button className="btn btn-success" id="cats-create-bot-btn" type="button" onClick={event => window.createCatsBotAndBind?.(event.currentTarget)} disabled={createBusy}>
            {createBusy ? 'Creating...' : 'Create new bot'}
          </button>
        </div>
        <div className="bot-list" data-react-bot-selector="mounted" id="bot-list">
          <BotSelectorList {...selector} />
        </div>
      </div>
    </div>
  );
}

function ChatConnectPanel({
  authDraft,
  endpointDraft,
  state,
}: {
  authDraft: CatsAuthDraft;
  endpointDraft: CatsEndpointDraft;
  state: ChatConnectPanelState;
}) {
  const gate = state.gate;
  const checklistClass = `chat-step-list${state.checklist.connected ? ' compact' : ''}`;
  const connectedVisible = state.connectedCard.visible ? 'block' : 'none';
  const authMode = state.authPanel.mode || 'login';
  const authVisible = state.authPanel.visible !== false;
  const actionColor = state.actionStatus.isError ? 'var(--red)' : 'var(--text2)';
  const connectTitle = state.connectToggle.title || '收起连接面板';

  return (
    <>
      <div className="chat-connect-header">
        <div>
          <div className="chat-page-title">CatsCo Chat</div>
          <div className="chat-muted chat-connect-intro">连接 CatsCompany 网页会话，本地 agent 回复。</div>
        </div>
        <div className="chat-connect-controls">
          <span className={`status-dot ${gate.stateClass || 'stopped'}`} data-react-cats-gate-state="mounted" id="cats-chat-state">
            {gate.badge || 'checking'}
          </span>
          <button
            aria-label={connectTitle}
            className="btn chat-collapse-toggle"
            data-react-cats-connect-toggle="mounted"
            hidden={!state.connectToggle.visible}
            id="cats-connect-toggle"
            onClick={() => window.toggleCatsConnectPanel?.()}
            title={connectTitle}
            type="button"
          >
            <span className="collapse-icon">{state.connectToggle.collapsed ? '>' : '<'}</span>
          </button>
        </div>
      </div>

      <div
        className={`chat-state-card ${gate.status || 'blocked'}${gate.compact ? ' compact' : ''}`}
        data-react-cats-gate="mounted"
        id="cats-state-card"
      >
        <CatsGateCard {...gate} />
      </div>

      <div className={checklistClass} data-react-cats-checklist="mounted" id="cats-checklist">
        {state.checklist.steps?.length ? (
          <CatsChecklist {...state.checklist} />
        ) : state.checklist.connected ? (
          <div className="chat-checklist-ok">当前检查项已通过</div>
        ) : (
          <div className="loading">检查中...</div>
        )}
      </div>

      <div className="chat-relay-model-panel" data-react-cats-relay-model="mounted" id="cats-relay-model-panel">
        {state.relayModelPanel ? <CatsRelayModelPanel {...state.relayModelPanel} /> : null}
      </div>

      <div className="chat-connected-card" data-react-cats-connected="mounted" id="cats-connected-card" style={{ display: connectedVisible }}>
        <CatsConnectedCard {...state.connectedCard} />
      </div>

      <div
        className="chat-form"
        data-react-cats-auth-panel="mounted"
        id="cats-auth-panel"
        style={{ display: authVisible ? 'grid' : 'none' }}
      >
        <div id="cats-login-fields" style={{ display: authMode === 'login' ? 'block' : 'none' }}>
          <div className="chat-muted" data-react-cats-login-copy="mounted" id="cats-login-copy" style={{ marginBottom: 10 }}>
            {state.authPanel.loginCopy || '使用 CatsCo webapp（CatsCompany）同一账号登录。'}
          </div>
          <input
            className="config-input"
            id="cats-account"
            ref={element => {
              catsAccountInputElement = element;
            }}
            type="text"
            value={authDraft.account}
            onChange={event => setCatsAuthDraft({ account: event.currentTarget.value })}
            placeholder="邮箱或用户名"
            style={{ marginBottom: 10 }}
          />
          <input
            className="config-input"
            id="cats-password"
            type="password"
            value={authDraft.password}
            onChange={event => setCatsAuthDraft({ password: event.currentTarget.value })}
            placeholder="密码"
          />
          <button
            className="btn btn-primary"
            data-react-cats-auth-button="mounted"
            disabled={Boolean(state.authButtons.authDisabled)}
            id="cats-auth-btn"
            type="button"
            onClick={() => window.submitCatsAuth?.()}
            style={{ width: '100%', marginTop: 12 }}
          >
            {state.authButtons.authLabel || '登录并连接'}
          </button>
          <div className="chat-secondary-action">
            还没有账号？{' '}
            <button className="chat-link-button" type="button" onClick={() => window.setCatsAuthMode?.('register')}>
              创建账号
            </button>
          </div>
        </div>

        <div id="cats-register-fields" style={{ display: authMode === 'register' ? 'block' : 'none' }}>
          <div className="chat-muted" style={{ marginBottom: 12 }}>
            创建账号后会自动登录并连接 CatsCo。
          </div>
          <input
            className="config-input"
            id="cats-email"
            type="email"
            value={authDraft.email}
            onChange={event => setCatsAuthDraft({ email: event.currentTarget.value })}
            placeholder="邮箱地址"
            style={{ marginBottom: 10 }}
          />
          <div className="chat-form-row" style={{ marginBottom: 10 }}>
            <input
              className="config-input"
              id="cats-code"
              type="text"
              value={authDraft.code}
              onChange={event => setCatsAuthDraft({ code: event.currentTarget.value })}
              placeholder="邮箱验证码"
            />
            <button
              className="btn"
              data-react-cats-auth-button="mounted"
              disabled={Boolean(state.authButtons.codeDisabled)}
              id="cats-code-btn"
              type="button"
              onClick={() => window.sendCatsCode?.()}
            >
              {state.authButtons.codeLabel || '发送验证码'}
            </button>
          </div>
          <input
            className="config-input"
            id="cats-username"
            type="text"
            value={authDraft.username}
            onChange={event => setCatsAuthDraft({ username: event.currentTarget.value })}
            placeholder="登录名称"
            style={{ marginBottom: 10 }}
          />
          <input
            className="config-input"
            id="cats-register-password"
            type="password"
            value={authDraft.registerPassword}
            onChange={event => setCatsAuthDraft({ registerPassword: event.currentTarget.value })}
            placeholder="设置密码"
          />
          <button
            className="btn btn-primary"
            data-react-cats-auth-button="mounted"
            disabled={Boolean(state.authButtons.registerDisabled)}
            id="cats-register-btn"
            type="button"
            onClick={() => window.submitCatsAuth?.()}
            style={{ width: '100%', marginTop: 12 }}
          >
            {state.authButtons.registerLabel || '创建并连接'}
          </button>
          <div className="chat-secondary-action">
            <button className="chat-link-button" type="button" onClick={() => window.setCatsAuthMode?.('login')}>
              返回登录
            </button>
          </div>
        </div>
      </div>

      <details
        className="chat-diagnostics"
        data-react-cats-connection-details="mounted"
        id="cats-connection-details"
        open={Boolean(state.connectionMeta.detailsOpen)}
        onToggle={event => setCatsConnectionDetailsOpen((event.currentTarget as HTMLDetailsElement).open)}
        style={{ display: state.connectionMeta.diagnosticsVisible ? 'block' : 'none' }}
      >
        <summary>
          <span>连接详情</span>
          <span className="tag" data-react-cats-details-summary="mounted" id="cats-details-summary">
            {state.connectionMeta.detailsSummary || 'account / agent / connector'}
          </span>
        </summary>
        <div className="chat-diagnostics-body">
          <div className="chat-status-list" data-react-cats-status="mounted" id="cats-status">
            {state.statusList.errorText || state.statusList.rows?.length ? (
              <CatsStatusList {...state.statusList} />
            ) : (
              <div className="loading">加载 CatsCo 状态...</div>
            )}
          </div>
          <details className="chat-advanced" id="cats-advanced">
            <summary>高级连接地址</summary>
            <div className="chat-advanced-body">
              <div className="chat-advanced-note">默认连接 CatsCo 生产环境。只有在调试私有部署时才需要修改。</div>
              <input
                className="config-input"
                id="cats-http-base"
                type="text"
                value={endpointDraft.httpBaseUrl}
                onChange={event => setCatsEndpointDraft({ httpBaseUrl: event.currentTarget.value })}
                placeholder="HTTP Base URL"
              />
              <input
                className="config-input"
                id="cats-ws-url"
                type="text"
                value={endpointDraft.serverUrl}
                onChange={event => setCatsEndpointDraft({ serverUrl: event.currentTarget.value })}
                placeholder="WebSocket URL"
              />
            </div>
          </details>
        </div>
      </details>

      <div
        className="chat-muted"
        data-react-cats-action-status="mounted"
        id="cats-action-status"
        style={{ color: actionColor, marginTop: 12 }}
      >
        {state.actionStatus.text || ''}
      </div>
    </>
  );
}

function hasDraggedFiles(event: React.DragEvent<HTMLElement>) {
  return Boolean(event.dataTransfer?.types && Array.from(event.dataTransfer.types).includes('Files'));
}

function handleCatsAttachmentDrag(event: React.DragEvent<HTMLElement>) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
}

function handleCatsAttachmentDrop(event: React.DragEvent<HTMLElement>) {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  window.showCatsAttachmentBrowserMessage?.();
}

function ChatPage({ state }: { state: ChatPageState }) {
  const attachments = state.attachments.items || [];
  const windowClassName = `chat-panel chat-window${state.windowLocked ? ' locked' : ''}`;
  return (
    <>
      <div className={state.shellClassName}>
        <div className={state.connectClassName} data-react-chat-connect="mounted" id="chat-connect-root">
          <ChatConnectPanel authDraft={state.authDraft} endpointDraft={state.endpointDraft} state={state.connectPanel} />
        </div>

        <div
          className={windowClassName}
          data-react-cats-window="mounted"
          onDragEnter={handleCatsAttachmentDrag}
          onDragOver={handleCatsAttachmentDrag}
          onDrop={handleCatsAttachmentDrop}
        >
          <div className="chat-window-header">
            <div>
              <div className="chat-window-title">CatsCo Agent</div>
              <div className="chat-muted" data-react-cats-topic-label="mounted" id="cats-topic-label">
                {state.topicLabel}
              </div>
            </div>
            <button className="btn" type="button" onClick={() => window.loadCatsMessages?.()}>
              刷新
            </button>
          </div>
          <div
            className="chat-messages"
            data-react-cats-messages="mounted"
            id="cats-messages"
            onScroll={event => window.handleCatsMessagesScroll?.(event.currentTarget)}
            ref={element => {
              catsMessagesElement = element;
            }}
          >
            <CatsMessagesTimeline {...state.messages} />
          </div>
          <div className="chat-composer" id="cats-composer">
            <div
              className="chat-attachment-tray"
              data-react-cats-attachments="mounted"
              hidden={attachments.length === 0}
              id="cats-attachment-tray"
            >
              <CatsAttachments items={attachments} />
            </div>
            <div data-react-cats-composer="mounted" id="cats-input-controls">
              <CatsComposer {...state.composer} inputKey={state.composerInputKey} />
            </div>
          </div>
        </div>
      </div>
      <BotSelectorModal
        createBusy={state.botSelectorCreateBusy}
        open={state.botSelectorOpen}
        selector={state.botSelector}
      />
    </>
  );
}

function chatLayoutClassName(base: string, flags: Record<string, boolean | undefined>) {
  const classes = [base];
  for (const [name, enabled] of Object.entries(flags)) {
    if (enabled) classes.push(name);
  }
  return classes.join(' ');
}

function getCatsComposerDraft() {
  return chatPageState.composer.currentValue || '';
}

function setCatsComposerDraft(value: string) {
  chatPageState = {
    ...chatPageState,
    composer: {
      ...chatPageState.composer,
      currentValue: String(value || ''),
    },
  };
  renderChatPage({ preserveDomState: false });
}

function setCatsWorkingDetailOpen(key: string, open: boolean) {
  if (!key || chatPageState.workingDetailOpen[key] === Boolean(open)) return;
  chatPageState = {
    ...chatPageState,
    workingDetailOpen: {
      ...chatPageState.workingDetailOpen,
      [key]: Boolean(open),
    },
  };
  renderChatPage();
}

function setCatsWorkingScrollTop(key: string, scrollTop: number) {
  if (!key) return;
  const nextScrollTop = Math.max(0, Number(scrollTop) || 0);
  const workingScrollTop = { ...chatPageState.workingScrollTop };
  if (nextScrollTop > 0) workingScrollTop[key] = nextScrollTop;
  else delete workingScrollTop[key];
  chatPageState = {
    ...chatPageState,
    workingScrollTop,
  };
}

function preserveChatDomState() {
  chatPageState = {
    ...chatPageState,
    composer: {
      ...chatPageState.composer,
      currentValue: getCatsComposerDraft(),
    },
  };
}

function renderChatPage({ preserveDomState = true }: { preserveDomState?: boolean } = {}) {
  if (!chatPageElement) return;
  if (preserveDomState) preserveChatDomState();
  chatPageRoot ??= createRoot(chatPageElement);
  chatPageRoot?.render(<ChatPage state={chatPageState} />);
  chatPageElement.dataset.reactChat = 'mounted';
}

function updateChatConnectPanel(patch: Partial<ChatConnectPanelState>) {
  chatPageState = {
    ...chatPageState,
    connectPanel: {
      ...chatPageState.connectPanel,
      ...patch,
    },
  };
  renderChatPage();
}

function renderCatsRelayModelPanel(payload: CatsRelayModelPanelPayload) {
  updateChatConnectPanel({ relayModelPanel: payload });
}

function renderCatsChecklist(payload: CatsChecklistPayload) {
  updateChatConnectPanel({ checklist: payload });
}

function renderCatsGate(payload: CatsGatePayload) {
  updateChatConnectPanel({ gate: payload });
}

function renderCatsComposer(payload: CatsComposerPayload) {
  chatPageState = {
    ...chatPageState,
    composer: {
      ...chatPageState.composer,
      ...payload,
      currentValue: payload.currentValue ?? chatPageState.composer.currentValue ?? '',
    },
    windowLocked: payload.locked ?? chatPageState.windowLocked,
  };
  renderChatPage();
}

function clearCatsComposerInput() {
  chatPageState = {
    ...chatPageState,
    composer: {
      ...chatPageState.composer,
      currentValue: '',
    },
    composerInputKey: chatPageState.composerInputKey + 1,
  };
  renderChatPage({ preserveDomState: false });
}

function renderCatsConnectedCard(payload: CatsConnectedPayload) {
  updateChatConnectPanel({ connectedCard: payload });
}

function renderCatsConnectToggle({ collapsed = false, title = '收起连接面板', visible = false }: CatsConnectTogglePayload) {
  updateChatConnectPanel({ connectToggle: { collapsed, title, visible } });
}

function renderCatsAuthPanel({ loginCopy = '', mode = 'login', visible = true }: CatsAuthPanelPayload) {
  updateChatConnectPanel({ authPanel: { loginCopy, mode, visible } });
}

function renderCatsAuthButtons(payload: CatsAuthButtonsPayload) {
  updateChatConnectPanel({
    authButtons: { ...chatPageState.connectPanel.authButtons, ...payload },
  });
}

function getCatsAuthDraft() {
  return { ...chatPageState.authDraft };
}

function setCatsAuthDraft(payload: Partial<CatsAuthDraft>) {
  chatPageState = {
    ...chatPageState,
    authDraft: {
      ...chatPageState.authDraft,
      ...payload,
    },
  };
  renderChatPage();
}

function getCatsEndpointDraft() {
  return { ...chatPageState.endpointDraft };
}

function setCatsEndpointDraft(payload: Partial<CatsEndpointDraft>) {
  chatPageState = {
    ...chatPageState,
    endpointDraft: {
      ...chatPageState.endpointDraft,
      ...payload,
    },
  };
  renderChatPage();
}

function focusCatsAccount() {
  catsAccountInputElement?.focus();
}

function focusCatsMessageInput() {
  catsMessageInputElement?.focus();
}

function getCatsMessagesBox() {
  return catsMessagesElement;
}

function resizeCatsComposerInput(source?: HTMLTextAreaElement | null) {
  const input = source || catsMessageInputElement;
  if (!input) return;
  const maxHeight = window.matchMedia('(max-width: 760px)').matches ? 180 : 220;
  input.style.height = 'auto';
  const measuredScrollHeight = input.scrollHeight;
  const nextHeight = Math.min(Math.max(measuredScrollHeight, 40), maxHeight);
  const inputOverflowY = measuredScrollHeight > maxHeight ? 'auto' : 'hidden';
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = inputOverflowY;
  if (chatPageState.composer.inputHeight === nextHeight && chatPageState.composer.inputOverflowY === inputOverflowY) return;
  chatPageState = {
    ...chatPageState,
    composer: {
      ...chatPageState.composer,
      inputHeight: nextHeight,
      inputOverflowY,
    },
  };
  renderChatPage();
}

function setCatsConnectionDetailsOpen(open: boolean) {
  updateChatConnectPanel({
    connectionMeta: {
      ...chatPageState.connectPanel.connectionMeta,
      detailsOpen: Boolean(open),
    },
  });
}

function renderCatsActionStatus({ isError = false, text = '' }: CatsActionStatusPayload) {
  updateChatConnectPanel({ actionStatus: { isError, text } });
}

function renderCatsConnectionMeta({
  detailsSummary = 'account / agent / connector',
  diagnosticsVisible = false,
  topicLabel = '尚未绑定会话',
}: CatsConnectionMetaPayload) {
  chatPageState = {
    ...chatPageState,
    connectPanel: {
      ...chatPageState.connectPanel,
      connectionMeta: { ...chatPageState.connectPanel.connectionMeta, detailsSummary, diagnosticsVisible, topicLabel },
    },
    topicLabel,
  };
  renderChatPage();
}

function renderCatsLayout({
  connectExpanded = false,
  connectNeedsAuth = false,
  connectNeedsSetup = false,
  shellCollapsed = false,
}: CatsLayoutPayload) {
  chatPageState = {
    ...chatPageState,
    connectClassName: chatLayoutClassName('chat-panel chat-connect', {
      expanded: connectExpanded,
      'needs-auth': connectNeedsAuth,
      'needs-setup': connectNeedsSetup,
    }),
    shellClassName: chatLayoutClassName('chat-shell', {
      'connect-collapsed': shellCollapsed,
    }),
  };
  renderChatPage();
}

function renderCatsStatusList(payload: CatsStatusPayload) {
  updateChatConnectPanel({ statusList: payload });
}

function renderBotSelectorList(payload: BotSelectorPayload) {
  chatPageState = { ...chatPageState, botSelector: payload };
  renderChatPage();
}

function setBotSelectorOpen(open: boolean) {
  chatPageState = { ...chatPageState, botSelectorOpen: open };
  renderChatPage();
}

function setBotSelectorCreateBusy(busy: boolean) {
  chatPageState = { ...chatPageState, botSelectorCreateBusy: busy };
  renderChatPage();
}

function renderCatsAttachments(payload: CatsAttachmentsPayload) {
  chatPageState = { ...chatPageState, attachments: { items: payload.items || [] } };
  renderChatPage();
}

function renderCatsMessages(payload: CatsMessagesPayload) {
  chatPageState = { ...chatPageState, messages: payload };
  renderChatPage();
}

export function mountChatPage() {
  const root = document.getElementById('chat-page-root');
  if (!root) return;
  chatPageElement = root;
  renderChatPage();
  window.__catscoRenderCatsRelayModelPanel = renderCatsRelayModelPanel;
  window.__catscoRenderCatsChecklist = renderCatsChecklist;
  window.__catscoRenderCatsConnectToggle = renderCatsConnectToggle;
  window.__catscoRenderCatsAuthPanel = renderCatsAuthPanel;
  window.__catscoRenderCatsAuthButtons = renderCatsAuthButtons;
  window.__catscoRenderCatsActionStatus = renderCatsActionStatus;
  window.__catscoRenderCatsConnectedCard = renderCatsConnectedCard;
  window.__catscoRenderCatsConnectionMeta = renderCatsConnectionMeta;
  window.__catscoGetCatsAuthDraft = getCatsAuthDraft;
  window.__catscoGetCatsEndpointDraft = getCatsEndpointDraft;
  window.__catscoRenderCatsLayout = renderCatsLayout;
  window.__catscoClearCatsComposerInput = clearCatsComposerInput;
  window.__catscoRenderCatsComposer = renderCatsComposer;
  window.__catscoRenderCatsGate = renderCatsGate;
  window.__catscoRenderCatsStatusList = renderCatsStatusList;
  window.__catscoSetBotSelectorCreateBusy = setBotSelectorCreateBusy;
  window.__catscoSetBotSelectorOpen = setBotSelectorOpen;
  window.__catscoSetCatsAuthDraft = setCatsAuthDraft;
  window.__catscoSetCatsConnectionDetailsOpen = setCatsConnectionDetailsOpen;
  window.__catscoSetCatsEndpointDraft = setCatsEndpointDraft;
  window.__catscoGetCatsComposerDraft = getCatsComposerDraft;
  window.__catscoSetCatsComposerDraft = setCatsComposerDraft;
  window.__catscoFocusCatsAccount = focusCatsAccount;
  window.__catscoFocusCatsMessageInput = focusCatsMessageInput;
  window.__catscoRenderBotSelectorList = renderBotSelectorList;
  window.__catscoRenderCatsAttachments = renderCatsAttachments;
  window.__catscoRenderCatsMessages = renderCatsMessages;
  window.__catscoGetCatsMessagesBox = getCatsMessagesBox;
  window.__catscoResizeCatsComposerInput = resizeCatsComposerInput;
}
