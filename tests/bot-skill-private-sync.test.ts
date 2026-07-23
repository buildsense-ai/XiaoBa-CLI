import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FileBotDefinitionRepository } from '../src/bot-definition/repository';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import { BOT_DEFINITION_SCHEMA, type BotSkillRef } from '../src/bot-definition/types';
import type {
  BotSkillArtifactTransport,
  BotSkillArtifactTransportContext,
  BotSkillPrivateUploadInput,
} from '../src/bot-skills/artifact-transport';
import { FileSimulatedSkillArtifactStore, type SimulatedSkillArtifact } from '../src/bot-skills/simulated-artifact-store';
import { SkillHubBotSkillArtifactTransport } from '../src/bot-skills/skillhub-artifact-transport';
import { scanLocalSkillManifest } from '../src/bot-skills/local-manifest';
import { FileBotSkillSyncBaseRepository } from '../src/bot-skills/sync-base';
import { BotSkillSyncError, createBotSkillSyncService } from '../src/bot-skills/sync-service';
import { createBotSkillWorkspaceService } from '../src/bot-skills/workspace-service';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { computeLocalSkillContentHash } from '../src/skillhub/local-skill-metadata';
import { writeSkillHubInstallMarker } from '../src/skillhub/install-marker';

describe('Bot private Skill synchronization', () => {
  let root: string;
  let cloudRoot: string;
  let artifactRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-private-sync-'));
    cloudRoot = path.join(root, 'cloud');
    artifactRoot = path.join(cloudRoot, 'artifacts');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('upserts a verified private version, stays quiet when unchanged, and versions edits', async () => {
    const runtimeRoot = path.join(root, 'runtime-a');
    const artifacts = artifactStore(runtimeRoot);
    const transport = new FakePrivateTransport(artifacts);
    const fixture = createFixture(runtimeRoot, artifacts, transport);
    const skillFile = writeSkill(fixture.skillsRoot, '# v1\n');

    const first = await fixture.sync.syncOnStartup('bot_A');
    assert.equal(transport.upserts, 1);
    assert.match(first.definition.skills![0].skillId, /^private:/);
    assert.equal(first.base.bindings[0].storage, 'skillhub-private');
    assert.equal(await fixture.sync.syncAfterTurn('bot_A').then(result => result.direction), 'none');
    assert.equal(transport.upserts, 1);

    fs.appendFileSync(skillFile, '\nlocal edit\n');
    const second = await fixture.sync.syncAfterTurn('bot_A');
    assert.equal(transport.upserts, 2);
    assert.equal(second.definition.skills![0].skillId, first.definition.skills![0].skillId);
    assert.notEqual(second.definition.skills![0].version, first.definition.skills![0].version);
  });

  test('treats a directory-only rename as workspace state without creating a duplicate private version', async () => {
    const runtimeRoot = path.join(root, 'runtime-rename');
    const artifacts = artifactStore(runtimeRoot);
    const transport = new FakePrivateTransport(artifacts);
    const fixture = createFixture(runtimeRoot, artifacts, transport);
    writeSkill(fixture.skillsRoot, '# rename me\n');
    const first = await fixture.sync.syncOnStartup('bot_A');
    fs.rmSync(artifacts.getPath(first.definition.skills![0]));
    transport.failUpload = true;

    fs.renameSync(
      path.join(fixture.skillsRoot, 'notes'),
      path.join(fixture.skillsRoot, 'renamed-notes'),
    );
    const renamed = await fixture.sync.syncAfterTurn('bot_A');

    assert.equal(transport.upserts, 1);
    assert.deepEqual(renamed.definition.skills, first.definition.skills);
    assert.equal(renamed.base.local.entries[0].path, 'renamed-notes');
    assert.equal(renamed.base.bindings[0].localSkillId, first.base.bindings[0].localSkillId);
  });

  test('migrates a PR4 simulated-private binding even when Local and Cloud otherwise match Base', async () => {
    const runtimeRoot = path.join(root, 'runtime-migration');
    const artifacts = artifactStore(runtimeRoot);
    const legacy = createFixture(runtimeRoot, artifacts, null);
    writeSkill(legacy.skillsRoot, '# legacy\n');
    const before = await legacy.sync.syncOnStartup('bot_A');
    assert.match(before.definition.skills![0].skillId, /^sim-private:/);

    const transport = new FakePrivateTransport(artifacts);
    const migratedSync = createBotSkillSyncService({
      runtimeRoot,
      expectedBotId: 'bot_A',
      workspaceService: legacy.workspace,
      definitionRepository: legacy.definitions,
      definitionService: legacy.definitionService,
      baseRepository: legacy.base,
      artifactStore: artifacts,
      artifactTransport: transport,
    });
    const migrated = await migratedSync.syncOnStartup('bot_A');

    assert.equal(migrated.reason, 'transport_migration');
    assert.match(migrated.definition.skills![0].skillId, /^private:/);
    assert.equal(migrated.base.bindings[0].storage, 'skillhub-private');
    assert.equal(transport.upserts, 1);
  });

  test('turns a modified public Skill into a private fork without changing the public ref', async () => {
    const runtimeRoot = path.join(root, 'runtime-public-fork');
    const artifacts = artifactStore(runtimeRoot);
    const transport = new FakePrivateTransport(artifacts);
    const fixture = createFixture(runtimeRoot, artifacts, transport);
    const skillFile = writeSkill(fixture.skillsRoot, '# public\n');
    const skillDir = path.dirname(skillFile);
    const publicRef = { skillId: 'alice/notes', version: '1.0.0' };
    writeSkillHubInstallMarker(skillDir, {
      source: 'skillhub',
      visibility: 'public',
      ...publicRef,
      name: 'notes',
      installName: 'notes',
      packageChecksumSha256: 'a'.repeat(64),
      installedContentHash: computeLocalSkillContentHash(skillDir),
      signature: {
        algorithm: 'ed25519',
        keyId: 'public-key',
        signature: 'public-signature',
        signedAt: '2026-07-01T00:00:00.000Z',
      },
      packageUrl: 'skillhub:alice/notes@1.0.0',
      installedAt: '2026-07-01T00:00:00.000Z',
    });
    const installed = await fixture.sync.syncOnStartup('bot_A');
    assert.deepEqual(installed.definition.skills, [publicRef]);
    assert.equal(transport.upserts, 0);

    fs.appendFileSync(skillFile, '\nprivate edit\n');
    const forked = await fixture.sync.syncAfterTurn('bot_A');

    assert.equal(transport.upserts, 1);
    assert.deepEqual(transport.lastForkedFrom, publicRef);
    assert.match(forked.definition.skills![0].skillId, /^private:/);
    assert.equal(forked.base.bindings[0].storage, 'skillhub-private');
  });

  test('does not let transport migration overwrite a Cloud change made after PR4 Base', async () => {
    const runtimeRoot = path.join(root, 'runtime-migration-cloud-change');
    const artifacts = artifactStore(runtimeRoot);
    const legacy = createFixture(runtimeRoot, artifacts, null);
    writeSkill(legacy.skillsRoot, '# legacy local\n');
    await legacy.sync.syncOnStartup('bot_A');
    const cloudRef = { skillId: 'alice/cloud-newer', version: '2.0.0' };
    legacy.definitionService.updateSkills('bot_A', [cloudRef]);

    const transport = new FakePrivateTransport(artifacts);
    const migratedSync = createBotSkillSyncService({
      runtimeRoot,
      expectedBotId: 'bot_A',
      workspaceService: legacy.workspace,
      definitionRepository: legacy.definitions,
      definitionService: legacy.definitionService,
      baseRepository: legacy.base,
      artifactStore: artifacts,
      artifactTransport: transport,
    });

    await assert.rejects(
      () => migratedSync.syncOnStartup('bot_A'),
      (error: any) => error?.code === 'BOT_SKILL_PULL_FAILED',
    );
    assert.equal(transport.upserts, 0);
    assert.deepEqual(legacy.definitions.readCanonical('bot_A')?.skills, [cloudRef]);
  });

  test('restores the same private localSkillId on a second workspace', async () => {
    const firstRuntime = path.join(root, 'runtime-first');
    const firstArtifacts = artifactStore(firstRuntime, path.join(root, 'cache-first'));
    const remoteArtifacts = new Map<string, SimulatedSkillArtifact>();
    const firstTransport = new FakePrivateTransport(firstArtifacts, remoteArtifacts);
    const first = createFixture(firstRuntime, firstArtifacts, firstTransport);
    writeSkill(first.skillsRoot, '# portable private\n');
    const uploaded = await first.sync.syncOnStartup('bot_A');

    const secondRuntime = path.join(root, 'runtime-second');
    const secondArtifacts = artifactStore(secondRuntime, path.join(root, 'cache-second'));
    const second = createFixture(
      secondRuntime,
      secondArtifacts,
      new FakePrivateTransport(secondArtifacts, remoteArtifacts),
      true,
    );
    const restored = await second.sync.syncOnStartup('bot_A', { workspaceWasMissing: true });

    assert.equal(restored.direction, 'cloud_to_local');
    assert.equal(restored.manifest.entries[0].localSkillId, uploaded.manifest.entries[0].localSkillId);
    assert.notEqual(restored.workspaceId, uploaded.workspaceId);
    assert.match(fs.readFileSync(path.join(second.skillsRoot, 'notes', 'SKILL.md'), 'utf8'), /portable private/);
  });

  test('keeps Local usable and does not advance Definition or Base when private upload fails', async () => {
    const runtimeRoot = path.join(root, 'runtime-offline');
    const artifacts = artifactStore(runtimeRoot);
    const transport = new FakePrivateTransport(artifacts);
    transport.failUpload = true;
    const fixture = createFixture(runtimeRoot, artifacts, transport);
    const skillFile = writeSkill(fixture.skillsRoot, '# offline edit\n');
    const canonicalBefore = fs.readFileSync(fixture.definitions.getCanonicalPath('bot_A'), 'utf8');

    await assert.rejects(
      () => fixture.sync.syncOnStartup('bot_A'),
      (error: any) => (
        error instanceof BotSkillSyncError
        && error.code === 'BOT_SKILL_PUSH_FAILED'
        && error.safeToUseLocal
      ),
    );
    assert.equal(fs.readFileSync(fixture.definitions.getCanonicalPath('bot_A'), 'utf8'), canonicalBefore);
    assert.equal(fixture.base.inspect('bot_A', fixture.workspaceId).status, 'missing');
    assert.match(fs.readFileSync(skillFile, 'utf8'), /offline edit/);
  });

  test('blocks high-confidence credentials before any private SkillHub request is sent', async () => {
    const runtimeRoot = path.join(root, 'runtime-sensitive');
    const artifacts = artifactStore(runtimeRoot);
    const fixture = createFixture(runtimeRoot, artifacts, null);
    writeSkill(fixture.skillsRoot, '# secret should stay local\n');
    fs.writeFileSync(
      path.join(fixture.skillsRoot, 'notes', 'config.json'),
      '{"api_key":"abcdefghijklmnopqrstuvwxyz123456"}\n',
    );
    const manifest = scanLocalSkillManifest({
      skillsRoot: fixture.skillsRoot,
      botId: 'bot_A',
      workspaceId: fixture.workspaceId,
      createIdentities: true,
    });
    assert.equal(manifest.status, 'complete');
    const snapshot = artifacts.snapshot({
      botId: 'bot_A',
      skillsRoot: fixture.skillsRoot,
      entry: manifest.entries[0],
    });
    let requests = 0;
    const client = {
      upsertPrivateSkill: async () => {
        requests += 1;
        throw new Error('must not be reached');
      },
    };
    const transport = new SkillHubBotSkillArtifactTransport({
      runtimeRoot,
      artifactStore: artifacts,
      client: client as any,
    });

    await assert.rejects(
      () => transport.upsertPrivate({
        botId: 'bot_A',
        workspaceId: fixture.workspaceId,
        artifact: snapshot,
      }),
      (error: any) => error?.code === 'BOT_SKILL_PRIVATE_CONTENT_BLOCKED',
    );
    assert.equal(requests, 0);
    assert.equal(fs.existsSync(artifacts.getPath(snapshot.ref)), false);
  });

  function artifactStore(
    runtimeRoot: string,
    rootPath = artifactRoot,
  ): FileSimulatedSkillArtifactStore {
    return new FileSimulatedSkillArtifactStore({ runtimeRoot, root: rootPath });
  }

  function createFixture(
    runtimeRoot: string,
    artifacts: FileSimulatedSkillArtifactStore,
    transport: BotSkillArtifactTransport | null,
    canonicalAlreadyExists = false,
  ) {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    createCatsCoLocalConfigService({ runtimeRoot }).save({
      version: 1,
      currentBot: { uid: 'bot_A', apiKey: 'bot-secret' },
    });
    const workspace = createBotSkillWorkspaceService({ runtimeRoot });
    const state = workspace.ensureActive('bot_A', { allowCreate: true });
    const definitions = new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot: cloudRoot });
    if (!canonicalAlreadyExists) {
      definitions.writeCanonical({
        schema: BOT_DEFINITION_SCHEMA,
        botId: 'bot_A',
        model: { kind: 'catalog', modelId: 'test-model' },
      });
    }
    const definitionService = createBotDefinitionSyncService({
      runtimeRoot,
      repository: definitions,
      simulatedCloudRoot: cloudRoot,
    });
    const base = new FileBotSkillSyncBaseRepository({ runtimeRoot });
    return {
      skillsRoot: path.join(runtimeRoot, 'skills'),
      workspaceId: state.workspaceId,
      workspace,
      definitions,
      definitionService,
      base,
      sync: createBotSkillSyncService({
        runtimeRoot,
        expectedBotId: 'bot_A',
        workspaceService: workspace,
        definitionRepository: definitions,
        definitionService,
        baseRepository: base,
        artifactStore: artifacts,
        artifactTransport: transport,
      }),
    };
  }
});

class FakePrivateTransport implements BotSkillArtifactTransport {
  upserts = 0;
  failUpload = false;
  lastForkedFrom?: BotSkillRef;

  constructor(
    private readonly artifacts: FileSimulatedSkillArtifactStore,
    private readonly remote = new Map<string, SimulatedSkillArtifact>(),
  ) {}

  async upsertPrivate(input: BotSkillPrivateUploadInput): Promise<SimulatedSkillArtifact> {
    this.upserts += 1;
    this.lastForkedFrom = input.forkedFrom && { ...input.forkedFrom };
    if (this.failUpload) throw new Error('private SkillHub offline');
    const ref = {
      skillId: `private:${sha256(`${input.botId}\0${input.artifact.localSkillId}`)}`,
      version: `content-${input.artifact.contentHash}`,
    };
    const artifact = this.artifacts.cacheVerified({
      ref,
      botId: input.botId,
      localSkillId: input.artifact.localSkillId,
      storage: 'skillhub-private',
      name: input.artifact.name,
      installName: input.artifact.installName,
      contentHash: input.artifact.contentHash,
      files: input.artifact.files,
      installMarker: privateMarker(ref, input),
    });
    this.remote.set(refKey(ref), artifact);
    return artifact;
  }

  async fetchVerified(
    ref: BotSkillRef,
    context: BotSkillArtifactTransportContext,
  ): Promise<SimulatedSkillArtifact> {
    const remote = this.remote.get(refKey(ref));
    if (!remote) throw new Error('remote private artifact missing');
    if (remote.botId !== context.botId) throw new Error('private owner mismatch');
    return this.artifacts.cacheVerified({
      ref: remote.ref,
      botId: remote.botId,
      localSkillId: remote.localSkillId,
      storage: 'skillhub-private',
      name: remote.name,
      installName: remote.installName,
      contentHash: remote.contentHash,
      files: remote.files,
      installMarker: remote.installMarker!,
    });
  }
}

function refKey(ref: BotSkillRef): string {
  return `${ref.skillId}\0${ref.version}`;
}

function privateMarker(ref: BotSkillRef, input: BotSkillPrivateUploadInput) {
  const signedAt = '2026-07-01T00:00:00.000Z';
  return {
    source: 'skillhub' as const,
    visibility: 'private' as const,
    ownerBotId: input.botId,
    localSkillId: input.artifact.localSkillId,
    skillId: ref.skillId,
    name: input.artifact.name,
    installName: input.artifact.installName,
    version: ref.version,
    packageChecksumSha256: sha256(`package\0${ref.skillId}\0${ref.version}`),
    installedContentHash: input.artifact.contentHash,
    signature: {
      algorithm: 'ed25519' as const,
      keyId: 'fake-key',
      signature: Buffer.from('fake-signature').toString('base64'),
      signedAt,
    },
    packageUrl: `skillhub:${ref.skillId}@${ref.version}`,
    installedAt: signedAt,
  };
}

function writeSkill(skillsRoot: string, body: string): string {
  const directory = path.join(skillsRoot, 'notes');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'SKILL.md');
  fs.writeFileSync(file, ['---', 'name: notes', 'description: notes', '---', '', body].join('\n'));
  return file;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
