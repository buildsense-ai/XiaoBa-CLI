import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { BotSkillBaseStore } from '../src/bot-skills/base-store';
import { scanBotSkillWorkspace } from '../src/bot-skills/local-manifest';
import { BotSkillSyncService } from '../src/bot-skills/sync-service';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';
import type { BotSkillRef } from '../src/bot-definition/types';

test('unchanged managed Skills can be reused beside malformed local additions and links', t => {
  const fixture = createFixture(t);
  const extra = path.join(fixture.skillsRoot, 'local-only');
  fs.mkdirSync(extra);
  fs.writeFileSync(path.join(extra, 'SKILL.md'), '---\ninvalid: [\n---');
  const outside = path.join(fixture.root, '.agents', 'skills');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'Do not inspect or publish.');
  const link = path.join(fixture.skillsRoot, 'game-assets');
  linkDirectory(outside, link);
  const linkTarget = fs.readlinkSync(link);
  const read = t.mock.method(fs, 'readFileSync');

  assert.equal(fixture.reuse()?.applyStatus, 'already_applied');
  assert.equal(fixture.base.read('bot-a')?.definitionRevision, 2);
  assert.equal(fs.readlinkSync(link), linkTarget);
  assert.equal(fs.existsSync(path.join(extra, '.xiaoba-bot-skill.json')), false);
  assert.equal(read.mock.calls.some(call => String(call.arguments[0]).includes('game-assets')), false);
  assert.equal(read.mock.calls.some(call => String(call.arguments[0]).includes('local-only')), false);
  assert.equal(read.mock.calls.some(call => String(call.arguments[0]).includes('.agents')), false);
});

test('changed managed package content cannot be reused even when references are unchanged', t => {
  const fixture = createFixture(t);
  fs.appendFileSync(path.join(fixture.managedRoot, 'SKILL.md'), '\nlocal edit');
  assert.equal(fixture.reuse(), undefined);
  assert.equal(fixture.base.read('bot-a')?.definitionRevision, 1);
});

for (const location of ['package', 'namespace', 'root'] as const) {
  test(`reuse refuses a ${location} directory link without reading its target`, t => {
    const fixture = createFixture(t);
    const source = location === 'package' ? fixture.managedRoot
      : location === 'namespace' ? path.dirname(fixture.managedRoot)
        : fixture.skillsRoot;
    const outside = path.join(fixture.root, 'external');
    fs.renameSync(source, outside);
    linkDirectory(outside, source);
    const read = t.mock.method(fs, 'readFileSync');

    assert.equal(fixture.reuse(), undefined);
    assert.equal(fixture.base.read('bot-a')?.definitionRevision, 1);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), true);
    // The Base is readable; package bytes through any alias must remain unread.
    assert.equal(read.mock.calls.some(call => String(call.arguments[0]).endsWith('SKILL.md')), false);
  });
}

test('noncanonical Base paths cannot bypass namespace link checks on Windows', t => {
  const fixture = createFixture(t);
  const base = fixture.base.read('bot-a')!;
  fixture.base.write({
    ...base,
    skills: base.skills.map(entry => ({ ...entry, installName: 'namespace\\managed' })),
  });
  const namespace = path.dirname(fixture.managedRoot);
  const outside = path.join(fixture.root, 'external');
  fs.renameSync(namespace, outside);
  linkDirectory(outside, namespace);
  const read = t.mock.method(fs, 'readFileSync');

  assert.equal(fixture.reuse(), undefined);
  assert.equal(read.mock.calls.some(call => String(call.arguments[0]).endsWith('SKILL.md')), false);
  assert.equal(fixture.base.read('bot-a')?.definitionRevision, 1);
});

test('a dangling workspace root link declines reuse without blocking strict activation', t => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.root, 'external');
  fs.renameSync(fixture.skillsRoot, outside);
  linkDirectory(outside, fixture.skillsRoot);
  fs.rmSync(outside, { recursive: true });

  assert.equal(fixture.reuse(), undefined);
  assert.equal(fixture.base.read('bot-a')?.definitionRevision, 1);
});

test('a link replacing a managed package directory cannot be reused', t => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.root, 'external');
  const assets = path.join(fixture.managedRoot, 'assets');
  fs.renameSync(assets, outside);
  linkDirectory(outside, assets);
  assert.equal(fixture.reuse(), undefined);
  assert.equal(fixture.base.read('bot-a')?.definitionRevision, 1);
});

test('changed desired Skill references do not use the model-only reuse path', t => {
  const fixture = createFixture(t);
  assert.equal(fixture.reuse([{ ...fixture.reference, version: '2.0.0' }]), undefined);
  assert.equal(fixture.base.read('bot-a')?.definitionRevision, 1);
});

test('missing Base and a foreign workspace cannot be success-acknowledged by reuse', t => {
  const fixture = createFixture(t);
  fs.unlinkSync(path.join(fixture.root, 'data', 'bot-skills', 'sync-base', 'bot-a.json'));
  assert.equal(fixture.reuse(), undefined);
  fixture.workspace.activate('bot-other');
  assert.equal(fixture.reuse(), undefined);
  assert.equal(fixture.workspace.getActiveBotId(), 'bot-other');
});

function createFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-skill-reuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, 'skills');
  const managedRoot = path.join(skillsRoot, 'namespace', 'managed');
  fs.mkdirSync(managedRoot, { recursive: true });
  fs.writeFileSync(path.join(managedRoot, 'SKILL.md'),
    '---\nname: managed\ndescription: Verified managed package.\n---\nOriginal content.\n');
  fs.mkdirSync(path.join(managedRoot, 'assets'));
  fs.writeFileSync(path.join(managedRoot, 'assets', 'example.txt'), 'Managed package content.');
  const [entry] = scanBotSkillWorkspace(skillsRoot);
  const reference: BotSkillRef = {
    source: 'skillhub', skillId: 'publisher/managed', version: '1.0.0', contentHash: entry.contentHash,
  };
  const base = new BotSkillBaseStore(root);
  base.write({
    schema: 'xiaoba.bot-skill-sync-base.v2', botId: 'bot-a', definitionRevision: 1,
    skills: [{
      localSkillId: entry.localSkillId, name: entry.name, installName: entry.installName,
      contentHash: entry.contentHash, reference,
    }],
    updatedAt: new Date().toISOString(),
  });
  const workspace = new BotSkillWorkspaceService(root);
  workspace.activate('bot-a');
  const service = new BotSkillSyncService({
    runtimeRoot: root, skillsRoot, botId: 'bot-a', workspaceExisted: true,
    auth: { apiKey: 'unit-test', botUid: 'bot-a', httpBaseUrl: 'https://cats.example.test' },
    fetchImpl: (async () => { throw new Error('Reuse must not access Cloud'); }) as typeof fetch,
  });
  return {
    root, skillsRoot, managedRoot, reference, base, workspace,
    reuse: (refs: readonly BotSkillRef[] = [reference]) => service.reuseVerifiedActivation(refs, 2),
  };
}

function linkDirectory(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
