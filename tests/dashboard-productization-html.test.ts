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
  assert.match(dashboardHtml, /CatsCo 托管模型/);
  assert.match(dashboardHtml, /自定义模型（高级）/);
  assert.match(dashboardHtml, /托管模型目录和用量服务还没有接入当前本地版本/);
  assert.match(dashboardHtml, /访问凭证只保存 presence，不会回显/);
  assert.match(dashboardHtml, /保存自定义模型设置？访问凭证会写入本地 \.env，仅用于本机 runtime。/);
  assert.match(dashboardHtml, /Runtime Profile 状态/);
  assert.match(dashboardHtml, /受控编辑/);
  assert.match(dashboardHtml, /保存后新 session 生效/);
  assert.match(dashboardHtml, /当前已运行 session 不会热更新/);
  assert.doesNotMatch(dashboardHtml, /buildsense\.asia/i);
});

test('run page is driven by readiness instead of raw diagnostics cards', () => {
  assert.match(dashboardHtml, /id="run-summary"/);
  assert.match(dashboardHtml, /id="readiness-grid"/);
  assert.match(dashboardHtml, /fetch\(API\+'\/api\/readiness'\)/);
  assert.match(dashboardHtml, /function renderReadiness\(data\)/);
  assert.match(dashboardHtml, /启动前检查未通过/);
  assert.match(dashboardHtml, /模型来源、CatsCo Chat、Runtime Profile 和 Skills/);
  assert.match(dashboardHtml, /<details class="run-details">\s*<summary><span>Service details<\/span><span class="tag">connector<\/span><\/summary>/);
  assert.match(dashboardHtml, /<summary><span>Diagnostics<\/span><span class="tag">version \/ host \/ paths<\/span><\/summary>/);
  assert.doesNotMatch(dashboardHtml, /<details class="run-details" open>/);
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
  assert.match(dashboardHtml, /Dashboard Chat 连接同一个 CatsCo webapp 会话/);
  assert.match(dashboardHtml, /<details class="chat-diagnostics" id="cats-connection-details">/);
  assert.match(dashboardHtml, /<summary>高级 endpoint<\/summary>/);
  assert.match(dashboardHtml, /input\.disabled=locked/);
  assert.match(dashboardHtml, /send\.disabled=locked/);
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
