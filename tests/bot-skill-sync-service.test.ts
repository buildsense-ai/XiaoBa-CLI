import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileBotDefinitionRepository } from '../src/bot-definition/repository';
import { BOT_DEFINITION_SCHEMA, type BotDefinition } from '../src/bot-definition/types';
import { FileBotSkillSyncBaseStore } from '../src/bot-skills/base-store';
import {
  BotDefinitionCloudError,
  type BotDefinitionCloudClient,
} from '../src/bot-skills/definition-cloud';
import { FileBotDefinitionCloudClient } from '../src/bot-skills/file-definition-cloud';
import { FileBotPrivateSkillPackageClient } from '../src/bot-skills/file-private-package';
import { FileBotSkillPendingCommitStore } from '../src/bot-skills/pending-commit-store';
import { buildBotSkillSourceSnapshot } from '../src/bot-skills/source-snapshot';
import { BotSkillSyncService } from '../src/bot-skills/sync-service';
import { restoreBotSkillWorkspace } from '../src/bot-skills/workspace-restore';
import {
  BOT_LOCAL_SKILL_IDENTITY_FILE,
  BOT_SKILL_WORKSPACE_IDENTITY_FILE,
  BotSkillWorkspaceService,
} from '../src/bot-skills/workspace';
import { writeSkillHubInstallMarker } from '../src/skillhub/install-marker';

describe('Bot Skill Local/Base/Cloud synchronization', () => {
  let root: string;
  let runtimeRoot: string;
  let skillsRoot: string;
  let cloudRoot: string;
  let packageRoot: string;
  let nextId: number;
  const authority = 'https://cats.example/user-1';
  const owner = { botId: 'bot-a', authority };
  const definition: BotDefinition = {
    schema: BOT_DEFINITION_SCHEMA,
    botId: 'bot-a',
    model: { kind: 'catalog', modelId: 'model-a' },
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-sync-'));
    runtimeRoot = path.join(root, 'runtime');
    skillsRoot = path.join(runtimeRoot, 'skills');
    cloudRoot = path.join(root, 'definition-cloud');
    packageRoot = path.join(root, 'package-cloud');
    nextId = 1;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function workspace(): BotSkillWorkspaceService {
    return new BotSkillWorkspaceService({
      runtimeRoot,
      skillsRoot,
      createId: () => `id-${nextId++}`,
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });
  }

  function baseStore(): FileBotSkillSyncBaseStore {
    return new FileBotSkillSyncBaseStore({ runtimeRoot, authority });
  }

  function cloud(): FileBotDefinitionCloudClient {
    return new FileBotDefinitionCloudClient({ root: cloudRoot, botId: 'bot-a' });
  }

  function packages(botId = 'bot-a'): FileBotPrivateSkillPackageClient {
    return new FileBotPrivateSkillPackageClient({
      root: packageRoot,
      botId,
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });
  }

  function pendingStore(): FileBotSkillPendingCommitStore {
    return new FileBotSkillPendingCommitStore({ runtimeRoot, authority });
  }

  function syncService(
    cloudClient: BotDefinitionCloudClient = cloud(),
    definitionCache?: {
      readCache?(botId: string): BotDefinition | undefined;
      writeCache(definition: BotDefinition): void;
    },
  ): BotSkillSyncService {
    return new BotSkillSyncService({
      workspace: workspace(),
      baseStore: baseStore(),
      cloud: cloudClient,
      packages: packages(),
      definitionCache,
      pendingStore: pendingStore(),
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });
  }

  function writeSkill(directoryName: string, name = directoryName, body = 'initial'): string {
    const directory = path.join(skillsRoot, directoryName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), [
      '---',
      `name: ${name}`,
      `description: ${name} skill`,
      '---',
      '',
      `# ${name}`,
      '',
      body,
      '',
    ].join('\n'));
    return directory;
  }

  async function establishBase(): Promise<void> {
    writeSkill('alpha');
    workspace().claimExisting(owner);
    const result = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(result.action, 'created_cloud');
  }

  test('Skill-only cloud refresh locks the cache and preserves locally owned model and prompt fields', async () => {
    await establishBase();
    const localDefinition: BotDefinition = {
      ...definition,
      model: { kind: 'catalog', modelId: 'latest-local-model' },
      prompt: { selected: 'custom', customSystemPrompt: 'keep local prompt' },
    };
    let written: BotDefinition | undefined;
    let locked = false;

    const result = await syncService(cloud(), {
      withWriteLock: (_botId, operation) => {
        assert.equal(locked, false);
        locked = true;
        try {
          return operation();
        } finally {
          locked = false;
        }
      },
      readCache: () => {
        assert.equal(locked, true);
        return localDefinition;
      },
      writeCache: value => {
        assert.equal(locked, true);
        written = value;
      },
    }).sync({ owner, definitionForCreate: localDefinition });

    assert.equal(result.action, 'noop');
    assert.deepStrictEqual(written?.prompt, localDefinition.prompt);
    assert.deepStrictEqual(written?.model, localDefinition.model);
    assert.deepStrictEqual(written?.skills?.length, 1);
  });

  test('Skill cache repair falls back to canonical Definition when the cache is missing', async () => {
    await establishBase();
    const repository = new FileBotDefinitionRepository({
      runtimeRoot,
      simulatedCloudRoot: path.join(root, 'definition-canonical'),
    });
    repository.writeCanonical({
      ...definition,
      model: { kind: 'catalog', modelId: 'canonical-model' },
      prompt: { selected: 'custom', customSystemPrompt: 'canonical prompt' },
    });

    const result = await syncService(cloud(), repository).sync({
      owner,
      definitionForCreate: definition,
    });

    assert.equal(result.action, 'noop');
    assert.deepStrictEqual(repository.readCache('bot-a')?.model, {
      kind: 'catalog',
      modelId: 'canonical-model',
    });
    assert.deepStrictEqual(repository.readCache('bot-a')?.prompt, {
      selected: 'custom',
      customSystemPrompt: 'canonical prompt',
    });
    assert.deepStrictEqual(repository.readCache('bot-a')?.skills?.length, 1);
  });

  async function uploadRemoteVersion(name: string, localSkillId: string, body: string) {
    const source = path.join(root, `remote-${localSkillId}-${body.replace(/\W/g, '')}`);
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), [
      '---',
      `name: ${name}`,
      `description: ${name} remote`,
      '---',
      '',
      body,
      '',
    ].join('\n'));
    return packages().upsert({
      localSkillId,
      name,
      snapshot: buildBotSkillSourceSnapshot(source),
    });
  }

  test('does nothing when Local, Base, and Cloud agree', async () => {
    await establishBase();
    const beforeCloud = await cloud().read();
    const beforePackages = fs.readdirSync(path.dirname(packages().getPackagePath(
      (workspace().inspect(owner) as any).skills[0].localSkillId,
      (workspace().inspect(owner) as any).skills[0].contentHash,
    ))).length;

    const result = await syncService().sync({ owner, definitionForCreate: definition });

    assert.equal(result.action, 'noop');
    assert.deepStrictEqual(await cloud().read(), beforeCloud);
    assert.equal(fs.readdirSync(path.dirname(packages().getPackagePath(
      (workspace().inspect(owner) as any).skills[0].localSkillId,
      (workspace().inspect(owner) as any).skills[0].contentHash,
    ))).length, beforePackages);
  });

  test('uploads Local changes and uses Local priority when Cloud changed too', async () => {
    await establishBase();
    const initialCloud = await cloud().read();
    assert.equal(initialCloud.kind, 'found');
    if (initialCloud.kind !== 'found') return;
    const localInspection = workspace().inspect(owner);
    assert.equal(localInspection.kind, 'valid');
    if (localInspection.kind !== 'valid') return;
    const remote = await uploadRemoteVersion('alpha', 'remote-alpha', 'remote change');
    await cloud().patchSkills([remote.reference], initialCloud.etag);
    fs.appendFileSync(localInspection.skills[0].skillFilePath, '\nlocal change\n');

    const result = await syncService().sync({ owner, definitionForCreate: definition });

    assert.equal(result.action, 'uploaded');
    const finalCloud = await cloud().read();
    assert.equal(finalCloud.kind, 'found');
    if (finalCloud.kind === 'found') {
      assert.notDeepStrictEqual(finalCloud.definition.skills, [remote.reference]);
      assert.match(finalCloud.definition.skills?.[0].skillId || '', /^priv_[a-f0-9]{40}$/);
      assert.doesNotMatch(finalCloud.definition.skills?.[0].skillId || '', new RegExp(localInspection.skills[0].localSkillId));
    }
  });

  test('downloads Cloud changes only when Local still matches Base', async () => {
    await establishBase();
    const initialCloud = await cloud().read();
    assert.equal(initialCloud.kind, 'found');
    if (initialCloud.kind !== 'found') return;
    const remote = await uploadRemoteVersion('alpha', 'remote-alpha', 'cloud wins');
    await cloud().patchSkills([remote.reference], initialCloud.etag);

    const result = await syncService().sync({ owner, definitionForCreate: definition });

    assert.equal(result.action, 'downloaded');
    assert.match(fs.readFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'), /cloud wins/);
    const next = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(next.action, 'noop');
  });

  test('restores a missing workspace from Cloud and treats an explicit empty Cloud list as valid', async () => {
    await establishBase();
    fs.rmSync(skillsRoot, { recursive: true, force: true });
    const restored = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(restored.action, 'downloaded');
    assert.equal(fs.existsSync(path.join(skillsRoot, 'alpha', 'SKILL.md')), true);

    const currentCloud = await cloud().read();
    assert.equal(currentCloud.kind, 'found');
    if (currentCloud.kind !== 'found') return;
    await cloud().patchSkills([], currentCloud.etag);
    const pulledEmpty = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(pulledEmpty.action, 'downloaded');
    const inspection = workspace().inspect(owner);
    assert.equal(inspection.kind === 'valid' && inspection.skills.length, 0);
  });

  test('uploads a valid empty Local workspace as deletion of all Skill references', async () => {
    await establishBase();
    const inspection = workspace().inspect(owner);
    assert.equal(inspection.kind, 'valid');
    if (inspection.kind !== 'valid') return;
    fs.rmSync(inspection.skills[0].directoryPath, { recursive: true, force: true });

    const result = await syncService().sync({ owner, definitionForCreate: definition });

    assert.equal(result.action, 'uploaded');
    const finalCloud = await cloud().read();
    assert.equal(finalCloud.kind === 'found' && finalCloud.definition.skills?.length, 0);
    const base = baseStore().read('bot-a', inspection.identity.workspaceId);
    assert.equal(base.kind === 'valid' && base.base.entries.length, 0);
  });

  test('partially advances safe Skills while sensitive Skills remain local and dirty', async () => {
    await establishBase();
    const inspection = workspace().inspect(owner);
    assert.equal(inspection.kind, 'valid');
    if (inspection.kind !== 'valid') return;
    fs.appendFileSync(inspection.skills[0].skillFilePath, '\nsafe update\n');
    const sensitive = writeSkill('sensitive');
    fs.writeFileSync(path.join(sensitive, '.env'), 'API_KEY=sk-proj-1234567890abcdefghijklmnop\n');

    const result = await syncService().sync({ owner, definitionForCreate: definition });

    assert.equal(result.action, 'uploaded');
    assert.equal(result.blockedSkills?.length, 1);
    assert.equal(result.blockedSkills?.[0].code, 'SKILL_SOURCE_SENSITIVE');
    assert.deepStrictEqual(result.blockedSkills?.[0].relativePaths, ['.env']);
    const finalCloud = await cloud().read();
    assert.equal(finalCloud.kind === 'found' && finalCloud.definition.skills?.length, 1);
    const again = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(again.action, 'uploaded');
    assert.equal(again.blockedSkills?.[0].code, 'SKILL_SOURCE_SENSITIVE');
  });

  test('does not advance Base when Definition PATCH fails or the ETag is stale', async () => {
    await establishBase();
    const inspection = workspace().inspect(owner);
    assert.equal(inspection.kind, 'valid');
    if (inspection.kind !== 'valid') return;
    const originalBase = baseStore().read('bot-a', inspection.identity.workspaceId);
    fs.appendFileSync(inspection.skills[0].skillFilePath, '\nchanged\n');
    const realCloud = cloud();
    const failingCloud: BotDefinitionCloudClient = {
      read: () => realCloud.read(),
      create: definition => realCloud.create(definition),
      patchSkills: async () => {
        throw new BotDefinitionCloudError('failed', 'TEST_PATCH_FAILED', 500);
      },
    };

    const failed = await syncService(failingCloud).sync({ owner, definitionForCreate: definition });
    assert.equal(failed.action, 'degraded_local');
    assert.deepStrictEqual(baseStore().read('bot-a', inspection.identity.workspaceId), originalBase);

    const staleCloud: BotDefinitionCloudClient = {
      read: () => realCloud.read(),
      create: definition => realCloud.create(definition),
      patchSkills: async () => {
        throw new BotDefinitionCloudError('stale', 'BOT_DEFINITION_PRECONDITION_FAILED', 412);
      },
    };
    const stale = await syncService(staleCloud).sync({ owner, definitionForCreate: definition });
    assert.equal(stale.action, 'degraded_local');
    assert.equal(stale.reason, 'CLOUD_ETAG_CONFLICT');
    assert.deepStrictEqual(baseStore().read('bot-a', inspection.identity.workspaceId), originalBase);
  });

  test('re-reads Cloud and retries a local-priority upload once after an ETag race', async () => {
    await establishBase();
    const inspection = workspace().inspect(owner);
    assert.equal(inspection.kind, 'valid');
    if (inspection.kind !== 'valid') return;
    fs.appendFileSync(inspection.skills[0].skillFilePath, '\nlocal edit during model race\n');
    const realCloud = cloud();
    let firstPatch = true;
    const racingCloud: BotDefinitionCloudClient = {
      read: () => realCloud.read(),
      create: value => realCloud.create(value),
      patchSkills: async (skills, etag) => {
        if (firstPatch) {
          firstPatch = false;
          const current = await realCloud.read();
          assert.equal(current.kind, 'found');
          if (current.kind !== 'found') throw new Error('cloud missing');
          await realCloud.patchSkills(current.definition.skills || [], current.etag);
          throw new BotDefinitionCloudError('stale', 'BOT_DEFINITION_PRECONDITION_FAILED', 412);
        }
        return realCloud.patchSkills(skills, etag);
      },
    };

    const result = await syncService(racingCloud).sync({ owner, definitionForCreate: definition });
    assert.equal(result.action, 'uploaded');
    const finalCloud = await realCloud.read();
    assert.equal(finalCloud.kind, 'found');
    assert.equal(finalCloud.kind === 'found' && finalCloud.definition.skills?.length, 1);
  });

  test('keeps a downloaded workspace and Base committed when Definition cache repair fails', async () => {
    await establishBase();
    const currentCloud = await cloud().read();
    assert.equal(currentCloud.kind, 'found');
    if (currentCloud.kind !== 'found') return;
    const remote = await uploadRemoteVersion('alpha', 'remote-cache-failure', 'cloud survives cache failure');
    await cloud().patchSkills([remote.reference], currentCloud.etag);

    const result = await syncService(cloud(), {
      writeCache: () => { throw new Error('cache directory is read-only'); },
    }).sync({ owner, definitionForCreate: definition });

    assert.equal(result.action, 'downloaded');
    assert.match(fs.readFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'), /cloud survives cache failure/);
    const inspection = workspace().inspect(owner);
    assert.equal(inspection.kind, 'valid');
    if (inspection.kind === 'valid') {
      assert.equal(baseStore().read('bot-a', inspection.identity.workspaceId).kind, 'valid');
    }
  });

  test('recovers Base when Cloud committed but the client lost the response', async () => {
    await establishBase();
    const inspection = workspace().inspect(owner);
    assert.equal(inspection.kind, 'valid');
    if (inspection.kind !== 'valid') return;
    const originalBase = baseStore().read('bot-a', inspection.identity.workspaceId);
    fs.appendFileSync(inspection.skills[0].skillFilePath, '\ncommit then disconnect\n');
    const realCloud = cloud();
    const lostResponseCloud: BotDefinitionCloudClient = {
      read: () => realCloud.read(),
      create: definition => realCloud.create(definition),
      patchSkills: async (skills, etag) => {
        await realCloud.patchSkills(skills, etag);
        const error: any = new Error('connection reset after commit');
        error.code = 'BOT_DEFINITION_NETWORK_ERROR';
        error.status = 503;
        throw error;
      },
    };

    const first = await syncService(lostResponseCloud).sync({ owner, definitionForCreate: definition });
    assert.equal(first.action, 'degraded_local');
    assert.deepStrictEqual(baseStore().read('bot-a', inspection.identity.workspaceId), originalBase);
    assert.equal(fs.existsSync(pendingStore().getPath()), true);

    const recovered = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(recovered.action, 'noop');
    assert.equal(fs.existsSync(pendingStore().getPath()), false);
    const finalBase = baseStore().read('bot-a', inspection.identity.workspaceId);
    assert.equal(finalBase.kind, 'valid');
    if (finalBase.kind === 'valid') {
      assert.notDeepStrictEqual(finalBase.base.entries, (originalBase as any).base.entries);
    }
  });

  test('stops on corrupt or unknown Base and degrades locally on Cloud outage', async () => {
    await establishBase();
    const inspection = workspace().inspect(owner);
    assert.equal(inspection.kind, 'valid');
    if (inspection.kind !== 'valid') return;
    fs.writeFileSync(baseStore().getPath('bot-a'), '{broken');
    const corrupt = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(corrupt.action, 'conflict');
    assert.equal(corrupt.reason, 'BASE_CORRUPT');

    const offlineCloud: BotDefinitionCloudClient = {
      read: async () => { throw new Error('offline'); },
      create: async () => { throw new Error('offline'); },
      patchSkills: async () => { throw new Error('offline'); },
    };
    const offline = await syncService(offlineCloud).sync({ owner, definitionForCreate: definition });
    assert.equal(offline.action, 'degraded_local');

    fs.rmSync(baseStore().getPath('bot-a'));
    const unknown = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(unknown.action, 'conflict');
    assert.equal(unknown.reason, 'BASE_UNKNOWN_CONFLICT');
  });

  test('repairs a missing Base only through an explicit local-wins or cloud-wins choice', async () => {
    await establishBase();
    const inspection = workspace().inspect(owner);
    assert.equal(inspection.kind, 'valid');
    if (inspection.kind !== 'valid') return;
    const currentCloud = await cloud().read();
    assert.equal(currentCloud.kind, 'found');
    if (currentCloud.kind !== 'found') return;

    const remote = await uploadRemoteVersion('alpha', 'remote-alpha', 'cloud repair choice');
    await cloud().patchSkills([remote.reference], currentCloud.etag);
    fs.appendFileSync(inspection.skills[0].skillFilePath, '\nlocal repair choice\n');
    fs.rmSync(baseStore().getPath('bot-a'));

    const unresolved = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(unresolved.action, 'conflict');
    assert.equal(unresolved.reason, 'BASE_UNKNOWN_CONFLICT');

    const localRepair = await syncService().repair(
      { owner, definitionForCreate: definition },
      'local-wins',
    );
    assert.equal(localRepair.action, 'uploaded');
    assert.equal(localRepair.reason, 'BASE_REPAIRED_LOCAL_WINS');
    const afterLocalCloud = await cloud().read();
    assert.equal(afterLocalCloud.kind, 'found');
    if (afterLocalCloud.kind !== 'found') return;
    assert.notDeepStrictEqual(afterLocalCloud.definition.skills, [remote.reference]);
    assert.equal(baseStore().read('bot-a', inspection.identity.workspaceId).kind, 'valid');

    const secondRemote = await uploadRemoteVersion('alpha', 'remote-alpha-2', 'second cloud choice');
    await cloud().patchSkills([secondRemote.reference], afterLocalCloud.etag);
    fs.appendFileSync(inspection.skills[0].skillFilePath, '\nsecond local choice\n');
    fs.rmSync(baseStore().getPath('bot-a'));

    const cloudRepair = await syncService().repair(
      { owner, definitionForCreate: definition },
      'cloud-wins',
    );
    assert.equal(cloudRepair.action, 'downloaded');
    assert.equal(cloudRepair.reason, 'BASE_REPAIRED_CLOUD_WINS');
    assert.match(
      fs.readFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'),
      /second cloud choice/,
    );
    const repairedInspection = workspace().inspect(owner);
    assert.equal(repairedInspection.kind, 'valid');
    if (repairedInspection.kind === 'valid') {
      assert.equal(baseStore().read('bot-a', repairedInspection.identity.workspaceId).kind, 'valid');
    }
  });

  test('does not partially overwrite Cloud when local-wins repair cannot upload every Skill', async () => {
    writeSkill('alpha');
    writeSkill('blocked');
    const inspection = workspace().claimExisting(owner);
    const originalCloud = await cloud().create({ ...definition, skills: [] });
    const realPackages = packages();
    const failingPackages = {
      download: realPackages.download.bind(realPackages),
      upsert: async (input: any) => {
        if (input.name === 'blocked') {
          const error: any = new Error('sensitive package');
          error.code = 'PRIVATE_SKILL_SENSITIVE_REJECTED';
          throw error;
        }
        return realPackages.upsert(input);
      },
    };
    const service = new BotSkillSyncService({
      workspace: workspace(),
      baseStore: baseStore(),
      cloud: cloud(),
      packages: failingPackages,
      pendingStore: pendingStore(),
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });

    const repaired = await service.repair(
      { owner, definitionForCreate: definition },
      'local-wins',
    );
    assert.equal(repaired.action, 'blocked');
    assert.equal(repaired.reason, 'SYNC_REPAIR_LOCAL_SKILLS_BLOCKED');
    assert.deepStrictEqual(repaired.blockedSkills?.map(item => item.name), ['blocked']);
    assert.deepStrictEqual(await cloud().read(), { kind: 'found', ...originalCloud });
    assert.equal(baseStore().read('bot-a', inspection.workspaceId).kind, 'missing');
  });

  test('cloud-wins repair refuses to activate a Cloud snapshot that changed during download', async () => {
    await establishBase();
    const inspection = workspace().inspect(owner);
    assert.equal(inspection.kind, 'valid');
    if (inspection.kind !== 'valid') return;
    const initialCloud = await cloud().read();
    assert.equal(initialCloud.kind, 'found');
    if (initialCloud.kind !== 'found') return;
    const firstRemote = await uploadRemoteVersion('alpha', 'remote-first', 'first remote');
    const firstCloud = await cloud().patchSkills([firstRemote.reference], initialCloud.etag);
    const secondRemote = await uploadRemoteVersion('alpha', 'remote-second', 'second remote');
    fs.appendFileSync(inspection.skills[0].skillFilePath, '\nkeep this local copy\n');
    fs.rmSync(baseStore().getPath('bot-a'));
    const realCloud = cloud();
    let reads = 0;
    const racingCloud: BotDefinitionCloudClient = {
      read: async () => {
        reads += 1;
        if (reads === 1) return realCloud.read();
        await realCloud.patchSkills([secondRemote.reference], firstCloud.etag);
        return realCloud.read();
      },
      create: value => realCloud.create(value),
      patchSkills: (skills, etag) => realCloud.patchSkills(skills, etag),
    };

    const repaired = await syncService(racingCloud).repair(
      { owner, definitionForCreate: definition },
      'cloud-wins',
    );
    assert.equal(repaired.action, 'degraded_local');
    assert.equal(repaired.reason, 'CLOUD_CHANGED_DURING_DOWNLOAD');
    assert.match(fs.readFileSync(inspection.skills[0].skillFilePath, 'utf8'), /keep this local copy/);
    assert.equal(baseStore().read('bot-a', inspection.identity.workspaceId).kind, 'missing');
  });

  test('explicitly claims and migrates a legacy local workspace only when Cloud lacks skills', async () => {
    writeSkill('legacy');
    await cloud().create(definition);

    const blocked = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(blocked.action, 'conflict');
    assert.equal(fs.existsSync(path.join(skillsRoot, 'legacy', BOT_LOCAL_SKILL_IDENTITY_FILE)), false);

    const migrated = await syncService().sync({
      owner,
      definitionForCreate: definition,
      allowLegacyClaim: true,
    });
    assert.equal(migrated.action, 'migrated');
    assert.equal(fs.existsSync(path.join(skillsRoot, 'legacy', BOT_LOCAL_SKILL_IDENTITY_FILE)), true);
    const finalCloud = await cloud().read();
    assert.equal(finalCloud.kind === 'found' && finalCloud.definition.skills?.length, 1);
  });

  test('initializes a default Skill once only for an explicit new Bot flow', async () => {
    let initializationCount = 0;
    const created = await syncService().sync({
      owner,
      definitionForCreate: definition,
      allowNewWorkspaceCreate: true,
      initializeNewWorkspace: async () => {
        initializationCount += 1;
        writeSkill('default-skill');
      },
    });
    assert.equal(created.action, 'created_cloud');
    assert.equal(initializationCount, 1);
    const createdCloud = await cloud().read();
    assert.equal(createdCloud.kind === 'found' && createdCloud.definition.skills?.length, 1);

    const second = await syncService().sync({
      owner,
      definitionForCreate: definition,
      allowNewWorkspaceCreate: true,
      initializeNewWorkspace: async () => {
        initializationCount += 1;
      },
    });
    assert.equal(second.action, 'noop');
    assert.equal(initializationCount, 1);
  });

  test('retries failed new-Bot default initialization before creating Cloud', async () => {
    let initializationCount = 0;
    await cloud().create(definition);
    await assert.rejects(
      syncService().sync({
        owner,
        definitionForCreate: definition,
        allowNewWorkspaceCreate: true,
        initializeNewWorkspace: async () => {
          initializationCount += 1;
          throw new Error('temporary default package outage');
        },
      }),
      /temporary default package outage/,
    );
    const legacyCloud = await cloud().read();
    assert.equal(legacyCloud.kind, 'found');
    assert.equal(legacyCloud.kind === 'found' && legacyCloud.definition.skills, undefined);
    assert.equal(workspace().inspect(owner).kind, 'valid');

    const recovered = await syncService().sync({
      owner,
      definitionForCreate: definition,
      allowNewWorkspaceCreate: true,
      initializeNewWorkspace: async () => {
        initializationCount += 1;
        writeSkill('default-after-retry');
      },
    });
    assert.equal(recovered.action, 'created_cloud');
    assert.equal(initializationCount, 2);
    const finalCloud = await cloud().read();
    assert.equal(finalCloud.kind === 'found' && finalCloud.definition.skills?.length, 1);
  });

  test('keeps an unchanged SkillHub reference and forks it privately after a local edit', async () => {
    const source = path.join(root, 'public-source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), [
      '---',
      'name: public-skill',
      'description: public skill',
      '---',
      '',
      '# public-skill',
      '',
    ].join('\n'));
    const published = await packages().upsert({
      localSkillId: 'public-source-id',
      name: 'public-skill',
      snapshot: buildBotSkillSourceSnapshot(source),
    });
    fs.cpSync(source, path.join(skillsRoot, 'public-skill'), { recursive: true });
    writeSkillHubInstallMarker(path.join(skillsRoot, 'public-skill'), {
      source: 'skillhub',
      skillId: published.reference.skillId,
      name: 'public-skill',
      installName: 'public-skill',
      version: published.reference.version,
      packageChecksumSha256: published.contentHash,
      signature: {
        algorithm: 'ed25519',
        keyId: 'test-key',
        value: 'test-signature',
      },
      packageUrl: 'https://skillhub.example/public-skill.tgz',
      installedAt: '2026-07-24T00:00:00.000Z',
    });
    workspace().claimExisting(owner);

    const initial = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(initial.action, 'created_cloud');
    const initialCloud = await cloud().read();
    assert.equal(initialCloud.kind, 'found');
    if (initialCloud.kind !== 'found') return;
    assert.deepStrictEqual(initialCloud.definition.skills, [published.reference]);

    fs.appendFileSync(path.join(skillsRoot, 'public-skill', 'SKILL.md'), '\nlocal fork\n');
    const forked = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(forked.action, 'uploaded');
    const forkedCloud = await cloud().read();
    assert.equal(forkedCloud.kind, 'found');
    if (forkedCloud.kind === 'found') {
      assert.notDeepStrictEqual(forkedCloud.definition.skills, [published.reference]);
      assert.match(forkedCloud.definition.skills?.[0].skillId || '', /^priv_[a-f0-9]{40}$/);
    }
  });

  test('recovers a restore interrupted before and just after target activation', async () => {
    await establishBase();
    const oldInspection = workspace().inspect(owner);
    assert.equal(oldInspection.kind, 'valid');
    if (oldInspection.kind !== 'valid') return;
    const oldWorkspaceId = oldInspection.identity.workspaceId;
    const currentCloud = await cloud().read();
    assert.equal(currentCloud.kind, 'found');
    if (currentCloud.kind !== 'found') return;
    const remote = await uploadRemoteVersion('alpha', 'remote-alpha', 'restored cloud content');
    const nextCloud = await cloud().patchSkills([remote.reference], currentCloud.etag);

    const stagingRoot = path.join(runtimeRoot, '.bot-skill-restore-crash');
    const backupRoot = path.join(runtimeRoot, '.bot-skill-backup-crash');
    const staged = await restoreBotSkillWorkspace({
      skillsRoot: stagingRoot,
      owner,
      references: [remote.reference],
      packageClient: packages(),
    });
    const writePending = (phase: 'prepared' | 'old_parked') => pendingStore().write({
      schema: 'xiaoba.bot-skill-pending-commit.v1',
      kind: 'restore',
      phase,
      botId: owner.botId,
      workspaceId: staged.identity.workspaceId,
      authority,
      cloudReferences: [remote.reference],
      entries: staged.entries,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      restore: {
        activeRoot: skillsRoot,
        stagingRoot,
        backupRoot,
        hadActive: true,
      },
    });

    writePending('prepared');
    const resumedBeforeRename = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(resumedBeforeRename.action, 'noop');
    assert.match(fs.readFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'), /restored cloud content/);
    assert.equal(fs.existsSync(backupRoot), false);
    assert.equal(fs.existsSync(pendingStore().getPath()), false);

    fs.renameSync(skillsRoot, stagingRoot);
    const oldRoot = path.join(root, 'old-workspace-rebuilt');
    const oldWorkspace = new BotSkillWorkspaceService({
      skillsRoot: oldRoot,
      createId: () => oldWorkspaceId,
    });
    oldWorkspace.initializeEmpty(owner);
    fs.mkdirSync(path.join(oldRoot, 'alpha'));
    fs.writeFileSync(path.join(oldRoot, 'alpha', 'SKILL.md'), [
      '---', 'name: alpha', 'description: alpha skill', '---', '', 'old local content', '',
    ].join('\n'));
    oldWorkspace.inspect(owner);
    fs.renameSync(oldRoot, backupRoot);
    fs.renameSync(stagingRoot, skillsRoot);
    writePending('old_parked');

    const resumedAfterRename = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(resumedAfterRename.action, 'noop');
    assert.equal(resumedAfterRename.definitionETag, nextCloud.etag);
    assert.match(fs.readFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'), /restored cloud content/);
    assert.equal(fs.existsSync(backupRoot), false);
    assert.equal(fs.existsSync(pendingStore().getPath()), false);

    const c1Base = baseStore().read('bot-a', staged.identity.workspaceId);
    assert.equal(c1Base.kind, 'valid');
    if (c1Base.kind !== 'valid') return;
    const remoteC2 = await uploadRemoteVersion('alpha', 'remote-alpha-c2', 'newer cloud content');
    const cloudBeforeC2 = await cloud().read();
    assert.equal(cloudBeforeC2.kind, 'found');
    if (cloudBeforeC2.kind !== 'found') return;
    await cloud().patchSkills([remoteC2.reference], cloudBeforeC2.etag);
    fs.cpSync(skillsRoot, backupRoot, { recursive: true });
    fs.writeFileSync(path.join(backupRoot, 'alpha', 'SKILL.md'), [
      '---', 'name: alpha', 'description: alpha skill', '---', '', 'obsolete backup content', '',
    ].join('\n'));
    pendingStore().write({
      schema: 'xiaoba.bot-skill-pending-commit.v1',
      kind: 'restore',
      phase: 'base_committed',
      botId: owner.botId,
      workspaceId: staged.identity.workspaceId,
      authority,
      definitionETag: nextCloud.etag,
      cloudReferences: [remote.reference],
      entries: c1Base.base.entries,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      restore: {
        activeRoot: skillsRoot,
        stagingRoot,
        backupRoot,
        hadActive: true,
      },
    });

    const resumedAfterCloudAdvanced = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(resumedAfterCloudAdvanced.action, 'downloaded');
    assert.match(fs.readFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'), /newer cloud content/);
    assert.doesNotMatch(fs.readFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'), /obsolete backup/);
    assert.equal(fs.existsSync(backupRoot), false);
    assert.equal(fs.existsSync(pendingStore().getPath()), false);

    const c2Inspection = workspace().inspect(owner);
    assert.equal(c2Inspection.kind, 'valid');
    if (c2Inspection.kind !== 'valid') return;
    const c2Base = baseStore().read('bot-a', c2Inspection.identity.workspaceId);
    assert.equal(c2Base.kind, 'valid');
    if (c2Base.kind !== 'valid') return;
    const cloudAtC2 = await cloud().read();
    assert.equal(cloudAtC2.kind, 'found');
    if (cloudAtC2.kind !== 'found') return;
    const remoteC3 = await uploadRemoteVersion('alpha', 'remote-alpha-c3', 'third cloud content');
    await cloud().patchSkills([remoteC3.reference], cloudAtC2.etag);
    fs.cpSync(skillsRoot, backupRoot, { recursive: true });
    fs.appendFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), '\noffline local edit must survive\n');
    pendingStore().write({
      schema: 'xiaoba.bot-skill-pending-commit.v1',
      kind: 'restore',
      phase: 'base_committed',
      botId: owner.botId,
      workspaceId: c2Inspection.identity.workspaceId,
      authority,
      definitionETag: cloudAtC2.etag,
      cloudReferences: [remoteC2.reference],
      entries: c2Base.base.entries,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      restore: {
        activeRoot: skillsRoot,
        stagingRoot,
        backupRoot,
        hadActive: true,
      },
    });

    const resumedWithOfflineEdit = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(resumedWithOfflineEdit.action, 'uploaded');
    assert.match(fs.readFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'), /offline local edit must survive/);
    const cloudAfterOfflineEdit = await cloud().read();
    assert.equal(cloudAfterOfflineEdit.kind, 'found');
    if (cloudAfterOfflineEdit.kind === 'found') {
      assert.notDeepStrictEqual(cloudAfterOfflineEdit.definition.skills, [remoteC3.reference]);
    }
    assert.equal(fs.existsSync(backupRoot), false);
    assert.equal(fs.existsSync(pendingStore().getPath()), false);

    const finalInspection = workspace().inspect(owner);
    assert.equal(finalInspection.kind, 'valid');
    if (finalInspection.kind !== 'valid') return;
    const finalBase = baseStore().read('bot-a', finalInspection.identity.workspaceId);
    assert.equal(finalBase.kind, 'valid');
    if (finalBase.kind !== 'valid') return;
    const finalCloud = await cloud().read();
    assert.equal(finalCloud.kind, 'found');
    if (finalCloud.kind !== 'found') return;
    const remoteC4 = await uploadRemoteVersion('alpha', 'remote-alpha-c4', 'fourth cloud content');
    await cloud().patchSkills([remoteC4.reference], finalCloud.etag);
    fs.cpSync(skillsRoot, backupRoot, { recursive: true });
    pendingStore().write({
      schema: 'xiaoba.bot-skill-pending-commit.v1',
      kind: 'restore',
      phase: 'base_committed',
      botId: owner.botId,
      workspaceId: finalInspection.identity.workspaceId,
      authority,
      definitionETag: finalCloud.etag,
      cloudReferences: finalBase.base.entries.map(entry => ({
        skillId: entry.cloudSkillId,
        version: entry.cloudVersion,
      })),
      entries: finalBase.base.entries,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      restore: {
        activeRoot: skillsRoot,
        stagingRoot,
        backupRoot,
        hadActive: true,
      },
    });
    fs.writeFileSync(path.join(skillsRoot, BOT_SKILL_WORKSPACE_IDENTITY_FILE), '{broken');

    const blockedUnreadable = await syncService().sync({ owner, definitionForCreate: definition });
    assert.equal(blockedUnreadable.action, 'blocked');
    assert.equal(blockedUnreadable.reason, 'PENDING_RESTORE_ACTIVE_UNSAFE');
    assert.match(fs.readFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'), /offline local edit must survive/);
    assert.equal(fs.existsSync(backupRoot), true);
    assert.equal(fs.existsSync(pendingStore().getPath()), true);
  });
});
