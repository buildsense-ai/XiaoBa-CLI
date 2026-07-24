import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BOT_LOCAL_SKILL_IDENTITY_FILE,
  BOT_SKILL_WORKSPACE_IDENTITY_FILE,
  BotSkillWorkspaceService,
} from '../src/bot-skills/workspace';

describe('Bot Skill workspace identity and inspection', () => {
  let root: string;
  let skillsRoot: string;
  let nextId: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-workspace-'));
    skillsRoot = path.join(root, 'skills');
    nextId = 1;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function service(): BotSkillWorkspaceService {
    return new BotSkillWorkspaceService({
      runtimeRoot: root,
      skillsRoot,
      createId: () => `id-${nextId++}`,
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });
  }

  function writeSkill(directoryName: string, name = directoryName, extra = ''): string {
    const directory = path.join(skillsRoot, directoryName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), [
      '---',
      `name: ${name}`,
      `description: ${name} description`,
      '---',
      '',
      `# ${name}`,
      extra,
      '',
    ].join('\n'));
    return directory;
  }

  test('distinguishes missing, unowned, and valid empty workspaces', () => {
    const workspace = service();
    assert.equal(workspace.inspect().kind, 'missing');

    fs.mkdirSync(skillsRoot, { recursive: true });
    assert.deepStrictEqual(workspace.inspect(), { kind: 'unowned', root: skillsRoot, skillCount: 0 });

    const identity = workspace.claimExisting({ botId: 'bot-a', authority: 'cats.example/user-1' });
    const inspected = workspace.inspect({ botId: 'bot-a', authority: 'cats.example/user-1' });
    assert.equal(inspected.kind, 'valid');
    if (inspected.kind === 'valid') {
      assert.deepStrictEqual(inspected.skills, []);
      assert.equal(inspected.identity.workspaceId, identity.workspaceId);
    }
  });

  test('claims a legacy workspace and keeps localSkillId stable across rename and content changes', () => {
    const oldDirectory = writeSkill('old-directory', 'renameable');
    const workspace = service();
    workspace.claimExisting({ botId: 'bot-a', authority: 'cats.example/user-1' });
    const first = workspace.inspect({ botId: 'bot-a', authority: 'cats.example/user-1' });
    assert.equal(first.kind, 'valid');
    if (first.kind !== 'valid') return;
    const originalId = first.skills[0].localSkillId;
    const originalHash = first.skills[0].contentHash;

    const newDirectory = path.join(skillsRoot, 'new-directory');
    fs.renameSync(oldDirectory, newDirectory);
    fs.appendFileSync(path.join(newDirectory, 'SKILL.md'), '\nchanged\n');
    const second = workspace.inspect({ botId: 'bot-a', authority: 'cats.example/user-1' });

    assert.equal(second.kind, 'valid');
    if (second.kind === 'valid') {
      assert.equal(second.skills[0].localSkillId, originalId);
      assert.notEqual(second.skills[0].contentHash, originalHash);
      assert.equal(second.skills[0].directoryName, 'new-directory');
    }
  });

  test('assigns an identity to a manually added Skill without changing its content hash', () => {
    const workspace = service();
    workspace.initializeEmpty({ botId: 'bot-a' });
    const directory = writeSkill('manual');
    const before = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8');

    const inspected = workspace.inspect({ botId: 'bot-a' });

    assert.equal(inspected.kind, 'valid');
    assert.equal(fs.existsSync(path.join(directory, BOT_LOCAL_SKILL_IDENTITY_FILE)), true);
    assert.equal(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'), before);
    if (inspected.kind === 'valid') {
      const hashAfterMarker = inspected.skills[0].contentHash;
      fs.rmSync(path.join(directory, BOT_LOCAL_SKILL_IDENTITY_FILE));
      workspace.inspect({ botId: 'bot-a' });
      const rescanned = workspace.inspect({ botId: 'bot-a' });
      assert.equal(rescanned.kind === 'valid' && rescanned.skills[0].contentHash, hashAfterMarker);
    }
  });

  test('refuses an owner mismatch instead of relabeling the active directory', () => {
    const workspace = service();
    workspace.initializeEmpty({ botId: 'bot-a', authority: 'server-a/user-a' });

    const inspected = workspace.inspect({ botId: 'bot-b', authority: 'server-a/user-a' });

    assert.equal(inspected.kind, 'owner_mismatch');
    const persisted = JSON.parse(
      fs.readFileSync(path.join(skillsRoot, BOT_SKILL_WORKSPACE_IDENTITY_FILE), 'utf8'),
    );
    assert.equal(persisted.workspaceOwnerBotId, 'bot-a');
  });

  test('treats malformed identity and duplicate localSkillId as unreadable, never as empty', () => {
    const workspace = service();
    workspace.initializeEmpty({ botId: 'bot-a' });
    fs.writeFileSync(path.join(skillsRoot, BOT_SKILL_WORKSPACE_IDENTITY_FILE), '{broken');
    assert.equal(workspace.inspect({ botId: 'bot-a' }).kind, 'unreadable');

    fs.rmSync(path.join(skillsRoot, BOT_SKILL_WORKSPACE_IDENTITY_FILE));
    const first = writeSkill('first');
    const second = writeSkill('second');
    workspace.claimExisting({ botId: 'bot-a' });
    fs.copyFileSync(
      path.join(first, BOT_LOCAL_SKILL_IDENTITY_FILE),
      path.join(second, BOT_LOCAL_SKILL_IDENTITY_FILE),
    );
    assert.equal(workspace.inspect({ botId: 'bot-a' }).kind, 'unreadable');
  });
});
