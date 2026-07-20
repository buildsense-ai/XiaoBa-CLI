import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

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
  assert.match(dashboardHtml, /CUSTOM_MODEL_CONTEXT_WINDOW_OPTIONS/);
  assert.match(dashboardHtml, /id="model-context-window-setting"/);
  assert.match(dashboardHtml, /id="model-openai-api-mode-setting"/);
  assert.match(dashboardHtml, /Responses API（提示词缓存）/);
  assert.match(dashboardHtml, /function syncCustomOpenAIApiModeVisibility\(\)/);
  assert.match(dashboardHtml, /'model\.openaiApiMode':document\.getElementById\('model-openai-api-mode-setting'\)/);
  assert.match(dashboardHtml, /'model\.contextWindowTokens':document\.getElementById\('model-context-window-setting'\)\.value/);
  assert.match(dashboardHtml, /自定义模型可在 128K 到 1M 间选择上下文/);
  assert.match(dashboardHtml, /上下文 '\+escapeHtml\(contextLabel\)\+'/);
  assert.match(dashboardHtml, /首页的一键启动区域负责选择 CatsCo 中转模型和推理强度/);
  assert.doesNotMatch(dashboardHtml, /当前启动模型的推理强度/);
  assert.doesNotMatch(dashboardHtml, /id="startup-reasoning-effort-setting"/);
  assert.doesNotMatch(dashboardHtml, /id="model-reasoning-effort-setting"/);
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

test('Companion prompt ask preserves the current proposal when no new diff is generated', () => {
  assert.match(dashboardHtml, /let promptCompanionAdvisor = null/);
  assert.match(dashboardHtml, /let promptCompanionAdvisorNotice = ''/);
  assert.match(dashboardHtml, /const advisor = data\.advisor \|\| null/);
  assert.match(dashboardHtml, /promptCompanionAdvisor = advisor/);
  assert.match(dashboardHtml, /function formatPromptCompanionAdvisorNotice\(advisor, fallback\)/);
  assert.match(dashboardHtml, /function renderPromptCompanionStage\(title, bodyHtml\)/);
  assert.match(dashboardHtml, /function buildPromptCompanionNoProposalCopy\(signals\)/);
  assert.match(dashboardHtml, /有运行信号，但暂时没有可安全应用的 prompt 小改动/);
  assert.match(dashboardHtml, /function renderPromptCompanionAdvisorDiagnosis\(\)/);
  assert.match(dashboardHtml, /1\. 问题定位/);
  assert.match(dashboardHtml, /2\. 拟改内容/);
  assert.match(dashboardHtml, /3\. 确认应用/);
  assert.match(dashboardHtml, /定位依据/);
  assert.match(dashboardHtml, /改动内容/);
  assert.match(dashboardHtml, /<strong>旁路回复：<\/strong>/);
  assert.match(dashboardHtml, /建议问法：/);
  assert.match(dashboardHtml, /else if \(note\) \{\s*promptCompanionAdvisorNotice = promptCompanionProposal/);
  assert.match(dashboardHtml, /已保留当前建议/);
  assert.match(dashboardHtml, /else \{\s*promptCompanionProposal = null;\s*promptCompanionAdvisor = null;\s*promptCompanionAdvisorNotice = '';\s*\}/);
});

test('SkillHub Skills page is separate from Companion Hub and owns publishing controls', () => {
  assert.match(dashboardHtml, /onclick="switchPage\('store'\)" data-page="store"/);
  assert.match(dashboardHtml, /<div class="page" id="page-store">/);
  assert.match(dashboardHtml, /id="skillhub-section"/);
  assert.match(dashboardHtml, /id="skillhub-search-input"/);
  assert.match(dashboardHtml, /发现技能/);
  assert.match(dashboardHtml, /已安装技能/);
  assert.match(dashboardHtml, /id="skillhub-package-versions-list"/);
  assert.doesNotMatch(dashboardHtml, /SkillHub Developer/);
  assert.doesNotMatch(dashboardHtml, /id="skillhub-developer-apply"/);
  assert.doesNotMatch(dashboardHtml, /id="skillhub-developer-console"/);
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
  assert.match(dashboardHtml, /let pendingRelayReasoningEffort = ''/);
  assert.match(dashboardHtml, /function relayModelIdForSetup\(\)/);
  assert.match(
    dashboardHtml,
    /id:'minimax-m3'[^\n]*default:true/,
    'Dashboard fallback catalog must select the product default MiniMax M3 before the authenticated catalog loads',
  );
  assert.doesNotMatch(
    dashboardHtml,
    /id:'minimax-m2\.7'[^\n]*default:true/,
    'The legacy first catalog entry must not silently become the Dashboard default',
  );
  assert.match(dashboardHtml, /function relayReasoningEffortForSetup\(\)/);
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
  assert.match(dashboardHtml, /let catsAutoStartInFlight=false/);
  assert.match(dashboardHtml, /let catsAutoStartAttemptKey=''/);
  assert.match(dashboardHtml, /let relayModelConfigRequestSeq=0/);
  assert.match(dashboardHtml, /function invalidateCatsStatusRequests\(\)/);
  assert.match(dashboardHtml, /function refreshCatsChatAfterMutation\(options=\{\}\)/);
  assert.match(dashboardHtml, /function maybeAutoStartCats\(stage\)/);
  assert.match(dashboardHtml, /function catsAutoStartReason\(stage\)/);
  assert.match(dashboardHtml, /function catsAutoStartReadinessSafe\(reason\)/);
  assert.match(dashboardHtml, /if\(reason==='binding'\)\{/);
  assert.match(dashboardHtml, /setupCatsBot\(\{forceLegacySetup:true, automatic:true\}\)/);
  assert.match(dashboardHtml, /startCurrentCatsConnector\(\{automatic:true\}\)/);
  assert.match(dashboardHtml, /\/api\/cats\/connector\/start/);
  assert.match(dashboardHtml, /maybeAutoStartCats\(stage\)/);
  assert.match(dashboardHtml, /function focusCatsMessageInputSoon\(\)/);
  assert.match(dashboardHtml, /function invalidateRelayModelConfigRequests\(\)/);
  assert.match(dashboardHtml, /function isRelayModelConfigRequestCurrent\(requestGeneration, requestSeq, requestAccountKey\)/);
  assert.match(dashboardHtml, /catsStatusMutationInFlight && !priority/);
  assert.match(dashboardHtml, /if\(stage\.key==='ready' && options\.focusInput!==false\)focusCatsMessageInputSoon\(\)/);
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

test('relay model cards render SDK labels from model payloads', () => {
  assert.match(dashboardHtml, /sdk_label:'Anthropic SDK'/);
  assert.match(dashboardHtml, /const sdkLabel=model\.sdk_label \|\|/);
  assert.match(dashboardHtml, /escapeHtml\(contextLabel\)\+' · '\+escapeHtml\(sdkLabel\)/);
  assert.doesNotMatch(dashboardHtml, /escapeHtml\(contextLabel\)\+' · Anthropic SDK'/);
  assert.doesNotMatch(dashboardHtml, /label:'GLM 5\.1'/);
  assert.match(dashboardHtml, /DeepSeek 官方参数/);
  assert.match(dashboardHtml, /reasoning_effort: high/);
  assert.match(dashboardHtml, /reasoning_effort: max/);
  assert.match(dashboardHtml, /thinking: disabled/);
  assert.match(dashboardHtml, /DeepSeek 默认 high/);
  assert.doesNotMatch(dashboardHtml, /官方默认/);
  assert.doesNotMatch(dashboardHtml, /glm/i);
  assert.match(dashboardHtml, /DEEPSEEK_REASONING_EFFORT_OPTIONS=REASONING_EFFORT_OPTIONS\.filter\(option=>option\.value!=='default'\)/);
  assert.match(dashboardHtml, /let relayModelSelectInteractionUntil=0/);
  assert.match(dashboardHtml, /function holdRelayModelPanelRender\(\)/);
  assert.match(dashboardHtml, /function shouldDeferRelayModelPanelRender\(\)/);
  assert.match(dashboardHtml, /if\(shouldDeferRelayModelPanelRender\(\)\)return/);
  assert.match(dashboardHtml, /onfocus="holdRelayModelPanelRender\(\)"/);
  assert.doesNotMatch(dashboardHtml, /function isInternalRelayModel\(model\)/);
  assert.doesNotMatch(dashboardHtml, /text\.includes\('glm'\)/);

  const functionSource = dashboardHtml.match(
    /function relayModelChoiceHtml\(model, activeId, catsConnected, context='settings'\)\{[\s\S]*?\n    \}/,
  )?.[0];
  assert.ok(functionSource);

  const relayModelChoiceHtml = vm.runInNewContext(`${functionSource}; relayModelChoiceHtml`, {
    escapeHtml: (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;'),
    formatModelContextLabel: (tokens: unknown, fallback: unknown) => fallback || `${tokens} tokens`,
    relayActionBusy: () => false,
    String,
  }) as (
    model: Record<string, unknown>,
    activeId: string,
    catsConnected: boolean,
    context?: string,
  ) => string;

  const html = relayModelChoiceHtml(
    {
      id: 'custom-openai',
      label: 'OpenAI <Relay>',
      model: 'custom&model',
      provider: 'anthropic',
      sdk_label: 'OpenAI SDK',
      quota_class: 'standard',
      context_window_tokens: 128000,
      context_label: '128K',
    },
    'custom-openai',
    true,
    'chat',
  );

  assert.match(html, /class="relay-model-choice active"/);
  assert.match(html, /data-relay-model-id="custom-openai"/);
  assert.match(html, /data-relay-model-context="chat"/);
  assert.match(html, /OpenAI &lt;Relay&gt;/);
  assert.match(html, /custom&amp;model/);
  assert.match(html, /上下文 128K · OpenAI SDK/);
  assert.doesNotMatch(html, /Anthropic SDK/);
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
  assert.match(
    dashboardHtml,
    /const requestPayload=\{\.\.\.payload,modelProfileSource:'custom',activateConnector:!auto\}/,
  );
  assert.match(dashboardHtml, /已自动保存，等待启用。/);
  assert.match(dashboardHtml, /if\(auto\)await fetchDashboardSettings\(\)/);
  assert.doesNotMatch(dashboardHtml, /restartConnector:!auto/);
});

test('CatsCo Chat setup refreshes readiness before unlocking the composer', () => {
  const setupBlock = dashboardHtml.match(/async function setupCatsBot\(options=\{\}\)\{[\s\S]*?async function resetCatsAuth/)?.[0] || '';
  assert.match(setupBlock, /const setupRelayModel=shouldSetupRelayOnCatsSetup\(\)/);
  assert.match(setupBlock, /setupRelayModel,/);
  assert.match(setupBlock, /relayModelId:setupRelayModel \? \(relayModelIdForSetup\(\)\|\|undefined\) : undefined/);
  assert.match(setupBlock, /reasoningEffort:setupRelayModel \? relayReasoningEffortForSetup\(\) : undefined/);
  assert.match(setupBlock, /rotateRelayKey:Boolean\(options\.rotateRelayKey\)/);
  assert.match(setupBlock, /const automatic=options\.automatic===true/);
  assert.match(setupBlock, /setCatsSetupBusy\(true\)/);
  assert.match(setupBlock, /setCatsStatusMutationBusy\(true\)/);
  assert.match(setupBlock, /invalidateCatsStatusRequests\(\)/);
  assert.match(setupBlock, /catsSetupWarningText\(data\)/);
  assert.match(setupBlock, /e\.status===409 && e\.action==='rotate_required'/);
  assert.match(setupBlock, /if\(automatic\)\{/);
  assert.match(setupBlock, /自动启动需要重新生成 CatsCo 中转 Key/);
  assert.match(setupBlock, /setCatsStatusMutationBusy\(false\)/);
  assert.match(setupBlock, /setCatsSetupBusy\(false\)/);
  assert.match(setupBlock, /const stage=await refreshCatsChatAfterMutation\(\{focusInput:true\}\)/);
  assert.match(setupBlock, /await loadCatsMessages\(true, \{reset:true, forceBottom:true\}\)/);
});

test('bound CatsCo connector recovery does not re-enter legacy setup or rebind the bot', () => {
  const handler = dashboardHtml.match(
    /async function handleCatsSetupAction\(\) \{[\s\S]*?async function sendCatsCode/,
  )?.[0] || '';
  assert.match(handler, /return startCurrentCatsConnector\(\)/);
  assert.match(handler, /fetch\(API\+'\/api\/cats\/connector\/start',\{method:'POST'\}\)/);
  assert.doesNotMatch(handler, /return bindCatsBot\(catsState\.botUid/);
  assert.doesNotMatch(handler, /fetch\(API\+'\/api\/cats\/setup'/);
});

test('CatsCo bot binding carries selected relay model setup', () => {
  const bindBlock = dashboardHtml.match(/async function bindCatsBot\(botUid, botName, button, options\) \{[\s\S]*?function closeBotSelector/)?.[0] || '';
  assert.match(bindBlock, /const setupRelayModel=shouldSetupRelayOnCatsSetup\(\)/);
  assert.match(bindBlock, /setupRelayModel,/);
  assert.match(bindBlock, /relayModelId:setupRelayModel \? \(relayModelIdForSetup\(\)\|\|undefined\) : undefined/);
  assert.match(bindBlock, /reasoningEffort:setupRelayModel \? relayReasoningEffortForSetup\(\) : undefined/);
  assert.match(bindBlock, /rotateRelayKey:Boolean\(options\?\.rotateRelayKey\)/);
  assert.match(bindBlock, /pendingStartupSource=''/);
  assert.match(bindBlock, /pendingRelayModelId=''/);
  assert.match(bindBlock, /pendingRelayReasoningEffort=''/);
  assert.match(bindBlock, /setCatsStatusMutationBusy\(true\)/);
  assert.match(bindBlock, /invalidateCatsStatusRequests\(\)/);
  assert.match(bindBlock, /const stage=await refreshCatsChatAfterMutation\(\{focusInput:true\}\)/);
  assert.match(bindBlock, /if\(stage\.key==='ready'\)await loadCatsMessages\(true, \{ reset: true, forceBottom: true \}\)/);
  assert.match(bindBlock, /setCatsStatusMutationBusy\(false\)/);
  assert.match(bindBlock, /e\.status===409 && e\.action==='rotate_required'/);
  assert.match(bindBlock, /bindCatsBot\(botUid, botName, button, \{\.\.\.options, confirm:false, restoreText, rotateRelayKey:true\}\)/);
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
