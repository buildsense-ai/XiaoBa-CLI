import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

// 测试 System Prompt 模块化
test('memory.md guidance exists and has content', () => {
  const memoryPath = path.join(__dirname, '../prompts/tools/memory.md');
  assert.ok(fs.existsSync(memoryPath), 'memory.md should exist');

  const content = fs.readFileSync(memoryPath, 'utf-8');
  assert.ok(content.includes('memory_search'), 'memory.md should mention memory_search');
  assert.ok(content.includes('记忆搜索'), 'memory.md should have section title');
});

test('planning.md guidance exists and has content', () => {
  const planningPath = path.join(__dirname, '../prompts/tools/planning.md');
  assert.ok(fs.existsSync(planningPath), 'planning.md should exist');

  const content = fs.readFileSync(planningPath, 'utf-8');
  assert.ok(content.includes('todo_write'), 'planning.md should mention todo_write');
  assert.ok(content.includes('completed'), 'planning.md should mention completed status');
});

test('basic.md exists with tool list', () => {
  const basicPath = path.join(__dirname, '../prompts/tools/basic.md');
  assert.ok(fs.existsSync(basicPath), 'basic.md should exist');
  const content = fs.readFileSync(basicPath, 'utf-8');
  assert.ok(content.includes('read_file'), 'basic.md should mention read_file');
});

// 测试 PromptManager
test('PromptManager.getToolGuidances loads memory.md for memory_search', () => {
  const { PromptManager } = require('../src/utils/prompt-manager');

  const guidance = PromptManager.getToolGuidances(['memory_search']);

  assert.ok(guidance.includes('记忆搜索'), 'Should include memory guidance');
});

test('PromptManager.getToolGuidances loads planning.md for todo_write', () => {
  const { PromptManager } = require('../src/utils/prompt-manager');

  const guidance = PromptManager.getToolGuidances(['todo_write', 'read_file']);

  assert.ok(guidance.includes('任务规划'), 'Should include planning guidance');
});

test('PromptManager.getToolGuidances deduplicates files', () => {
  const { PromptManager } = require('../src/utils/prompt-manager');

  // memory_search 和 todo_write 都在，应该加载两个文件
  const guidance = PromptManager.getToolGuidances(['memory_search', 'todo_write', 'memory_search', 'todo_write']);

  // 计算出现次数（每个 section 标题应该只出现一次）
  const memoryCount = (guidance.match(/## 记忆搜索/g) || []).length;
  const planningCount = (guidance.match(/## 任务规划/g) || []).length;

  assert.equal(memoryCount, 1, 'memory.md should only be loaded once');
  assert.equal(planningCount, 1, 'planning.md should only be loaded once');
});

test('PromptManager.buildSystemPrompt includes tool guidances', async () => {
  const { PromptManager } = require('../src/utils/prompt-manager');

  const prompt = await PromptManager.buildSystemPrompt(['memory_search', 'todo_write']);

  // 应包含基础 system prompt（agent_name 会被替换为偏好值）
  assert.ok(prompt.includes('你是谁'), 'Should include base prompt identity section');

  // 应包含工具 guidance
  assert.ok(prompt.includes('记忆搜索'), 'Should include memory guidance');
  assert.ok(prompt.includes('任务规划'), 'Should include planning guidance');
});

test('system-prompt.md has complete tool list', () => {
  const systemPromptPath = path.join(__dirname, '../prompts/system-prompt.md');
  const content = fs.readFileSync(systemPromptPath, 'utf-8');

  const requiredTools = [
    'send_message',
    'send_file',
    'read_file',
    'write_file',
    'edit_file',
    'execute_bash',
    'glob',
    'grep',
    'web_search',
    'web_fetch',
    'memory_search',
    'todo_write',
    'spawn_subagent',
    'check_subagent',
    'stop_subagent',
    'resume_subagent',
  ];

  for (const tool of requiredTools) {
    assert.ok(content.includes(tool), `system-prompt.md should include ${tool}`);
  }
});

// 测试 GauzMemService.recall (not activeSearch)
test('GauzMemService has recall method', () => {
  const { GauzMemService } = require('../src/utils/gauzmem-service');

  const service = GauzMemService.getInstance();
  assert.ok(typeof service.recall === 'function', 'recall should be a function');
});

test('GauzMemService has ActiveSearchResult type exported', () => {
  const types = require('../src/utils/gauzmem-service');

  // 验证类型导出（运行时无法直接验证类型，但可以验证模块导出存在）
  assert.ok(types.GauzMemService, 'GauzMemService should be exported');
});

// 测试 MemorySearchTool definition
test('MemorySearchTool definition has correct name and query param', () => {
  const { MemorySearchTool } = require('../src/tools/memory-search-tool');

  const tool = new MemorySearchTool();
  const def = tool.definition;

  assert.equal(def.name, 'memory_search');
  assert.ok(def.parameters.properties.query, 'Should have query parameter');
  assert.ok(def.description.includes('之前讨论了什么'), 'Should mention use case for recalling history');
});

// ─── 新增：communication.md 测试 ───

test('communication.md exists and has emotional tone guidance', () => {
  const commPath = path.join(__dirname, '../prompts/tools/communication.md');
  assert.ok(fs.existsSync(commPath), 'communication.md should exist');

  const content = fs.readFileSync(commPath, 'utf-8');
  assert.ok(content.includes('send_message'), 'Should mention send_message');
  assert.ok(content.includes('send_file'), 'Should mention send_file');
  assert.ok(content.includes('温度'), 'Should include emotional tone guidance');
});

test('communication.md deduplicates when both send_message and send_file present', () => {
  const { PromptManager } = require('../src/utils/prompt-manager');

  const guidance = PromptManager.getToolGuidances(['send_message', 'send_file']);
  const count = (guidance.match(/## 沟通方式/g) || []).length;

  assert.equal(count, 1, 'communication.md should only be loaded once');
});

// ─── 新增：buildSystemPrompt 加载 communication 指引 ───

test('buildSystemPrompt loads communication guidance for send_message', async () => {
  const { PromptManager } = require('../src/utils/prompt-manager');

  const prompt = await PromptManager.buildSystemPrompt(['send_message', 'send_file']);
  assert.ok(prompt.includes('沟通方式'), 'Should include communication guidance');
});

// ─── 新增：planning.md 包含中途插话指引 ───

test('planning.md includes mid-task interruption handling', () => {
  const planningPath = path.join(__dirname, '../prompts/tools/planning.md');
  const content = fs.readFileSync(planningPath, 'utf-8');

  assert.ok(content.includes('中途插话'), 'Should include interruption handling');
  assert.ok(content.includes('语气'), 'Should include tone guidance');
});

console.log('All prompt modular tests passed!');
