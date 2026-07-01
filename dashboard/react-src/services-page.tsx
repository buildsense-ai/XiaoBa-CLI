import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

declare global {
  interface Window {
    __catscoRenderServices?: (payload: ServiceRenderPayload) => void;
    __catscoRenderCustomModelToggle?: (payload: CustomModelTogglePayload) => void;
    __catscoRenderModelSource?: (payload: ModelSourcePayload) => void;
    __catscoRenderModelSourceStatus?: (payload: ModelSourceStatusPayload) => void;
    __catscoCustomModelHasFocus?: () => boolean;
    __catscoGetCustomModelFocusSnapshot?: () => CustomModelFocusSnapshot;
    __catscoRestoreCustomModelFocus?: (snapshot: CustomModelFocusSnapshot) => void;
    __catscoScrollCustomModelSettings?: (block?: ScrollLogicalPosition) => void;
    __catscoGetServiceConfigDraft?: (name: string) => Record<string, string>;
    __catscoGetCustomModelDraft?: () => CustomModelDraft;
    __catscoSetCustomModelDraft?: (payload: CustomModelDraftPayload) => void;
    __catscoSetServiceConfigDraft?: (payload: ServiceConfigDraftPayload) => void;
    __catscoServiceConfigHasFocus?: () => boolean;
    __catscoSetModelSourceSaved?: (saved: boolean) => void;
    __catscoSetServiceConfigUi?: (payload: ServiceConfigUiPayload) => void;
    cancelServiceConfig?: (name: string) => void;
    fetchStatus?: () => void;
    getWeixinToken?: () => void;
    handleCustomModelToggle?: (open: boolean) => void;
    refreshSettingsPage?: () => void;
    saveCustomModelSettings?: () => void;
    saveServiceConfig?: (name: string) => void;
    scheduleCustomModelAutoSave?: () => void;
    showLogs?: (name: string, label: string) => void;
    svcAction?: (name: string, command: string) => void;
    toggleCustomModelSettings?: () => void;
  }
}

type ServiceInfo = {
  label?: string;
  lastError?: string;
  name?: string;
  pid?: string | number;
  status?: string;
  uptime?: number;
};

type ServiceConfigKey = {
  action?: string;
  key: string;
  label: string;
  sensitive?: boolean;
};

type ServiceConfigGroup = {
  hint: string;
  keys: ServiceConfigKey[];
  title: string;
};

type ServiceRenderPayload = {
  configData?: Record<string, unknown>;
  serviceConfigGroups?: Record<string, ServiceConfigGroup>;
  services: ServiceInfo[];
};

type ModelSourcePayload = {
  apiBaseDisplayValue?: string;
  apiBasePlaceholder?: string;
  credentialMeta?: string;
  customModelSettingsOpen?: boolean;
  fieldsAvailable?: boolean;
  hideInternalGateway?: boolean;
  keyPresent?: boolean;
  modelValue?: string;
  providerValue?: string;
};

type CustomModelTogglePayload = {
  open?: boolean;
};

type CustomModelDraft = {
  apiBase: string;
  clearSecret: boolean;
  model: string;
  provider: string;
  secret: string;
  secretPlaceholder: string;
};

type CustomModelDraftPayload = Partial<CustomModelDraft> & {
  dirty?: boolean;
  reset?: boolean;
};

type ModelSourceStatusPayload = {
  message?: string;
  tone?: string;
};

type ServiceConfigUiPayload = {
  dirty?: boolean;
  name: string;
  saved?: boolean;
};

type ServiceConfigUiState = {
  dirty?: boolean;
  saved?: boolean;
};

type CustomModelFocusSnapshot = {
  activeId?: string;
  selectionEnd?: number | null;
  selectionStart?: number | null;
};

type ServiceConfigDraftPayload = {
  dirty?: boolean;
  key?: string;
  name: string;
  reset?: boolean;
  saved?: boolean;
  value?: string;
  values?: Record<string, string>;
};

type ServicesPageState = {
  customModelDirty: boolean;
  customModelDraft: CustomModelDraft;
  customModelOpen: boolean;
  modelSourcePayload?: ModelSourcePayload;
  modelSourceSaved: boolean;
  modelSourceStatus: ModelSourceStatusPayload;
  serviceConfigDrafts: Record<string, Record<string, string>>;
  serviceConfigUi: Record<string, ServiceConfigUiState>;
  servicesPayload?: ServiceRenderPayload;
};

const SERVICE_COPY: Record<string, string> = {
  catscompany: '连接 CatsCo webapp，会把网页会话消息送入本地 agent。',
  feishu: '启动飞书机器人入口，用飞书 App 配置接入本地 agent。',
  weixin: '启动微信机器人入口，用微信 Token 接入本地 agent。',
};

const EMPTY_CUSTOM_MODEL_DRAFT: CustomModelDraft = {
  apiBase: '',
  clearSecret: false,
  model: '',
  provider: 'anthropic',
  secret: '',
  secretPlaceholder: '',
};

function serviceCopy(name: string) {
  return SERVICE_COPY[name] || '启动本地机器人连接器。';
}

function servicePrimaryAction(name: string, running: boolean) {
  if (running) return '停止';
  if (name === 'catscompany') return '启动 CatsCo';
  if (name === 'feishu') return '启动飞书';
  if (name === 'weixin') return '启动微信';
  return '启动';
}

function serviceConfigValue(key: string, configData: Record<string, unknown>) {
  if (Object.prototype.hasOwnProperty.call(configData, key)) return String(configData[key] ?? '');
  const aliases: Record<string, string> = {
    CATSCO_API_KEY: 'CATSCOMPANY_API_KEY',
    CATSCO_HTTP_BASE_URL: 'CATSCOMPANY_HTTP_BASE_URL',
    CATSCO_SERVER_URL: 'CATSCOMPANY_SERVER_URL',
  };
  const alias = aliases[key];
  return alias && Object.prototype.hasOwnProperty.call(configData, alias) ? String(configData[alias] ?? '') : '';
}

function serviceConfigValues(group: ServiceConfigGroup | undefined, configData: Record<string, unknown>) {
  const values: Record<string, string> = {};
  if (!group) return values;
  group.keys.forEach(item => {
    values[item.key] = serviceConfigValue(item.key, configData);
  });
  return values;
}

function syncedServiceConfigDrafts(
  payload: ServiceRenderPayload,
  currentDrafts: Record<string, Record<string, string>>,
  uiState: Record<string, ServiceConfigUiState>,
) {
  const nextDrafts = { ...currentDrafts };
  const configData = payload.configData || {};
  Object.entries(payload.serviceConfigGroups || {}).forEach(([name, group]) => {
    if (uiState[name]?.dirty && nextDrafts[name]) return;
    nextDrafts[name] = serviceConfigValues(group, configData);
  });
  return nextDrafts;
}

function customModelDraftFromPayload(payload: ModelSourcePayload | undefined): CustomModelDraft {
  return {
    ...EMPTY_CUSTOM_MODEL_DRAFT,
    apiBase: payload?.apiBaseDisplayValue || '',
    model: payload?.modelValue || '',
    provider: payload?.providerValue || 'anthropic',
  };
}

function formatServiceUptime(seconds: number) {
  const totalSeconds = Math.floor(Number(seconds) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`;
}

function serviceStatusClass(status: string) {
  return status.replace(/[^a-z0-9_-]/gi, '') || 'stopped';
}

function ServiceConfig({
  configData,
  draft,
  group,
  name,
  ui,
}: {
  configData: Record<string, unknown>;
  draft: Record<string, string>;
  group?: ServiceConfigGroup;
  name: string;
  ui?: ServiceConfigUiState;
}) {
  if (!group) return null;
  const className = `service-config${ui?.dirty ? ' dirty' : ''}`;

  return (
    <details
      className={className}
      id={`service-config-${name}`}
      onBlur={event => {
        const nextFocus = event.relatedTarget;
        if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
          if (focusedServiceConfigName === name) focusedServiceConfigName = '';
        }
      }}
      onFocus={() => {
        focusedServiceConfigName = name;
      }}
    >
      <summary>
        <span>{group.title}</span>
        <span className="tag">高级</span>
      </summary>
      <div className="service-config-body">
        <div className="runtime-note">{group.hint}</div>
        {group.keys.map(item => (
          <div className="service-config-row" key={item.key}>
            <label className="config-label">{item.label}</label>
            <input
              className="config-input"
              data-service-config={name}
              data-key={item.key}
              type={item.sensitive ? 'password' : 'text'}
              value={draft[item.key] ?? serviceConfigValue(item.key, configData)}
              onChange={event =>
                setServiceConfigDraft({
                  name,
                  key: item.key,
                  value: event.currentTarget.value,
                  dirty: true,
                  saved: false,
                })
              }
              placeholder={item.key}
            />
            {item.action === 'weixinToken' ? (
              <button className="btn btn-primary" type="button" onClick={() => window.getWeixinToken?.()} style={{ marginTop: 6 }}>
                获取 Token
              </button>
            ) : null}
          </div>
        ))}
        <div className="service-config-actions">
          <span className="service-config-hint">凭证仅保存到本地 .env</span>
          <button className="btn btn-primary" type="button" onClick={() => window.saveServiceConfig?.(name)}>
            保存
          </button>
          <button className="btn" type="button" onClick={() => window.cancelServiceConfig?.(name)}>
            取消
          </button>
          <span className={`config-saved${ui?.saved ? ' show' : ''}`} id={`service-config-saved-${name}`}>
            已保存
          </span>
        </div>
      </div>
    </details>
  );
}

function ServiceCard({
  configData,
  service,
  serviceConfigDrafts,
  serviceConfigGroups,
  serviceConfigUi,
}: {
  configData: Record<string, unknown>;
  service: ServiceInfo;
  serviceConfigDrafts: Record<string, Record<string, string>>;
  serviceConfigGroups: Record<string, ServiceConfigGroup>;
  serviceConfigUi: Record<string, ServiceConfigUiState>;
}) {
  const name = String(service.name || '');
  const label = String(service.label || name || 'Service');
  const status = String(service.status || 'stopped');
  const running = status === 'running';
  const uptime = running && service.uptime ? formatServiceUptime(service.uptime) : '-';

  return (
    <div className="service-card">
      <div className="service-header">
        <div className="service-name">{label}</div>
        <span className={`service-status ${serviceStatusClass(status)}`}>{status}</span>
      </div>
      <div className="service-copy">{serviceCopy(name)}</div>
      <div className="service-detail">
        {running ? (
          <>
            <span>PID: {service.pid}</span>
            <span>Uptime: {uptime}</span>
          </>
        ) : (
          <span>未运行</span>
        )}
        {service.lastError ? <span style={{ color: 'var(--red)' }}>{service.lastError}</span> : null}
      </div>
      <div className="service-actions">
        {running ? (
          <>
            <button className="btn btn-danger" type="button" onClick={() => window.svcAction?.(name, 'stop')}>
              {servicePrimaryAction(name, true)}
            </button>
            <button className="btn" type="button" onClick={() => window.svcAction?.(name, 'restart')}>
              重启
            </button>
          </>
        ) : (
          <button className="btn btn-success" type="button" onClick={() => window.svcAction?.(name, 'start')}>
            {servicePrimaryAction(name, false)}
          </button>
        )}
        <button className="btn" type="button" onClick={() => window.showLogs?.(name, label)}>
          日志
        </button>
      </div>
      <ServiceConfig
        configData={configData}
        draft={serviceConfigDrafts[name] || {}}
        group={serviceConfigGroups[name]}
        name={name}
        ui={serviceConfigUi[name]}
      />
    </div>
  );
}

function ServiceGrid({
  configData = {},
  serviceConfigDrafts,
  serviceConfigGroups = {},
  serviceConfigUi,
  services,
}: ServiceRenderPayload & {
  serviceConfigDrafts: Record<string, Record<string, string>>;
  serviceConfigUi: Record<string, ServiceConfigUiState>;
}) {
  if (!services.length) return <div className="loading">无服务</div>;
  return (
    <>
      {services.map(service => (
        <ServiceCard
          configData={configData}
          key={`${service.name || service.label}-${JSON.stringify(configData)}`}
          service={service}
          serviceConfigDrafts={serviceConfigDrafts}
          serviceConfigUi={serviceConfigUi}
          serviceConfigGroups={serviceConfigGroups}
        />
      ))}
    </>
  );
}

function setCustomModelFieldElement<T extends HTMLElement>(id: string) {
  return (element: T | null) => {
    if (element) customModelFieldElements[id] = element;
    else delete customModelFieldElements[id];
  };
}

function ModelSourcePanel({
  apiBasePlaceholder = 'https://example.com/v1/messages',
  credentialMeta = '未配置访问凭证',
  customModelSettingsOpen = false,
  draft,
  fieldsAvailable = true,
  hideInternalGateway = false,
  keyPresent = false,
  saved = false,
  status = {},
}: ModelSourcePayload & { draft: CustomModelDraft; saved?: boolean; status?: ModelSourceStatusPayload }) {
  if (!fieldsAvailable) {
    return <div className="runtime-note warning">模型来源暂不可用，请稍后刷新。</div>;
  }
  const statusText =
    status.message || '凭证仅保存到本地 .env；自定义模型默认 128K 安全上下文，新 session 或下一次启动 connector 后生效。';
  const statusColor = status.tone === 'error' ? 'var(--red)' : status.tone === 'success' ? 'var(--green)' : 'var(--text2)';
  const updateDraft = (payload: CustomModelDraftPayload) => {
    setCustomModelDraft({ ...payload, dirty: true });
    window.scheduleCustomModelAutoSave?.();
  };
  const secretPlaceholder = draft.secretPlaceholder || (keyPresent ? '留空表示保持现有凭证' : '输入访问凭证');

  return (
      <div className="model-source-layout">
        <div className="runtime-note">
        中转模型和自定义模型会分别保存。CatsCo 中转会按所选模型自动调整上下文；自定义模型默认按 128K
        安全上下文运行，若模型实际窗口更小，请减少历史或在高级环境变量里降低 GAUZ_LLM_CONTEXT_WINDOW_TOKENS。
      </div>
      <details
        className="model-source-card warning"
        id="custom-model-settings"
        onToggle={event => window.handleCustomModelToggle?.((event.currentTarget as HTMLDetailsElement).open)}
        open={customModelSettingsOpen}
        ref={element => {
          customModelDetailsElement = element;
        }}
      >
        <summary>
          <div className="model-source-head">
            <div>
              <div className="model-source-title">自定义模型（第三方）</div>
              <div className="model-source-copy">
                只有手动接入第三方模型时需要填写。CatsCo 中转模型请在 CatsCo 页面选择；自定义模型默认使用 128K
                安全上下文。
              </div>
            </div>
            <span className={`tag ${keyPresent ? 'green' : 'gray'}`}>{credentialMeta}</span>
          </div>
        </summary>
        <div className="model-source-form">
          <div className="config-row">
            <label className="config-label">兼容类型</label>
            <select
              className="config-select"
              id="model-provider-setting"
              ref={setCustomModelFieldElement<HTMLSelectElement>('model-provider-setting')}
              value={draft.provider || 'anthropic'}
              onChange={event => updateDraft({ provider: event.currentTarget.value })}
            >
              <option value="anthropic">Anthropic-compatible</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </div>
          <div className="config-row">
            <label className="config-label">模型地址</label>
            <input
              className="config-input"
              data-hidden-internal={hideInternalGateway ? 'true' : 'false'}
              id="model-api-base-setting"
              ref={setCustomModelFieldElement<HTMLInputElement>('model-api-base-setting')}
              value={draft.apiBase}
              onChange={event => updateDraft({ apiBase: event.currentTarget.value })}
              placeholder={apiBasePlaceholder}
            />
          </div>
          <div className="config-row">
            <label className="config-label">模型名称</label>
            <input
              className="config-input"
              id="model-name-setting"
              ref={setCustomModelFieldElement<HTMLInputElement>('model-name-setting')}
              value={draft.model}
              onChange={event => updateDraft({ model: event.currentTarget.value })}
              placeholder="model-name"
            />
          </div>
          <div className="config-row">
            <label className="config-label">访问凭证</label>
            <input
              className="config-input"
              id="model-secret-setting"
              ref={setCustomModelFieldElement<HTMLInputElement>('model-secret-setting')}
              type="password"
              value={draft.secret}
              onChange={event => updateDraft({ secret: event.currentTarget.value, secretPlaceholder: '' })}
              placeholder={secretPlaceholder}
            />
          </div>
          <div className="model-secret-row">
            <label>
              <input
                type="checkbox"
                id="model-secret-clear-setting"
                ref={setCustomModelFieldElement<HTMLInputElement>('model-secret-clear-setting')}
                checked={draft.clearSecret}
                onChange={event => updateDraft({ clearSecret: event.currentTarget.checked })}
              /> 清除已保存的访问凭证
            </label>
            <span>{credentialMeta}</span>
          </div>
          <div className="model-source-actions">
            <button className="btn btn-primary" type="button" onClick={() => window.saveCustomModelSettings?.()}>
              保存自定义模型
            </button>
            <span className={`config-saved${saved ? ' show' : ''}`} id="model-source-saved">
              已保存
            </span>
          </div>
          <div id="model-source-status" data-react-model-source-status="mounted" style={{ color: statusColor, fontSize: 13 }}>
            {statusText}
          </div>
        </div>
      </details>
    </div>
  );
}

function ServicesPage({ state }: { state: ServicesPageState }) {
  const modelSourcePayload = state.modelSourcePayload
    ? { ...state.modelSourcePayload, customModelSettingsOpen: state.customModelOpen }
    : undefined;

  return (
    <>
      <div className="settings-header">
        <div className="settings-heading">
          <div className="settings-kicker">Agent Hub</div>
          <div className="section-title" style={{ marginBottom: 0 }}>
            运行、连接与设置
          </div>
          <div className="settings-meta">集中处理本地 agent、连接器和必要的高级环境变量。</div>
        </div>
        <button className="btn btn-primary" type="button" onClick={() => window.fetchStatus?.()}>
          刷新状态
        </button>
      </div>

      <div className="services-grid robot-grid" data-react-services-grid="mounted" id="services-grid">
        {state.servicesPayload ? (
          <ServiceGrid
            {...state.servicesPayload}
            serviceConfigDrafts={state.serviceConfigDrafts}
            serviceConfigUi={state.serviceConfigUi}
          />
        ) : (
          <div className="loading">加载中...</div>
        )}
      </div>

      <div className="settings-header" style={{ marginTop: 28 }}>
        <div className="settings-heading">
          <div className="settings-kicker">Settings</div>
          <div className="section-title" style={{ marginBottom: 0 }}>
            自定义模型
          </div>
          <div className="settings-meta">CatsCo 中转模型在 CatsCo 页面选择；这里只保留第三方模型的手动配置。</div>
        </div>
        <div className="settings-actions">
          <button
            className="btn"
            data-react-custom-model-toggle="mounted"
            id="custom-model-toggle-btn"
            type="button"
            onClick={() => window.toggleCustomModelSettings?.()}
          >
            {state.customModelOpen ? '收纳配置' : '展开配置'}
          </button>
          <button className="btn" type="button" onClick={() => window.refreshSettingsPage?.()}>
            刷新设置
          </button>
        </div>
      </div>

      <div className="config-section" data-react-model-source="mounted" id="model-source-panel">
        {modelSourcePayload ? (
          <ModelSourcePanel
            {...modelSourcePayload}
            draft={state.customModelDraft}
            saved={state.modelSourceSaved}
            status={state.modelSourceStatus}
          />
        ) : (
          <div className="loading">加载模型来源...</div>
        )}
      </div>
    </>
  );
}

let servicesPageRoot: Root | null = null;
let servicesPageElement: HTMLElement | null = null;
let customModelDetailsElement: HTMLDetailsElement | null = null;
const customModelFieldElements: Record<string, HTMLElement | null> = {};
let focusedServiceConfigName = '';
let servicesPageState: ServicesPageState = {
  customModelDirty: false,
  customModelDraft: EMPTY_CUSTOM_MODEL_DRAFT,
  customModelOpen: false,
  modelSourceSaved: false,
  modelSourceStatus: {},
  serviceConfigDrafts: {},
  serviceConfigUi: {},
};

function renderServicesPage() {
  if (!servicesPageElement) return;
  servicesPageRoot ||= createRoot(servicesPageElement);
  servicesPageRoot?.render(<ServicesPage state={servicesPageState} />);
  servicesPageElement.dataset.reactServices = 'mounted';
}

function renderServicesGrid(payload: ServiceRenderPayload) {
  servicesPageState = {
    ...servicesPageState,
    serviceConfigDrafts: syncedServiceConfigDrafts(payload, servicesPageState.serviceConfigDrafts, servicesPageState.serviceConfigUi),
    servicesPayload: payload,
  };
  renderServicesPage();
}

function baselineServiceConfigDraft(name: string) {
  return serviceConfigValues(servicesPageState.servicesPayload?.serviceConfigGroups?.[name], servicesPageState.servicesPayload?.configData || {});
}

function getServiceConfigDraft(name: string) {
  if (!name) return {};
  return {
    ...baselineServiceConfigDraft(name),
    ...(servicesPageState.serviceConfigDrafts[name] || {}),
  };
}

function getCustomModelDraft() {
  return {
    ...customModelDraftFromPayload(servicesPageState.modelSourcePayload),
    ...servicesPageState.customModelDraft,
  };
}

function setCustomModelDraft(payload: CustomModelDraftPayload) {
  const baseline = payload.reset ? customModelDraftFromPayload(servicesPageState.modelSourcePayload) : getCustomModelDraft();
  servicesPageState = {
    ...servicesPageState,
    customModelDirty: Boolean(payload.dirty ?? servicesPageState.customModelDirty),
    customModelDraft: {
      ...baseline,
      ...(payload.apiBase === undefined ? {} : { apiBase: String(payload.apiBase ?? '') }),
      ...(payload.clearSecret === undefined ? {} : { clearSecret: Boolean(payload.clearSecret) }),
      ...(payload.model === undefined ? {} : { model: String(payload.model ?? '') }),
      ...(payload.provider === undefined ? {} : { provider: String(payload.provider || 'anthropic') }),
      ...(payload.secret === undefined ? {} : { secret: String(payload.secret ?? '') }),
      ...(payload.secretPlaceholder === undefined ? {} : { secretPlaceholder: String(payload.secretPlaceholder ?? '') }),
    },
  };
  renderServicesPage();
}

function setServiceConfigDraft({ dirty, key, name, reset = false, saved, value = '', values }: ServiceConfigDraftPayload) {
  if (!name) return;
  const nextDraft = reset ? baselineServiceConfigDraft(name) : getServiceConfigDraft(name);
  if (values) {
    Object.entries(values).forEach(([draftKey, draftValue]) => {
      nextDraft[draftKey] = String(draftValue ?? '');
    });
  }
  if (key) nextDraft[key] = String(value ?? '');
  servicesPageState = {
    ...servicesPageState,
    serviceConfigDrafts: {
      ...servicesPageState.serviceConfigDrafts,
      [name]: nextDraft,
    },
    serviceConfigUi: {
      ...servicesPageState.serviceConfigUi,
      [name]: {
        ...servicesPageState.serviceConfigUi[name],
        ...(dirty === undefined ? {} : { dirty }),
        ...(saved === undefined ? {} : { saved }),
      },
    },
  };
  renderServicesPage();
}

function serviceConfigHasFocus() {
  return Boolean(focusedServiceConfigName);
}

function renderModelSourcePanel(payload: ModelSourcePayload) {
  const nextCustomModelOpen = Boolean(payload.customModelSettingsOpen ?? servicesPageState.customModelOpen);
  const keepDraft = servicesPageState.customModelDirty || nextCustomModelOpen;
  servicesPageState = {
    ...servicesPageState,
    customModelDirty: keepDraft ? servicesPageState.customModelDirty : false,
    customModelDraft: keepDraft ? servicesPageState.customModelDraft : customModelDraftFromPayload(payload),
    customModelOpen: nextCustomModelOpen,
    modelSourcePayload: payload,
  };
  renderServicesPage();
}

function renderCustomModelToggle({ open = false }: CustomModelTogglePayload) {
  servicesPageState = { ...servicesPageState, customModelOpen: open };
  renderServicesPage();
}

function renderModelSourceStatus({ message = '', tone = '' }: ModelSourceStatusPayload) {
  servicesPageState = { ...servicesPageState, modelSourceStatus: { message, tone } };
  renderServicesPage();
}

function setModelSourceSaved(saved: boolean) {
  servicesPageState = { ...servicesPageState, modelSourceSaved: Boolean(saved) };
  renderServicesPage();
}

function customModelHasFocus() {
  const active = document.activeElement;
  return Boolean(customModelDetailsElement && active && customModelDetailsElement.contains(active));
}

function getCustomModelFocusSnapshot(): CustomModelFocusSnapshot {
  const active = document.activeElement as HTMLElement | null;
  if (!customModelDetailsElement || !active || !customModelDetailsElement.contains(active)) {
    return { activeId: '', selectionEnd: null, selectionStart: null };
  }
  const input = active as HTMLInputElement | HTMLTextAreaElement;
  return {
    activeId: active.id || '',
    selectionEnd: typeof input.selectionEnd === 'number' ? input.selectionEnd : null,
    selectionStart: typeof input.selectionStart === 'number' ? input.selectionStart : null,
  };
}

function restoreCustomModelFocus(snapshot: CustomModelFocusSnapshot = {}) {
  const activeId = String(snapshot.activeId || '');
  const active = activeId ? customModelFieldElements[activeId] : null;
  if (!active) return;
  active.focus({ preventScroll: true });
  const input = active as HTMLInputElement | HTMLTextAreaElement;
  if (typeof snapshot.selectionStart === 'number' && typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(snapshot.selectionStart || 0, snapshot.selectionEnd ?? snapshot.selectionStart ?? 0);
  }
}

function scrollCustomModelSettings(block: ScrollLogicalPosition = 'nearest') {
  customModelDetailsElement?.scrollIntoView({ behavior: 'smooth', block });
}

function setServiceConfigUi({ dirty, name, saved }: ServiceConfigUiPayload) {
  if (!name) return;
  servicesPageState = {
    ...servicesPageState,
    serviceConfigUi: {
      ...servicesPageState.serviceConfigUi,
      [name]: {
        ...servicesPageState.serviceConfigUi[name],
        ...(dirty === undefined ? {} : { dirty }),
        ...(saved === undefined ? {} : { saved }),
      },
    },
  };
  renderServicesPage();
}

export function mountServicesPage() {
  const root = document.getElementById('services-page-root');
  if (!root) return;
  servicesPageElement = root;
  renderServicesPage();
  window.__catscoRenderServices = renderServicesGrid;
  window.__catscoRenderCustomModelToggle = renderCustomModelToggle;
  window.__catscoRenderModelSource = renderModelSourcePanel;
  window.__catscoRenderModelSourceStatus = renderModelSourceStatus;
  window.__catscoCustomModelHasFocus = customModelHasFocus;
  window.__catscoGetCustomModelFocusSnapshot = getCustomModelFocusSnapshot;
  window.__catscoRestoreCustomModelFocus = restoreCustomModelFocus;
  window.__catscoScrollCustomModelSettings = scrollCustomModelSettings;
  window.__catscoGetCustomModelDraft = getCustomModelDraft;
  window.__catscoSetCustomModelDraft = setCustomModelDraft;
  window.__catscoGetServiceConfigDraft = getServiceConfigDraft;
  window.__catscoSetServiceConfigDraft = setServiceConfigDraft;
  window.__catscoServiceConfigHasFocus = serviceConfigHasFocus;
  window.__catscoSetModelSourceSaved = setModelSourceSaved;
  window.__catscoSetServiceConfigUi = setServiceConfigUi;
}
