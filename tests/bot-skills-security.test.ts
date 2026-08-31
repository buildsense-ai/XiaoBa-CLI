import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalizeBotSkillRefs } from '../src/bot-skills/canonical';
import {
  BotSkillWorkspaceScanLimitError,
  isPortablePackagePath,
  scanBotSkillWorkspace,
  scanLocalBotSkill,
} from '../src/bot-skills/local-manifest';
import { BotPrivateSkillClient } from '../src/bot-skills/private-package-client';
import type { BotSkillRef } from '../src/bot-definition/types';
import type { BotSkillPackage } from '../src/bot-skills/types';

describe('Bot Skill sync security boundaries', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('packages archives and binary-looking files without content-policy blocking', () => {
    const extensionRoot = createSkill(roots, 'archive-extension');
    fs.writeFileSync(path.join(extensionRoot, 'payload.tar.gz'), 'not even a real archive');
    assert.equal(
      scanLocalBotSkill(extensionRoot).files.some(file => file.path === 'payload.tar.gz'),
      true,
    );

    const magicRoot = createSkill(roots, 'archive-magic');
    fs.writeFileSync(
      path.join(magicRoot, 'payload.bin'),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
    );
    assert.equal(
      scanLocalBotSkill(magicRoot).files.some(file => file.path === 'payload.bin'),
      true,
    );

    const credentialsRoot = createSkill(roots, 'credentials-and-executable');
    fs.mkdirSync(path.join(credentialsRoot, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(credentialsRoot, '.ssh', 'id_rsa'), 'private-key-placeholder');
    fs.writeFileSync(path.join(credentialsRoot, 'runner.exe'), Buffer.from([0x4d, 0x5a, 0x00, 0x01]));
    const packagedPaths = scanLocalBotSkill(credentialsRoot).files.map(file => file.path);
    assert.equal(packagedPaths.includes('.ssh/id_rsa'), true);
    assert.equal(packagedPaths.includes('runner.exe'), true);
  });

  test('keeps path and package-size boundaries after removing content inspection', () => {
    for (const unsafePath of ['../outside', '/absolute', 'C:/absolute', 'nested/../outside', 'nested//file']) {
      assert.equal(isPortablePackagePath(unsafePath), false, unsafePath);
    }
    assert.equal(isPortablePackagePath('scripts/publish.mjs'), true);

    const oversizedRoot = createSkill(roots, 'oversized');
    fs.writeFileSync(path.join(oversizedRoot, 'payload.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
    assert.throws(() => scanLocalBotSkill(oversizedRoot), /file is too large/i);

    const crowdedRoot = createSkill(roots, 'crowded');
    for (let index = 0; index < 200; index += 1) {
      fs.writeFileSync(path.join(crowdedRoot, `file-${index}.txt`), '');
    }
    assert.throws(() => scanLocalBotSkill(crowdedRoot), /too many files/i);
  });

  test('bounds aggregate workspace listing work without retaining package bodies', () => {
    const skillRoot = createSkill(roots, 'bounded-listing');
    const workspaceRoot = path.dirname(skillRoot);
    assert.throws(
      () => scanBotSkillWorkspace(workspaceRoot, { maxSkillEntries: 0 }),
      (error: unknown) => error instanceof BotSkillWorkspaceScanLimitError,
    );
    assert.throws(
      () => scanBotSkillWorkspace(workspaceRoot, { maxTotalPackageBytes: 1 }),
      (error: unknown) => error instanceof BotSkillWorkspaceScanLimitError,
    );
    const [entry] = scanBotSkillWorkspace(workspaceRoot, { retainPackageContents: false });
    assert.ok(entry?.contentHash);
    assert.deepEqual(entry.files, []);
  });

  test('excludes runtime cache directories without deleting or size-checking them', () => {
    const skillRoot = createSkill(roots, 'runtime-cache');
    const cachePaths = [
      path.join(skillRoot, '.cache', 'quant_cache.db'),
      path.join(skillRoot, '.mypy_cache', 'state.bin'),
      path.join(skillRoot, '.ruff_cache', 'state.bin'),
      path.join(skillRoot, '__pycache__', 'module.pyc'),
      path.join(skillRoot, '.pytest_cache', 'state.bin'),
    ];
    for (const cachePath of cachePaths) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, Buffer.alloc(2 * 1024 * 1024 + 1));
    }
    fs.writeFileSync(
      path.join(skillRoot, '__pycache__', 'SKILL.md'),
      '---\nname: cached-copy\ndescription: must not become a workspace Skill\n---\n',
    );

    const first = scanLocalBotSkill(skillRoot);
    assert.deepEqual(first.files.map(file => file.path), ['SKILL.md']);
    assert.equal(cachePaths.every(cachePath => fs.existsSync(cachePath)), true);
    assert.equal(scanBotSkillWorkspace(path.dirname(skillRoot)).length, 1);

    fs.writeFileSync(cachePaths[0], Buffer.from('runtime cache changed'));
    const second = scanLocalBotSkill(skillRoot);
    assert.equal(second.contentHash, first.contentHash);
  });

  test('rejects unsafe reference segments and matches Go byte/control limits', async () => {
    for (const skillId of ['.', '..', 'owner/../skill', 'owner/./skill', 'owner//skill']) {
      assert.throws(() => canonicalizeBotSkillRefs([ref(skillId, 'v1')]), /unsafe Skill reference/i);
    }
    for (const version of ['.', '..']) {
      assert.throws(() => canonicalizeBotSkillRefs([ref('owner/skill', version)]), /unsafe Skill reference/i);
    }
    assert.throws(
      () => canonicalizeBotSkillRefs([ref('界'.repeat(81), 'v1')]),
      /invalid skillId/i,
    );
    assert.throws(
      () => canonicalizeBotSkillRefs([ref('owner/\u0085skill', 'v1')]),
      /invalid skillId/i,
    );
    assert.throws(
      () => canonicalizeBotSkillRefs([{ ...ref('owner/skill', 'v1'), contentHash: `sha256:${'a'.repeat(64)}` }]),
      /contentHash/i,
    );

    let requested = false;
    const client = createClient(async () => {
      requested = true;
      return Response.json({});
    });
    await assert.rejects(client.download(ref('owner/../skill', 'v1')), /invalid Skill reference/i);
    assert.equal(requested, false);
  });

  test('normalizes preferred install names and rejects Windows reserved names', async () => {
    const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-materialize-'));
    roots.push(skillsRoot);
    const client = createClient(async () => Response.json({}));

    const installed = await client.materialize(packageValue('nested-skill'), skillsRoot, 'group\\nested-skill');
    assert.equal(installed, path.join(skillsRoot, 'group', 'nested-skill'));
    assert.equal(fs.existsSync(path.join(installed, 'SKILL.md')), true);

    await assert.rejects(
      client.materialize(packageValue('reserved-skill'), skillsRoot, 'group/CON'),
      /unsafe install directory/i,
    );
    await assert.rejects(
      client.materialize(packageValue('reserved-root'), skillsRoot, 'NUL.txt'),
      /unsafe install directory/i,
    );
    await assert.rejects(
      client.materialize(packageValue('control-name'), skillsRoot, 'group/\u0085skill'),
      /unsafe install directory/i,
    );
  });

  test('falls back to a portable directory for a package name reserved on Windows', async () => {
    const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-materialize-'));
    roots.push(skillsRoot);
    const client = createClient(async () => Response.json({}));
    const installed = await client.materialize(packageValue('CON'), skillsRoot);
    assert.match(path.basename(installed), /^skill-[a-f0-9]{16}$/);
    assert.equal(fs.existsSync(path.join(installed, 'SKILL.md')), true);
  });

  test('uses a deterministic suffix when a preferred install directory is already occupied', async () => {
    const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-materialize-'));
    roots.push(skillsRoot);
    const client = createClient(async () => Response.json({}));
    const firstPackage = packageValue('shared-name');
    const secondPackage = {
      ...packageValue('shared-name'),
      reference: { skillId: 'private/shared-name-second', version: 'v1' },
      localSkillId: 'local:shared-name-second',
    };

    const first = await client.materialize(firstPackage, skillsRoot, 'shared-name');
    const second = await client.materialize(secondPackage, skillsRoot, 'shared-name');

    assert.equal(first, path.join(skillsRoot, 'shared-name'));
    const suffix = crypto.createHash('sha256')
      .update(secondPackage.localSkillId, 'utf8')
      .digest('hex')
      .slice(0, 12);
    assert.equal(second, path.join(skillsRoot, `shared-name-${suffix}`));
    assert.equal(fs.existsSync(path.join(first, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(second, 'SKILL.md')), true);
  });

  test('treats install directory names case-insensitively on every host platform', async () => {
    const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-materialize-'));
    roots.push(skillsRoot);
    const client = createClient(async () => Response.json({}));
    const firstPackage = packageValue('Shared-Name');
    const secondPackage = {
      ...packageValue('shared-name'),
      reference: { skillId: 'private/shared-name-second', version: 'v1' },
      localSkillId: 'local-shared-name-second',
    };

    const first = await client.materialize(firstPackage, skillsRoot, 'Shared-Name');
    const second = await client.materialize(secondPackage, skillsRoot, 'shared-name');

    assert.equal(first, path.join(skillsRoot, 'Shared-Name'));
    assert.notEqual(second, path.join(skillsRoot, 'shared-name'));
    assert.equal(fs.existsSync(path.join(first, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(second, 'SKILL.md')), true);
  });

  test('treats canonically equivalent install directory names as occupied on every host platform', async () => {
    const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-materialize-'));
    roots.push(skillsRoot);
    const client = createClient(async () => Response.json({}));
    const composedName = 'caf\u00e9-skill';
    const decomposedName = 'cafe\u0301-skill';
    const firstPackage = {
      ...packageValue(composedName),
      reference: { skillId: 'private/cafe-skill-first', version: 'v1' },
      localSkillId: 'local-cafe-skill-first',
    };
    const secondPackage = {
      ...packageValue(decomposedName),
      reference: { skillId: 'private/cafe-skill-second', version: 'v1' },
      localSkillId: 'local-cafe-skill-second',
    };

    const first = await client.materialize(firstPackage, skillsRoot, composedName);
    const second = await client.materialize(secondPackage, skillsRoot, decomposedName);

    assert.equal(first, path.join(skillsRoot, composedName));
    assert.notEqual(second, path.join(skillsRoot, decomposedName));
    assert.equal(fs.existsSync(path.join(first, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(second, 'SKILL.md')), true);
  });

  test('rejects a package whose verified hash differs from the Definition reference', async () => {
    const packageData = packageValue('hash-mismatch');
    const client = createClient(async () => Response.json(packageData));
    await assert.rejects(
      client.download({
        source: 'skillhub',
        ...packageData.reference,
        contentHash: '0'.repeat(64),
      }),
      /BotDefinition contentHash/i,
    );
  });
});

function ref(skillId: string, version: string, contentHash = 'a'.repeat(64)): BotSkillRef {
  return { source: 'skillhub', skillId, version, contentHash };
}

function createSkill(roots: string[], name: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-security-'));
  roots.push(parent);
  const skillRoot = path.join(parent, name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: security test\n---\n`,
  );
  return skillRoot;
}

function createClient(fetchImpl: typeof fetch): BotPrivateSkillClient {
  return new BotPrivateSkillClient({
    auth: {
      apiKey: 'test-key',
      httpBaseUrl: 'https://cats.test',
      serverUrl: 'wss://cats.test',
    },
    botId: 'bot-a',
    baseUrl: 'https://hub.test',
    fetchImpl,
  });
}

function packageValue(name: string): BotSkillPackage {
  const bytes = Buffer.from(`---\nname: ${name}\ndescription: materialize test\n---\n`, 'utf8');
  const file = {
    path: 'SKILL.md',
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64'),
  };
  const contentHash = crypto.createHash('sha256').update(Buffer.from(JSON.stringify([{
    path: file.path,
    size: file.size,
    sha256: file.sha256,
  }]), 'utf8')).digest('hex');
  return {
    schema: 'catsco.private-skill-package.v1',
    source: 'private',
    reference: { skillId: `private/${name.toLowerCase()}`, version: 'v1' },
    localSkillId: `local-${name.toLowerCase()}`,
    name,
    contentHash,
    createdAt: '2026-07-28T00:00:00.000Z',
    files: [file],
  };
}
