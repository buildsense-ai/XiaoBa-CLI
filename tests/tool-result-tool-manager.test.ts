/**
 * tool-manager 核心测试：验证 ToolExecutionResult 结构统一处理
 */
import { describe, test, beforeEach, mock } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ToolManager } from '../src/tools/tool-manager';
import { SubAgentManager } from '../src/core/sub-agent-manager';

describe('ToolManager - ToolExecutionResult 统一处理', () => {
  let manager: ToolManager;
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-result-'));
    manager = new ToolManager(testRoot);
  });

  // ─── 成功路径 ───────────────────────────────────────────────

  test('write_file 成功返回 ok=true', async () => {
    const result = await manager.executeTool(
      { id: 't1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'ok.txt', content: 'hello' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('成功写入') || result.content?.includes('成功创建'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('read_file 成功返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'read_ok.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3');
    const result = await manager.executeTool(
      { id: 't2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: filePath }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('read_ok.txt'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('edit_file 成功返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'edit_ok.txt');
    fs.writeFileSync(filePath, 'hello world');
    const result = await manager.executeTool(
      { id: 't3', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: filePath, old_string: 'world', new_string: 'Albert' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('成功编辑'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('glob 成功返回 ok=true', async () => {
    fs.writeFileSync(path.join(testRoot, 'a.txt'), '');
    fs.writeFileSync(path.join(testRoot, 'b.txt'), '');
    const result = await manager.executeTool(
      { id: 't4', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.txt' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('找到'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('glob returns absolute filenames when searching an absolute path', async () => {
    const filePath = path.join(testRoot, 'absolute-result.txt');
    fs.writeFileSync(filePath, '');

    const result = await manager.executeTool(
      { id: 't4_abs', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.txt', path: testRoot }) } },
      [],
    );

    assert.strictEqual(result.ok, true);
    assert.ok(String(result.content).includes(filePath));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('read_file uses reader proxy path for images when primary model is text-only', async () => {
    const previousConfigPath = process.env.XIAOBA_CONFIG_PATH;
    const previousModel = process.env.GAUZ_LLM_MODEL;
    const previousApiKey = process.env.CATSCOMPANY_API_KEY;
    const previousReaderApiKey = process.env.READER_PROXY_API_KEY;
    process.env.XIAOBA_CONFIG_PATH = path.join(testRoot, 'missing-config.json');
    process.env.GAUZ_LLM_MODEL = 'gpt-3.5-turbo';
    delete process.env.CATSCOMPANY_API_KEY;
    delete process.env.READER_PROXY_API_KEY;

    try {
      const filePath = path.join(testRoot, 'image.png');
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await manager.executeTool(
        { id: 't2_img', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: filePath }) } },
        [{ role: 'user', content: '帮我看看图里有什么' }],
      );

      assert.strictEqual(result.ok, true);
      assert.ok(String(result.content).includes('当前主模型不能直接读取图片内容'));
      assert.ok(String(result.content).includes('读图服务配置缺失'));
      assert.ok(String(result.content).includes('排查信息'));
      assert.strictEqual(result.errorCode, undefined);
    } finally {
      if (previousConfigPath === undefined) delete process.env.XIAOBA_CONFIG_PATH;
      else process.env.XIAOBA_CONFIG_PATH = previousConfigPath;
      if (previousModel === undefined) delete process.env.GAUZ_LLM_MODEL;
      else process.env.GAUZ_LLM_MODEL = previousModel;
      if (previousApiKey === undefined) delete process.env.CATSCOMPANY_API_KEY;
      else process.env.CATSCOMPANY_API_KEY = previousApiKey;
      if (previousReaderApiKey === undefined) delete process.env.READER_PROXY_API_KEY;
      else process.env.READER_PROXY_API_KEY = previousReaderApiKey;
    }
  });

  test('grep 成功返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'grep_ok.txt');
    fs.writeFileSync(filePath, 'match line here');
    const result = await manager.executeTool(
      { id: 't5', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'match', path: testRoot }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('找到'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('record_decision 成功返回 ok=true 且默认不进 transcript', async () => {
    const definition = manager.getToolDefinitions().find(tool => tool.name === 'record_decision');
    assert.equal(definition?.transcriptMode, 'suppress');

    const result = await manager.executeTool(
      {
        id: 't_record_decision',
        type: 'function',
        function: {
          name: 'record_decision',
          arguments: JSON.stringify({
            summary: '这轮先出 plan，再把登录和日志拆出去并行检查',
            plan_decision: 'use_plan',
            subagent_decision: 'spawn_now',
            task_split: ['主线检查聊天体验', '子 agent 扫登录绑定', '子 agent 审查日志链路'],
          }),
        },
      },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('决策说明已记录'));
    assert.strictEqual(result.errorCode, undefined);
  });

  // ─── 失败路径 ───────────────────────────────────────────────

  test('read_file 文件不存在返回 ok=false + FILE_NOT_FOUND', async () => {
    const result = await manager.executeTool(
      { id: 't7', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: '/nope/not/exist.txt' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
    assert.ok(result.content?.includes('文件不存在'));
  });

  test('edit_file 文件不存在返回 ok=false + FILE_NOT_FOUND', async () => {
    const result = await manager.executeTool(
      { id: 't8', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: '/nope/not/exist.txt', old_string: 'a', new_string: 'b' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
    assert.ok(result.content?.includes('文件不存在'));
  });

  test('edit_file old_string 不存在返回 ok=false', async () => {
    const filePath = path.join(testRoot, 'no_match.txt');
    fs.writeFileSync(filePath, 'original content');
    const result = await manager.executeTool(
      { id: 't9', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: filePath, old_string: 'not found string', new_string: 'x' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.content?.includes('未找到'));
  });

  test('edit_file replace_all=false 但匹配多个返回 ok=false', async () => {
    const filePath = path.join(testRoot, 'multi_match.txt');
    fs.writeFileSync(filePath, 'foo bar foo baz');
    const result = await manager.executeTool(
      { id: 't10', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: filePath, old_string: 'foo', new_string: 'baz', replace_all: false }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.content?.includes('2 个匹配项'));
  });

  test('glob 目录不存在返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't11', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.txt', path: '/nope/not/here' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
  });

  test('tool 不存在返回 ok=false + TOOL_NOT_FOUND', async () => {
    const result = await manager.executeTool(
      { id: 't12', type: 'function', function: { name: 'nonexistent_tool', arguments: '{}' } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_NOT_FOUND');
  });

  test('参数 JSON 无效返回 ok=false + INVALID_TOOL_ARGUMENTS', async () => {
    const result = await manager.executeTool(
      { id: 't13', type: 'function', function: { name: 'write_file', arguments: '{bad json' } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('spawn_subagent 参数缺失返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't14', type: 'function', function: { name: 'spawn_subagent', arguments: JSON.stringify({}) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.ok(result.content?.includes('必填参数'));
  });

  test('stop_subagent 参数缺失返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't15', type: 'function', function: { name: 'stop_subagent', arguments: JSON.stringify({}) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('resume_subagent 参数缺失返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't16', type: 'function', function: { name: 'resume_subagent', arguments: JSON.stringify({ subagent_id: 'sub-1' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('check_subagent 不存在的 ID 返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't17', type: 'function', function: { name: 'check_subagent', arguments: JSON.stringify({ subagent_id: 'sub-does-not-exist' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_NOT_FOUND');
  });

  test('stop_subagent 不存在的 ID 返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't18', type: 'function', function: { name: 'stop_subagent', arguments: JSON.stringify({ subagent_id: 'sub-does-not-exist' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_NOT_FOUND');
  });

  test('stop_subagent 跨会话返回 PERMISSION_DENIED', async () => {
    const subAgentManager = SubAgentManager.getInstance() as any;
    subAgentManager.parentMap.set('sub-forbidden-stop', 'other-session');
    subAgentManager.subAgents.set('sub-forbidden-stop', {
      status: 'running',
      stop() {},
    });

    try {
      const result = await manager.executeTool(
        { id: 't18_forbidden', type: 'function', function: { name: 'stop_subagent', arguments: JSON.stringify({ subagent_id: 'sub-forbidden-stop' }) } },
        [],
        { sessionId: 'current-session' },
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.errorCode, 'PERMISSION_DENIED');
    } finally {
      subAgentManager.parentMap.delete('sub-forbidden-stop');
      subAgentManager.subAgents.delete('sub-forbidden-stop');
    }
  });

  test('resume_subagent 跨会话返回 PERMISSION_DENIED', async () => {
    const subAgentManager = SubAgentManager.getInstance() as any;
    subAgentManager.parentMap.set('sub-forbidden-resume', 'other-session');
    subAgentManager.subAgents.set('sub-forbidden-resume', {
      status: 'waiting_for_input',
      resume() { return true; },
    });

    try {
      const result = await manager.executeTool(
        { id: 't18_resume_forbidden', type: 'function', function: { name: 'resume_subagent', arguments: JSON.stringify({ subagent_id: 'sub-forbidden-resume', answer: 'ok' }) } },
        [],
        { sessionId: 'current-session' },
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.errorCode, 'PERMISSION_DENIED');
    } finally {
      subAgentManager.parentMap.delete('sub-forbidden-resume');
      subAgentManager.subAgents.delete('sub-forbidden-resume');
    }
  });

  // ─── 别名兼容 ───────────────────────────────────────────────

  test('Bash 别名映射到 execute_shell 成功', async () => {
    const result = await manager.executeTool(
      { id: 't19', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo hello' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('hello'));
  });

  test('execute_shell 支持 AbortSignal 取消长命令', async () => {
    const controller = new AbortController();
    const nodePath = process.execPath.replace(/"/g, '\\"');
    const command = `"${nodePath}" -e "setTimeout(function(){}, 5000)"`;

    const startedAt = Date.now();
    const execution = manager.executeTool(
      { id: 't19_abort', type: 'function', function: { name: 'execute_shell', arguments: JSON.stringify({ command, timeout: 10000 }) } },
      [],
      { abortSignal: controller.signal },
    );

    setTimeout(() => controller.abort(), 100);
    const result = await execution;

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'EXECUTION_TIMEOUT');
    assert.match(String(result.content), /取消/);
    assert.ok(Date.now() - startedAt < 3000, 'abort should return before the command timeout');
  });

  test('context overrides do not clear an existing AbortSignal with undefined', async () => {
    const controller = new AbortController();
    const scopedManager = new ToolManager(testRoot, { abortSignal: controller.signal }, {
      enabledToolNames: [],
    });
    let capturedSignal: AbortSignal | undefined;
    scopedManager.registerTool({
      definition: {
        name: 'capture_signal',
        description: 'capture signal',
        parameters: { type: 'object', properties: {} },
      },
      async execute(_args, context) {
        capturedSignal = context.abortSignal;
        return { ok: true, content: 'ok' };
      },
    });

    const result = await scopedManager.executeTool(
      { id: 't19_context_merge', type: 'function', function: { name: 'capture_signal', arguments: '{}' } },
      [],
      { abortSignal: undefined },
    );

    assert.equal(result.ok, true);
    assert.equal(capturedSignal, controller.signal);
  });

  test('Write 别名映射到 write_file 成功', async () => {
    const result = await manager.executeTool(
      { id: 't20', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: 'alias.txt', content: 'via alias' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('成功'));
  });
});
