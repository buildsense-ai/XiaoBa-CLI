import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { FileBotDefinitionRepository } from '../src/bot-definition/repository';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import { BOT_DEFINITION_SCHEMA } from '../src/bot-definition/types';
import { createBotSkillService } from '../src/bot-skills/service';
import {
  FileBotSkillSyncBaseRepository,
  localProjectionDigest,
  projectLocalManifest,
} from '../src/bot-skills/sync-base';
import {
  FileSimulatedSkillArtifactStore,
} from '../src/bot-skills/simulated-artifact-store';
import {
  BotSkillSyncError,
  createBotSkillSyncService,
} from '../src/bot-skills/sync-service';
import {
  flushBotSkillSyncQueue,
  resetBotSkillSyncCoordinatorForTests,
  scheduleBotSkillSync,
  setBotSkillSyncRunnerForTests,
} from '../src/bot-skills/sync-coordinator';
import { createBotSkillWorkspaceService } from '../src/bot-skills/workspace-service';
import {
  BOT_SKILL_PULL_JOURNAL_SCHEMA,
  recoverBotSkillWorkspaceReconciles,
} from '../src/bot-skills/workspace-reconciler';
import { scanLocalSkillManifest } from '../src/bot-skills/local-manifest';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { computeLocalSkillContentHash } from '../src/skillhub/local-skill-metadata';
import { writeSkillHubInstallMarker } from '../src/skillhub/install-marker';

describe('BotSkillSyncService', () => {
  let root: string;
  let runtimeRoot: string;
  let cloudRoot: string;
  let artifactRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-sync-'));
    runtimeRoot = path.join(root, 'runtime-a');
    cloudRoot = path.join(root, 'simulated-cloud');
    artifactRoot = path.join(cloudRoot, 'artifacts');
    fs.mkdirSync(runtimeRoot, { recursive: true });
  });

  afterEach(() => {
    resetBotSkillSyncCoordinatorForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('migrates a local Skill to a deterministic private artifact and advances Base last', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    writeSkill(path.join(fixture.skillsRoot, 'notes'), 'notes', '# v1\n');

    const first = await fixture.sync.syncOnStartup('bot_A');
    const definition = fixture.definitions.readCanonical('bot_A');
    const base = fixture.base.inspect('bot_A', fixture.workspaceId);

    assert.equal(first.direction, 'local_to_cloud');
    assert.equal(first.reason, 'legacy_migration');
    assert.equal(definition?.skills?.length, 1);
    assert.match(definition!.skills![0].skillId, /^sim-private:/);
    assert.match(definition!.skills![0].version, /^content-[0-9a-f]{64}$/);
    assert.equal(base.status, 'valid');
    assert.equal(base.status === 'valid' && base.base.bindings[0].localSkillId,
      first.manifest.entries[0].localSkillId);
    assert.ok(fs.existsSync(fixture.artifacts.getPath(definition!.skills![0])));

    const second = await fixture.sync.syncAfterTurn('bot_A');
    assert.equal(second.direction, 'none');
    assert.equal(second.reason, 'already_synced');
    assert.deepEqual(second.definition.skills, definition?.skills);
  });

  test('uses the same private skillId and a new immutable version after local edits', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillFile = path.join(fixture.skillsRoot, 'notes', 'SKILL.md');
    writeSkill(path.dirname(skillFile), 'notes', '# v1\n');
    const first = await fixture.sync.syncOnStartup('bot_A');

    fs.appendFileSync(skillFile, '\nlocal edit\n');
    const second = await fixture.sync.syncAfterTurn('bot_A');

    assert.equal(second.direction, 'local_to_cloud');
    assert.equal(second.reason, 'local_changed');
    assert.equal(second.definition.skills?.[0].skillId, first.definition.skills?.[0].skillId);
    assert.notEqual(second.definition.skills?.[0].version, first.definition.skills?.[0].version);
    assert.ok(fs.existsSync(fixture.artifacts.getPath(first.definition.skills![0])));
    assert.ok(fs.existsSync(fixture.artifacts.getPath(second.definition.skills![0])));
  });

  test('keeps an unmodified public ref and forks local edits into a private ref', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillDir = path.join(fixture.skillsRoot, 'browser');
    const skillFile = path.join(skillDir, 'SKILL.md');
    writeSkill(skillDir, 'browser', '# public\n');
    const installedContentHash = computeLocalSkillContentHash(skillDir);
    writeSkillHubInstallMarker(skillDir, {
      source: 'skillhub',
      skillId: 'alice/browser',
      name: 'browser',
      installName: 'browser',
      version: '1.0.3',
      packageChecksumSha256: 'a'.repeat(64),
      installedContentHash,
      signature: {
        algorithm: 'ed25519',
        keyId: 'test-key',
        signature: 'test-signature',
        signedAt: '2026-01-01T00:00:00.000Z',
      },
      packageUrl: '/package',
      installedAt: '2026-01-01T00:00:00.000Z',
    });

    const migrated = await fixture.sync.syncOnStartup('bot_A');
    assert.deepEqual(migrated.definition.skills, [{
      skillId: 'alice/browser',
      version: '1.0.3',
    }]);

    fs.appendFileSync(skillFile, '\nlocal fork\n');
    const forked = await fixture.sync.syncAfterTurn('bot_A');
    assert.match(forked.definition.skills![0].skillId, /^sim-private:/);
    assert.notEqual(forked.definition.skills![0].skillId, 'alice/browser');
  });

  test('restores a mirrored public Skill with a workspace-local identity', async () => {
    const first = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillDir = path.join(first.skillsRoot, 'browser');
    writeSkill(skillDir, 'browser', '# public\n');
    const installedContentHash = computeLocalSkillContentHash(skillDir);
    writeSkillHubInstallMarker(skillDir, publicMarker(installedContentHash));
    const uploaded = await first.sync.syncOnStartup('bot_A');

    const secondRuntime = path.join(root, 'runtime-public-b');
    fs.mkdirSync(secondRuntime, { recursive: true });
    const second = createFixture(secondRuntime, cloudRoot, artifactRoot, 'bot_A', {
      canonicalAlreadyExists: true,
    });
    const restored = await second.sync.syncOnStartup('bot_A', {
      workspaceWasMissing: true,
    });

    assert.deepEqual(restored.definition.skills, [{
      skillId: 'alice/browser',
      version: '1.0.3',
    }]);
    assert.equal(restored.manifest.entries[0].source, 'skillhub');
    assert.notEqual(restored.manifest.entries[0].localSkillId, 'public');
    assert.notEqual(
      restored.manifest.entries[0].localSkillId,
      uploaded.manifest.entries[0].localSkillId,
    );
  });

  test('deduplicates one public version across install sessions and Bots', async () => {
    const first = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const firstDir = path.join(first.skillsRoot, 'browser');
    writeSkill(firstDir, 'browser', '# public\n');
    const contentHash = computeLocalSkillContentHash(firstDir);
    writeSkillHubInstallMarker(firstDir, {
      ...publicMarker(contentHash),
      userId: 'user-a',
      packageUrl: '/session-a/package',
      installedAt: '2026-01-02T00:00:00.000Z',
    });
    const uploadedA = await first.sync.syncOnStartup('bot_A');

    const secondRuntime = path.join(root, 'runtime-public-other-bot');
    fs.mkdirSync(secondRuntime, { recursive: true });
    const second = createFixture(secondRuntime, cloudRoot, artifactRoot, 'bot_B');
    const secondDir = path.join(second.skillsRoot, 'browser');
    writeSkill(secondDir, 'browser', '# public\n');
    writeSkillHubInstallMarker(secondDir, {
      ...publicMarker(computeLocalSkillContentHash(secondDir)),
      userId: 'user-b',
      packageUrl: '/session-b/package',
      installedAt: '2026-02-03T00:00:00.000Z',
    });
    const uploadedB = await second.sync.syncOnStartup('bot_B');

    assert.deepEqual(uploadedB.definition.skills, uploadedA.definition.skills);
    assert.equal(
      second.artifacts.getPath(uploadedB.definition.skills![0]),
      first.artifacts.getPath(uploadedA.definition.skills![0]),
    );
  });

  test('keeps the workspace localSkillId when Cloud upgrades the same public Skill', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillDir = path.join(fixture.skillsRoot, 'browser');
    writeSkill(skillDir, 'browser', '# public v1\n');
    writeSkillHubInstallMarker(skillDir, publicMarker(computeLocalSkillContentHash(skillDir)));
    const first = await fixture.sync.syncOnStartup('bot_A');
    const originalLocalSkillId = first.manifest.entries[0].localSkillId;
    const originalSkill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const originalMarker = fs.readFileSync(
      path.join(skillDir, '.xiaoba-skillhub-install.json'),
      'utf8',
    );

    writeSkill(skillDir, 'browser', '# public v2\n');
    writeSkillHubInstallMarker(skillDir, {
      ...publicMarker(computeLocalSkillContentHash(skillDir)),
      version: '1.0.4',
    });
    const v2Manifest = await fixture.botSkills.scanManifest();
    const v2Artifact = fixture.artifacts.put({
      botId: 'bot_A',
      skillsRoot: fixture.skillsRoot,
      entry: v2Manifest.entries[0],
      publicRef: { skillId: 'alice/browser', version: '1.0.4' },
    });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), originalSkill);
    fs.writeFileSync(path.join(skillDir, '.xiaoba-skillhub-install.json'), originalMarker);
    fixture.definitionService.updateSkills('bot_A', [v2Artifact.ref]);

    const pulled = await fixture.sync.syncOnStartup('bot_A');

    assert.equal(pulled.direction, 'cloud_to_local');
    assert.equal(pulled.manifest.entries[0].localSkillId, originalLocalSkillId);
    assert.match(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), /public v2/);
  });

  test('pulls a Cloud-only version when Local still equals Base', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillFile = path.join(fixture.skillsRoot, 'notes', 'SKILL.md');
    writeSkill(path.dirname(skillFile), 'notes', '# v1\n');
    const first = await fixture.sync.syncOnStartup('bot_A');
    const v1 = fs.readFileSync(skillFile, 'utf8');

    fs.writeFileSync(skillFile, v1.replace('# v1', '# v2'));
    const changed = await fixture.botSkills.scanManifest();
    const v2Artifact = fixture.artifacts.put({
      botId: 'bot_A',
      skillsRoot: fixture.skillsRoot,
      entry: changed.entries[0],
    });
    fs.writeFileSync(skillFile, v1);
    fixture.definitionService.updateSkills('bot_A', [v2Artifact.ref]);

    const pulled = await fixture.sync.syncOnStartup('bot_A');

    assert.equal(pulled.direction, 'cloud_to_local');
    assert.equal(pulled.reason, 'cloud_changed');
    assert.match(fs.readFileSync(skillFile, 'utf8'), /# v2/);
    assert.equal(pulled.manifest.entries[0].localSkillId, first.manifest.entries[0].localSkillId);
    assert.deepEqual(pulled.definition.skills, [v2Artifact.ref]);
  });

  test('protects Local when both Local and Cloud changed from Base', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillFile = path.join(fixture.skillsRoot, 'notes', 'SKILL.md');
    writeSkill(path.dirname(skillFile), 'notes', '# v1\n');
    await fixture.sync.syncOnStartup('bot_A');

    const original = fs.readFileSync(skillFile, 'utf8');
    fs.writeFileSync(skillFile, original.replace('# v1', '# cloud'));
    const cloudManifest = await fixture.botSkills.scanManifest();
    const cloudArtifact = fixture.artifacts.put({
      botId: 'bot_A',
      skillsRoot: fixture.skillsRoot,
      entry: cloudManifest.entries[0],
    });
    fixture.definitionService.updateSkills('bot_A', [cloudArtifact.ref]);
    fs.writeFileSync(skillFile, original.replace('# v1', '# local'));

    const result = await fixture.sync.syncAfterTurn('bot_A');

    assert.equal(result.direction, 'local_to_cloud');
    assert.match(fs.readFileSync(skillFile, 'utf8'), /# local/);
    assert.notDeepEqual(result.definition.skills, [cloudArtifact.ref]);
  });

  test('keeps disabled content locally while removing it from Cloud active refs', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    writeSkill(path.join(fixture.skillsRoot, 'notes'), 'notes', '# v1\n');
    await fixture.sync.syncOnStartup('bot_A');

    await fixture.botSkills.setEnabledByName('notes', false);
    const result = await fixture.sync.syncAfterTurn('bot_A');
    const base = fixture.base.inspect('bot_A', fixture.workspaceId);

    assert.deepEqual(result.definition.skills, []);
    assert.equal(result.manifest.entries[0].enabled, false);
    assert.equal(base.status, 'valid');
    assert.equal(base.status === 'valid' && base.base.bindings.length, 1);
    assert.ok(fs.existsSync(path.join(fixture.skillsRoot, 'notes', 'SKILL.md.disabled')));
    assert.equal((await fixture.sync.syncAfterTurn('bot_A')).direction, 'none');
  });

  test('restores a missing workspace on a second device from canonical and artifacts', async () => {
    const first = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    writeSkill(path.join(first.skillsRoot, 'notes'), 'notes', '# portable\n');
    const uploaded = await first.sync.syncOnStartup('bot_A');

    const secondRuntime = path.join(root, 'runtime-b');
    fs.mkdirSync(secondRuntime, { recursive: true });
    const second = createFixture(secondRuntime, cloudRoot, artifactRoot, 'bot_A', {
      canonicalAlreadyExists: true,
    });
    const restored = await second.sync.syncOnStartup('bot_A', {
      workspaceWasMissing: true,
    });

    assert.equal(restored.direction, 'cloud_to_local');
    assert.equal(restored.reason, 'workspace_restore');
    assert.match(
      fs.readFileSync(path.join(second.skillsRoot, 'notes', 'SKILL.md'), 'utf8'),
      /# portable/,
    );
    assert.equal(restored.manifest.entries[0].localSkillId, uploaded.manifest.entries[0].localSkillId);
  });

  test('derives the default artifact repository from the shared simulated cloud root', async () => {
    const first = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A', {
      useServiceDefaultArtifactStore: true,
    });
    writeSkill(path.join(first.skillsRoot, 'notes'), 'notes', '# shared default root\n');
    await first.sync.syncOnStartup('bot_A');

    const secondRuntime = path.join(root, 'runtime-default-artifact-b');
    fs.mkdirSync(secondRuntime, { recursive: true });
    const second = createFixture(secondRuntime, cloudRoot, artifactRoot, 'bot_A', {
      canonicalAlreadyExists: true,
      useServiceDefaultArtifactStore: true,
    });
    const restored = await second.sync.syncOnStartup('bot_A', {
      workspaceWasMissing: true,
    });

    assert.equal(restored.direction, 'cloud_to_local');
    assert.match(
      fs.readFileSync(path.join(second.skillsRoot, 'notes', 'SKILL.md'), 'utf8'),
      /shared default root/,
    );
    assert.equal(
      first.artifacts.root,
      path.join(path.resolve(cloudRoot), 'skill-artifacts'),
    );
    assert.equal(second.artifacts.root, first.artifacts.root);
  });

  test('keeps retrying an unfinished empty-workspace restore after process restart', async () => {
    const first = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    writeSkill(path.join(first.skillsRoot, 'notes'), 'notes', '# recover after restart\n');
    const uploaded = await first.sync.syncOnStartup('bot_A');
    const artifactPath = first.artifacts.getPath(uploaded.definition.skills![0]);
    const unavailablePath = `${artifactPath}.offline`;
    fs.renameSync(artifactPath, unavailablePath);

    const secondRuntime = path.join(root, 'runtime-retry-b');
    fs.mkdirSync(secondRuntime, { recursive: true });
    const second = createFixture(secondRuntime, cloudRoot, artifactRoot, 'bot_A', {
      canonicalAlreadyExists: true,
    });
    await assert.rejects(
      () => second.sync.syncOnStartup('bot_A', { workspaceWasMissing: true }),
      (error: any) => error?.code === 'BOT_SKILL_PULL_FAILED' && !error.safeToUseLocal,
    );
    assert.equal((await second.botSkills.scanManifest()).entries.length, 0);
    fs.renameSync(unavailablePath, artifactPath);

    const restartedSync = createBotSkillSyncService({
      runtimeRoot: secondRuntime,
      expectedBotId: 'bot_A',
      workspaceService: second.workspace,
      definitionRepository: second.definitions,
      definitionService: second.definitionService,
      baseRepository: second.base,
      artifactStore: second.artifacts,
    });
    const retried = await restartedSync.syncOnStartup('bot_A');

    assert.equal(retried.direction, 'cloud_to_local');
    assert.match(
      fs.readFileSync(path.join(second.skillsRoot, 'notes', 'SKILL.md'), 'utf8'),
      /recover after restart/,
    );
    assert.deepEqual(second.definitions.readCanonical('bot_A')?.skills, uploaded.definition.skills);
  });

  test('does not treat an invalid Base or canonical record as an empty state', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    writeSkill(path.join(fixture.skillsRoot, 'notes'), 'notes', '# v1\n');
    await fixture.sync.syncOnStartup('bot_A');
    const canonicalBefore = fs.readFileSync(
      fixture.definitions.getCanonicalPath('bot_A'),
      'utf8',
    );
    fs.writeFileSync(fixture.base.getPath('bot_A', fixture.workspaceId), '{"broken":true}');
    fs.appendFileSync(path.join(fixture.skillsRoot, 'notes', 'SKILL.md'), '\nlocal\n');

    await assert.rejects(
      () => fixture.sync.syncAfterTurn('bot_A'),
      (error: any) => (
        error instanceof BotSkillSyncError
        && error.code === 'BOT_SKILL_SYNC_BASE_INVALID'
        && error.safeToUseLocal
      ),
    );
    assert.equal(
      fs.readFileSync(fixture.definitions.getCanonicalPath('bot_A'), 'utf8'),
      canonicalBefore,
    );
  });

  test('rejects a structurally valid-looking Base when its artifact bindings were tampered', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    writeSkill(path.join(fixture.skillsRoot, 'notes'), 'notes', '# v1\n');
    await fixture.sync.syncOnStartup('bot_A');
    const basePath = fixture.base.getPath('bot_A', fixture.workspaceId);
    const tampered = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    tampered.bindings[0].artifactDigest = 'e'.repeat(64);
    fs.writeFileSync(basePath, `${JSON.stringify(tampered, null, 2)}\n`);

    const inspected = fixture.base.inspect('bot_A', fixture.workspaceId);

    assert.equal(inspected.status, 'invalid');
    await assert.rejects(
      () => fixture.sync.syncOnStartup('bot_A'),
      (error: any) => error?.code === 'BOT_SKILL_SYNC_BASE_INVALID',
    );
  });

  test('fails closed on an invalid canonical record even when cache and Local are valid', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillFile = path.join(fixture.skillsRoot, 'notes', 'SKILL.md');
    writeSkill(path.dirname(skillFile), 'notes', '# v1\n');
    await fixture.sync.syncOnStartup('bot_A');
    fs.writeFileSync(
      fixture.definitions.getCanonicalPath('bot_A'),
      '{"schema":"xiaoba.bot-definition.v1","broken":true}',
    );
    fs.appendFileSync(skillFile, '\nprotected local edit\n');

    await assert.rejects(
      () => fixture.sync.syncAfterTurn('bot_A'),
      (error: any) => (
        error instanceof BotSkillSyncError
        && error.code === 'BOT_SKILL_CLOUD_INVALID'
        && error.safeToUseLocal
      ),
    );
    assert.equal(
      fs.readFileSync(fixture.definitions.getCanonicalPath('bot_A'), 'utf8'),
      '{"schema":"xiaoba.bot-definition.v1","broken":true}',
    );
    assert.match(fs.readFileSync(skillFile, 'utf8'), /protected local edit/);
  });

  test('leaves Local and Base unchanged when a Cloud artifact is unavailable', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillFile = path.join(fixture.skillsRoot, 'notes', 'SKILL.md');
    writeSkill(path.dirname(skillFile), 'notes', '# v1\n');
    const first = await fixture.sync.syncOnStartup('bot_A');
    const baseBefore = fixture.base.inspect('bot_A', fixture.workspaceId);
    fixture.definitionService.updateSkills('bot_A', [{
      skillId: 'sim-private:missing',
      version: `content-${'f'.repeat(64)}`,
    }]);

    await assert.rejects(
      () => fixture.sync.syncOnStartup('bot_A'),
      (error: any) => (
        error?.code === 'BOT_SKILL_PULL_FAILED'
        && error.safeToUseLocal === false
        && /artifact is missing/.test(error.message)
      ),
    );
    assert.match(fs.readFileSync(skillFile, 'utf8'), /# v1/);
    assert.deepEqual(fixture.base.inspect('bot_A', fixture.workspaceId), baseBefore);
    assert.deepEqual(projectLocalManifest(await fixture.botSkills.scanManifest()), first.base.local.entries);
  });

  test('syncs deletion as a Definition ref removal without deleting immutable history', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    writeSkill(path.join(fixture.skillsRoot, 'notes'), 'notes', '# v1\n');
    const first = await fixture.sync.syncOnStartup('bot_A');
    const oldRef = first.definition.skills![0];
    const oldArtifact = fixture.artifacts.getPath(oldRef);
    fs.rmSync(path.join(fixture.skillsRoot, 'notes'), { recursive: true, force: true });

    const removed = await fixture.sync.syncAfterTurn('bot_A');

    assert.deepEqual(removed.definition.skills, []);
    assert.deepEqual(removed.base.local.entries, []);
    assert.ok(fs.existsSync(oldArtifact));
  });

  test('never turns a partial Local manifest into Cloud deletion', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const source = path.join(fixture.skillsRoot, 'notes');
    writeSkill(source, 'notes', '# v1\n');
    await fixture.sync.syncOnStartup('bot_A');
    const canonicalBefore = fs.readFileSync(
      fixture.definitions.getCanonicalPath('bot_A'),
      'utf8',
    );
    fs.cpSync(source, path.join(fixture.skillsRoot, 'copied-notes'), { recursive: true });

    await assert.rejects(
      () => fixture.sync.syncAfterTurn('bot_A'),
      (error: any) => (
        error?.code === 'LOCAL_SKILL_MANIFEST_INCOMPLETE'
        || error?.code === 'BOT_SKILL_LOCAL_INCOMPLETE'
      ),
    );
    assert.equal(
      fs.readFileSync(fixture.definitions.getCanonicalPath('bot_A'), 'utf8'),
      canonicalBefore,
    );
  });

  test('reports upload failure as locally usable and leaves Base behind for retry', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillFile = path.join(fixture.skillsRoot, 'notes', 'SKILL.md');
    writeSkill(path.dirname(skillFile), 'notes', '# v1\n');
    await fixture.sync.syncOnStartup('bot_A');
    const baseBefore = fixture.base.inspect('bot_A', fixture.workspaceId);
    const canonicalBefore = fixture.definitions.readCanonical('bot_A');
    fs.appendFileSync(skillFile, '\nlocal pending edit\n');
    const originalUpdate = fixture.definitionService.updateSkills.bind(fixture.definitionService);
    (fixture.definitionService as any).updateSkills = () => {
      throw new Error('simulated cloud write failure');
    };

    await assert.rejects(
      () => fixture.sync.syncAfterTurn('bot_A'),
      (error: any) => (
        error?.code === 'BOT_SKILL_PUSH_FAILED'
        && error.safeToUseLocal === true
      ),
    );
    (fixture.definitionService as any).updateSkills = originalUpdate;

    assert.match(fs.readFileSync(skillFile, 'utf8'), /local pending edit/);
    assert.deepEqual(fixture.base.inspect('bot_A', fixture.workspaceId), baseBefore);
    assert.deepEqual(fixture.definitions.readCanonical('bot_A'), canonicalBefore);
  });

  test('rolls back a target-active pull failure without changing Base', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillFile = path.join(fixture.skillsRoot, 'notes', 'SKILL.md');
    writeSkill(path.dirname(skillFile), 'notes', '# v1\n');
    const first = await fixture.sync.syncOnStartup('bot_A');
    const baseBefore = fixture.base.inspect('bot_A', fixture.workspaceId);
    const v1 = fs.readFileSync(skillFile, 'utf8');

    fs.writeFileSync(skillFile, v1.replace('# v1', '# v2'));
    const changed = await fixture.botSkills.scanManifest();
    const v2Artifact = fixture.artifacts.put({
      botId: 'bot_A',
      skillsRoot: fixture.skillsRoot,
      entry: changed.entries[0],
    });
    fs.writeFileSync(skillFile, v1);
    fixture.definitionService.updateSkills('bot_A', [v2Artifact.ref]);
    const crashingSync = createBotSkillSyncService({
      runtimeRoot,
      expectedBotId: 'bot_A',
      workspaceService: fixture.workspace,
      definitionRepository: fixture.definitions,
      definitionService: fixture.definitionService,
      baseRepository: fixture.base,
      artifactStore: fixture.artifacts,
      onPullPhasePersisted(phase) {
        if (phase === 'target-active') throw new Error('simulated crash');
      },
    });

    await assert.rejects(() => crashingSync.syncOnStartup('bot_A'), /simulated crash/);

    assert.equal(fs.readFileSync(skillFile, 'utf8'), v1);
    assert.deepEqual(fixture.base.inspect('bot_A', fixture.workspaceId), baseBefore);
    assert.deepEqual(
      projectLocalManifest(await fixture.botSkills.scanManifest()),
      first.base.local.entries,
    );
  });

  test('recovers both rename-before-journal crash windows without losing Local', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    const skillFile = path.join(fixture.skillsRoot, 'notes', 'SKILL.md');
    writeSkill(path.dirname(skillFile), 'notes', '# old\n');
    const synced = await fixture.sync.syncOnStartup('bot_A');
    const oldContent = fs.readFileSync(skillFile, 'utf8');
    const oldDigest = synced.base.local.digest;

    for (const crashWindow of ['after-source-rename', 'after-target-rename'] as const) {
      const operationDir = createCrashWindowOperation({
        runtimeRoot,
        fixture,
        oldDigest,
        crashWindow,
      });

      recoverBotSkillWorkspaceReconciles({
        runtimeRoot,
        definitionRepository: fixture.definitions,
        baseRepository: fixture.base,
      });

      assert.equal(fs.readFileSync(skillFile, 'utf8'), oldContent);
      assert.equal(fs.existsSync(operationDir), false);
      assert.equal(
        (await fixture.botSkills.scanManifest()).entries[0].contentHash,
        synced.manifest.entries[0].contentHash,
      );
    }
  });

  test('coalesces repeated background triggers and keeps one trailing rerun', async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    setBotSkillSyncRunnerForTests(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
    });
    const request = {
      runtimeRoot,
      botId: 'bot_A',
      workspaceId: 'workspace_A',
    };
    scheduleBotSkillSync(request);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(calls, 1);
    for (let index = 0; index < 100; index += 1) scheduleBotSkillSync(request);
    releaseFirst();
    await flushBotSkillSyncQueue();

    assert.equal(calls, 2);
  });

  test('does not hot-loop failed background sync and retries on the next trigger', async () => {
    let calls = 0;
    setBotSkillSyncRunnerForTests(async () => {
      calls += 1;
      throw new Error('offline');
    });
    const request = {
      runtimeRoot,
      botId: 'bot_A',
      workspaceId: 'workspace_A',
    };
    scheduleBotSkillSync(request);
    await flushBotSkillSyncQueue();
    assert.equal(calls, 1);

    scheduleBotSkillSync(request);
    await flushBotSkillSyncQueue();
    assert.equal(calls, 2);
  });

  test('schedules managed BotSkillService mutations with the captured workspace identity', async () => {
    const fixture = createFixture(runtimeRoot, cloudRoot, artifactRoot, 'bot_A');
    writeSkill(path.join(fixture.skillsRoot, 'notes'), 'notes', '# v1\n');
    await fixture.sync.syncOnStartup('bot_A');
    let captured: any;
    setBotSkillSyncRunnerForTests(async request => {
      captured = request;
    });

    await fixture.botSkills.setEnabledByName('notes', false);
    await flushBotSkillSyncQueue();

    assert.equal(captured.botId, 'bot_A');
    assert.equal(captured.workspaceId, fixture.workspaceId);
    assert.equal(captured.runtimeRoot, path.resolve(runtimeRoot));
  });
});

function createFixture(
  runtimeRoot: string,
  cloudRoot: string,
  artifactRoot: string,
  botId: string,
  options: {
    canonicalAlreadyExists?: boolean;
    useServiceDefaultArtifactStore?: boolean;
  } = {},
) {
  const localConfig = createCatsCoLocalConfigService({ runtimeRoot });
  localConfig.save(botConfig(botId));
  const workspace = createBotSkillWorkspaceService({ runtimeRoot });
  const state = workspace.ensureActive(botId, { allowCreate: true });
  const definitions = new FileBotDefinitionRepository({
    runtimeRoot,
    simulatedCloudRoot: cloudRoot,
  });
  if (!options.canonicalAlreadyExists) {
    definitions.writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId,
      model: { kind: 'catalog', modelId: 'test-model' },
    });
  }
  const definitionService = createBotDefinitionSyncService({
    runtimeRoot,
    simulatedCloudRoot: cloudRoot,
    repository: definitions,
  });
  const base = new FileBotSkillSyncBaseRepository({ runtimeRoot });
  const artifacts = new FileSimulatedSkillArtifactStore({
    runtimeRoot,
    ...(options.useServiceDefaultArtifactStore
      ? { simulatedCloudRoot: cloudRoot }
      : { root: artifactRoot }),
  });
  const botSkills = createBotSkillService({
    runtimeRoot,
    expectedBotId: botId,
    workspaceService: workspace,
  });
  const sync = createBotSkillSyncService(options.useServiceDefaultArtifactStore
    ? {
      runtimeRoot,
      expectedBotId: botId,
      workspaceService: workspace,
      simulatedCloudRoot: cloudRoot,
      baseRepository: base,
    }
    : {
      runtimeRoot,
      expectedBotId: botId,
      workspaceService: workspace,
      definitionRepository: definitions,
      definitionService,
      baseRepository: base,
      artifactStore: artifacts,
    });
  return {
    skillsRoot: path.join(runtimeRoot, 'skills'),
    workspaceId: state.workspaceId,
    workspace,
    definitions,
    definitionService,
    base,
    artifacts,
    botSkills,
    sync,
  };
}

function writeSkill(directory: string, name: string, body: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    '---',
    '',
    body,
  ].join('\n'));
}

function createCrashWindowOperation(options: {
  runtimeRoot: string;
  fixture: ReturnType<typeof createFixture>;
  oldDigest: string;
  crashWindow: 'after-source-rename' | 'after-target-rename';
}): string {
  const workspaceScope = crypto.createHash('sha256')
    .update(options.fixture.workspaceId, 'utf8')
    .digest('hex');
  const operationDir = path.join(
    options.runtimeRoot,
    'data',
    'bot-skills',
    'sync-operations',
    `w_${workspaceScope}`,
    `pull-crash-${options.crashWindow}-${crypto.randomUUID()}`,
  );
  const stagedRoot = path.join(operationDir, 'staged');
  const backupRoot = path.join(operationDir, 'backup');
  fs.mkdirSync(operationDir, { recursive: true });
  fs.cpSync(options.fixture.skillsRoot, stagedRoot, { recursive: true });
  const stagedSkill = path.join(stagedRoot, 'notes', 'SKILL.md');
  fs.writeFileSync(stagedSkill, fs.readFileSync(stagedSkill, 'utf8').replace('# old', '# target'));
  const targetManifest = scanLocalSkillManifest({
    skillsRoot: stagedRoot,
    botId: 'bot_A',
    workspaceId: options.fixture.workspaceId,
    createIdentities: false,
  });
  assert.equal(targetManifest.status, 'complete');
  const targetDigest = localProjectionDigest(projectLocalManifest(targetManifest));
  const journal = {
    schema: BOT_SKILL_PULL_JOURNAL_SCHEMA,
    transactionId: crypto.randomUUID(),
    botId: 'bot_A',
    workspaceId: options.fixture.workspaceId,
    phase: options.crashWindow === 'after-source-rename' ? 'prepared' : 'source-backed-up',
    oldLocalDigest: options.oldDigest,
    targetLocalDigest: targetDigest,
    targetCloudDigest: 'f'.repeat(64),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(operationDir, 'journal.json'), `${JSON.stringify(journal)}\n`);
  fs.renameSync(options.fixture.skillsRoot, backupRoot);
  if (options.crashWindow === 'after-target-rename') {
    fs.renameSync(stagedRoot, options.fixture.skillsRoot);
  }
  return operationDir;
}

function publicMarker(installedContentHash: string) {
  return {
    source: 'skillhub' as const,
    skillId: 'alice/browser',
    name: 'browser',
    installName: 'browser',
    version: '1.0.3',
    packageChecksumSha256: 'a'.repeat(64),
    installedContentHash,
    signature: {
      algorithm: 'ed25519' as const,
      keyId: 'test-key',
      signature: 'test-signature',
      signedAt: '2026-01-01T00:00:00.000Z',
    },
    packageUrl: '/package',
    installedAt: '2026-01-01T00:00:00.000Z',
  };
}

function botConfig(botId: string) {
  return {
    version: 1 as const,
    currentBot: {
      uid: botId,
      apiKey: `key-${botId}`,
      boundByUserUid: 'user-1',
      bindingSource: 'test',
    },
    device: {
      deviceId: 'device-1',
      bodyId: 'device-1',
      installationId: 'device-1',
    },
  };
}
