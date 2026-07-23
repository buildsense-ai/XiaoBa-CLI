import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createBotSkillService } from '../src/bot-skills/service';
import {
  BOT_SKILL_LOCAL_IDENTITY_FILE,
  scanLocalSkillManifest,
} from '../src/bot-skills/local-manifest';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace-service';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import type { SkillHubRegistryEntry } from '../src/skillhub/types';

describe('BotSkillService', () => {
  let testRoot: string;
  let runtimeRoot: string;
  let skillsRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-service-'));
    runtimeRoot = path.join(testRoot, 'runtime');
    skillsRoot = path.join(testRoot, 'editable-skills');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.mkdirSync(skillsRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('distinguishes a missing workspace from a valid empty manifest', () => {
    const missing = scanLocalSkillManifest({
      skillsRoot: path.join(testRoot, 'missing'),
    });
    const empty = scanLocalSkillManifest({ skillsRoot });

    assert.equal(missing.status, 'missing');
    assert.deepEqual(missing.entries, []);
    assert.equal(empty.status, 'complete');
    assert.deepEqual(empty.entries, []);
  });

  test('refuses an unclaimed managed workspace even when XIAOBA_SKILLS_DIR points to it', async () => {
    const managedSkills = path.join(runtimeRoot, 'skills');
    fs.mkdirSync(managedSkills, { recursive: true });
    const service = createBotSkillService({
      runtimeRoot,
      env: { XIAOBA_SKILLS_DIR: managedSkills },
    });

    await assert.rejects(
      () => service.scanManifest(),
      (error: any) => error?.code === 'SKILL_WORKSPACE_UNCLAIMED',
    );
  });

  test('builds deterministic local and SkillHub entries with stable local ids', async () => {
    writeSkill(path.join(skillsRoot, 'local-demo'), 'local-demo', '# v1\n');
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    const first = await service.scanManifest();
    const local = first.entries[0];

    assert.equal(first.status, 'complete');
    assert.equal(local.key, 'local:local-demo');
    assert.equal(local.source, 'local');
    assert.equal(local.enabled, true);
    assert.match(local.localSkillId, /^[0-9a-f-]{36}$/);
    assert.equal(local.path, 'local-demo');

    fs.appendFileSync(path.join(skillsRoot, 'local-demo', 'notes.txt'), 'changed\n');
    const changed = await service.scanManifest();
    assert.equal(changed.entries[0].localSkillId, local.localSkillId);
    assert.notEqual(changed.entries[0].contentHash, local.contentHash);

    await service.setEnabledByName('local-demo', false);
    const disabled = await service.scanManifest();
    assert.equal(disabled.entries[0].enabled, false);
    assert.equal(disabled.entries[0].localSkillId, local.localSkillId);
    assert.equal(disabled.entries[0].contentHash, changed.entries[0].contentHash);
  });

  test('keeps localSkillId when SKILL.md metadata is renamed in place', async () => {
    const directory = path.join(skillsRoot, 'local-demo');
    writeSkill(directory, 'local-demo', '# v1\n');
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    const before = await service.scanManifest();

    writeSkill(directory, 'renamed-demo', '# v2\n');
    const after = await service.scanManifest();

    assert.equal(after.entries[0].name, 'renamed-demo');
    assert.equal(after.entries[0].localSkillId, before.entries[0].localSkillId);
  });

  test('preserves disabled state while updating an unmodified SkillHub Skill', async () => {
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    await service.installVerifiedSkillHubPackage(
      packageFixture('alice/demo', 'demo', '1.0.0', '# one\n'),
    );
    await service.setEnabledByName('demo', false);

    const updated = await service.installVerifiedSkillHubPackage({
      ...packageFixture('alice/demo', 'demo', '2.0.0', '# two\n'),
      allowUpdate: true,
    });

    assert.equal(updated.manifest.entries[0].enabled, false);
    assert.equal(
      updated.manifest.entries[0].contentHash,
      updated.manifest.entries[0].installedContentHash,
    );
    assert.match(
      fs.readFileSync(path.join(skillsRoot, 'demo', 'SKILL.md.disabled'), 'utf8'),
      /# two/,
    );
  });

  test('keeps localSkillId when a SkillHub update changes SKILL.md name', async () => {
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    const installed = await service.installVerifiedSkillHubPackage(
      packageFixture('alice/demo', 'demo', '1.0.0', '# one\n'),
    );
    const update = packageFixture('alice/demo', 'demo', '2.0.0', '# two\n');
    const renamedSkill = Buffer.from([
      '---',
      'name: renamed-demo',
      'description: renamed description',
      '---',
      '',
      '# two',
    ].join('\n'));
    const entry = update.verification.packageObject.payload.files[0];
    entry.size = renamedSkill.length;
    entry.sha256 = crypto.createHash('sha256').update(renamedSkill).digest('hex');
    entry.contentBase64 = renamedSkill.toString('base64');

    const changed = await service.installVerifiedSkillHubPackage({
      ...update,
      allowUpdate: true,
    });

    assert.equal(changed.manifest.entries[0].name, 'renamed-demo');
    assert.equal(
      changed.manifest.entries[0].localSkillId,
      installed.manifest.entries[0].localSkillId,
    );
  });

  test('records an installed content baseline and protects local changes from update', async () => {
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    const first = packageFixture('alice/demo', 'demo', '1.0.0', '# one\n');
    const installed = await service.installVerifiedSkillHubPackage(first);
    const entry = installed.manifest.entries[0];

    assert.equal(entry.source, 'skillhub');
    assert.equal(entry.skillId, 'alice/demo');
    assert.equal(entry.version, '1.0.0');
    assert.equal(entry.installedContentHash, entry.contentHash);

    const skillFile = path.join(skillsRoot, 'demo', 'SKILL.md');
    fs.appendFileSync(skillFile, '\nlocal edit\n');
    const second = packageFixture('alice/demo', 'demo', '2.0.0', '# two\n');
    await assert.rejects(
      () => service.installVerifiedSkillHubPackage({ ...second, allowUpdate: true }),
      (error: any) => error?.code === 'LOCAL_MODIFICATIONS',
    );
    assert.match(fs.readFileSync(skillFile, 'utf8'), /local edit/);
  });

  test('rejects oversized install metadata before committing the target directory', async () => {
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    const incoming = packageFixture('alice/oversized', 'oversized', '1.0.0', '# one\n');
    incoming.registryEntry.packageUrl = `https://example.test/${'x'.repeat(70 * 1024)}`;

    await assert.rejects(
      () => service.installVerifiedSkillHubPackage(incoming),
      (error: any) => error?.code === 'INSTALL_MARKER_TOO_LARGE',
    );
    assert.equal(fs.existsSync(path.join(skillsRoot, 'oversized')), false);
  });

  test('keeps staging and backup directories outside the runtime catalog', async () => {
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    await service.installVerifiedSkillHubPackage(
      packageFixture('alice/demo', 'demo', '1.0.0', '# one\n'),
    );

    assert.deepEqual(
      fs.readdirSync(skillsRoot).filter(name => name.startsWith('.skillhub-')),
      [],
    );
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'data', 'bot-skills', 'operations')), true);
  });

  test('recovers a complete old or new package across update rename failures', async () => {
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    await service.installVerifiedSkillHubPackage(
      packageFixture('alice/demo', 'demo', '1.0.0', '# one\n'),
    );
    const update = packageFixture('alice/demo', 'demo', '2.0.0', '# two\n');

    await assert.rejects(
      () => service.installVerifiedSkillHubPackage({
        ...update,
        allowUpdate: true,
        onPhasePersisted: phase => {
          if (phase === 'target-backed-up') throw new Error('simulated crash');
        },
      }),
      /simulated crash/,
    );
    assert.match(
      fs.readFileSync(path.join(skillsRoot, 'demo', 'SKILL.md'), 'utf8'),
      /# one/,
    );

    await assert.rejects(
      () => service.installVerifiedSkillHubPackage({
        ...update,
        allowUpdate: true,
        onPhasePersisted: phase => {
          if (phase === 'target-active') throw new Error('simulated crash');
        },
      }),
      /simulated crash/,
    );
    assert.match(
      fs.readFileSync(path.join(skillsRoot, 'demo', 'SKILL.md'), 'utf8'),
      /# two/,
    );
    const recovered = await service.scanManifest();
    assert.equal(recovered.status, 'complete');
    assert.equal(recovered.entries[0].version, '2.0.0');
  });

  test('preserves a unique package backup when the recovered target is ambiguous', async () => {
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    await service.installVerifiedSkillHubPackage(
      packageFixture('alice/demo', 'demo', '1.0.0', '# one\n'),
    );
    const operationDir = path.join(service.operationsRoot, 'install-ambiguous');
    const backupDir = path.join(operationDir, 'backup');
    fs.mkdirSync(operationDir, { recursive: true });
    fs.renameSync(path.join(skillsRoot, 'demo'), backupDir);
    writeSkill(path.join(skillsRoot, 'demo'), 'unexpected', '# replacement\n');
    fs.writeFileSync(path.join(operationDir, 'journal.json'), `${JSON.stringify({
      schema: 'xiaoba.skillhub-install-transaction.v1',
      phase: 'target-backed-up',
      targetDir: path.join(skillsRoot, 'demo'),
      targetExisted: true,
      expectedSkillId: 'alice/demo',
      expectedVersion: '2.0.0',
      expectedChecksumSha256: 'expected-v2',
    })}\n`);

    await assert.rejects(
      () => service.scanManifest(),
      (error: any) => error?.code === 'INSTALL_RECOVERY_AMBIGUOUS',
    );
    assert.equal(fs.existsSync(path.join(backupDir, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(operationDir, 'journal.json')), true);
  });

  test('preserves a package backup when a target-active journal has no target', async () => {
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    await service.installVerifiedSkillHubPackage(
      packageFixture('alice/demo', 'demo', '1.0.0', '# one\n'),
    );
    const operationDir = path.join(service.operationsRoot, 'install-active-missing');
    const backupDir = path.join(operationDir, 'backup');
    fs.mkdirSync(operationDir, { recursive: true });
    fs.renameSync(path.join(skillsRoot, 'demo'), backupDir);
    fs.writeFileSync(path.join(operationDir, 'journal.json'), `${JSON.stringify({
      schema: 'xiaoba.skillhub-install-transaction.v1',
      phase: 'target-active',
      targetDir: path.join(skillsRoot, 'demo'),
      targetExisted: true,
      expectedSkillId: 'alice/demo',
      expectedVersion: '2.0.0',
      expectedChecksumSha256: 'expected-v2',
    })}\n`);

    await assert.rejects(
      () => service.scanManifest(),
      (error: any) => error?.code === 'INSTALL_RECOVERY_AMBIGUOUS',
    );
    assert.equal(fs.existsSync(path.join(backupDir, 'SKILL.md')), true);
  });

  test('preserves a unique local backup when the recovered target is ambiguous', async () => {
    writeSkill(path.join(skillsRoot, 'demo'), 'demo', '# one\n');
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    const before = await service.scanManifest();
    const operationDir = path.join(service.operationsRoot, 'local-install-ambiguous');
    const backupDir = path.join(operationDir, 'backup');
    fs.mkdirSync(operationDir, { recursive: true });
    fs.renameSync(path.join(skillsRoot, 'demo'), backupDir);
    writeSkill(path.join(skillsRoot, 'demo'), 'unexpected', '# replacement\n');
    fs.writeFileSync(
      path.join(operationDir, 'local-install-journal.json'),
      `${JSON.stringify({
        schema: 'xiaoba.local-skill-install.v1',
        phase: 'target-backed-up',
        targetDir: path.join(skillsRoot, 'demo'),
        targetExisted: true,
        expectedLocalSkillId: before.entries[0].localSkillId,
        expectedContentHash: before.entries[0].contentHash,
      })}\n`,
    );

    await assert.rejects(
      () => service.scanManifest(),
      (error: any) => error?.code === 'LOCAL_INSTALL_RECOVERY_AMBIGUOUS',
    );
    assert.equal(fs.existsSync(path.join(backupDir, 'SKILL.md')), true);
    assert.equal(
      fs.existsSync(path.join(operationDir, 'local-install-journal.json')),
      true,
    );
  });

  test('preserves a local backup when a target-active journal has no target', async () => {
    writeSkill(path.join(skillsRoot, 'demo'), 'demo', '# one\n');
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    const before = await service.scanManifest();
    const operationDir = path.join(service.operationsRoot, 'local-install-active-missing');
    const backupDir = path.join(operationDir, 'backup');
    fs.mkdirSync(operationDir, { recursive: true });
    fs.renameSync(path.join(skillsRoot, 'demo'), backupDir);
    fs.writeFileSync(
      path.join(operationDir, 'local-install-journal.json'),
      `${JSON.stringify({
        schema: 'xiaoba.local-skill-install.v1',
        phase: 'target-active',
        targetDir: path.join(skillsRoot, 'demo'),
        targetExisted: true,
        expectedLocalSkillId: before.entries[0].localSkillId,
        expectedContentHash: before.entries[0].contentHash,
      })}\n`,
    );

    await assert.rejects(
      () => service.scanManifest(),
      (error: any) => error?.code === 'LOCAL_INSTALL_RECOVERY_AMBIGUOUS',
    );
    assert.equal(fs.existsSync(path.join(backupDir, 'SKILL.md')), true);
  });

  test('reports copied local identities and symlinks as partial instead of complete deletion state', async t => {
    writeSkill(path.join(skillsRoot, 'one'), 'one', '# one\n');
    writeSkill(path.join(skillsRoot, 'two'), 'two', '# two\n');
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    await service.scanManifest();
    fs.copyFileSync(
      path.join(skillsRoot, 'one', BOT_SKILL_LOCAL_IDENTITY_FILE),
      path.join(skillsRoot, 'two', BOT_SKILL_LOCAL_IDENTITY_FILE),
    );

    const duplicate = scanLocalSkillManifest({ skillsRoot, createIdentities: false });
    assert.equal(duplicate.status, 'partial');
    assert.ok(duplicate.issues.some(item => item.code === 'DUPLICATE_LOCAL_SKILL_ID'));

    const outside = path.join(testRoot, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(skillsRoot, 'linked');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error: any) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('Creating a junction requires additional Windows privileges.');
        return;
      }
      throw error;
    }
    const unsafe = scanLocalSkillManifest({ skillsRoot, createIdentities: false });
    assert.equal(unsafe.status, 'partial');
    assert.ok(unsafe.issues.some(item => item.code === 'SYMLINK_UNSUPPORTED'));
  });

  test('treats nested Skill roots as a blocking manifest issue', () => {
    writeSkill(path.join(skillsRoot, 'outer'), 'outer', '# outer\n');
    writeSkill(path.join(skillsRoot, 'outer', 'inner'), 'inner', '# inner\n');

    const manifest = scanLocalSkillManifest({ skillsRoot });

    assert.equal(manifest.status, 'partial');
    assert.ok(manifest.issues.some(item => item.code === 'NESTED_SKILL_UNSUPPORTED'));
    assert.deepEqual(manifest.entries.map(entry => entry.name), ['outer']);
  });

  test('rejects a prospective name conflict before installing local content', async () => {
    writeSkill(path.join(skillsRoot, 'existing'), 'shared-name', '# existing\n');
    const source = path.join(testRoot, 'incoming');
    writeSkill(source, 'shared-name', '# incoming\n');
    const service = createBotSkillService({ runtimeRoot, skillsRoot });

    await assert.rejects(
      () => service.installLocalDirectory({
        sourceDir: source,
        installName: 'other-directory',
      }),
      (error: any) => error?.code === 'SKILL_MANIFEST_CONFLICT',
    );
    assert.equal(fs.existsSync(path.join(skillsRoot, 'other-directory')), false);
    assert.match(
      fs.readFileSync(path.join(skillsRoot, 'existing', 'SKILL.md'), 'utf8'),
      /existing/,
    );
  });

  test('rejects a prospective name conflict before installing a SkillHub package', async () => {
    writeSkill(path.join(skillsRoot, 'existing'), 'shared-name', '# existing\n');
    const incoming = packageFixture(
      'alice/cloud-demo',
      'shared-name',
      '1.0.0',
      '# incoming\n',
    );
    incoming.verification.packageObject.payload.manifest.name = 'cloud-demo';
    incoming.registryEntry.name = 'cloud-demo';
    const service = createBotSkillService({ runtimeRoot, skillsRoot });

    await assert.rejects(
      () => service.installVerifiedSkillHubPackage(incoming),
      (error: any) => error?.code === 'SKILL_MANIFEST_CONFLICT',
    );
    assert.equal(fs.existsSync(path.join(skillsRoot, 'cloud-demo')), false);
  });

  test('does not uninstall after discovering an unrelated partial manifest', async () => {
    const service = createBotSkillService({ runtimeRoot, skillsRoot });
    await service.installVerifiedSkillHubPackage(
      packageFixture('alice/demo', 'demo', '1.0.0', '# demo\n'),
    );
    writeSkill(path.join(skillsRoot, 'outer'), 'outer', '# outer\n');
    writeSkill(path.join(skillsRoot, 'outer', 'inner'), 'inner', '# inner\n');

    await assert.rejects(
      () => service.uninstallSkillHubPackage({
        skillId: 'alice/demo',
        installName: 'demo',
      }),
      (error: any) => error?.code === 'LOCAL_SKILL_MANIFEST_INCOMPLETE',
    );
    assert.equal(fs.existsSync(path.join(skillsRoot, 'demo', 'SKILL.md')), true);
  });

  test('uses the PR2 activation lock and revalidates the Bot owner before writing identity', async () => {
    const managedSkills = path.join(runtimeRoot, 'skills');
    writeSkill(path.join(managedSkills, 'demo'), 'demo', '# demo\n');
    const config = createCatsCoLocalConfigService({ runtimeRoot, env: {} });
    config.save(botConfig('bot_A'));
    const workspace = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    workspace.ensureActive('bot_A');
    const service = createBotSkillService({
      runtimeRoot,
      skillsRoot: managedSkills,
      env: {},
      workspaceService: workspace,
    });

    const held = workspace.acquireActivationLock();
    try {
      await assert.rejects(
        () => service.scanManifest(),
        /already locked/,
      );
      assert.equal(
        fs.existsSync(path.join(managedSkills, 'demo', BOT_SKILL_LOCAL_IDENTITY_FILE)),
        false,
      );
    } finally {
      held.release();
    }

    config.save(botConfig('bot_B'));
    await assert.rejects(
      () => service.scanManifest(),
      (error: any) => error?.code === 'SKILL_WORKSPACE_OWNER_CHANGED',
    );
    assert.equal(
      fs.existsSync(path.join(managedSkills, 'demo', BOT_SKILL_LOCAL_IDENTITY_FILE)),
      false,
    );
  });

  test('adopts an unbound local identity without changing localSkillId', async () => {
    const managedSkills = path.join(runtimeRoot, 'skills');
    writeSkill(path.join(managedSkills, 'demo'), 'demo', '# demo\n');
    const unmanaged = createBotSkillService({
      runtimeRoot,
      skillsRoot: managedSkills,
      env: {},
      allowUnmanagedWorkspace: true,
    });
    const before = await unmanaged.scanManifest();
    const localSkillId = before.entries[0].localSkillId;

    const config = createCatsCoLocalConfigService({ runtimeRoot, env: {} });
    config.save(botConfig('bot_A'));
    const workspace = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    const state = workspace.ensureActive('bot_A');
    const after = await createBotSkillService({
      runtimeRoot,
      env: {},
      workspaceService: workspace,
    }).scanManifest();

    assert.equal(after.entries[0].localSkillId, localSkillId);
    const identity = JSON.parse(fs.readFileSync(
      path.join(managedSkills, 'demo', BOT_SKILL_LOCAL_IDENTITY_FILE),
      'utf8',
    ));
    assert.equal(identity.workspaceId, state.workspaceId);
  });

  test('keeps interrupted operations isolated by workspace across Bot switches', async () => {
    const managedSkills = path.join(runtimeRoot, 'skills');
    writeSkill(path.join(managedSkills, 'demo'), 'demo', '# A\n');
    const config = createCatsCoLocalConfigService({ runtimeRoot, env: {} });
    config.save(botConfig('bot_A'));
    const workspace = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    workspace.ensureActive('bot_A');
    const serviceA = createBotSkillService({
      runtimeRoot,
      env: {},
      workspaceService: workspace,
    });
    const operationDir = path.join(serviceA.operationsRoot, 'install-crash');
    const backupDir = path.join(operationDir, 'backup');
    fs.mkdirSync(operationDir, { recursive: true });
    fs.renameSync(path.join(managedSkills, 'demo'), backupDir);
    fs.writeFileSync(path.join(operationDir, 'journal.json'), `${JSON.stringify({
      schema: 'xiaoba.skillhub-install-transaction.v1',
      phase: 'prepared',
      targetDir: path.join(managedSkills, 'demo'),
      targetExisted: true,
    })}\n`);

    const toB = workspace.beginSwitch('bot_B', { allowCreate: true });
    workspace.commitSwitch(toB.transactionId!);
    config.save(botConfig('bot_B'));
    const serviceB = createBotSkillService({
      runtimeRoot,
      env: {},
      workspaceService: workspace,
    });
    assert.notEqual(serviceB.operationsRoot, serviceA.operationsRoot);
    const manifestB = await serviceB.scanManifest();
    assert.deepEqual(manifestB.entries, []);
    assert.equal(fs.existsSync(backupDir), true);
    assert.equal(fs.existsSync(path.join(managedSkills, 'demo')), false);

    const toA = workspace.beginSwitch('bot_A');
    workspace.commitSwitch(toA.transactionId!);
    config.save(botConfig('bot_A'));
    const recoveredA = await createBotSkillService({
      runtimeRoot,
      env: {},
      workspaceService: workspace,
    }).scanManifest();
    assert.equal(recoveredA.entries[0].name, 'demo');
    assert.match(
      fs.readFileSync(path.join(managedSkills, 'demo', 'SKILL.md'), 'utf8'),
      /# A/,
    );
  });

  test('uses the pending target identity while validating a workspace switch', async () => {
    const managedSkills = path.join(runtimeRoot, 'skills');
    fs.mkdirSync(managedSkills, { recursive: true });
    const config = createCatsCoLocalConfigService({ runtimeRoot, env: {} });
    config.save(botConfig('bot_A'));
    const workspace = new BotSkillWorkspaceService({ runtimeRoot, env: {} });
    workspace.ensureActive('bot_A');
    const lock = workspace.acquireActivationLock();
    try {
      const switching = workspace.beginSwitch('bot_B', {
        allowCreate: true,
        lock,
      });
      config.save(botConfig('bot_B'));
      writeSkill(path.join(managedSkills, 'target-skill'), 'target-skill', '# B\n');

      const manifest = await createBotSkillService({
        runtimeRoot,
        env: {},
        expectedBotId: 'bot_B',
        workspaceService: workspace,
        activationLock: lock,
        activationTransactionId: switching.transactionId,
      }).scanManifest();

      const pending = workspace.readState()?.switchJournal?.to;
      assert.equal(manifest.botId, 'bot_B');
      assert.equal(manifest.workspaceId, pending?.workspaceId);
      const identity = JSON.parse(fs.readFileSync(
        path.join(managedSkills, 'target-skill', BOT_SKILL_LOCAL_IDENTITY_FILE),
        'utf8',
      ));
      assert.equal(identity.workspaceId, pending?.workspaceId);
    } finally {
      lock.release();
    }
  });

  test('local directory overwrite is atomic and keeps identity for the same Skill', async () => {
    const sourceOne = path.join(testRoot, 'source-one');
    const sourceTwo = path.join(testRoot, 'source-two');
    writeSkill(sourceOne, 'prompt-editor', '# one\n');
    writeSkill(sourceTwo, 'prompt-editor', '# two\n');
    const service = createBotSkillService({ runtimeRoot, skillsRoot });

    const first = await service.installLocalDirectory({
      sourceDir: sourceOne,
      installName: 'prompt-editor',
    });
    const firstId = first.manifest.entries[0].localSkillId;
    const second = await service.installLocalDirectory({
      sourceDir: sourceTwo,
      installName: 'prompt-editor',
      overwrite: true,
    });

    assert.equal(second.manifest.entries[0].localSkillId, firstId);
    assert.match(
      fs.readFileSync(path.join(skillsRoot, 'prompt-editor', 'SKILL.md'), 'utf8'),
      /# two/,
    );
  });

  test('accepts Windows path casing differences without treating them as links', {
    skip: process.platform !== 'win32',
  }, async () => {
    const lowerSkillsRoot = skillsRoot.toLowerCase();
    const service = createBotSkillService({
      runtimeRoot,
      skillsRoot: lowerSkillsRoot,
    });

    const installed = await service.installVerifiedSkillHubPackage(
      packageFixture('alice/casing', 'casing', '1.0.0', '# casing\n'),
    );

    assert.equal(installed.manifest.entries[0].name, 'casing');
  });
});

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

function packageFixture(
  skillId: string,
  name: string,
  version: string,
  body: string,
) {
  const skill = Buffer.from([
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    '---',
    '',
    body,
  ].join('\n'));
  const registryEntry = {
    skillId,
    name,
    displayName: name,
    latestVersion: version,
    packageUrl: '/package',
    checksumSha256: crypto.createHash('sha256').update(`${skillId}:${version}`).digest('hex'),
    signature: {
      algorithm: 'ed25519' as const,
      keyId: 'test-key',
      signature: 'test-signature',
      signedAt: '2026-01-01T00:00:00.000Z',
    },
  } as SkillHubRegistryEntry;
  return {
    registryEntry,
    verification: {
      packageObject: {
        payload: {
          manifest: {
            id: skillId,
            name,
            displayName: name,
            version,
            entrypoints: { skillFile: 'SKILL.md' },
          },
          files: [{
            path: 'SKILL.md',
            size: skill.length,
            sha256: crypto.createHash('sha256').update(skill).digest('hex'),
            contentBase64: skill.toString('base64'),
          }],
        },
      },
    } as any,
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
