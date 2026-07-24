import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileBotPrivateSkillPackageClient } from '../src/bot-skills/file-private-package';
import { buildBotSkillSourceSnapshot } from '../src/bot-skills/source-snapshot';
import { restoreBotSkillWorkspace } from '../src/bot-skills/workspace-restore';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';

describe('transactional Bot Skill workspace restore', () => {
  let root: string;
  let packageRoot: string;
  let activeRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-restore-'));
    packageRoot = path.join(root, 'cloud');
    activeRoot = path.join(root, 'runtime', 'skills');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function upload(name: string, localSkillId: string) {
    const source = path.join(root, `source-${name}`);
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), [
      '---',
      `name: ${name}`,
      `description: ${name} skill`,
      '---',
      '',
      `# ${name}`,
      '',
    ].join('\n'));
    const client = new FileBotPrivateSkillPackageClient({ root: packageRoot, botId: 'bot-a' });
    return client.upsert({
      localSkillId,
      name,
      snapshot: buildBotSkillSourceSnapshot(source),
    });
  }

  test('downloads everything to staging and activates one complete workspace', async () => {
    const a = await upload('alpha', 'local-a');
    const b = await upload('beta', 'local-b');
    const client = new FileBotPrivateSkillPackageClient({ root: packageRoot, botId: 'bot-a' });

    const restored = await restoreBotSkillWorkspace({
      skillsRoot: activeRoot,
      owner: { botId: 'bot-a', authority: 'authority-a' },
      references: [b.reference, a.reference],
      packageClient: client,
      createId: (() => {
        let value = 1;
        return () => `restore-${value++}`;
      })(),
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });

    const inspected = new BotSkillWorkspaceService({ skillsRoot: activeRoot })
      .inspect({ botId: 'bot-a', authority: 'authority-a' });
    assert.equal(inspected.kind, 'valid');
    assert.deepStrictEqual(restored.entries.map(entry => entry.localSkillId), ['local-a', 'local-b']);
    assert.equal(fs.existsSync(path.join(activeRoot, 'alpha', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(activeRoot, 'beta', 'SKILL.md')), true);
  });

  test('leaves the active workspace byte-for-byte intact when a download or guard fails', async () => {
    fs.mkdirSync(activeRoot, { recursive: true });
    fs.writeFileSync(path.join(activeRoot, 'sentinel.txt'), 'keep me');
    const version = await upload('alpha', 'local-a');
    const client = new FileBotPrivateSkillPackageClient({ root: packageRoot, botId: 'bot-a' });

    await assert.rejects(
      restoreBotSkillWorkspace({
        skillsRoot: activeRoot,
        owner: { botId: 'bot-a' },
        references: [version.reference, { skillId: `priv_${'a'.repeat(40)}`, version: `v_${'b'.repeat(48)}` }],
        packageClient: client,
      }),
    );
    assert.equal(fs.readFileSync(path.join(activeRoot, 'sentinel.txt'), 'utf8'), 'keep me');

    await assert.rejects(
      restoreBotSkillWorkspace({
        skillsRoot: activeRoot,
        owner: { botId: 'bot-a' },
        references: [version.reference],
        packageClient: client,
        beforeCommit: () => {
          throw new Error('local changed');
        },
      }),
    );
    assert.equal(fs.readFileSync(path.join(activeRoot, 'sentinel.txt'), 'utf8'), 'keep me');
  });

  test('preserves localSkillId when the same Cloud Skill advances to a new version', async () => {
    const initial = await upload('alpha', 'server-local-id');
    const client = new FileBotPrivateSkillPackageClient({ root: packageRoot, botId: 'bot-a' });
    const downloaded = await client.download(initial.reference);
    const nextReference = {
      skillId: initial.reference.skillId,
      version: `v_${'c'.repeat(48)}`,
    };

    const restored = await restoreBotSkillWorkspace({
      skillsRoot: activeRoot,
      owner: { botId: 'bot-a' },
      references: [nextReference],
      baseEntries: [{
        localSkillId: 'stable-local-id',
        localContentHash: downloaded.contentHash,
        cloudSkillId: initial.reference.skillId,
        cloudVersion: initial.reference.version,
      }],
      packageClient: {
        download: async reference => ({
          ...downloaded,
          reference,
          localSkillId: 'different-server-local-id',
        }),
      },
    });

    assert.equal(restored.entries[0].localSkillId, 'stable-local-id');
    const inspected = new BotSkillWorkspaceService({ skillsRoot: activeRoot })
      .inspect({ botId: 'bot-a' });
    assert.equal(
      inspected.kind === 'valid' && inspected.skills[0].localSkillId,
      'stable-local-id',
    );
  });

  test('rejects a download response bound to a different Cloud reference', async () => {
    const version = await upload('alpha', 'local-a');
    const client = new FileBotPrivateSkillPackageClient({ root: packageRoot, botId: 'bot-a' });
    const downloaded = await client.download(version.reference);

    await assert.rejects(
      restoreBotSkillWorkspace({
        skillsRoot: activeRoot,
        owner: { botId: 'bot-a' },
        references: [version.reference],
        packageClient: {
          download: async () => ({
            ...downloaded,
            reference: {
              skillId: `priv_${'d'.repeat(40)}`,
              version: version.reference.version,
            },
          }),
        },
      }),
      (error: any) => error?.code === 'BOT_SKILL_RESTORE_REFERENCE_MISMATCH',
    );
    assert.equal(fs.existsSync(activeRoot), false);
  });

  test('rejects package paths that are unsafe on Windows even when restored elsewhere', async () => {
    const version = await upload('alpha', 'local-a');
    const client = new FileBotPrivateSkillPackageClient({ root: packageRoot, botId: 'bot-a' });
    const downloaded = await client.download(version.reference);
    const unsafe = {
      ...downloaded,
      files: [
        ...downloaded.files,
        {
          path: 'CON.txt',
          size: 1,
          sha256: '0'.repeat(64),
          bytes: Buffer.from('x'),
        },
      ],
    };

    await assert.rejects(
      restoreBotSkillWorkspace({
        skillsRoot: activeRoot,
        owner: { botId: 'bot-a' },
        references: [version.reference],
        packageClient: { download: async () => unsafe },
      }),
      (error: any) => error?.code === 'BOT_SKILL_RESTORE_PATH_UNSAFE',
    );
  });
});
