import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const dashboardHtml = readFileSync(join(process.cwd(), 'dashboard/index.html'), 'utf-8');

function countOccurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

test('dashboard settings page uses model source before Runtime Profile', () => {
  assert.match(dashboardHtml, /模型来源与 Runtime Profile/);
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
  assert.match(dashboardHtml, /title==='CatsCo Chat'\?'运行中':'完成'/);
  assert.match(dashboardHtml, /title==='CatsCo Chat'\?'未启动':'需处理'/);
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
  assert.match(dashboardHtml, /<details class="run-details" open>\s*<summary><span>启动前检查<\/span><span class="tag">readiness<\/span><\/summary>/);
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
});

test('CatsCo Chat page is driven by readiness state instead of loose controls', () => {
  assert.match(dashboardHtml, /id="cats-chat-state"/);
  assert.match(dashboardHtml, /id="cats-state-card"/);
  assert.match(dashboardHtml, /id="cats-checklist"/);
  assert.match(dashboardHtml, /function buildCatsChatStage\(\)/);
  assert.match(dashboardHtml, /function renderCatsChecklist\(stage\)/);
  assert.match(dashboardHtml, /function runCatsNextAction\(\)/);
  assert.match(dashboardHtml, /先完成模型来源/);
  assert.match(dashboardHtml, /Dashboard Chat 连接同一个 CatsCompany 网页会话/);
  assert.match(dashboardHtml, /CatsCompany connector/);
  assert.match(dashboardHtml, /恢复 CatsCompany connector/);
  assert.match(dashboardHtml, /<details class="chat-diagnostics" id="cats-connection-details">/);
  assert.match(dashboardHtml, /<summary>高级 endpoint<\/summary>/);
  assert.match(dashboardHtml, /input\.disabled=locked/);
  assert.match(dashboardHtml, /send\.disabled=locked/);
  assert.match(dashboardHtml, /attach\.disabled=locked/);
  assert.match(dashboardHtml, /id="cats-message-input"[^>]*disabled/);
  assert.match(dashboardHtml, /id="cats-send-btn" disabled/);
  assert.match(dashboardHtml, /needs-readiness/);
  assert.match(dashboardHtml, /appReadinessLoaded/);
  assert.doesNotMatch(dashboardHtml, /末尾 \+/);
});

test('CatsCo Chat preserves scroll position while reading history', () => {
  assert.match(dashboardHtml, /let catsScrollPinnedToBottom = true/);
  assert.match(dashboardHtml, /const CATS_SCROLL_BOTTOM_THRESHOLD = 80/);
  assert.match(dashboardHtml, /function isCatsMessageScrollNearBottom\(box\)/);
  assert.match(dashboardHtml, /function updateCatsMessageScrollIntent\(\)/);
  assert.match(dashboardHtml, /function scrollCatsMessagesToBottom\(box\)/);
  assert.match(dashboardHtml, /addEventListener\('scroll', updateCatsMessageScrollIntent, \{ passive: true \}\)/);

  const renderBlock = dashboardHtml.match(/function renderCatsMessages\(messages\)\{[\s\S]*?async function loadCatsMessages/)?.[0] || '';
  assert.match(renderBlock, /const shouldStickToBottom=/);
  assert.match(renderBlock, /if\(shouldStickToBottom\)scrollCatsMessagesToBottom\(box\)/);
  assert.doesNotMatch(renderBlock, /box\.scrollTop=box\.scrollHeight;\s*updatePetFromCatsMessages/);
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
  assert.match(dashboardHtml, /document\.documentElement\.style\.fontSize=scale\+'%'/);
  assert.match(dashboardHtml, /function handleDashboardFontScaleShortcut\(event\)/);
  assert.match(dashboardHtml, /key==='\+' \|\| key==='=' \|\| key==='Add'/);
  assert.match(dashboardHtml, /key==='-' \|\| key==='_'\s*\|\| key==='Subtract'/);
  assert.match(dashboardHtml, /key==='0' \|\| key==='\)'/);
  assert.match(dashboardHtml, /loadDashboardFontScale\(\);/);
  assert.match(dashboardHtml, /document\.addEventListener\('keydown',handleDashboardFontScaleShortcut\)/);
});
