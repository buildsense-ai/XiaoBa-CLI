import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const dashboardHtml = readFileSync(join(process.cwd(), 'dashboard/index.html'), 'utf-8');

function countOccurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

test('dashboard settings page uses model source before Runtime Profile', () => {
  assert.match(dashboardHtml, /模型设置/);
  assert.match(dashboardHtml, /id="model-source-panel"/);
  assert.match(dashboardHtml, /function fetchDashboardSettings\(\)/);
  assert.match(dashboardHtml, /\/api\/settings/);
  assert.match(dashboardHtml, /id="settings-setup-panel"/);
  assert.match(dashboardHtml, /先完成关键配置/);
  assert.match(dashboardHtml, /CatsCo 托管模型/);
  assert.match(dashboardHtml, /自定义模型（当前需要）/);
  assert.match(dashboardHtml, /托管模型目录和用量服务还没有接入当前本地版本/);
  assert.match(dashboardHtml, /访问凭证只保存 presence，不会回显/);
  assert.match(dashboardHtml, /保存自定义模型设置？访问凭证会写入本地 \.env，仅用于本机 runtime。/);
  assert.match(dashboardHtml, /Runtime Profile 状态/);
  assert.match(dashboardHtml, /受控编辑/);
  assert.match(dashboardHtml, /config-group-title-main/);
  assert.match(dashboardHtml, /config-group-title-actions/);
  assert.match(dashboardHtml, /保存后新 session 生效/);
  assert.match(dashboardHtml, /const isEntry=title==='聊天入口'/);
  assert.match(dashboardHtml, /status==='blocked'\?'待设置':'等待'/);
  assert.doesNotMatch(dashboardHtml, /status==='warning'\?'注意'/);
  assert.match(dashboardHtml, /当前已运行 session 不会热更新/);
  assert.doesNotMatch(dashboardHtml, /buildsense\.asia/i);
});

test('dashboard settings collapse state survives refresh-oriented rerenders', () => {
  assert.match(dashboardHtml, /const settingsCollapseState=\{/);
  assert.match(dashboardHtml, /function toggleSettingsGroup\(id, key\)/);
  assert.match(dashboardHtml, /settingsCollapsedClass\('modelSource', false\)/);
  assert.match(dashboardHtml, /settingsCollapsedClass\('runtimeStatus', valid\)/);
  assert.match(dashboardHtml, /settingsCollapsedClass\('runtimeEditor', true\)/);
  assert.match(dashboardHtml, /function shouldDeferRuntimeConfigRender\(\)/);
  assert.match(dashboardHtml, /editor\.contains\(active\) && active\.matches\('input, select, textarea'\)/);
  assert.match(dashboardHtml, /fetchRuntimeConfig\(\{force:true\}\)/);
  assert.match(dashboardHtml, /飞书（高级）/);
  assert.match(dashboardHtml, /微信（高级）/);
});

test('run page is driven by readiness instead of raw diagnostics cards', () => {
  assert.match(dashboardHtml, /id="run-summary"/);
  assert.match(dashboardHtml, /id="readiness-grid"/);
  assert.match(dashboardHtml, /fetch\(API\+'\/api\/readiness'\)/);
  assert.match(dashboardHtml, /function renderReadiness\(data\)/);
  assert.match(dashboardHtml, /启动前检查未通过/);
  assert.match(dashboardHtml, /模型来源、CatsCo Chat、Runtime Profile 和 Skills/);
  assert.match(dashboardHtml, /<details class="run-details">\s*<summary><span>启动诊断<\/span><span class="tag">readiness<\/span><\/summary>/);
  assert.match(dashboardHtml, /<summary><span>Diagnostics<\/span><span class="tag">version \/ host \/ paths<\/span><\/summary>/);
  assert.doesNotMatch(dashboardHtml, /<summary><span>Service details<\/span><span class="tag">connector<\/span><\/summary>/);
  assert.doesNotMatch(dashboardHtml, /<div class="section-title">系统状态<\/div>/);
  assert.doesNotMatch(dashboardHtml, /<div class="label">Provider<\/div>/);
});

test('raw env editing is explicitly advanced and confirmed', () => {
  assert.match(
    dashboardHtml,
    /<details class="config-section settings-advanced-shell" id="env-config-details">[\s\S]*本地环境变量（高级诊断）[\s\S]*id="config-panel"/,
  );
  assert.match(dashboardHtml, /展开后加载 \.env 配置/);
  assert.match(dashboardHtml, /function setupEnvConfigLazyLoad\(\)/);
  assert.match(dashboardHtml, /保存本地环境变量配置？这会写入项目 \.env，可能包含访问凭证、token 或 secret。/);
  assert.match(dashboardHtml, /访问凭证、token、secret 不会写入 Runtime Profile/);
  assert.doesNotMatch(dashboardHtml, /备用模型兼容配置|GAUZ_LLM_BACKUP_/);
  assert.equal(countOccurrences(dashboardHtml, /id="config-saved"/g), 1);
  assert.equal(countOccurrences(dashboardHtml, /id="save-config-btn"/g), 1);

  const initBlock = dashboardHtml.match(/\/\/ Init[\s\S]*?<\/script>/)?.[0] || '';
  assert.match(initBlock, /setupEnvConfigLazyLoad\(\)/);
  assert.doesNotMatch(initBlock, /fetchConfig\(\)/);
});

test('dashboard IA no longer exposes old temporary labels in primary entries', () => {
  assert.doesNotMatch(dashboardHtml, /XiaoBa TEST|XiaoBa Chat|XiaoBa Bot|CatsCompany 连接|Skill Store|<span>商店<\/span>|<span>配置<\/span>|<span>服务<\/span>/);
  assert.match(dashboardHtml, /<span>启动<\/span>/);
  assert.match(dashboardHtml, /<span>模型<\/span>/);
  assert.match(dashboardHtml, /<span>通道<\/span>/);
  assert.match(dashboardHtml, /实验 \/ 开发/);
});

test('CatsCo Chat page is driven by readiness state instead of loose controls', () => {
  assert.match(dashboardHtml, /id="cats-chat-state"/);
  assert.match(dashboardHtml, /id="cats-state-card"/);
  assert.match(dashboardHtml, /id="cats-checklist"/);
  assert.match(dashboardHtml, /function buildCatsChatStage\(\)/);
  assert.match(dashboardHtml, /function renderCatsChecklist\(stage\)/);
  assert.match(dashboardHtml, /function runCatsNextAction\(\)/);
  assert.match(dashboardHtml, /配置模型来源/);
  assert.match(dashboardHtml, /下一步：登录 CatsCo/);
  assert.match(dashboardHtml, /startup-step-list/);
  assert.match(dashboardHtml, /chat-shell\.chat-ready/);
  assert.match(dashboardHtml, /\.chat-window \{[\s\S]*?display: none;[\s\S]*?\.chat-shell\.chat-ready \.chat-window \{[\s\S]*?display: flex;/);
  assert.match(dashboardHtml, /\.chat-shell\.connect-collapsed #cats-state-card,[\s\S]*?\.chat-shell\.connect-collapsed #cats-checklist,/);
  assert.match(dashboardHtml, /const ready=chatStage\.key==='ready';/);
  assert.match(dashboardHtml, /id="sidebar-webapp-btn"[^>]*disabled/);
  assert.match(dashboardHtml, /id="cats-connected-webapp-btn" disabled/);
  assert.match(dashboardHtml, /id="cats-connected-weixin-btn" disabled/);
  assert.match(dashboardHtml, /sidebarWebapp\.disabled=!ready/);
  assert.match(dashboardHtml, /connectedWebapp\.disabled=!ready/);
  assert.match(dashboardHtml, /connectedWeixin\.disabled=!ready/);
  assert.match(dashboardHtml, /openCatsWebapp\(\)/);
  assert.match(dashboardHtml, /微信扫码/);
  assert.match(dashboardHtml, /CatsCompany connector/);
  assert.match(dashboardHtml, /Agent Body/);
  assert.match(dashboardHtml, /function formatCatsBodyStatus\(bodyStatus, configured\)/);
  assert.match(dashboardHtml, /body-conflict/);
  assert.match(dashboardHtml, /body-auth-error/);
  assert.match(dashboardHtml, /catsNextAction==='bot-selector'/);
  assert.match(dashboardHtml, /另一个设备正在运行这个 agent/);
  assert.match(dashboardHtml, /当前账号不能管理这个 agent/);
  assert.match(dashboardHtml, /恢复 CatsCompany connector/);
  assert.match(dashboardHtml, /<details class="chat-diagnostics" id="cats-connection-details">/);
  assert.match(dashboardHtml, /<summary>Endpoint<\/summary>/);
  assert.match(dashboardHtml, /input\.disabled=locked/);
  assert.match(dashboardHtml, /send\.disabled=locked/);
  assert.match(dashboardHtml, /attach\.disabled=locked/);
  assert.match(dashboardHtml, /id="cats-message-input"[^>]*disabled/);
  assert.match(dashboardHtml, /id="cats-send-btn" disabled/);
  assert.match(dashboardHtml, /needs-readiness/);
  assert.match(dashboardHtml, /appReadinessLoaded/);
  assert.doesNotMatch(dashboardHtml, /末尾 \+/);
});

test('agent channel page replaces legacy service manager as the primary entry', () => {
  assert.match(dashboardHtml, /Agent 通道/);
  assert.match(dashboardHtml, /管理当前 Agent 的联系入口/);
  assert.match(dashboardHtml, /function renderChannelCards\(svcs\)/);
  assert.match(dashboardHtml, /CatsCo WebApp/);
  assert.match(dashboardHtml, /同事访问/);
  assert.match(dashboardHtml, /id="agent-access-user-ref"/);
  assert.match(dashboardHtml, /id="agent-access-status"/);
  assert.match(dashboardHtml, /同事用户编号或用户名/);
  assert.match(dashboardHtml, /channel-access-form/);
  assert.match(dashboardHtml, /function setAgentAccessStatus/);
  assert.match(dashboardHtml, /inviteAgentTeammate\(this\)/);
  assert.match(dashboardHtml, /loadAgentAccessOverview\(this\)/);
  assert.match(dashboardHtml, /id="agent-access-permission"/);
  assert.match(dashboardHtml, /id="agent-invite-agent-ref"/);
  assert.match(dashboardHtml, /acceptAgentInvite\(this\)/);
  assert.match(dashboardHtml, /\/api\/cats\/agent-access\/invite/);
  assert.match(dashboardHtml, /\/api\/cats\/agent-access\/overview/);
  assert.match(dashboardHtml, /\/api\/cats\/agent-access\/accept-invite/);
  assert.match(dashboardHtml, /扫码绑定/);
  assert.match(dashboardHtml, /待接入。/);
  assert.match(dashboardHtml, /本地接收服务诊断（高级）/);
  assert.match(dashboardHtml, /id="legacy-services-grid"/);
  assert.match(dashboardHtml, /function renderLegacyServiceControls\(svcs\)/);
  const channelBlock = dashboardHtml.match(/function renderChannelCards\(svcs\)\{[\s\S]*?function renderLegacyServiceControls/)?.[0] || '';
  assert.doesNotMatch(channelBlock, /svcAction\(/);
  assert.match(channelBlock, /openCatsWebapp\(\)/);
  assert.match(channelBlock, /getWeixinToken\(\)/);
});

test('CatsCo login is separate from bot binding and connector startup', () => {
  assert.match(dashboardHtml, /id="cats-auth-btn"[^>]*>登录<\/button>/);
  assert.match(dashboardHtml, /id="cats-register-btn"[^>]*>创建并登录<\/button>/);
  assert.match(dashboardHtml, /登录态已保存。请确认要绑定的 CatsCo agent，再手动启动 connector。/);
  assert.match(dashboardHtml, /showBotSelector\(\)/);
  assert.match(dashboardHtml, /createCatsBotAndBind\(this\)/);
  assert.match(dashboardHtml, /id="cats-create-bot-name"/);
  assert.match(dashboardHtml, /id="bot-selector-status"/);
  assert.match(dashboardHtml, /创建并绑定/);
  assert.match(dashboardHtml, /\/api\/cats\/create-bot/);
  assert.match(dashboardHtml, /\/api\/cats\/bind-bot/);
  assert.match(dashboardHtml, /data-bind-bot/);
  assert.match(dashboardHtml, /请选择已有机器人，或点击“绑定并启动”创建\/绑定当前 agent。/);
  assert.doesNotMatch(dashboardHtml, /prompt\('为当前设备创建一个新的 CatsCo agent/);
  assert.doesNotMatch(
    dashboardHtml,
    /setCatsAction\('登录态已保存，正在绑定 CatsCo agent\.\.\.'\);\s*await setupCatsBot\(\);/,
  );
  assert.doesNotMatch(dashboardHtml, /fetch\(API \+ '\/api\/cats\/switch-bot'/);
  assert.doesNotMatch(dashboardHtml, /fetch\(API\+'\/api\/cats\/setup'/);
  assert.doesNotMatch(dashboardHtml, /onclick="bindCatsBot\('\$\{escapeJsString/);
});

test('custom model save refreshes readiness before Chat remains locked', () => {
  assert.match(
    dashboardHtml,
    /fetchDashboardSettings\(\),fetchStatus\(\),fetchRuntimeConfig\(\),fetchReadiness\(\),fetchCatsStatus\(\)/,
  );
  assert.match(dashboardHtml, /已保存，正在刷新启动状态/);
});

test('CatsCo Chat preserves scroll position while reading history', () => {
  assert.match(dashboardHtml, /let catsScrollPinnedToBottom = true/);
  assert.match(dashboardHtml, /let catsMessagesCache = \[\]/);
  assert.match(dashboardHtml, /let catsMessagesOwnerKey = ''/);
  assert.match(dashboardHtml, /const CATS_MESSAGES_PAGE_SIZE = 50/);
  assert.match(dashboardHtml, /const CATS_SCROLL_BOTTOM_THRESHOLD = 80/);
  assert.match(dashboardHtml, /const CATS_SCROLL_TOP_THRESHOLD = 96/);
  assert.match(dashboardHtml, /function isCatsMessageScrollNearBottom\(box\)/);
  assert.match(dashboardHtml, /function updateCatsMessageScrollIntent\(\)/);
  assert.match(dashboardHtml, /function handleCatsMessagesScroll\(\)/);
  assert.match(dashboardHtml, /function catsMessageOwnerKey\(state\)/);
  assert.match(dashboardHtml, /function isCatsMessageRequestCurrent\(ownerKey, topicId\)/);
  assert.match(dashboardHtml, /function resetCatsMessageCache\(ownerKey=''\)/);
  assert.match(dashboardHtml, /登录 CatsCo 后查看当前账号消息/);
  assert.match(dashboardHtml, /function scrollCatsMessagesToBottom\(box\)/);
  assert.match(dashboardHtml, /function loadOlderCatsMessages\(\)/);
  assert.match(dashboardHtml, /fetchCatsMessagesPage\(catsMessagesCache\.length, CATS_MESSAGES_PAGE_SIZE, requestTopicId\)/);
  assert.match(dashboardHtml, /addEventListener\('scroll', handleCatsMessagesScroll, \{ passive: true \}\)/);

  const renderBlock = dashboardHtml.match(/function renderCatsMessages\(messages, options=\{\}\)\{[\s\S]*?async function fetchCatsMessagesPage/)?.[0] || '';
  assert.match(renderBlock, /const shouldStickToBottom=/);
  assert.match(renderBlock, /const preserveViewport=Boolean\(options\.preserveViewport\)/);
  assert.match(renderBlock, /box\.scrollTop=Math\.max\(0, oldScrollTop\+delta\)/);
  assert.match(renderBlock, /else if\(shouldStickToBottom\)\{\s*scrollCatsMessagesToBottom\(box\)/);
  assert.doesNotMatch(renderBlock, /box\.scrollTop=box\.scrollHeight;\s*updatePetFromCatsMessages/);
});

test('CatsCo Chat recognizes persisted runtime plan snapshots instead of rendering raw JSON', () => {
  assert.match(dashboardHtml, /function parseCatsRuntimePlanValue\(value\)/);
  assert.match(dashboardHtml, /parsed\.revision!=null/);
  assert.match(dashboardHtml, /function isCatsMessageMine\(message\)/);
  assert.match(dashboardHtml, /!isCatsMessageMine\(message\) && parseCatsRuntimePlanValue\(message\?\.content\)/);
  assert.match(dashboardHtml, /parseCatsRuntimePlanValue\(message\?\.content\)/);
  assert.match(dashboardHtml, /const flushRuntimePlan=\(\)=>/);
  assert.match(dashboardHtml, /pendingRuntimePlan=\{type:'runtime_plan'/);
  assert.match(dashboardHtml, /group\.type==='runtime_plan'/);
  assert.match(dashboardHtml, /renderCatsMessageShell\(group\.message, renderCatsRuntimePlan\(group\.message\)/);
});

test('CatsCo Chat composer supports local attachments', () => {
  assert.doesNotMatch(dashboardHtml, /id="cats-file-input"/);
  assert.match(dashboardHtml, /id="cats-attachment-tray"/);
  assert.match(dashboardHtml, /id="cats-attach-note" hidden/);
  assert.match(dashboardHtml, /id="cats-attach-btn"/);
  assert.match(dashboardHtml, /function chooseCatsFiles\(\)/);
  assert.match(dashboardHtml, /function catsDesktopFilePickerAvailable\(\)/);
  assert.match(dashboardHtml, /const CATS_ATTACHMENT_BROWSER_MESSAGE =/);
  assert.match(dashboardHtml, /attach\.disabled=locked \|\| !desktopPickerReady/);
  assert.match(dashboardHtml, /attachNote\.hidden=locked \|\| catsDesktopFilePickerAvailable\(\)/);
  assert.match(dashboardHtml, /setCatsAction\(CATS_ATTACHMENT_BROWSER_MESSAGE, true\)/);
  assert.match(dashboardHtml, /window\.catscoDesktop\.selectFiles/);
  assert.match(dashboardHtml, /file_token:item\.token/);
  assert.match(dashboardHtml, /function setupCatsAttachmentInputs\(\)/);
  assert.doesNotMatch(dashboardHtml, /file_path:item\.path/);
  assert.doesNotMatch(dashboardHtml, /input\.click\(\)/);
  assert.doesNotMatch(dashboardHtml, /queueCatsPaths/);
  assert.match(dashboardHtml, /catsMessageInput\.addEventListener\('paste'/);
  assert.match(dashboardHtml, /\/api\/cats\/messages\/send-file/);
});

test('CatsCo Chat composer keeps focused text readable on dark input surface', () => {
  assert.match(
    dashboardHtml,
    /\.chat-input-bar textarea:focus \{[\s\S]*?background: transparent;[\s\S]*?color: #f8fafc;[\s\S]*?box-shadow: none;[\s\S]*?\}/,
  );
});

test('CatsCo Chat preserves fallback tool metadata for WORKING rendering', () => {
  const fallbackBlock = dashboardHtml.match(/function catsContentBlocksFromMessage\(message\)\{[\s\S]*?function groupCatsWorkingBlocks/)?.[0] || '';
  assert.match(fallbackBlock, /type:'tool_use'[\s\S]*metadata:message\.metadata\|\|\{\}/);
  assert.match(fallbackBlock, /type:'tool_result'[\s\S]*metadata:message\.metadata\|\|\{\}/);

  const workingBlock = dashboardHtml.match(/function renderCatsWorkingBlocks\(blocks\)\{[\s\S]*?function renderCatsMessageBody/)?.[0] || '';
  assert.match(workingBlock, /const metadata=Object\.assign\(\{\}, tool\.metadata\|\|\{\}, result\.metadata\|\|\{\}\)/);
  assert.match(workingBlock, /metadata\.status\|\|tool\.input\?\.status/);
  assert.match(workingBlock, /metadata\.step_count\?metadata\.step_count\+' 步'/);
});

test('dashboard supports hidden persistent font scaling shortcuts', () => {
  assert.doesNotMatch(dashboardHtml, /id="font-scale-slider"/);
  assert.doesNotMatch(dashboardHtml, /id="font-scale-value"/);
  assert.doesNotMatch(dashboardHtml, /font-scale-control/);
  assert.match(dashboardHtml, /DASHBOARD_FONT_SCALE_KEY = 'xiaoba\.dashboardFontScale'/);
  assert.match(dashboardHtml, /function applyDashboardFontScale\(value, persist=true\)/);
  assert.match(dashboardHtml, /function dashboardFontScaleLimit\(\)/);
  assert.match(dashboardHtml, /--dashboard-ui-zoom: 1/);
  assert.match(dashboardHtml, /\.sidebar \{\s*zoom: var\(--dashboard-ui-zoom\);/);
  assert.match(dashboardHtml, /\.main-wrapper \{\s*zoom: var\(--dashboard-ui-zoom\);/);
  assert.match(dashboardHtml, /document\.documentElement\.style\.setProperty\('--dashboard-ui-zoom', String\(effectiveScale \/ 100\)\)/);
  assert.match(dashboardHtml, /document\.body\.style\.zoom=''/);
  assert.match(dashboardHtml, /function handleDashboardFontScaleShortcut\(event\)/);
  assert.match(dashboardHtml, /key==='\+' \|\| key==='=' \|\| key==='Add'/);
  assert.match(dashboardHtml, /key==='-' \|\| key==='_'\s*\|\| key==='Subtract'/);
  assert.match(dashboardHtml, /key==='0' \|\| key==='\)'/);
  assert.match(dashboardHtml, /loadDashboardFontScale\(\);/);
  assert.match(dashboardHtml, /document\.addEventListener\('keydown',handleDashboardFontScaleShortcut\)/);
  assert.match(dashboardHtml, /window\.addEventListener\('resize',refreshDashboardFontScaleForViewport\)/);
});

test('dashboard non-chat pages use the full available work area', () => {
  assert.doesNotMatch(dashboardHtml, /--dashboard-content-max/);
  assert.match(dashboardHtml, /\.page-content \{\s*width: 100%;\s*max-width: none;\s*margin: 0;/);
  assert.match(dashboardHtml, /body:not\(\.chat-active\) \.sidebar \{\s*position: static;\s*width: 100%;\s*min-height: auto;/);
  assert.match(dashboardHtml, /body:not\(\.chat-active\) \.main-wrapper \{\s*margin-left: 0;/);
  assert.match(dashboardHtml, /@media \(max-width: 780px\) \{\s*body:not\(\.chat-active\) \.companion-hero,/);
});
