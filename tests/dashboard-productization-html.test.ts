import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf-8');

const dashboardHtml = read('dashboard/index.html');
const dashboardCss = read('dashboard/styles/dashboard.css');

const reactFiles = {
  chat: read('dashboard/react-src/chat-page.tsx'),
  companion: read('dashboard/react-src/companion-page.tsx'),
  globalModals: read('dashboard/react-src/global-modals.tsx'),
  prompts: read('dashboard/react-src/prompts-page.tsx'),
  services: read('dashboard/react-src/services-page.tsx'),
  shell: read('dashboard/react-src/dashboard-shell.tsx'),
  store: read('dashboard/react-src/store-page.tsx'),
};

const scriptFiles = {
  attachments: read('dashboard/scripts/cats-chat-attachments.js'),
  basePet: read('dashboard/scripts/base-pet.js'),
  bootstrap: read('dashboard/scripts/bootstrap.js'),
  catsChat: read('dashboard/scripts/cats-chat-core.js'),
  config: read('dashboard/scripts/dashboard-config.js'),
  fontScale: read('dashboard/scripts/font-scale.js'),
  markdown: read('dashboard/scripts/cats-chat-markdown.js'),
  messages: read('dashboard/scripts/cats-chat-messages.js'),
  modelSettings: read('dashboard/scripts/model-settings.js'),
  promptCompanion: read('dashboard/scripts/prompt-companion.js'),
  promptWorkbench: read('dashboard/scripts/prompt-workbench.js'),
  serviceUpdate: read('dashboard/scripts/service-update.js'),
  settingsState: read('dashboard/scripts/settings-state.js'),
  skillhub: read('dashboard/scripts/skillhub.js'),
  status: read('dashboard/scripts/dashboard-status.js'),
  weixin: read('dashboard/scripts/weixin.js'),
};

const reactSource = Object.values(reactFiles).join('\n');
const scriptSource = Object.values(scriptFiles).join('\n');
const dashboardSource = [dashboardHtml, dashboardCss, reactSource, scriptSource].join('\n');

test('dashboard index is a small React shell with split runtime scripts', () => {
  assert.match(dashboardHtml, /<div id="dashboard-app-root" data-dashboard-version="1\.2\.0"><\/div>/);
  assert.match(dashboardHtml, /<div id="global-modals-root"><\/div>/);
  assert.match(dashboardHtml, /build\/dashboard-shell\.js\?v=react-script-bridge-free/);
  assert.match(dashboardHtml, /styles\/dashboard\.css\?v=react-script-bridge-free/);

  for (const scriptName of [
    'base-pet',
    'settings-state',
    'dashboard-config',
    'dashboard-status',
    'service-update',
    'model-settings',
    'font-scale',
    'skillhub',
    'cats-chat-core',
    'cats-chat-markdown',
    'cats-chat-messages',
    'cats-chat-attachments',
    'prompt-workbench',
    'prompt-companion',
    'weixin',
    'bootstrap',
  ]) {
    assert.match(dashboardHtml, new RegExp(`scripts/${scriptName}\\.js\\?v=react-script-bridge-free`));
  }

  assert.equal(dashboardHtml.split(/\r?\n/).length <= 40, true);
  assert.doesNotMatch(dashboardHtml, /legacy-dashboard|legacy-body|react-legacy-shell|onclick=|onchange=|oninput=/);
});

test('React shell owns navigation, page roots, and global modal mounting', () => {
  assert.match(reactFiles.shell, /import \{ mountChatPage \} from '\.\/chat-page'/);
  assert.match(reactFiles.shell, /import \{ mountServicesPage \} from '\.\/services-page'/);
  assert.match(reactFiles.shell, /import \{ mountPromptsPage \} from '\.\/prompts-page'/);
  assert.match(reactFiles.shell, /import \{ mountCompanionPage \} from '\.\/companion-page'/);
  assert.match(reactFiles.shell, /import \{ mountStorePage \} from '\.\/store-page'/);
  assert.match(reactFiles.shell, /import \{ mountGlobalModals \} from '\.\/global-modals'/);
  assert.match(reactFiles.shell, /href=\{`#\$\{item\.page\}`\}/);
  assert.match(reactFiles.shell, /page: 'prompts'/);
  assert.ok(reactFiles.shell.indexOf("page: 'store'") < reactFiles.shell.indexOf("page: 'prompts'"));
  assert.match(reactFiles.shell, /id: 'services-page-root'/);
  assert.match(reactFiles.shell, /id: 'prompts-page-root'/);
  assert.match(reactFiles.shell, /id: 'companion-page-root'/);
  assert.match(reactFiles.shell, /id: 'store-page-root'/);
  assert.match(reactFiles.shell, /id: 'chat-page-root'/);
  assert.match(reactFiles.shell, /mountPromptsPage\(\);/);
  assert.match(dashboardCss, /\.sidebar-brand-logo\s*\{[\s\S]*width:\s*100%;[\s\S]*height:\s*100%;[\s\S]*object-fit:\s*contain;[\s\S]*border-radius:\s*inherit;/);
  assert.match(dashboardCss, /\.modal-body\s*\{[\s\S]*font-family:\s*'SF Mono', 'Fira Code', 'Consolas', monospace;[\s\S]*font-size:\s*12px;[\s\S]*line-height:\s*1\.75;[\s\S]*white-space:\s*pre-wrap;/);
  assert.match(reactFiles.shell, /document\.body\.classList\.toggle\('chat-active', activePage === 'chat'\)/);
  assert.match(reactFiles.shell, /document\.body\.classList\.toggle\('companion-active', activePage === 'companion'\)/);
  assert.match(reactFiles.globalModals, /export function mountGlobalModals\(\)/);
  assert.match(reactFiles.globalModals, /onClick=\{\(\) => window\.closeUpdateModal\?\.\(\)\}/);
  assert.match(reactFiles.globalModals, /onClick=\{\(\) => window\.closeCatsMediaPreview\?\.\(\)\}/);
  assert.match(reactFiles.globalModals, /if \(globalModalsState\.modalOpen\.update\) window\.closeUpdateModal\?\.\(\);/);
  assert.match(reactFiles.globalModals, /if \(globalModalsState\.modalOpen\.mediaPreview\) window\.closeCatsMediaPreview\?\.\(\);/);
  assert.match(reactFiles.globalModals, /<span style=\{color \? \{ color \} : undefined\}>\{payload\.text\}<\/span>/);
  assert.doesNotMatch(reactFiles.globalModals, /<pre[^>]*>\{payload\.text\}<\/pre>/);
  assert.doesNotMatch(reactSource, /legacyBody|dangerouslySetInnerHTML|data-action|onclick=|onchange=|oninput=/);
});

test('Agent Hub and model settings are React-rendered while scripts provide API state', () => {
  assert.match(reactFiles.services, /id="services-grid"/);
  assert.match(reactFiles.services, /id="custom-model-toggle-btn"/);
  assert.match(reactFiles.services, /id="model-source-panel"/);
  assert.match(reactFiles.services, /id="model-context-window-setting"/);
  assert.match(reactFiles.services, /contextWindowTokens: '128000'/);
  assert.match(reactFiles.services, /128K · 安全默认/);
  assert.match(reactFiles.services, /留空表示保持现有凭证/);
  assert.match(reactFiles.services, /输入访问凭证/);
  assert.doesNotMatch(reactFiles.services, /鐣欑|杈撳/);
  assert.match(reactFiles.chat, /data-relay-model-id=\{choice\.id\}/);
  assert.match(reactFiles.chat, /data-relay-model-context="chat"/);
  assert.match(reactFiles.services, /window\.saveServiceConfig\?\.\(name\)/);
  assert.match(scriptFiles.status, /function markServiceConfigDirty\(name\)/);
  assert.match(scriptFiles.status, /async function saveServiceConfig\(name\)/);
  assert.match(scriptFiles.status, /function cancelServiceConfig\(name\)/);
  assert.match(scriptFiles.modelSettings, /async function refreshSettingsPage\(\)/);
  assert.match(scriptFiles.modelSettings, /function openCustomModelFromChat\(\)\{\s*switchPage\('services'\);/);
  assert.match(scriptFiles.modelSettings, /CUSTOM_MODEL_CONTEXT_WINDOW_OPTIONS/);
  assert.match(scriptFiles.modelSettings, /function customModelContextWindowValue\(rawValue\)/);
  assert.match(scriptFiles.modelSettings, /'model\.contextWindowTokens':contextWindowTokens/);
  assert.match(scriptFiles.modelSettings, /contextWindowTokens:settings\['model\.contextWindowTokens'\]/);
  assert.match(scriptFiles.modelSettings, /'标准额度'/);
  assert.match(scriptFiles.modelSettings, /meta:quota\+' · 上下文 '\+contextLabel/);
  assert.match(scriptFiles.modelSettings, /'自定义配置 · 上下文 '\+customContextLabel/);
  assert.doesNotMatch(scriptFiles.modelSettings, /Low quota Flash|Multimodal|Standard quota|Custom config|Not configured|Configure endpoint \/ key/);
  assert.match(scriptFiles.modelSettings, /async function refreshCatsChatAfterMutation\(options=\{\}\)/);
  assert.match(scriptFiles.modelSettings, /setCatsStatusMutationBusy\(true\);[\s\S]*invalidateCatsStatusRequests\(\);/);
  assert.match(scriptFiles.modelSettings, /fetchCatsStatus\(\{priority:true\}\)/);
  assert.match(scriptFiles.modelSettings, /function enableCatsRelayModel\(modelId, options=\{\}\)/);
  assert.match(scriptFiles.modelSettings, /function enableRelayFallbackForIncompleteCustom\(options=\{\}\)/);
  assert.match(scriptFiles.modelSettings, /自定义模型未填写，正在改用 CatsCo 中转模型/);
  assert.match(scriptFiles.modelSettings, /\/api\/cats\/relay\/model-config\/apply/);
  assert.match(scriptFiles.config, /if\(appStatusSnapshot && Array\.isArray\(appStatusSnapshot\.services\) && !shouldDeferServiceRender\(\)\)renderServices\(appStatusSnapshot\.services\);/);
  assert.doesNotMatch(reactFiles.services, /settings-setup-panel|env-config-details|save-config-btn|config-panel/);
  assert.doesNotMatch(dashboardSource, /setupEnvConfigLazyLoad|escapeJsString|buildsense\.asia/i);
});

test('Companion Hub is a React pet view with preview and floating controls', () => {
  assert.match(reactFiles.companion, /id="companion-pet-bubble"/);
  assert.match(reactFiles.companion, /id="pet-frame-strip"/);
  assert.match(reactFiles.companion, /id="floating-pet-root"|id="floating-pet"/);
  assert.match(reactFiles.companion, /id="companion-prompt-card"/);
  assert.match(reactFiles.companion, /id="companion-prompt-proposal"/);
  assert.match(reactFiles.companion, /id="floating-prompt-proposal"/);
  assert.match(reactFiles.companion, /window\.previewPetAction\?\.\(action\.state\)/);
  assert.match(scriptFiles.basePet, /function previewPetAction/);
  assert.match(scriptFiles.basePet, /let previewPetState/);
  assert.match(scriptFiles.basePet, /function restorePetRealState/);
  assert.match(scriptFiles.basePet, /function shouldInterruptPetPreview/);
  assert.doesNotMatch(reactFiles.companion, /pet-token-xp/);
});

test('Companion prompt advisor is React-rendered while preserving current proposals', () => {
  assert.match(reactFiles.companion, /type PromptCompanionAdvisor/);
  assert.match(reactFiles.companion, /function PromptCompanionAdvisorNotice/);
  assert.match(reactFiles.companion, /function PromptCompanionStage/);
  assert.match(reactFiles.companion, /function buildPromptCompanionNoProposalCopy/);
  assert.match(reactFiles.companion, /Runtime signals exist, but there is no safe prompt patch yet/);
  assert.match(reactFiles.companion, /<PromptCompanionStage title="1\. Issue">/);
  assert.match(reactFiles.companion, /<PromptCompanionStage title="2\. Proposed change">/);
  assert.match(reactFiles.companion, /<PromptCompanionStage title="3\. Confirm">/);
  assert.match(reactFiles.companion, /window\.__catscoRenderPromptCompanion = renderPromptCompanion/);
  assert.match(scriptFiles.promptCompanion, /let promptCompanionAdvisor = null/);
  assert.match(scriptFiles.promptCompanion, /let promptCompanionAdvisorNotice = ''/);
  assert.match(scriptFiles.promptCompanion, /const advisor = data\.advisor \|\| null/);
  assert.match(scriptFiles.promptCompanion, /promptCompanionAdvisor = advisor/);
  assert.match(scriptFiles.promptCompanion, /function formatPromptCompanionAdvisorNotice\(advisor, fallback\)/);
  assert.match(scriptFiles.promptCompanion, /function buildPromptCompanionNoProposalCopy\(signals\)/);
  assert.match(scriptFiles.promptCompanion, /else if \(note\) \{\s*promptCompanionAdvisorNotice = promptCompanionProposal/);
  assert.match(scriptFiles.promptCompanion, /kept current suggestion/);
  assert.match(scriptFiles.promptCompanion, /else \{\s*promptCompanionProposal = null;\s*promptCompanionAdvisor = null;\s*promptCompanionAdvisorNotice = '';\s*\}/);
  assert.match(scriptFiles.bootstrap, /fetchPromptCompanionProposal\(\)/);
  assert.doesNotMatch(scriptFiles.promptCompanion, /document\.|querySelector|getElementById|classList|innerHTML|insertAdjacentHTML|activeElement|closest\(/);
});

test('Prompt Lab is React-rendered and keeps prompt editing behind script bridges', () => {
  assert.match(reactFiles.prompts, /id="prompt-workbench"/);
  assert.match(reactFiles.prompts, /Prompt Lab/);
  assert.match(reactFiles.prompts, /提示词调试/);
  assert.match(reactFiles.prompts, /id="prompt-editor-textarea"/);
  assert.match(reactFiles.prompts, /window\.savePromptEditorFile\?\.\(\)/);
  assert.match(reactFiles.prompts, /window\.resetPromptEditorFile\?\.\(\)/);
  assert.match(reactFiles.prompts, /window\.setBranchAgentsEnabled\?\.\(event\.currentTarget\.checked\)/);
  assert.match(reactFiles.prompts, /window\.__catscoRenderPromptWorkbench = renderPromptWorkbench/);
  assert.match(reactFiles.prompts, /window\.__catscoGetPromptEditorDraft = getPromptEditorDraft/);
  assert.match(scriptFiles.promptWorkbench, /async function refreshPromptWorkbench\(selectPath, options = \{\}\)/);
  assert.match(scriptFiles.promptWorkbench, /\/api\/prompts'/);
  assert.match(scriptFiles.promptWorkbench, /\/api\/prompts\/file/);
  assert.match(scriptFiles.promptWorkbench, /\/api\/prompts\/branch-agents/);
  assert.match(scriptFiles.promptWorkbench, /\/api\/prompts\/editor-skill\/install/);
  assert.match(scriptFiles.promptWorkbench, /window\.__catscoRenderPromptWorkbench\?\./);
  assert.match(scriptFiles.status, /dashboardActivePage === 'prompts'/);
  assert.match(scriptFiles.promptCompanion, /window\.refreshPromptWorkbench\?\.\(p\.path \|\| data\.proposal\?\.path \|\| 'system-prompt\.md'\)/);
  assert.doesNotMatch(scriptFiles.promptWorkbench, /document\.|querySelector|getElementById|classList|innerHTML|insertAdjacentHTML|activeElement|closest\(/);
});

test('SkillHub store is separate from Companion Hub and owns publishing controls', () => {
  assert.match(reactFiles.store, /id="skillhub-section"/);
  assert.match(reactFiles.store, /id="skillhub-search-input"/);
  assert.match(reactFiles.store, /id="skillhub-package-versions-list"/);
  assert.match(reactFiles.store, /公开 Skill 无需登录即可搜索和安装；登录后可分享本地 Skill 并管理已发布版本。/);
  assert.match(reactFiles.store, /placeholder="搜索合同审查、PPT、工程量清单\.\.\."/);
  assert.match(reactFiles.store, /<span>发现技能<\/span>/);
  assert.match(reactFiles.store, /<span>已安装技能<\/span>/);
  assert.match(reactFiles.store, /id="copy-skills-root-btn"/);
  assert.match(reactFiles.store, /我的发布/);
  assert.match(reactFiles.store, /data-skillhub-install=\{canInstall \? 'true' : undefined\}/);
  assert.match(reactFiles.store, /data-skillhub-versions="true"/);
  assert.match(reactFiles.store, /data-skillhub-yank-version="true"/);
  assert.match(reactFiles.store, /data-skillhub-restore-version="true"/);
  assert.match(reactFiles.store, /data-skillhub-delete-version="true"/);
  assert.match(scriptFiles.status, /if \(target === 'skills'\) return switchPage\('store'\);/);
  assert.match(scriptFiles.status, /if \(target === 'prompts'\) return switchPage\('prompts'\);/);
  assert.match(scriptFiles.skillhub, /async function copySkillsRootPath\(\)/);
  assert.match(scriptFiles.skillhub, /async function installSkillHubSkill\(skillId, version\)/);
  assert.match(scriptFiles.skillhub, /async function showSkillHubVersions\(skillId\)/);
  assert.match(scriptFiles.skillhub, /async function yankOwnSkillHubVersion\(packageVersionId\)/);
  assert.match(scriptFiles.skillhub, /async function restoreOwnSkillHubVersion\(packageVersionId\)/);
  assert.match(scriptFiles.skillhub, /async function deleteOwnSkillHubVersion\(packageVersionId\)/);
  assert.match(scriptFiles.weixin, /let weixinPollAgentUid=''/);
  assert.match(scriptFiles.weixin, /agent_uid/);
  assert.match(scriptFiles.weixin, /encodeURIComponent\(qrcode\)\+agentParam/);
  assert.match(scriptFiles.weixin, /d\.status==='confirmed'&&d\.token_saved/);
  assert.doesNotMatch(scriptFiles.weixin, /d\.bot_token|WEIXIN_TOKEN/);
  assert.doesNotMatch(
    dashboardSource,
    /SkillHub Developer|id="skillhub-developer-apply"|id="skillhub-developer-console"|data-page="developer"|id="page-developer"/,
  );
  assert.doesNotMatch(
    scriptFiles.skillhub,
    /applySkillHubDeveloper|createSkillHubManifestDraft|submitSkillHubReview|renderSkillHubManifestPreviewState/,
  );
  assert.doesNotMatch(reactFiles.store, /\?\? Skill \?+/);
  assert.doesNotMatch(reactFiles.store, /placeholder="\?+/);
});

test('CatsCo Chat readiness, setup, and composer are split between React UI and script state', () => {
  assert.match(reactFiles.chat, /id="cats-chat-state"/);
  assert.match(reactFiles.chat, /id="cats-state-card"/);
  assert.match(reactFiles.chat, /id="cats-checklist"/);
  assert.match(reactFiles.chat, /id="cats-relay-model-panel"/);
  assert.match(reactFiles.chat, /id="cats-connection-details"/);
  assert.match(reactFiles.chat, /id="cats-message-input"/);
  assert.match(reactFiles.chat, /id="cats-send-btn"/);
  assert.match(reactFiles.chat, /id="cats-attach-btn"/);
  assert.match(reactFiles.chat, /<span className="relay-model-label">自定义模型<\/span>/);
  assert.match(reactFiles.chat, /正在加载更早消息/);
  assert.match(reactFiles.chat, /已到最早消息/);
  assert.match(reactFiles.chat, /group\.mine \? '我' : 'C'/);
  assert.doesNotMatch(reactFiles.chat, /Custom model|Loading earlier messages|Reached the earliest message|group\.mine \? 'Me'/);
  assert.match(reactFiles.chat, /__catscoFocusCatsMessageInput/);
  assert.match(reactFiles.chat, /input\.style\.height = 'auto'/);
  assert.doesNotMatch(reactFiles.chat, /setupLabel = '检查并启动'/);
  assert.match(scriptFiles.basePet, /let pendingStartupSource = ''/);
  assert.match(scriptFiles.catsChat, /function buildCatsChatStage\(\)/);
  assert.match(scriptFiles.catsChat, /function isCatsBodyReady\(bodyStatus\)/);
  assert.match(scriptFiles.catsChat, /bodyStatus\?\.active===true/);
  assert.match(scriptFiles.catsChat, /state==='active'\|\|state==='online'/);
  assert.doesNotMatch(scriptFiles.catsChat, /catsState\.bodyStatus\?\.state==='active'/);
  assert.match(scriptFiles.catsChat, /function renderCatsChecklist\(stage\)/);
  assert.match(scriptFiles.catsChat, /const connectedCardOwnsAction=connected && \(stage\.action==='setup' \|\| stage\.action==='refresh'\)/);
  assert.match(scriptFiles.catsChat, /const showSetup=false/);
  assert.doesNotMatch(scriptFiles.catsChat, /请点击.“检查并启动”|setupLabel=.*检查并启动|actionLabel:'检查并启动'/);
  assert.match(scriptFiles.modelSettings, /function renderCatsRelayModelPanel\(\)/);
  assert.match(scriptFiles.catsChat, /function runCatsNextAction\(\)/);
  assert.match(scriptFiles.catsChat, /function unlockCatsAuthFields\(focusAccount=false\)/);
  assert.match(reactFiles.chat, /当前检查项已通过/);
  assert.match(scriptFiles.catsChat, /step\.status==='fail'\|\|step\.status==='warning'/);
  assert.match(scriptFiles.basePet, /let catsStatusGeneration = 0/);
  assert.match(scriptFiles.basePet, /let catsStatusMutationInFlight = false/);
  assert.match(scriptFiles.settingsState, /let catsSetupInFlight=false/);
  assert.match(scriptFiles.settingsState, /let catsAutoStartInFlight=false/);
  assert.match(scriptFiles.settingsState, /let catsAutoStartAttemptKey=''/);
  assert.match(scriptFiles.settingsState, /let relayModelConfigRequestSeq=0/);
  assert.match(scriptFiles.catsChat, /function invalidateCatsStatusRequests\(\)/);
  assert.match(scriptFiles.modelSettings, /function invalidateRelayModelConfigRequests\(\)/);
  assert.match(scriptFiles.modelSettings, /return relayModelApplyInFlight \|\| catsSetupInFlight \|\| catsAutoStartInFlight/);
  assert.match(scriptFiles.modelSettings, /function setCatsAutoStartBusy\(busy\)/);
  assert.match(scriptFiles.catsChat, /function maybeAutoStartCats\(stage\)/);
  assert.match(scriptFiles.catsChat, /function catsAutoStartReason\(stage\)/);
  assert.match(scriptFiles.catsChat, /function catsAutoStartReadinessSafe\(reason\)/);
  assert.match(scriptFiles.catsChat, /setupCatsBot\(\{forceLegacySetup:true, automatic:true\}\)/);
  assert.match(scriptFiles.catsChat, /maybeAutoStartCats\(stage\)/);
  assert.match(scriptFiles.catsChat, /async function setupCatsBot\(options=\{\}\)/);
  assert.match(scriptFiles.catsChat, /async function bindCatsBot\(botUid, botName, button, options\)/);

  const setupBlock = scriptFiles.catsChat.match(/async function setupCatsBot\(options=\{\}\)\{[\s\S]*?async function resetCatsAuth/)?.[0] || '';
  assert.match(setupBlock, /const automatic=options\.automatic===true/);
  assert.match(setupBlock, /if\(automatic\)\{\s*setCatsAction\(/);
});

test('CatsCo Chat messages preserve history, runtime plans, tool metadata, and attachments', () => {
  assert.match(scriptFiles.basePet, /let catsScrollPinnedToBottom = true/);
  assert.match(scriptFiles.basePet, /const CATS_MESSAGES_PAGE_SIZE = 50/);
  assert.match(scriptFiles.messages, /function loadOlderCatsMessages\(\)/);
  assert.match(scriptFiles.messages, /function afterCatsMessagesRender\(callback\)/);
  assert.match(scriptFiles.messages, /requestAnimationFrame/);
  assert.match(scriptFiles.messages, /fetchCatsMessagesPage\(0, CATS_MESSAGES_PAGE_SIZE, requestTopicId\)/);
  assert.match(scriptFiles.messages, /fetchCatsMessagesPage\(catsMessagesCache\.length, CATS_MESSAGES_PAGE_SIZE, requestTopicId\)/);
  assert.match(scriptFiles.messages, /box\.scrollTop<=CATS_SCROLL_TOP_THRESHOLD/);
  assert.match(scriptFiles.messages, /function parseCatsRuntimePlanValue\(value\)/);
  assert.match(scriptFiles.messages, /parsed\.revision!=null/);
  assert.match(scriptFiles.messages, /pendingRuntimePlan=\{type:'runtime_plan'/);
  assert.match(reactFiles.chat, /data-cats-runtime-plan="true"/);
  assert.match(scriptFiles.messages, /type:'tool_use'[\s\S]*metadata:message\.metadata\|\|\{\}/);
  assert.match(scriptFiles.messages, /type:'tool_result'[\s\S]*metadata:message\.metadata\|\|\{\}/);
  assert.match(scriptFiles.messages, /const metadata=Object\.assign\(\{\}, tool\.metadata\|\|\{\}, result\.metadata\|\|\{\}\)/);
  assert.match(scriptFiles.messages, /metadata\.status\|\|tool\.input\?\.status/);
  assert.match(reactFiles.chat, /id="cats-attachment-tray"/);
  assert.match(scriptFiles.attachments, /function chooseCatsFiles\(\)/);
  assert.match(scriptFiles.attachments, /window\.catscoDesktop\.selectFiles/);
  assert.match(scriptFiles.attachments, /file_tokens:sendable\.map\(item=>item\.token\)/);
  assert.doesNotMatch(scriptFiles.attachments, /sendCatsAttachment|file_path:item\.path|input\.click\(\)|queueCatsPaths/);
});

test('dashboard font scaling and non-chat layout remain stylesheet-driven', () => {
  assert.match(scriptFiles.basePet, /const DASHBOARD_FONT_SCALE_KEY = 'xiaoba\.dashboardFontScale'/);
  assert.match(scriptFiles.fontScale, /function applyDashboardFontScale\(value, persist=true\)/);
  assert.match(scriptFiles.fontScale, /function dashboardFontScaleLimit\(\)/);
  assert.match(scriptFiles.fontScale, /function handleDashboardFontScaleShortcut\(event\)/);
  assert.match(scriptFiles.bootstrap, /loadDashboardFontScale\(\);/);
  assert.match(reactFiles.shell, /document\.addEventListener\('keydown', handleKeyDown\)/);
  assert.match(reactFiles.shell, /window\.addEventListener\('resize', handleResize\)/);
  assert.match(dashboardCss, /\.dashboard-app \{\s*display: flex;\s*min-height: 100vh;[\s\S]*?width: 100%;\s*\}/);
  assert.match(dashboardCss, /--dashboard-ui-zoom: 1/);
  assert.match(dashboardCss, /\.sidebar \{\s*zoom: var\(--dashboard-ui-zoom\);/);
  assert.match(dashboardCss, /\.main-wrapper \{\s*zoom: var\(--dashboard-ui-zoom\);/);
  assert.doesNotMatch(dashboardCss, /--dashboard-content-max/);
  assert.match(dashboardCss, /\.page-content \{\s*width: 100%;\s*max-width: none;\s*margin: 0;/);
  assert.match(dashboardCss, /body\.chat-active \.main-wrapper \{[\s\S]*height: 100vh;[\s\S]*overflow: hidden;/);
  assert.match(dashboardCss, /\.chat-shell \{[\s\S]*grid-template-rows: minmax\(0, 1fr\);/);
  assert.match(dashboardCss, /body\.chat-active \.chat-shell \{[\s\S]*position: absolute;[\s\S]*inset: 0;[\s\S]*height: auto;[\s\S]*overflow: hidden;/);
  assert.match(dashboardCss, /\.chat-connect \{[\s\S]*overflow-y: auto;[\s\S]*overscroll-behavior: contain;/);
  assert.match(dashboardCss, /\.chat-messages \{[\s\S]*overflow-y: auto;[\s\S]*overscroll-behavior: contain;/);
  assert.match(dashboardCss, /body:not\(\.chat-active\) \.sidebar \{\s*position: static;\s*width: 100%;\s*min-height: auto;/);
});

test('release version scripts target the React shell mount version', () => {
  const injectVersion = read('scripts/inject-version.js');
  const verifyVersion = read('scripts/verify-release-version.js');
  assert.match(injectVersion, /data-dashboard-version=/);
  assert.match(injectVersion, /updateDashboardHtmlVersion/);
  assert.match(verifyVersion, /data-dashboard-version="\$\{version\}"/);
  assert.doesNotMatch(injectVersion, /sidebar-brand-ver">v/);
  assert.doesNotMatch(verifyVersion, /sidebar-brand-ver">v/);
});

test('split dashboard scripts no longer mutate DOM directly', () => {
  assert.doesNotMatch(
    scriptSource,
    /document\.|window\.addEventListener|querySelector|getElementById|classList|innerHTML|insertAdjacentHTML|activeElement|closest\(/,
  );
  assert.match(scriptSource, /window\.__catscoRenderServices\?\./);
  assert.match(scriptSource, /window\.__catscoRenderPromptWorkbench\?\./);
  assert.match(scriptSource, /window\.__catscoRenderCatsMessages\?\./);
  assert.match(scriptSource, /window\.__catscoRenderSkillHubRegistry\?\./);
  assert.match(scriptSource, /window\.__catscoRenderPetProfile\?\./);
  assert.match(scriptSource, /window\.__catscoRenderUpdateStatus\?\./);
});
