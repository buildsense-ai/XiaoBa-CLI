import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileBotPrivateSkillPackageClient } from '../src/bot-skills/file-private-package';
import { buildBotSkillSourceSnapshot } from '../src/bot-skills/source-snapshot';

describe('file-backed private Skill package transport', () => {
  let root: string;
  let packageRoot: string;
  let skillDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-private-skill-'));
    packageRoot = path.join(root, 'cloud');
    skillDir = path.join(root, 'skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: demo',
      'description: demo skill',
      '---',
      '',
      '# Demo',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(skillDir, 'script.js'), 'console.log("demo");\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('upserts immutable content by bot/localSkillId/contentHash and never rewrites Local', async () => {
    const client = new FileBotPrivateSkillPackageClient({
      root: packageRoot,
      botId: 'bot-a',
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });
    const original = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const snapshot = buildBotSkillSourceSnapshot(skillDir);

    const first = await client.upsert({ localSkillId: 'local-a', name: 'demo', snapshot });
    const second = await client.upsert({ localSkillId: 'local-a', name: 'demo-renamed', snapshot });

    assert.deepStrictEqual(second, first);
    assert.match(first.reference.skillId, /^priv_[a-f0-9]{40}$/);
    assert.match(first.reference.version, /^v_[a-f0-9]{48}$/);
    assert.doesNotMatch(first.reference.skillId, /bot-a|local-a/);
    assert.doesNotMatch(first.reference.version, new RegExp(snapshot.contentHash));
    assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), original);
    assert.equal(fs.existsSync(client.getPackagePath('local-a', snapshot.contentHash)), true);
  });

  test('downloads and revalidates exact bytes, while another Bot cannot read the package', async () => {
    const owner = new FileBotPrivateSkillPackageClient({ root: packageRoot, botId: 'bot-a' });
    const snapshot = buildBotSkillSourceSnapshot(skillDir);
    const version = await owner.upsert({ localSkillId: 'local-a', name: 'demo', snapshot });

    const downloaded = await owner.download(version.reference);

    assert.equal(downloaded.contentHash, snapshot.contentHash);
    assert.deepStrictEqual(
      downloaded.files.map(file => [file.path, file.bytes.toString('utf8')]),
      snapshot.files.map(file => [file.path, file.bytes.toString('utf8')]),
    );
    const otherBot = new FileBotPrivateSkillPackageClient({ root: packageRoot, botId: 'bot-b' });
    await assert.rejects(
      otherBot.download(version.reference),
      (error: any) => error.code === 'PRIVATE_SKILL_NOT_FOUND',
    );
  });

  test('detects storage tampering before materialization', async () => {
    const client = new FileBotPrivateSkillPackageClient({ root: packageRoot, botId: 'bot-a' });
    const snapshot = buildBotSkillSourceSnapshot(skillDir);
    const version = await client.upsert({ localSkillId: 'local-a', name: 'demo', snapshot });
    const packagePath = client.getPackagePath('local-a', snapshot.contentHash);
    const stored = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    stored.files[0].contentBase64 = Buffer.from('tampered').toString('base64');
    fs.writeFileSync(packagePath, JSON.stringify(stored));

    await assert.rejects(
      client.download(version.reference),
      (error: any) => error.code === 'PRIVATE_SKILL_PACKAGE_INVALID'
        || error.code === 'PRIVATE_SKILL_PACKAGE_CHECKSUM_MISMATCH',
    );
  });
});
