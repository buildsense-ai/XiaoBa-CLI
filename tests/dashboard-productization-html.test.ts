import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const dashboardHtml = readFileSync(join(process.cwd(), 'dashboard/index.html'), 'utf-8');
const servicesPageHtml = dashboardHtml.match(/<div class="page" id="page-services">[\s\S]*?<div class="page" id="page-companion">/)?.[0] || '';

test('Agent Hub keeps connector controls and third-party model config without duplicate runtime panels', () => {
  assert.match(servicesPageHtml, /Agent Hub/);
  assert.match(servicesPageHtml, /运行、连接与设置/);
  assert.match(servicesPageHtml, /id="services-grid"/);
  assert.match(servicesPageHtml, /自定义模型/);
  assert.match(servicesPageHtml, /id="custom-model-toggle-btn"/);
  assert.match(dashboardHtml, /function toggleCustomModelSettings\(\)/);
  assert.match(servicesPageHtml, /id="model-source-panel"/);
  assert.match(dashboardHtml, /自定义模型（第三方）/);
  assert.match(dashboardHtml, /保存自定义模型/);
  assert.match(dashboardHtml, /凭证仅保存到本地 \.env/);
  assert.match(dashboardHtml, /function markServiceConfigDirty\(name\)/);
  assert.match(dashboardHtml, /async function saveServiceConfig\(name\)/);
  assert.match(dashboardHtml, /function cancelServiceConfig\(name\)/);
  assert.match(dashboardHtml, /function enableCatsRelayModel\(modelId, options=\{\}\)/);
  assert.match(dashboardHtml, /let relayModelApplyInFlight=false/);
  assert.match(dashboardHtml, /function setRelayModelApplyBusy\(busy\)/);
  assert.match(dashboardHtml, /data-relay-model-id/);
  assert.match(dashboardHtml, /data-relay-model-context/);
  assert.match(dashboardHtml, /function enableCatsRelayModelFromButton\(button, options=\{\}\)/);
  assert.match(dashboardHtml, /const context=button\?\.dataset\?\.relayModelContext \|\| 'settings'/);
  assert.match(dashboardHtml, /button\.disabled=relayActionBusy\(\) \|\| \(context!=='chat' && !isCatsLoggedIn\(\)\)/);
  assert.match(dashboardHtml, /activateConnector:options\.activateConnector!==false/);
  assert.match(dashboardHtml, /\/api\/cats\/relay\/model-config\/apply/);
  assert.match(dashboardHtml, /service-config/);
  assert.match(dashboardHtml, /CatsCo 中转模型在 CatsCo 页面选择/);
  assert.doesNotMatch(servicesPageHtml, /模型来源与 Runtime Profile/);
  assert.doesNotMatch(servicesPageHtml, /id="settings-setup-panel"/);
  assert.doesNotMatch(servicesPageHtml, /先完成关键配置/);
  assert.doesNotMatch(servicesPageHtml, /启动前检查/);
  assert.doesNotMatch(servicesPageHtml, /Diagnostics/);
  assert.doesNotMatch(servicesPageHtml, /Runtime Profile 状态/);
  assert.doesNotMatch(servicesPageHtml, /受控编辑/);
  assert.doesNotMatch(servicesPageHtml, /id="env-config-details"/);
  assert.doesNotMatch(servicesPageHtml, /id="save-config-btn"/);
  assert.doesNotMatch(servicesPageHtml, /id="config-panel"/);
  assert.doesNotMatch(dashboardHtml, /function setupEnvConfigLazyLoad\(\)/);
  assert.doesNotMatch(dashboardHtml, /escapeJsString/);
  assert.doesNotMatch(dashboardHtml, /buildsense\.asia/i);
});

test('Companion Hub presents pet growth and action preview', () => {
  assert.match(dashboardHtml, /Companion Hub/);
  assert.match(dashboardHtml, /伙伴 <span class="badge">动作库 22 帧<\/span>/);
  assert.match(dashboardHtml, /CatsCo Companion/);
  assert.match(dashboardHtml, /id="companion-pet-bubble"/);
  assert.match(dashboardHtml, /下一解锁/);
  assert.match(dashboardHtml, /Lv\.2 Skill 气泡/);
  assert.match(dashboardHtml, /今日成长/);
  assert.match(dashboardHtml, /能力调用/);
  assert.match(dashboardHtml, /最近工作/);
  assert.match(dashboardHtml, /当前动作库/);
  assert.match(dashboardHtml, /function previewPetAction/);
  assert.match(dashboardHtml, /previewPetState/);
  assert.match(dashboardHtml, /restorePetRealState/);
  assert.match(dashboardHtml, /shouldInterruptPetPreview/);
  assert.doesNotMatch(dashboardHtml, /Token 经验/);
  assert.doesNotMatch(dashboardHtml, /id="pet-token-xp"/);
});

test('SkillHub Skills page is separate from Companion Hub and owns publishing controls', () => {
  assert.match(dashboardHtml, /onclick="switchPage\('store'\)" data-page="store"/);
  assert.match(dashboardHtml, /<div class="page" id="page-store">/);
  assert.match(dashboardHtml, /id="skillhub-section"/);
  assert.match(dashboardHtml, /id="skillhub-search-input"/);
  assert.match(dashboardHtml, /发现技能/);
  assert.match(dashboardHtml, /已安装技能/);
  assert.match(dashboardHtml, /SkillHub Developer/);
  assert.match(dashboardHtml, /id="skillhub-package-versions-list"/);
  assert.doesNotMatch(dashboardHtml, /data-page="developer"/);
  assert.doesNotMatch(dashboardHtml, /id="page-developer"/);
  assert.match(dashboardHtml, /if \(target === 'skills'\) return switchPage\('store'\);/);
});
test('settings refresh path follows simplified Agent Hub sections', () => {
  assert.match(dashboardHtml, /async function refreshSettingsPage\(\)/);
  assert.match(dashboardHtml, /Promise\.all\(\[fetchDashboardSettings\(\), fetchReadiness\(\), fetchConfig\(\)\]\)/);
  assert.match(dashboardHtml, /fetchDashboardSettings\(\),fetchStatus\(\),fetchReadiness\(\),fetchCatsStatus\(\)/);
  assert.match(dashboardHtml, /if\(appStatusSnapshot && Array\.isArray\(appStatusSnapshot\.services\) && !shouldDeferServiceRender\(\)\)renderServices\(appStatusSnapshot\.services\);/);
  assert.doesNotMatch(dashboardHtml, /fetchDashboardSettings\(\),fetchStatus\(\),fetchRuntimeConfig\(\),fetchReadiness\(\),fetchCatsStatus\(\)/);
});

test('dashboard IA no longer exposes old temporary labels in primary entries', () => {
  assert.doesNotMatch(dashboardHtml, /XiaoBa TEST|XiaoBa Chat|XiaoBa Bot|CatsCompany 连接|Skill Store|<span>商店<\/span>|<span>配置<\/span>|<span>服务<\/span>/);
});

test('CatsCo Chat page is driven by readiness state instead of loose controls', () => {
  assert.match(dashboardHtml, /id="cats-chat-state"/);
  assert.match(dashboardHtml, /id="cats-state-card"/);
  assert.match(dashboardHtml, /id="cats-checklist"/);
  assert.match(dashboardHtml, /id="cats-relay-model-panel"/);
  assert.match(dashboardHtml, /\.chat-shell\.connect-collapsed #cats-relay-model-panel/);
  assert.match(dashboardHtml, /let pendingStartupSource = ''/);
  assert.match(dashboardHtml, /function relayModelIdForSetup\(\)/);
  assert.match(dashboardHtml, /登录后会自动接入/);
  assert.match(dashboardHtml, /function buildCatsChatStage\(\)/);
  assert.match(dashboardHtml, /function renderCatsChecklist\(stage\)/);
  assert.match(dashboardHtml, /if\(!connected\)\{\s*list\.classList\.remove\('compact'\);\s*list\.innerHTML='';\s*return;\s*\}/);
  assert.match(dashboardHtml, /diagnostics\.style\.display=connected\?'block':'none'/);
  assert.match(dashboardHtml, /function renderCatsRelayModelPanel\(\)/);
  assert.match(dashboardHtml, /function runCatsNextAction\(\)/);
  assert.match(dashboardHtml, /先完成模型来源/);
  assert.match(dashboardHtml, /启动模型/);
  assert.match(dashboardHtml, /切换后自动重启/);
  assert.match(dashboardHtml, /先选模型，再检查启动/);
  assert.match(dashboardHtml, /连接 CatsCompany 网页会话，本地 agent 回复/);
  assert.match(dashboardHtml, /CatsCompany connector/);
  assert.match(dashboardHtml, /选择机器人/);
  assert.match(dashboardHtml, /已绑定，启动后接收网页消息/);
  assert.match(dashboardHtml, /<details class="chat-diagnostics" id="cats-connection-details">/);
  assert.match(dashboardHtml, /<summary>高级 endpoint<\/summary>/);
  assert.doesNotMatch(dashboardHtml, /toggleCatsAdvanced/);
  assert.doesNotMatch(dashboardHtml, />高级设置<\/button>/);
  assert.match(dashboardHtml, /function unlockCatsAuthFields\(focusAccount=false\)/);
  assert.match(dashboardHtml, /if\(!connected\)unlockCatsAuthFields\(false\)/);
  assert.match(dashboardHtml, /let catsStatusGeneration = 0/);
  assert.match(dashboardHtml, /let catsStatusMutationInFlight = false/);
  assert.match(dashboardHtml, /let catsSetupInFlight=false/);
  assert.match(dashboardHtml, /let relayModelConfigRequestSeq=0/);
  assert.match(dashboardHtml, /function invalidateCatsStatusRequests\(\)/);
  assert.match(dashboardHtml, /function invalidateRelayModelConfigRequests\(\)/);
  assert.match(dashboardHtml, /function isRelayModelConfigRequestCurrent\(requestGeneration, requestSeq, requestAccountKey\)/);
  assert.match(dashboardHtml, /catsStatusMutationInFlight && !priority/);
  assert.match(dashboardHtml, /function autoResizeCatsMessageInput\(\)/);
  assert.match(dashboardHtml, /overflowY=input\.scrollHeight>maxHeight\?'auto':'hidden'/);
  assert.match(dashboardHtml, /const connectedCardOwnsAction=connected && \(stage\.action==='setup' \|\| stage\.action==='refresh'\)/);
  assert.match(dashboardHtml, /steps\.filter\(step=>step\.status==='fail'\)/);
  assert.match(dashboardHtml, /input\.disabled=locked/);
  assert.match(dashboardHtml, /send\.disabled=locked/);
  assert.match(dashboardHtml, /attach\.disabled=locked/);
  assert.match(dashboardHtml, /id="cats-message-input"[^>]*disabled/);
  assert.match(dashboardHtml, /id="cats-send-btn" disabled/);
  assert.match(dashboardHtml, /needs-readiness/);
  assert.match(dashboardHtml, /appReadinessLoaded/);
  assert.doesNotMatch(dashboardHtml, /末尾 \+/);
});

test('custom model save refreshes simplified state before Chat remains locked', () => {
  assert.match(
    dashboardHtml,
    /fetchDashboardSettings\(\),fetchStatus\(\),fetchReadiness\(\),fetchCatsStatus\(\)/,
  );
  assert.doesNotMatch(
    dashboardHtml,
    /fetchDashboardSettings\(\),fetchStatus\(\),fetchRuntimeConfig\(\),fetchReadiness\(\),fetchCatsStatus\(\)/,
  );
  assert.match(dashboardHtml, /已保存。新 session 或下一次启动 connector 后生效。/);
});

test('CatsCo Chat setup refreshes readiness before unlocking the composer', () => {
  const setupBlock = dashboardHtml.match(/async function setupCatsBot\(options=\{\}\)\{[\s\S]*?async function resetCatsAuth/)?.[0] || '';
  assert.match(setupBlock, /const setupRelayModel=shouldSetupRelayOnCatsSetup\(\)/);
  assert.match(setupBlock, /setupRelayModel,/);
  assert.match(setupBlock, /relayModelId:setupRelayModel \? \(relayModelIdForSetup\(\)\|\|undefined\) : undefined/);
  assert.match(setupBlock, /rotateRelayKey:Boolean\(options\.rotateRelayKey\)/);
  assert.match(setupBlock, /setCatsSetupBusy\(true\)/);
  assert.match(setupBlock, /setCatsStatusMutationBusy\(true\)/);
  assert.match(setupBlock, /invalidateCatsStatusRequests\(\)/);
  assert.match(setupBlock, /catsSetupWarningText\(data\)/);
  assert.match(setupBlock, /e\.status===409 && e\.action==='rotate_required'/);
  assert.match(setupBlock, /setCatsStatusMutationBusy\(false\)/);
  assert.match(setupBlock, /setCatsSetupBusy\(false\)/);
  assert.match(setupBlock, /await fetchStatus\(\)/);
  assert.match(setupBlock, /await fetchCatsStatus\(\{priority:true\}\)/);
  assert.match(setupBlock, /renderCatsStatus\(\)/);
  assert.match(setupBlock, /const stage=buildCatsChatStage\(\)/);
  assert.match(setupBlock, /await loadCatsMessages\(true, \{reset:true, forceBottom:true\}\)/);
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
  assert.match(dashboardHtml, /file_tokens:sendable\.map\(item=>item\.token\)/);
  assert.match(dashboardHtml, /function setupCatsAttachmentInputs\(\)/);
  assert.doesNotMatch(dashboardHtml, /sendCatsAttachment/);
  assert.doesNotMatch(dashboardHtml, /file_path:item\.path/);
  assert.doesNotMatch(dashboardHtml, /input\.click\(\)/);
  assert.doesNotMatch(dashboardHtml, /queueCatsPaths/);
  assert.match(dashboardHtml, /catsMessageInput\.addEventListener\('paste'/);
  assert.doesNotMatch(dashboardHtml, /\/api\/cats\/messages\/send-file/);
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
  assert.match(dashboardHtml, /window\.addEventListener\('resize',\(\)=>\{refreshDashboardFontScaleForViewport\(\); autoResizeCatsMessageInput\(\);\}\)/);
});

test('dashboard non-chat pages use the full available work area', () => {
  assert.doesNotMatch(dashboardHtml, /--dashboard-content-max/);
  assert.match(dashboardHtml, /\.page-content \{\s*width: 100%;\s*max-width: none;\s*margin: 0;/);
  assert.match(dashboardHtml, /body:not\(\.chat-active\) \.sidebar \{\s*position: static;\s*width: 100%;\s*min-height: auto;/);
  assert.match(dashboardHtml, /body:not\(\.chat-active\) \.main-wrapper \{\s*margin-left: 0;/);
  assert.match(dashboardHtml, /@media \(max-width: 780px\) \{\s*body:not\(\.chat-active\) \.companion-hero,/);
});
