import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { SkillManager } from '../src/skills/skill-manager';
import { SkillTool } from '../src/tools/skill-tool';
import { SessionSkillRuntime } from '../src/skills/session-skill-runtime';
import { TurnSkillSnapshotStore } from '../src/skills/turn-skill-snapshot';
import { PromptComposer } from '../src/runtime/prompt-composer';
import { DEFAULT_PROMPTS_DIR } from '../src/utils/prompt-template';
import { ToolManager } from '../src/tools/tool-manager';

const helper = path.resolve(__dirname, '../skills/xiaoba-knowledge/scripts/knowledge.cjs');
const { KnowledgeStore } = require(helper);
const run = promisify(execFile);
const request = (overrides: Record<string, unknown> = {}) => ({
  expectedRevision: null, title: '部署流程', summary: '发布与验证', category: 'procedures',
  sources: ['用户明确约定；测试环境验证记录'], change: '记录发布流程', body: '# 部署\n\n运行测试再发布。', ...overrides,
});

describe('instance shared knowledge', () => {
  let temp: string;
  let root: string;
  let originalDataRoot: string | undefined;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-knowledge-'));
    root = path.join(temp, '共享 知识');
    originalDataRoot = process.env.XIAOBA_USER_DATA_DIR;
    process.env.XIAOBA_USER_DATA_DIR = temp;
  });
  afterEach(() => {
    if (originalDataRoot === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = originalDataRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  });

  test('reads an empty library without creating it, and isolates separate runtime roots', async () => {
    const store = new KnowledgeStore(root);
    assert.deepEqual(store.index().items, []);
    assert.equal(fs.existsSync(root), false);
    const created = await store.put(request());
    assert.equal(new KnowledgeStore(root).read(created.id).body, request().body);
    assert.equal(new KnowledgeStore(path.join(temp, 'other')).index().total, 0);
  });

  test('preserves IDs and history, rejects stale writes, and skips unchanged content', async () => {
    const first = new KnowledgeStore(root);
    const second = new KnowledgeStore(root);
    const initial = await first.put(request());
    const updated = await second.put(request({ id: initial.id, expectedRevision: initial.revision, body: '修正后的流程', change: '核验并修正' }));
    assert.equal(updated.id, initial.id);
    assert.notEqual(updated.revision, initial.revision);
    await assert.rejects(first.put(request({ id: initial.id, expectedRevision: initial.revision, body: '过期写入' })), { code: 'REVISION_CONFLICT' });
    assert.equal(first.read(initial.id).body, '修正后的流程');
    assert.match(fs.readFileSync(path.join(root, '.history', initial.id, `${initial.revision}.md`), 'utf8'), /运行测试再发布/);
    assert.match(fs.readFileSync(path.join(root, 'changes.md'), 'utf8'), /核验并修正/);
    assert.match(fs.readFileSync(path.join(root, 'changes.md'), 'utf8'), /记录发布流程/);
    const unchanged = await second.put(request({ id: initial.id, expectedRevision: updated.revision, body: '修正后的流程' }));
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.revision, updated.revision);
  });

  test('resolves short citations uniquely and searches full IDs and prefixes', async () => {
    const store = new KnowledgeStore(root);
    const created = await store.put(request());
    const shortId = created.id.slice(0, 11);
    assert.equal(store.read(shortId).id, created.id);
    assert.equal(store.read(shortId).revision, created.revision);
    assert.equal(store.index(shortId).items[0].id, created.id);
    assert.equal(store.index(created.id).items[0].id, created.id);
    assert.throws(() => new KnowledgeStore(path.join(temp, 'empty')).read(shortId), { code: 'NOT_FOUND' });
    assert.equal(fs.existsSync(path.join(temp, 'empty')), false);

    // Two legitimate full IDs can share their first eight UUID characters.
    const secondId = created.id.slice(0, -1) + (created.id.endsWith('0') ? '1' : '0');
    const raw = fs.readFileSync(path.join(root, 'documents', `${created.id}.md`), 'utf8');
    fs.writeFileSync(path.join(root, 'documents', `${secondId}.md`), raw.replace(created.id, secondId));
    assert.equal(store.index(shortId).total, 2);
    assert.throws(() => store.read(shortId), { code: 'AMBIGUOUS_ID' });
    assert.equal(store.read(created.id).id, created.id);
    assert.equal(store.read(secondId).id, secondId);
    await assert.rejects(store.put(request({ id: shortId, expectedRevision: created.revision })), { code: 'INVALID_ID' });
  });

  test('independent processes serialize writes and keep a complete shared index', async () => {
    const writes = Array.from({ length: 4 }, (_, i) => {
      const input = path.join(temp, `请求 ${i}.json`);
      fs.writeFileSync(input, JSON.stringify(request({ title: `项目 ${i}` })));
      return run(process.execPath, [helper, '--root', root, 'put', input]);
    });
    const results = await Promise.all(writes);
    const ids = results.map(result => JSON.parse(result.stdout).id);
    assert.equal(new Set(ids).size, 4);
    const store = new KnowledgeStore(root);
    assert.equal(store.index().total, 4);
    for (const id of ids) assert.ok(fs.readFileSync(path.join(root, 'index.md'), 'utf8').includes(id));
    assert.equal(fs.existsSync(path.join(root, '.write.lock')), false);
  });

  test('two concurrent edits of the same revision cannot both succeed', async () => {
    const store = new KnowledgeStore(root);
    const initial = await store.put(request());
    const results = await Promise.allSettled(['A', 'B'].map(body => {
      const input = path.join(temp, `update-${body}.json`);
      fs.writeFileSync(input, JSON.stringify(request({ id: initial.id, expectedRevision: initial.revision, body })));
      return run(process.execPath, [helper, '--root', root, 'put', input]);
    }));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(JSON.parse(rejected.reason.stderr).code, 'REVISION_CONFLICT');
  });

  test('a live owner and a crashed owner both block writes until explicit recovery', { timeout: 15000 }, async () => {
    const child = spawn(process.execPath, ['-e', `
      const {KnowledgeStore}=require(process.argv[1]);
      new KnowledgeStore(process.argv[2]).withLock(() => {
        process.stdout.write('LOCKED\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    `, helper, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      await Promise.race([
        once(child.stdout!, 'data'),
        exited.then(() => { throw new Error('lock owner exited before acquiring the lock'); }),
      ]);
      const lock = path.join(root, '.write.lock');
      const original = fs.readFileSync(lock, 'utf8');
      assert.equal(JSON.parse(original).pid, child.pid);
      await assert.rejects(new KnowledgeStore(root).put(request()), { code: 'LOCK_BUSY' });
      assert.equal(fs.readFileSync(lock, 'utf8'), original);
      child.kill('SIGKILL');
      await exited;
      await assert.rejects(new KnowledgeStore(root).put(request()), { code: 'LOCK_BUSY' });
      assert.equal(fs.readFileSync(lock, 'utf8'), original);
      assert.equal(new KnowledgeStore(root).index().total, 0);
      // The owner is now known to have exited. Simulate the documented operator recovery.
      fs.unlinkSync(lock);
      const saved = await new KnowledgeStore(root).put(request());
      assert.equal(new KnowledgeStore(root).read(saved.id).body, request().body);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });

  test('finishing an old write does not delete a replacement lock', async () => {
    const lock = path.join(root, '.write.lock');
    const replacement = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: 'replacement-owner' });
    await new KnowledgeStore(root).withLock(() => {
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, replacement, { flag: 'wx' });
    });
    assert.equal(fs.readFileSync(lock, 'utf8'), replacement);
  });

  test('bounds reads, searches full bodies, and rebuilds index after manual edits', async () => {
    const store = new KnowledgeStore(root);
    const body = '文'.repeat(13000) + '特殊配置';
    const created = await store.put(request({ body }));
    const first = store.read(created.id);
    const next = store.read(created.id, first.nextOffset);
    assert.equal(first.body + next.body, body);
    assert.equal(first.revision, next.revision);
    assert.equal(store.index('特殊配置').items[0].id, created.id);
    const file = path.join(root, 'documents', `${created.id}.md`);
    fs.appendFileSync(file, '\n手动补充');
    await assert.rejects(store.put(request({ id: created.id, expectedRevision: created.revision })), { code: 'REVISION_CONFLICT' });
    fs.unlinkSync(path.join(root, 'index.md'));
    await store.reindex();
    assert.ok(fs.existsSync(path.join(root, 'index.md')));
    assert.equal(store.index('手动补充').total, 1);
  });

  test('rejects missing versions, path traversal, and directory links', async () => {
    const store = new KnowledgeStore(root);
    await assert.rejects(store.put(request({ expectedRevision: undefined })), { code: 'INVALID_INPUT' });
    assert.throws(() => store.read('../secret'), { code: 'INVALID_ID' });
    fs.mkdirSync(root);
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'documents'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.put(request()), { code: 'UNSAFE_PATH' });
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.throws(() => store.index(), { code: 'UNSAFE_PATH' });
    await assert.rejects(store.reindex(), { code: 'UNSAFE_PATH' });
  });

  for (const corruption of ['plain-name', 'incomplete', 'bad-json', 'null', 'missing-fields', 'wrong-id', 'oversized']) {
    test(`isolates ${corruption} Markdown while retaining valid search, read and reindex`, async () => {
      const store = new KnowledgeStore(root);
      const good = await store.put(request());
      const bad = await store.put(request({ title: 'Damaged document' }));
      const originalPath = path.join(root, 'documents', `${bad.id}.md`);
      const original = fs.readFileSync(originalPath, 'utf8');
      let file = originalPath;
      let damaged: string;
      switch (corruption) {
        case 'plain-name':
          file = path.join(root, 'documents', 'notes.md');
          fs.renameSync(originalPath, file);
          damaged = 'a manually added note'; break;
        case 'incomplete': damaged = '---\n{"id":'; break;
        case 'bad-json': damaged = '---\n{broken}\n---\n\nbody'; break;
        case 'null': damaged = '---\nnull\n---\n\nbody'; break;
        case 'missing-fields': damaged = `---\n${JSON.stringify({ id: bad.id })}\n---\n\nbody`; break;
        case 'wrong-id': damaged = original.replace(bad.id, good.id); break;
        default: damaged = 'x'.repeat(256 * 1024 + 1);
      }
      fs.writeFileSync(file, damaged);
      const relative = path.relative(root, file).split(path.sep).join('/');
      for (const result of [store.index(), await store.reindex()]) {
        assert.equal(result.total ?? result.documents, corruption === 'oversized' ? 1 : 2);
        assert.equal(result.warnings.length, corruption === 'plain-name' ? 0 : 1);
        if (result.warnings.length) {
          assert.equal(result.warnings[0].file, relative);
          assert.equal(result.warnings[0].code, 'INVALID_DOCUMENT');
          assert.ok(result.warnings[0].message);
        }
      }
      assert.ok(store.index('部署').items.some((item: any) => item.id === good.id));
      if (corruption !== 'oversized') {
        const source = store.index().items.find((item: any) => !item.managed);
        assert.equal(source.id, `file:${relative}`);
        assert.equal(store.read(source.id).body, damaged);
        assert.equal(store.read(source.id).managed, false);
        await assert.rejects(store.put(request({ id: source.id, expectedRevision: source.revision })), { code: 'INVALID_ID' });
      }
      assert.equal(store.read(good.id).body, request().body);
      assert.match(fs.readFileSync(path.join(root, 'index.md'), 'utf8'), new RegExp(good.id));
      assert.equal(fs.readFileSync(file, 'utf8'), damaged);
      if (file !== originalPath) fs.renameSync(file, originalPath);
      fs.writeFileSync(originalPath, original);
      assert.equal((await store.reindex()).warnings.length, 0);
      assert.equal(store.index().total, 2);
    });
  }

  test('skips damaged history and reports partial indexing on a successful put', async () => {
    const store = new KnowledgeStore(root);
    const initial = await store.put(request());
    const updated = await store.put(request({ id: initial.id, expectedRevision: initial.revision, body: 'Updated evidence' }));
    const archive = path.join(root, '.history', initial.id, `${initial.revision}.md`);
    fs.writeFileSync(archive, 'damaged archive');
    const created = await store.put(request({ title: 'Other valid document' }));
    assert.equal(created.saved, true);
    assert.equal(created.warnings[0].file, path.relative(root, archive).split(path.sep).join('/'));
    const rebuilt = await store.reindex();
    assert.equal(rebuilt.documents, 2);
    assert.equal(rebuilt.revisions, 2);
    assert.equal(rebuilt.warnings.length, 1);
    assert.equal(store.read(updated.id).body, 'Updated evidence');
    assert.equal(fs.readFileSync(archive, 'utf8'), 'damaged archive');
  });

  test('skips an unsafe individual document without following its hard link', async () => {
    const store = new KnowledgeStore(root);
    const good = await store.put(request());
    const outside = path.join(temp, 'outside.md');
    fs.writeFileSync(outside, 'outside data');
    const unsafeId = 'KB-00000000-0000-0000-0000-000000000000';
    fs.linkSync(outside, path.join(root, 'documents', `${unsafeId}.md`));
    assert.equal(store.index().items[0].id, good.id);
    assert.equal(store.index().warnings[0].code, 'UNSAFE_PATH');
    assert.throws(() => store.read(unsafeId), { code: 'UNSAFE_PATH' });
    assert.equal((await store.reindex()).documents, 1);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside data');
  });

  test('copied Markdown is searchable and pageable without metadata or automatic edits', async () => {
    const store = new KnowledgeStore(root);
    const relative = 'documents/客户学校/试卷 #1 (解析).MD';
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = '# 三角函数例题\n\n' + '题目解析'.repeat(4000) + '\n终点特殊答案';
    fs.writeFileSync(file, body);
    const found = store.index('终点特殊答案');
    assert.equal(found.total, 1);
    assert.deepEqual(found.warnings, []);
    assert.equal(found.items[0].title, '三角函数例题');
    assert.equal(found.items[0].managed, false);
    assert.equal(found.items[0].file, relative);
    const first = store.read(found.items[0].id);
    const rest = store.read(found.items[0].id, first.nextOffset);
    assert.equal(first.body + rest.body, body);
    assert.equal(first.revision, rest.revision);
    const cli = await run(process.execPath, [helper, '--root', root, 'read', found.items[0].id]);
    assert.equal(JSON.parse(cli.stdout).body, first.body);
    const rebuilt = await store.reindex();
    assert.equal(rebuilt.documents, 1);
    assert.equal(rebuilt.revisions, 0);
    assert.match(fs.readFileSync(path.join(root, 'index.md'), 'utf8'), /%231%20%28/);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
    assert.equal(fs.existsSync(path.join(root, '.history')), false);
    fs.appendFileSync(file, '\n客户补充条件');
    assert.equal(store.index('客户补充条件').total, 1);
    assert.notEqual(store.read(found.items[0].id).revision, first.revision);
  });

  test('file references reject escapes and linked folders while retaining other sources', async () => {
    const store = new KnowledgeStore(root);
    await store.put(request());
    const outside = path.join(temp, 'external');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.md'), 'outside secret');
    fs.symlinkSync(outside, path.join(root, 'documents', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(store.index('outside secret').total, 0);
    assert.equal(store.index().warnings[0].code, 'UNSAFE_PATH');
    assert.throws(() => store.read('file:documents/linked/secret.md'), { code: 'UNSAFE_PATH' });
    for (const reference of ['file:documents/../secret.md', 'file:documents/../../external/secret.md', 'file:documents\\secret.md', 'file:/documents/secret.md', 'file:documents//secret.md', 'file:documents/secret.md:stream.md', 'file:.history/secret.md']) {
      assert.throws(() => store.read(reference), { code: 'INVALID_PATH' });
    }
    assert.equal((await store.reindex()).documents, 1);
  });

  test('noncanonical KB extension stays a file reference on case-sensitive platforms', async () => {
    const store = new KnowledgeStore(root);
    const created = await store.put(request());
    const relative = `documents/${created.id}.MD`;
    fs.renameSync(path.join(root, 'documents', `${created.id}.md`), path.join(root, relative));
    const found = store.index().items[0];
    assert.equal(found.managed, false);
    assert.equal(found.id, `file:${relative}`);
    assert.match(store.read(found.id).body, /运行测试再发布/);
    assert.equal((await store.reindex()).documents, 1);
  });

  test('reports a committed document when index repair fails, without duplicating the document', async () => {
    const store = new KnowledgeStore(root);
    fs.mkdirSync(path.join(root, 'index.md'), { recursive: true });
    const created = await store.put(request());
    assert.equal(created.saved, true);
    assert.match(created.warning, /reindex/);
    assert.equal(store.read(created.id).title, '部署流程');
    fs.rmdirSync(path.join(root, 'index.md'));
    await store.reindex();
    assert.equal(store.index().total, 1);
  });

  test('discoverable without installed Skills, including immutable turn snapshots; knowledge changes leave prompt and listing stable', async () => {
    const manager = new SkillManager(path.join(temp, 'missing-skills'));
    await manager.loadSkills();
    assert.ok(manager.getSkill('xiaoba-knowledge'));
    assert.equal(fs.existsSync(path.join(temp, 'knowledge')), false);
    const runtime = new SessionSkillRuntime(manager, 'bot-A');
    const listing = runtime.buildSkillsListMessage();
    const prompt = () => PromptComposer.composeSystemPrompt({ promptsDir: DEFAULT_PROMPTS_DIR, now: new Date('2026-09-07T00:00:00Z') });
    const beforePrompt = prompt();
    const store = new KnowledgeStore(path.join(temp, 'knowledge'));
    await store.put(request());
    await manager.loadSkills();
    assert.deepEqual(runtime.buildSkillsListMessage(), listing);
    assert.equal(prompt(), beforePrompt);
    assert.ok(!String(listing?.content).includes(temp));

    const skillsRoot = path.join(temp, 'skills');
    fs.mkdirSync(skillsRoot);
    const snapshots = new TurnSkillSnapshotStore({ runtimeRoot: temp, skillsRoot });
    const lease = await snapshots.acquire();
    try {
      const snapshotManager = new SkillManager(lease.snapshot.rootPath);
      await snapshotManager.loadSkills();
      const result = await new SkillTool().execute({ skill: 'xiaoba-knowledge' }, {
        workingDirectory: temp, conversationHistory: [], turnSkillSnapshot: lease,
        runtimeServices: { aiService: {} as any, skillManager: snapshotManager },
      });
      assert.equal(result.ok, true);
      const content = String((result as any).content);
      assert.ok(content.includes(path.join(temp, 'knowledge')));
      assert.ok(content.includes(process.execPath));
      assert.doesNotMatch(content, /<KNOWLEDGE_ROOT>|<KNOWLEDGE_NODE>|<SKILL_DIR>/);
      assert.equal(lease.snapshot.fileCount, 0);
    } finally { await lease.release(); }
  });

  test('preserves an explicitly installed same-name Skill', async () => {
    const skills = path.join(temp, 'custom');
    const directory = path.join(skills, 'override');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: xiaoba-knowledge\ndescription: Custom knowledge workflow\n---\nUser workflow.');
    const manager = new SkillManager(skills);
    await manager.loadSkills();
    assert.equal(manager.getSkill('xiaoba-knowledge')?.content, 'User workflow.');
  });

  test('actual Skill, write_file and execute_shell tools share knowledge across bot sessions', async () => {
    const botA = new ToolManager(temp, { surface: 'catscompany', sessionId: 'knowledge-bot-A' });
    const botB = new ToolManager(temp, { surface: 'catscompany', sessionId: 'knowledge-bot-B' });
    const call = (manager: ToolManager, name: string, args: Record<string, unknown>) => manager.executeTool({
      id: `test-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
    });
    const loaded = await call(botA, 'skill', { skill: 'xiaoba-knowledge' });
    assert.equal(loaded.ok, true);
    const sharedRoot = path.join(temp, 'knowledge');
    assert.ok(String(loaded.content).includes(sharedRoot));
    const input = path.join(temp, '工具链 请求.json');
    const written = await call(botA, 'write_file', { file_path: input, content: JSON.stringify(request()) });
    assert.equal(written.ok, true);
    const quote = (value: string) => process.platform === 'win32'
      ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
    const command = (...args: string[]) => `${process.platform === 'win32' ? '& ' : ''}${[process.execPath, helper, '--root', sharedRoot, ...args].map(quote).join(' ')}`;
    const saved = await call(botA, 'execute_shell', { command: command('put', input) });
    assert.equal(saved.ok, true, String(saved.content));
    const created = new KnowledgeStore(sharedRoot).index().items[0];
    const read = await call(botB, 'execute_shell', { command: command('read', created.id) });
    assert.equal(read.ok, true, String(read.content));
    assert.ok(String(read.content).includes(created.id));
    assert.ok(String(read.content).includes('运行测试再发布'));
  });
});
