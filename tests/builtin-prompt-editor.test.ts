import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillManager } from '../src/skills/skill-manager';
import { SkillTool } from '../src/tools/skill-tool';
import { PROMPT_EDITOR_SKILL_FILE } from '../src/skills/builtin-prompt-editor-skill';
import { ToolManager } from '../src/tools/tool-manager';

test('bundled editor is available without installation, survives empty reload and supports explicit overrides', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-editor-'));
  try {
    const manager = new SkillManager(root);
    await manager.loadSkills();
    assert.equal(manager.getSkill('catsco-prompt-editor')!.filePath, PROMPT_EDITOR_SKILL_FILE);
    assert.ok(manager.getSkill('xiaoba-knowledge'));
    assert.deepEqual(fs.readdirSync(root), []);
    await manager.reload();
    assert.equal(manager.getAllSkills().length, 2);
    fs.mkdirSync(path.join(root, 'custom'));
    fs.writeFileSync(path.join(root, 'custom/SKILL.md'), '---\nname: catsco-prompt-editor\ndescription: User override\n---\nMy custom guidance.');
    await manager.reload();
    assert.equal(manager.getSkill('catsco-prompt-editor')!.content, 'My custom guidance.');
    assert.equal(manager.getAllSkills().length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('skill invocation renders the actual runtime and package helper paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-render-'));
  const previous = process.env.XIAOBA_USER_DATA_DIR;
  try {
    process.env.XIAOBA_USER_DATA_DIR = root;
    const result = await new SkillTool().execute({ skill: 'catsco-prompt-editor', runtimeRoot: 'forged' }, {
      workingDirectory: root, conversationHistory: [],
    });
    assert.equal(result.ok, true);
    assert.ok(String(result.content).includes(root));
    assert.ok(String(result.content).includes(path.dirname(PROMPT_EDITOR_SKILL_FILE)));
    assert.doesNotMatch(String(result.content), /<PROMPT_RUNTIME_ROOT>|<PROMPT_NODE>|<SKILL_DIR>|forged/);
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_USER_DATA_DIR; else process.env.XIAOBA_USER_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('actual skill, write_file and execute_shell tools complete local prompt edit and reset', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-toolchain-'));
  const previous = process.env.XIAOBA_USER_DATA_DIR;
  try {
    process.env.XIAOBA_USER_DATA_DIR = root;
    const manager = new ToolManager(root, { surface: 'catscompany', sessionId: 'prompt-editor-fixture' });
    const call = (name: string, args: Record<string, unknown>) => manager.executeTool({
      id: `editor-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
    });
    assert.equal((await call('skill', { skill: 'catsco-prompt-editor' })).ok, true);
    const helper = path.resolve(path.dirname(PROMPT_EDITOR_SKILL_FILE), 'scripts/prompt.cjs');
    const quote = (value: string) => process.platform === 'win32'
      ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
    const command = (...args: string[]) => `${process.platform === 'win32' ? '& ' : ''}${[process.execPath, helper, '--root', root, ...args].map(quote).join(' ')}`;
    const shell = async (...args: string[]) => {
      const result = await call('execute_shell', { command: command(...args) });
      assert.equal(result.ok, true, String(result.content));
      const json = String(result.content).split(/\r?\n/).find(line => line.startsWith('{"ok":'));
      assert.ok(json, String(result.content));
      return JSON.parse(json);
    };
    const input = path.join(root, 'request.json');
    let state = await shell('show');
    const initial = state.content;
    const writeRequest = async (content?: string) => {
      const result = await call('write_file', { file_path: input, content: JSON.stringify({
        botId: state.botId, expectedHash: state.expectedHash, expectedRevision: state.expectedRevision,
        ...(content !== undefined ? { content } : {}),
      }) });
      assert.equal(result.ok, true);
    };
    await writeRequest('Only the requested user preference.');
    await shell('set', input);
    state = await shell('show');
    assert.equal(state.content, 'Only the requested user preference.');
    assert.equal(state.localMatches, true);
    await writeRequest();
    state = await shell('reset', input);
    assert.equal(state.content, initial);
    assert.equal(state.selected, 'default');
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_USER_DATA_DIR; else process.env.XIAOBA_USER_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
