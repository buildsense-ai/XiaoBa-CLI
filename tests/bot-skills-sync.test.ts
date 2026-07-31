import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import type { BotDefinition, BotSkillRef } from '../src/bot-definition/types';
import { BotSkillBaseStore } from '../src/bot-skills/base-store';
import {
  readBotSkillLocalMarker,
  scanLocalBotSkill,
} from '../src/bot-skills/local-manifest';
import { BotSkillSyncService } from '../src/bot-skills/sync-service';
import type { BotSkillPackage, LocalBotSkillManifestEntry } from '../src/bot-skills/types';
import { readSkillHubInstallMarker } from '../src/skillhub/install-marker';

describe('Bot Skill Local/Base/Cloud sync', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('uploads local edits, keeps the Base stable, and restores cloud-only changes atomically', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'local v1');

    const first = await fixture.sync();
    assert.equal(first.direction, 'local_to_cloud');
    assert.equal(fixture.cloud.revision, 1);
    assert.equal(fixture.uploads, 1);
    assert.deepStrictEqual(fixture.definitionService.read(fixture.botId)?.skills, fixture.cloud.skills);
    assert.equal(new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId)?.definitionRevision, 1);

    const second = await fixture.sync();
    assert.equal(second.direction, 'none');
    assert.equal(fixture.uploads, 1);
    assert.equal(fixture.patches, 1);
    fs.writeFileSync(path.join(fixture.skillsRoot, 'workspace-notes.txt'), 'preserve me');
    fs.mkdirSync(path.join(fixture.skillsRoot, 'disabled'), { recursive: true });
    fs.writeFileSync(path.join(fixture.skillsRoot, 'disabled', 'SKILL.md.disabled'), 'disabled history');

    const external = createPackage(roots, 'cloud-b', 'cloud-b', 'cloud only');
    delete (external as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(external.reference), external);
    fixture.cloud = {
      revision: 2,
      skills: [definitionRef(external)],
    };

    const restored = await fixture.sync();
    assert.equal(restored.direction, 'cloud_to_local');
    assert.equal(fs.existsSync(path.join(fixture.skillsRoot, 'local-a')), false);
    assert.match(fs.readFileSync(path.join(fixture.skillsRoot, 'cloud-b', 'SKILL.md'), 'utf8'), /cloud only/);
    assert.equal(fs.readFileSync(path.join(fixture.skillsRoot, 'workspace-notes.txt'), 'utf8'), 'preserve me');
    assert.equal(
      fs.readFileSync(path.join(fixture.skillsRoot, 'disabled', 'SKILL.md.disabled'), 'utf8'),
      'disabled history',
    );
    assert.equal(readSkillHubInstallMarker(path.join(fixture.skillsRoot, 'cloud-b'))?.skillId, external.reference.skillId);
    assert.equal(new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId)?.definitionRevision, 2);
  });

  test('protects a local edit when Local and Cloud both changed and retries one Definition revision conflict', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'local v1');
    await fixture.sync();
    fs.writeFileSync(path.join(fixture.skillsRoot, 'local-a', 'SKILL.md'), skillText('local-a', 'local v2'));

    const external = createPackage(roots, 'cloud-b', 'cloud-b', 'cloud edit');
    fixture.packages.set(refKey(external.reference), external);
    fixture.cloud = {
      revision: 2,
      skills: [definitionRef(external)],
    };
    fixture.conflictNextPatch = true;

    const result = await fixture.sync();
    assert.equal(result.direction, 'local_to_cloud');
    assert.equal(fixture.cloud.revision, 4);
    assert.equal(fixture.patches, 3);
    assert.notDeepStrictEqual(fixture.cloud.skills, [definitionRef(external)]);
    assert.match(fs.readFileSync(path.join(fixture.skillsRoot, 'local-a', 'SKILL.md'), 'utf8'), /local v2/);
    assert.equal(
      fs.readdirSync(path.join(fixture.runtimeRoot, 'data', 'bot-skills', 'conflicts', fixture.botId)).length >= 1,
      true,
    );
  });

  test('does not restore Skills when only the unified Definition revision changed', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'stable local');
    await fixture.sync();
    const patches = fixture.patches;
    const marker = fs.readFileSync(
      path.join(fixture.skillsRoot, 'local-a', 'SKILL.md'),
      'utf8',
    );
    fixture.cloud = { ...fixture.cloud, revision: fixture.cloud.revision + 1 };

    const result = await fixture.sync();
    assert.equal(result.direction, 'none');
    assert.equal(fixture.patches, patches);
    assert.equal(
      new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId)?.definitionRevision,
      fixture.cloud.revision,
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.skillsRoot, 'local-a', 'SKILL.md'), 'utf8'),
      marker,
    );
  });

  test('keeps Local and Base unchanged when the cloud Definition omits Skills', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'stable local');
    await fixture.sync();
    const previousBase = new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId);
    const previousDefinition = fixture.definitionService.read(fixture.botId);
    fixture.omitSkillsField = true;

    const result = await fixture.sync();

    assert.equal(result.direction, 'feature_unavailable');
    assert.match(
      fs.readFileSync(path.join(fixture.skillsRoot, 'local-a', 'SKILL.md'), 'utf8'),
      /stable local/,
    );
    assert.deepStrictEqual(
      new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId),
      previousBase,
    );
    assert.deepStrictEqual(fixture.definitionService.read(fixture.botId), previousDefinition);
  });

  test('merges cloud Skills without overwriting pending local model or prompt fields', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'stable local');
    await fixture.sync();
    fixture.definitionService.updateModel(fixture.botId, {
      kind: 'catalog',
      modelId: 'gpt-5.6-sol',
    });
    fixture.definitionService.updatePrompt(fixture.botId, {
      selected: 'custom',
      customSystemPrompt: 'pending local prompt',
    });
    fixture.cloud = { ...fixture.cloud, revision: fixture.cloud.revision + 1 };

    const result = await fixture.sync();

    assert.equal(result.direction, 'none');
    assert.deepStrictEqual(fixture.definitionService.read(fixture.botId)?.model, {
      kind: 'catalog',
      modelId: 'gpt-5.6-sol',
    });
    assert.deepStrictEqual(fixture.definitionService.read(fixture.botId)?.prompt, {
      selected: 'custom',
      customSystemPrompt: 'pending local prompt',
    });
    assert.deepStrictEqual(
      fixture.definitionService.read(fixture.botId)?.skills,
      fixture.cloud.skills,
    );
  });

  test('treats explicit cloud skills: [] as deletion of all managed local Skills', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'managed local');
    await fixture.sync();
    fixture.cloud = {
      revision: fixture.cloud.revision + 1,
      skills: [],
    };

    const result = await fixture.sync();

    assert.equal(result.direction, 'cloud_to_local');
    assert.equal(fs.existsSync(path.join(fixture.skillsRoot, 'local-a')), false);
    assert.deepStrictEqual(fixture.definitionService.read(fixture.botId)?.skills, []);
    assert.deepStrictEqual(
      new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId)?.skills,
      [],
    );
  });

  test('accepts the complete cloud Definition during first bootstrap without a local Definition', async () => {
    const fixture = createFixture(roots, { initializeLocalDefinition: false });
    fixture.cloud = { revision: 1, skills: [] };
    fixture.cloudModel = { kind: 'catalog', modelId: 'cloud-model' };
    fixture.cloudPrompt = {
      selected: 'custom',
      customSystemPrompt: 'cloud bootstrap prompt',
    };

    const result = await fixture.sync();

    assert.equal(result.direction, 'none');
    assert.deepStrictEqual(fixture.definitionService.read(fixture.botId), {
      schema: 'xiaoba.bot-definition.v1',
      botId: fixture.botId,
      model: fixture.cloudModel,
      prompt: fixture.cloudPrompt,
      skills: [],
    });
  });

  test('uses the canonical workspace hash instead of a public package archive checksum', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'public-skill', 'public-skill', 'public package');
    const skillRoot = path.join(fixture.skillsRoot, 'public-skill');
    const archiveChecksum = 'f'.repeat(64);
    fs.writeFileSync(path.join(skillRoot, '.xiaoba-skillhub-install.json'), JSON.stringify({
      source: 'skillhub',
      skillId: 'public/public-skill',
      name: 'public-skill',
      installName: 'public-skill',
      version: '1.0.0',
      packageChecksumSha256: archiveChecksum,
      signature: {},
      packageUrl: 'https://hub.test/public-skill.skillpkg',
      installedAt: '2026-07-29T00:00:00.000Z',
    }));
    const scanned = scanLocalBotSkill(skillRoot, fixture.skillsRoot);

    assert.deepStrictEqual(scanned.origin, {
      skillId: 'public/public-skill',
      version: '1.0.0',
    });
    assert.equal(scanned.reference, undefined);
    assert.notEqual(scanned.contentHash, archiveChecksum);

    const result = await fixture.sync();

    assert.equal(result.direction, 'local_to_cloud');
    assert.equal(fixture.uploads, 1);
    assert.equal(fixture.cloud.skills[0]?.contentHash, scanned.contentHash);
    assert.equal(
      readBotSkillLocalMarker(skillRoot)?.reference?.contentHash,
      scanned.contentHash,
    );
    assert.deepStrictEqual(readBotSkillLocalMarker(skillRoot)?.origin, scanned.origin);
  });

  test('migrates a stale Draft marker that used a public package archive checksum', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'public-skill', 'public-skill', 'public package');
    const skillRoot = path.join(fixture.skillsRoot, 'public-skill');
    const archiveChecksum = 'f'.repeat(64);
    fs.writeFileSync(path.join(skillRoot, '.xiaoba-bot-skill.json'), JSON.stringify({
      schema: 'xiaoba.bot-skill-local.v1',
      localSkillId: 'legacy-public-local-id',
      reference: {
        source: 'skillhub',
        skillId: 'public/public-skill',
        version: '1.0.0',
        contentHash: archiveChecksum,
      },
      origin: {
        skillId: 'public/public-skill',
        version: '1.0.0',
      },
    }));

    const scanned = scanLocalBotSkill(skillRoot, fixture.skillsRoot);

    assert.equal(scanned.reference, undefined);
    assert.notEqual(scanned.contentHash, archiveChecksum);
    const result = await fixture.sync();
    assert.equal(result.direction, 'local_to_cloud');
    assert.equal(fixture.uploads, 1);
    assert.equal(
      readBotSkillLocalMarker(skillRoot)?.reference?.contentHash,
      scanned.contentHash,
    );
    assert.deepStrictEqual(readBotSkillLocalMarker(skillRoot)?.origin, scanned.origin);
  });

  test('does not replace a good local workspace or Base when a cloud package fails verification', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'safe local');
    await fixture.sync();
    const previousBase = new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId);
    const previousSkills = fixture.definitionService.read(fixture.botId)?.skills;

    const broken = createPackage(roots, 'cloud-b', 'cloud-b', 'broken cloud');
    broken.contentHash = '0'.repeat(64);
    fixture.packages.set(refKey(broken.reference), broken);
    fixture.cloud = {
      revision: 2,
      skills: [definitionRef(broken)],
    };

    await assert.rejects(fixture.sync(), /content hash does not match/i);
    assert.match(fs.readFileSync(path.join(fixture.skillsRoot, 'local-a', 'SKILL.md'), 'utf8'), /safe local/);
    assert.deepStrictEqual(new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId), previousBase);
    assert.deepStrictEqual(fixture.definitionService.read(fixture.botId)?.skills, previousSkills);
  });

  test('rejects credential files and high-confidence secrets before any upload request is built', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-sensitive-skill-'));
    roots.push(root);
    writeSkill(root, 'unsafe', 'unsafe', 'local only');
    fs.writeFileSync(path.join(root, 'unsafe', '.env'), 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz');
    assert.throws(
      () => scanLocalBotSkill(path.join(root, 'unsafe')),
      /sensitive material/i,
    );

    fs.rmSync(path.join(root, 'unsafe', '.env'));
    fs.writeFileSync(
      path.join(root, 'unsafe', 'config.txt'),
      'clientSecret: a-real-secret-value-that-must-not-leave-device',
    );
    assert.throws(
      () => scanLocalBotSkill(path.join(root, 'unsafe')),
      /sensitive material/i,
    );
  });

  test('restores a missing nested workspace from Cloud instead of uploading an empty list', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'group/nested', 'nested', 'nested local');
    await fixture.sync();
    assert.equal(fixture.cloud.revision, 1);
    assert.equal(
      new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId)?.skills[0]?.installName,
      'group/nested',
    );

    fs.rmSync(fixture.skillsRoot, { recursive: true, force: true });
    const result = await fixture.sync(false);
    assert.equal(result.direction, 'cloud_to_local');
    assert.equal(fixture.patches, 1);
    assert.match(
      fs.readFileSync(path.join(fixture.skillsRoot, 'group', 'nested', 'SKILL.md'), 'utf8'),
      /nested local/,
    );
  });

  test('recreates a missing cloud node from Local instead of treating revision zero as deletion', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'keep local');
    await fixture.sync();
    fixture.cloud = {
      revision: 0,
      skills: [],
    };

    const result = await fixture.sync();
    assert.equal(result.direction, 'local_to_cloud');
    assert.equal(fixture.cloud.revision, 1);
    assert.equal(fixture.cloud.skills.length, 1);
    assert.match(fs.readFileSync(path.join(fixture.skillsRoot, 'local-a', 'SKILL.md'), 'utf8'), /keep local/);
  });

  test('does not pretend a missing workspace is complete when the cloud manifest cannot be read', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'local');
    await fixture.sync();
    fixture.cloudReadStatus = 503;
    assert.equal((await fixture.sync()).direction, 'feature_unavailable');

    fs.rmSync(fixture.skillsRoot, { recursive: true, force: true });
    await assert.rejects(fixture.sync(false), /cloud unavailable/i);
    assert.equal(fs.existsSync(fixture.skillsRoot), false);
  });

  test('does not advance Base when recreating a missing cloud node fails', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'keep local');
    await fixture.sync();
    const previousBase = new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId);
    fixture.cloud = {
      revision: 0,
      skills: [],
    };
    fixture.patchStatus = 503;
    fs.rmSync(fixture.skillsRoot, { recursive: true, force: true });

    await assert.rejects(fixture.sync(false), /cloud patch unavailable/i);
    assert.deepStrictEqual(
      new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId),
      previousBase,
    );
    assert.equal(fs.existsSync(fixture.skillsRoot), false);
  });

  test('rejects unmanaged content that collides with a restored managed install path', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'safe local');
    await fixture.sync();
    const previousBase = new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId);

    const unmanaged = path.join(fixture.skillsRoot, 'cloud-b');
    fs.mkdirSync(unmanaged, { recursive: true });
    fs.writeFileSync(path.join(unmanaged, 'notes.txt'), 'must not merge into managed package');
    const external = createPackage(roots, 'cloud-b', 'cloud-b', 'cloud managed');
    fixture.packages.set(refKey(external.reference), external);
    fixture.cloud = {
      revision: 2,
      skills: [definitionRef(external)],
    };

    await assert.rejects(fixture.sync(), /unmanaged workspace content conflicts/i);
    assert.equal(
      fs.readFileSync(path.join(fixture.skillsRoot, 'cloud-b', 'notes.txt'), 'utf8'),
      'must not merge into managed package',
    );
    assert.match(
      fs.readFileSync(path.join(fixture.skillsRoot, 'local-a', 'SKILL.md'), 'utf8'),
      /safe local/,
    );
    assert.deepStrictEqual(
      new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId),
      previousBase,
    );
  });
});

function createFixture(
  roots: string[],
  options: { initializeLocalDefinition?: boolean } = {},
) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skills-runtime-'));
  const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skills-definition-'));
  roots.push(runtimeRoot, simulatedCloudRoot);
  const skillsRoot = path.join(runtimeRoot, 'skills');
  fs.mkdirSync(skillsRoot, { recursive: true });
  const botId = 'bot-a';
  const definitionService = createBotDefinitionSyncService({ runtimeRoot, simulatedCloudRoot });
  if (options.initializeLocalDefinition !== false) {
    definitionService.publish(botId, { kind: 'catalog', modelId: 'minimax-m3' });
  }
  const packages = new Map<string, BotSkillPackage>();
  let cloud = {
    revision: 0,
    skills: [] as BotSkillRef[],
  };
  const fixture = {
    runtimeRoot,
    skillsRoot,
    botId,
    definitionService,
    packages,
    cloud,
    uploads: 0,
    patches: 0,
    conflictNextPatch: false,
    cloudReadStatus: 200,
    patchStatus: 200,
    omitSkillsField: false,
    cloudModel: { kind: 'catalog', modelId: 'minimax-m3' } as BotDefinition['model'],
    cloudPrompt: { selected: 'default' } as NonNullable<BotDefinition['prompt']>,
    sync: async (workspaceExisted = true) => new BotSkillSyncService({
      runtimeRoot,
      skillsRoot,
      botId,
      workspaceExisted,
      auth: {
        apiKey: 'bot-key',
        httpBaseUrl: 'https://cats.test',
        serverUrl: 'wss://cats.test',
      },
      fetchImpl,
      skillHubBaseUrl: 'https://hub.test',
      definitionService,
    }).sync(),
  };

  async function fetchImpl(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.hostname === 'cats.test' && url.pathname === '/api/bot/definition' && method === 'GET') {
      if (fixture.cloudReadStatus !== 200) {
        return Response.json({ error: 'cloud unavailable' }, { status: fixture.cloudReadStatus });
      }
      const configured = fixture.cloud.revision > 0 || fixture.cloud.skills.length > 0;
      return Response.json(configured
        ? {
            configured: true,
            revision: fixture.cloud.revision,
            definition: {
              schema: 'xiaoba.bot-definition.v1',
              botId,
              model: fixture.cloudModel,
              prompt: fixture.cloudPrompt,
              ...(!fixture.omitSkillsField ? { skills: fixture.cloud.skills } : {}),
            },
          }
        : { configured: false, revision: fixture.cloud.revision });
    }
    if (url.hostname === 'cats.test' && url.pathname === '/api/bot/definition/skills') {
      if (method === 'GET') {
        return Response.json({ error: 'method not allowed' }, { status: 405 });
      }
      fixture.patches += 1;
      if (fixture.patchStatus !== 200) {
        return Response.json(
          { error: 'cloud patch unavailable' },
          { status: fixture.patchStatus },
        );
      }
      if (fixture.conflictNextPatch) {
        fixture.conflictNextPatch = false;
        fixture.cloud = {
          ...fixture.cloud,
          revision: fixture.cloud.revision + 1,
        };
        return Response.json(
          { error: 'stale', currentRevision: fixture.cloud.revision },
          { status: 409 },
        );
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.revision !== fixture.cloud.revision) {
        return Response.json({ error: 'stale' }, { status: 409 });
      }
      fixture.cloud = {
        revision: fixture.cloud.revision + 1,
        skills: body.skills,
      };
      return Response.json({ botId, skills: fixture.cloud.skills, revision: fixture.cloud.revision });
    }
    if (url.hostname === 'hub.test' && method === 'PUT' && url.pathname === '/api/bot/private-skill-packages') {
      assert.equal(new Headers(init?.headers).get('X-CatsCo-Bot-Id'), botId);
      fixture.uploads += 1;
      const body = JSON.parse(String(init?.body || '{}'));
      const reference = {
        skillId: `private/${body.localSkillId}`,
        version: `sha256-${String(body.contentHash).slice(0, 16)}`,
      };
      const packageValue: BotSkillPackage = {
        schema: 'catsco.private-skill-package.v1',
        reference,
        localSkillId: body.localSkillId,
        name: body.name,
        contentHash: body.contentHash,
        createdAt: new Date().toISOString(),
        ...(body.origin ? { origin: body.origin } : {}),
        files: body.files,
      };
      fixture.packages.set(refKey(reference), packageValue);
      return Response.json({
        reference,
        localSkillId: body.localSkillId,
        name: body.name,
        contentHash: body.contentHash,
      });
    }
    if (url.hostname === 'hub.test' && method === 'GET') {
      assert.equal(new Headers(init?.headers).get('X-CatsCo-Bot-Id'), botId);
      const packageValue = [...fixture.packages.values()].find(item => (
        url.pathname.includes(item.reference.version)
        && url.pathname.includes(item.reference.skillId.split('/').at(-1) || '')
      ));
      return packageValue
        ? Response.json(packageValue)
        : Response.json({ error: 'not found' }, { status: 404 });
    }
    return Response.json({ error: 'unexpected request' }, { status: 500 });
  }

  return fixture;
}

function writeSkill(root: string, directory: string, name: string, body: string): void {
  const skillRoot = path.join(root, directory);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), skillText(name, body));
}

function skillText(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: test\n---\n\n${body}\n`;
}

function createPackage(
  roots: string[],
  directory: string,
  name: string,
  body: string,
): BotSkillPackage {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cloud-package-'));
  roots.push(root);
  writeSkill(root, directory, name, body);
  const entry: LocalBotSkillManifestEntry = scanLocalBotSkill(path.join(root, directory));
  const reference = {
    skillId: `private/${entry.localSkillId}`,
    version: `sha256-${entry.contentHash.slice(0, 16)}`,
  };
  return {
    schema: 'catsco.private-skill-package.v1',
    reference,
    localSkillId: entry.localSkillId,
    name: entry.name,
    contentHash: entry.contentHash,
    createdAt: new Date().toISOString(),
    files: entry.files,
  };
}

function definitionRef(packageValue: BotSkillPackage): BotSkillRef {
  return {
    source: 'skillhub',
    ...packageValue.reference,
    contentHash: packageValue.contentHash,
  };
}

function refKey(reference: Pick<BotSkillRef, 'skillId' | 'version'>): string {
  return `${reference.skillId}@${reference.version}`;
}
