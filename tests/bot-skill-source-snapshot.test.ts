import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BOT_SKILL_SOURCE_MAX_FILES,
  BOT_SKILL_SOURCE_MAX_SINGLE_FILE_BYTES,
  BotSkillSourceError,
  buildBotSkillSourceSnapshot,
  computeBotSkillSourceContentHash,
} from '../src/bot-skills/source-snapshot';

describe('Bot Skill source snapshot security boundary', () => {
  let root: string;
  let skillDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-source-'));
    skillDir = path.join(root, 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: demo',
      'description: demo skill',
      '---',
      '',
      '# Demo',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('hashes and uploads the exact same ordered bytes without local identity metadata', () => {
    fs.mkdirSync(path.join(skillDir, 'scripts'));
    fs.writeFileSync(path.join(skillDir, 'scripts', 'run.js'), 'console.log("ok");\r\n');
    fs.writeFileSync(path.join(skillDir, '.xiaoba-local-skill.json'), '{"localSkillId":"not-source"}');

    const snapshot = buildBotSkillSourceSnapshot(skillDir);

    assert.equal(snapshot.contentHash, computeBotSkillSourceContentHash(skillDir));
    assert.deepStrictEqual(snapshot.files.map(file => file.path), ['SKILL.md', 'scripts/run.js']);
    assert.equal(snapshot.files.find(file => file.path === 'scripts/run.js')?.bytes.toString('utf8'), 'console.log("ok");\r\n');
  });

  test('blocks sensitive names and content without including the secret value in the error', () => {
    const secret = 'sk-proj-1234567890abcdefghijklmnop';
    fs.writeFileSync(path.join(skillDir, '.env'), `API_KEY=${secret}\n`);

    assert.throws(
      () => buildBotSkillSourceSnapshot(skillDir),
      (error: any) => {
        assert.equal(error instanceof BotSkillSourceError, true);
        assert.equal(error.code, 'SKILL_SOURCE_SENSITIVE');
        assert.deepStrictEqual(error.relativePaths, ['.env']);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );

    fs.rmSync(path.join(skillDir, '.env'));
    fs.writeFileSync(path.join(skillDir, 'config.txt'), `access_token=${secret}\n`);
    assert.throws(
      () => buildBotSkillSourceSnapshot(skillDir),
      (error: any) => error.code === 'SKILL_SOURCE_SENSITIVE' && !error.message.includes(secret),
    );
  });

  test('blocks service-prefixed, AWS, generic, and camelCase credential assignments', () => {
    const assignments = [
      'CATSCO_API_KEY=not-a-real-catsco-key-1234567890',
      'AWS_SECRET_ACCESS_KEY=not-a-real-aws-secret-1234567890',
      'MY_SERVICE_TOKEN=not-a-real-service-token-1234567890',
      '{"catscoApiKey":"not-a-real-json-key-1234567890"}',
      'DJANGO_SECRET_KEY=django-insecure-abcdefghijklmnopqrstuvwxyz1234567890',
      'API_KEY=abcd1234',
      'password=S3cur3Pass!',
      'SAFE=${SAFE};PASSWORD=realpassword',
      'config["apiKey"]="realpassword"',
      'API_KEY?=realpassword',
      'API_KEY+=realpassword',
      'connect(api_key="realpassword")',
      'API_KEY="${SAFE_ENV} actual-secret-value"',
      'SAFE=x&&PASSWORD=realpassword',
      'SAFE=x&PASSWORD=realpassword',
      'https://x.test/?access_token=realpassword',
    ];

    for (const [index, assignment] of assignments.entries()) {
      const filePath = path.join(skillDir, `config-${index}.txt`);
      fs.writeFileSync(filePath, `${assignment}\n`);
      assert.throws(
        () => buildBotSkillSourceSnapshot(skillDir),
        (error: any) => (
          error.code === 'SKILL_SOURCE_SENSITIVE'
          && error.relativePaths.includes(`config-${index}.txt`)
          && !error.message.includes('not-a-real')
        ),
      );
      fs.rmSync(filePath);
    }
  });

  test('allows only explicit safe credential references, placeholders, and schema values', () => {
    fs.writeFileSync(path.join(skillDir, 'example.txt'), [
      'CATSCO_API_KEY=your_api_key_here',
      'MY_SERVICE_TOKEN=placeholder-value',
      'clientSecret=****************',
      'STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}',
      'password=minimum_length_16',
      'interface Config { apiKey: string; }',
      '{ password: z.string().min(8) }',
      'clientSecret: null',
      'API_KEY=""',
    ].join('\n'));

    assert.doesNotThrow(() => buildBotSkillSourceSnapshot(skillDir));
  });

  test('does not treat a password-only policy value as a general secret placeholder', () => {
    fs.writeFileSync(path.join(skillDir, 'unsafe-policy.txt'), 'STRIPE_SECRET_KEY=minimum_length_16\n');
    assert.throws(
      () => buildBotSkillSourceSnapshot(skillDir),
      (error: any) => error.code === 'SKILL_SOURCE_SENSITIVE',
    );
  });

  test('fails the whole snapshot on file count or file size limits instead of truncating it', () => {
    for (let index = 0; index < BOT_SKILL_SOURCE_MAX_FILES; index += 1) {
      fs.writeFileSync(path.join(skillDir, `file-${index}.txt`), String(index));
    }
    assert.throws(
      () => buildBotSkillSourceSnapshot(skillDir),
      (error: any) => error.code === 'SKILL_SOURCE_FILE_LIMIT',
    );

    for (const name of fs.readdirSync(skillDir)) {
      if (name !== 'SKILL.md') fs.rmSync(path.join(skillDir, name), { recursive: true, force: true });
    }
    fs.writeFileSync(
      path.join(skillDir, 'large.bin'),
      Buffer.alloc(BOT_SKILL_SOURCE_MAX_SINGLE_FILE_BYTES + 1),
    );
    assert.throws(
      () => buildBotSkillSourceSnapshot(skillDir),
      (error: any) => error.code === 'SKILL_SOURCE_FILE_TOO_LARGE',
    );
  });

  test('rejects source paths deeper than the private package contract', () => {
    const deepRoot = path.join(skillDir, ...Array.from({ length: 65 }, (_, index) => `d${index}`));
    fs.mkdirSync(deepRoot, { recursive: true });
    fs.writeFileSync(path.join(deepRoot, 'deep.txt'), 'too deep');
    assert.throws(
      () => buildBotSkillSourceSnapshot(skillDir),
      (error: any) => error.code === 'SKILL_SOURCE_PATH_UNSAFE',
    );
  });

  test('rejects symlinks when the platform permits creating them', (t) => {
    const target = path.join(root, 'outside.txt');
    fs.writeFileSync(target, 'outside');
    try {
      fs.symlinkSync(target, path.join(skillDir, 'linked.txt'));
    } catch {
      t.skip('symlink creation is unavailable on this platform');
      return;
    }
    assert.throws(
      () => buildBotSkillSourceSnapshot(skillDir),
      (error: any) => error.code === 'SKILL_SOURCE_SYMLINK',
    );
  });
});
