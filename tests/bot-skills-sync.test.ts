import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import type { BotDefinition, BotSkillRef } from '../src/bot-definition/types';
import { BotSkillBaseStore } from '../src/bot-skills/base-store';
import {
  BOT_SKILL_LOCAL_MARKER_FILE,
  readBotSkillLocalMarker,
  scanBotSkillWorkspace,
  scanLocalBotSkill,
} from '../src/bot-skills/local-manifest';
import { BotSkillSyncService } from '../src/bot-skills/sync-service';
import type { BotSkillPackage, LocalBotSkillManifestEntry } from '../src/bot-skills/types';
import { readSkillHubInstallMarker } from '../src/skillhub/install-marker';
import {
  applySkillHubLocalMetadata,
  readSkillHubLocalMetadata,
} from '../src/skillhub/local-skill-metadata';

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

  test('keeps a public reference after replacing the private sync copy of a local Skill', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'local-a', 'local-a', 'share this publicly');
    await fixture.sync();

    const privateReference = fixture.cloud.skills[0];
    const privatePackage = fixture.packages.get(refKey(privateReference));
    assert.ok(privatePackage);
    const publicReference = { skillId: 'alice/local-a', version: '1.0.0' };
    const publicPackage: BotSkillPackage = {
      ...privatePackage,
      reference: publicReference,
      origin: publicReference,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(publicReference), publicPackage);
    fixture.cloud = {
      revision: fixture.cloud.revision + 1,
      skills: [{
        source: 'skillhub',
        ...publicReference,
        contentHash: privatePackage.contentHash,
      }],
    };

    const finalized = await fixture.sync();
    assert.equal(finalized.direction, 'cloud_to_local');
    assert.equal(
      readBotSkillLocalMarker(path.join(fixture.skillsRoot, 'local-a'))?.reference?.skillId,
      'alice/local-a',
    );
    assert.equal(
      readSkillHubInstallMarker(path.join(fixture.skillsRoot, 'local-a'))?.skillId,
      'alice/local-a',
    );

    const repeated = await fixture.sync();
    assert.equal(repeated.direction, 'none');
    assert.deepStrictEqual(fixture.cloud.skills, [{
      source: 'skillhub',
      ...publicReference,
      contentHash: privatePackage.contentHash,
    }]);
  });

  test('promotes a new local Skill to its public reference without privately uploading it', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'existing', 'existing', 'already in Base');
    await fixture.sync();
    writeSkill(fixture.skillsRoot, 'shared-new', 'shared-new', 'share this globally');
    writeSkill(fixture.skillsRoot, 'other-new', 'other-new', 'keep this private');

    const target = scanLocalBotSkill(path.join(fixture.skillsRoot, 'shared-new'));
    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-05T00:00:00.000Z',
    };
    const publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-public-package-'));
    roots.push(publicRoot);
    writeSkill(publicRoot, 'shared-new', 'shared-new', 'share this globally');
    const publicSkillFile = path.join(publicRoot, 'shared-new', 'SKILL.md');
    fs.writeFileSync(
      publicSkillFile,
      applySkillHubLocalMetadata(fs.readFileSync(publicSkillFile, 'utf8'), metadata),
      'utf8',
    );
    const canonicalPublic = scanLocalBotSkill(path.join(publicRoot, 'shared-new'));
    const publicReference = {
      source: 'skillhub' as const,
      skillId: 'alice/shared-new',
      version: metadata.version,
      contentHash: canonicalPublic.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: {
        skillId: publicReference.skillId,
        version: publicReference.version,
      },
      localSkillId: target.localSkillId,
      name: target.name,
      contentHash: canonicalPublic.contentHash,
      createdAt: metadata.uploadedAt,
      origin: {
        skillId: publicReference.skillId,
        version: publicReference.version,
      },
      files: canonicalPublic.files,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(publicReference), publicPackage);
    fixture.cloud = {
      revision: fixture.cloud.revision + 1,
      skills: [...fixture.cloud.skills, publicReference],
    };

    const uploadsBeforeFinalize = fixture.uploads;
    const finalized = await fixture.finalize({
      localSkillId: target.localSkillId,
      skillName: target.name,
      reference: publicReference,
    });

    assert.equal(finalized.direction, 'local_to_cloud');
    assert.equal(fixture.uploads, uploadsBeforeFinalize + 1, 'only the unrelated new Skill is private-uploaded');
    assert.equal(fixture.cloud.skills.some(skill => skill.skillId === publicReference.skillId), true);
    assert.equal(fixture.cloud.skills.some(skill => (
      skill.skillId.startsWith('private/')
      && fixture.packages.get(refKey(skill))?.localSkillId === target.localSkillId
    )), false);
    assert.deepEqual(readSkillHubLocalMetadata(path.join(fixture.skillsRoot, 'shared-new', 'SKILL.md')), metadata);
    assert.deepEqual(
      readBotSkillLocalMarker(path.join(fixture.skillsRoot, 'shared-new'))?.reference,
      publicReference,
    );

    const repeated = await fixture.sync();
    assert.equal(repeated.direction, 'none');
    assert.equal(fixture.uploads, uploadsBeforeFinalize + 1);
  });

  test('rolls back Local and Base when the public ref disappears at the final cloud CAS', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'shared', 'shared', 'same canonical body');
    const skillFile = path.join(fixture.skillsRoot, 'shared', 'SKILL.md');
    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    };
    fs.writeFileSync(
      skillFile,
      applySkillHubLocalMetadata(fs.readFileSync(skillFile, 'utf8'), metadata),
      'utf8',
    );
    await fixture.sync();
    const target = scanLocalBotSkill(path.join(fixture.skillsRoot, 'shared'));
    const privateReference = fixture.cloud.skills[0];
    const privatePackage = fixture.packages.get(refKey(privateReference));
    assert.ok(privatePackage);
    const publicReference = {
      source: 'skillhub' as const,
      skillId: 'alice/shared',
      version: metadata.version,
      contentHash: target.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      ...privatePackage,
      source: 'public',
      reference: { skillId: publicReference.skillId, version: publicReference.version },
      origin: { skillId: publicReference.skillId, version: publicReference.version },
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(publicReference), publicPackage);
    fixture.cloud = {
      revision: fixture.cloud.revision + 1,
      skills: [publicReference],
    };
    const markerFile = path.join(target.path, '.xiaoba-bot-skill.json');
    const previousSkill = fs.readFileSync(skillFile, 'utf8');
    const previousMarker = fs.readFileSync(markerFile, 'utf8');
    const previousBase = new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId);
    fixture.conflictNextPatch = true;
    fixture.removeSkillsOnConflict = true;

    await assert.rejects(
      fixture.finalize({
        localSkillId: target.localSkillId,
        skillName: target.name,
        reference: publicReference,
      }),
      /removed from BotDefinition during finalization/i,
    );

    assert.equal(fs.readFileSync(skillFile, 'utf8'), previousSkill);
    assert.equal(fs.readFileSync(markerFile, 'utf8'), previousMarker);
    assert.deepEqual(new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId), previousBase);
    assert.deepEqual(fixture.cloud.skills, []);
  });

  test('leaves local files and markers unchanged when public package verification fails', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'existing', 'existing', 'already in Base');
    await fixture.sync();
    writeSkill(fixture.skillsRoot, 'shared-new', 'shared-new', 'local body');
    const target = scanLocalBotSkill(path.join(fixture.skillsRoot, 'shared-new'));
    const skillFile = path.join(target.path, 'SKILL.md');
    const markerFile = path.join(target.path, '.xiaoba-bot-skill.json');
    const previousSkill = fs.readFileSync(skillFile, 'utf8');
    const previousMarker = fs.readFileSync(markerFile, 'utf8');

    const publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-public-mismatch-'));
    roots.push(publicRoot);
    writeSkill(publicRoot, 'shared-new', 'shared-new', 'different published body');
    const publicSkillFile = path.join(publicRoot, 'shared-new', 'SKILL.md');
    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-05T00:00:00.000Z',
    };
    fs.writeFileSync(
      publicSkillFile,
      applySkillHubLocalMetadata(fs.readFileSync(publicSkillFile, 'utf8'), metadata),
      'utf8',
    );
    const canonicalPublic = scanLocalBotSkill(path.join(publicRoot, 'shared-new'));
    const reference = {
      source: 'skillhub' as const,
      skillId: 'alice/shared-new',
      version: metadata.version,
      contentHash: canonicalPublic.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: { skillId: reference.skillId, version: reference.version },
      localSkillId: target.localSkillId,
      name: target.name,
      contentHash: reference.contentHash,
      createdAt: metadata.uploadedAt,
      files: canonicalPublic.files,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(reference), publicPackage);
    fixture.cloud = {
      revision: fixture.cloud.revision + 1,
      skills: [...fixture.cloud.skills, reference],
    };

    await assert.rejects(
      fixture.finalize({
        localSkillId: target.localSkillId,
        skillName: target.name,
        reference,
      }),
      /changed after it was shared/i,
    );
    assert.equal(fs.readFileSync(skillFile, 'utf8'), previousSkill);
    assert.equal(fs.readFileSync(markerFile, 'utf8'), previousMarker);
  });

  test('does not overwrite a local edit made while the public package is becoming ready', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'existing', 'existing', 'already in Base');
    await fixture.sync();
    writeSkill(fixture.skillsRoot, 'shared-new', 'shared-new', 'original local body');
    const target = scanLocalBotSkill(path.join(fixture.skillsRoot, 'shared-new'));
    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-05T00:00:00.000Z',
    };
    const publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-public-race-'));
    roots.push(publicRoot);
    writeSkill(publicRoot, 'shared-new', 'shared-new', 'original local body');
    const publicSkillFile = path.join(publicRoot, 'shared-new', 'SKILL.md');
    fs.writeFileSync(
      publicSkillFile,
      applySkillHubLocalMetadata(fs.readFileSync(publicSkillFile, 'utf8'), metadata),
      'utf8',
    );
    const canonicalPublic = scanLocalBotSkill(path.join(publicRoot, 'shared-new'));
    const reference = {
      source: 'skillhub' as const,
      skillId: 'alice/shared-new',
      version: metadata.version,
      contentHash: canonicalPublic.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: { skillId: reference.skillId, version: reference.version },
      localSkillId: target.localSkillId,
      name: target.name,
      contentHash: reference.contentHash,
      createdAt: metadata.uploadedAt,
      files: canonicalPublic.files,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(reference), publicPackage);
    fixture.cloud = {
      revision: fixture.cloud.revision + 1,
      skills: [...fixture.cloud.skills, reference],
    };
    const skillFile = path.join(target.path, 'SKILL.md');
    const markerFile = path.join(target.path, '.xiaoba-bot-skill.json');
    const previousMarker = fs.readFileSync(markerFile, 'utf8');
    let scopeChecks = 0;

    await assert.rejects(
      fixture.finalize({
        localSkillId: target.localSkillId,
        skillName: target.name,
        reference,
      }, {
        validateScope: () => {
          scopeChecks += 1;
          if (scopeChecks === 2) {
            fs.writeFileSync(skillFile, skillText('shared-new', 'edited while publishing'));
          }
        },
      }),
      /changed while its public package was being published/i,
    );
    assert.match(fs.readFileSync(skillFile, 'utf8'), /edited while publishing/);
    assert.equal(fs.readFileSync(markerFile, 'utf8'), previousMarker);
  });

  test('rechecks BotDefinition after publication wait and refuses a concurrently removed public reference', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'shared-new', 'shared-new', 'share this globally');
    const target = scanLocalBotSkill(path.join(fixture.skillsRoot, 'shared-new'));
    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    };
    const publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-public-removed-'));
    roots.push(publicRoot);
    writeSkill(publicRoot, 'shared-new', 'shared-new', 'share this globally');
    const publicSkillFile = path.join(publicRoot, 'shared-new', 'SKILL.md');
    fs.writeFileSync(
      publicSkillFile,
      applySkillHubLocalMetadata(fs.readFileSync(publicSkillFile, 'utf8'), metadata),
    );
    const published = scanLocalBotSkill(path.join(publicRoot, 'shared-new'));
    const reference = {
      source: 'skillhub' as const,
      skillId: 'alice/shared-new',
      version: metadata.version,
      contentHash: published.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: { skillId: reference.skillId, version: reference.version },
      localSkillId: target.localSkillId,
      name: target.name,
      contentHash: reference.contentHash,
      createdAt: metadata.uploadedAt,
      files: published.files,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(reference), publicPackage);
    fixture.cloud = { revision: 1, skills: [reference] };
    const skillFile = path.join(target.path, 'SKILL.md');
    const markerFile = path.join(target.path, '.xiaoba-bot-skill.json');
    const previousSkill = fs.readFileSync(skillFile, 'utf8');
    const previousMarker = fs.readFileSync(markerFile, 'utf8');
    let scopeChecks = 0;

    await assert.rejects(
      fixture.finalize({
        localSkillId: target.localSkillId,
        skillName: target.name,
        reference,
      }, {
        validateScope: () => {
          scopeChecks += 1;
          if (scopeChecks === 3) {
            fixture.cloud = { revision: 2, skills: [] };
          }
        },
      }),
      /removed from BotDefinition during finalization/i,
    );
    assert.equal(fs.readFileSync(skillFile, 'utf8'), previousSkill);
    assert.equal(fs.readFileSync(markerFile, 'utf8'), previousMarker);
    assert.deepEqual(fixture.cloud.skills, []);
  });

  test('promotes a public marker over a same-hash private Base reference', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'shared-existing', 'shared-existing', 'same canonical body');
    const skillFile = path.join(fixture.skillsRoot, 'shared-existing', 'SKILL.md');
    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    };
    fs.writeFileSync(
      skillFile,
      applySkillHubLocalMetadata(fs.readFileSync(skillFile, 'utf8'), metadata),
    );
    await fixture.sync();
    const target = scanLocalBotSkill(path.join(fixture.skillsRoot, 'shared-existing'));
    const privateReference = fixture.cloud.skills[0];
    const reference = {
      source: 'skillhub' as const,
      skillId: 'alice/shared-existing',
      version: metadata.version,
      contentHash: target.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: { skillId: reference.skillId, version: reference.version },
      localSkillId: target.localSkillId,
      name: target.name,
      contentHash: target.contentHash,
      createdAt: metadata.uploadedAt,
      files: target.files,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(reference), publicPackage);
    fixture.cloud = {
      revision: fixture.cloud.revision + 1,
      skills: [privateReference, reference],
    };

    const result = await fixture.finalize({
      localSkillId: target.localSkillId,
      skillName: target.name,
      reference,
    });
    assert.equal(result.direction, 'local_to_cloud');
    assert.deepEqual(fixture.cloud.skills, [reference]);
    assert.deepEqual(
      new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId)?.skills[0].reference,
      reference,
    );
    assert.deepEqual(readBotSkillLocalMarker(target.path)?.reference, reference);
    assert.equal(fs.existsSync(path.join(
      fixture.runtimeRoot,
      'data',
      'bot-skills',
      'finalize-journal',
      fixture.botId,
      `${target.localSkillId}.json`,
    )), false);
  });

  test('halts a real public finalize before its cloud CAS when shutdown starts during package validation', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'shutdown-finalize', 'shutdown-finalize', 'published body');
    const skillFile = path.join(fixture.skillsRoot, 'shutdown-finalize', 'SKILL.md');
    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    };
    fs.writeFileSync(
      skillFile,
      applySkillHubLocalMetadata(fs.readFileSync(skillFile, 'utf8'), metadata),
    );
    await fixture.sync();
    const target = scanLocalBotSkill(path.join(fixture.skillsRoot, 'shutdown-finalize'));
    const privateReference = fixture.cloud.skills[0];
    const publicReference = {
      source: 'skillhub' as const,
      skillId: 'alice/shutdown-finalize',
      version: metadata.version,
      contentHash: target.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: { skillId: publicReference.skillId, version: publicReference.version },
      localSkillId: target.localSkillId,
      name: target.name,
      contentHash: target.contentHash,
      createdAt: metadata.uploadedAt,
      files: target.files,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(publicReference), publicPackage);
    fixture.cloud = {
      revision: fixture.cloud.revision + 1,
      skills: [privateReference, publicReference],
    };
    fixture.packageDownloads = 0;
    const previousSkill = fs.readFileSync(skillFile, 'utf8');
    const markerFile = path.join(target.path, BOT_SKILL_LOCAL_MARKER_FILE);
    const previousMarker = fs.readFileSync(markerFile, 'utf8');
    const previousBase = new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId);
    const previousCloud = structuredClone(fixture.cloud);
    const previousPatches = fixture.patches;
    let shuttingDown = false;

    await assert.rejects(
      fixture.finalize({
        localSkillId: target.localSkillId,
        skillName: target.name,
        reference: publicReference,
      }, {
        validateScope: () => {
          // The first public download is publication readiness; the second is
          // pushLocal's marker verification. Shutdown starts during that await.
          if (fixture.packageDownloads >= 2) shuttingDown = true;
          if (shuttingDown) throw new Error('connector shutdown');
        },
      }),
      /connector shutdown/i,
    );

    assert.equal(fs.readFileSync(skillFile, 'utf8'), previousSkill);
    assert.equal(fs.readFileSync(markerFile, 'utf8'), previousMarker);
    assert.deepEqual(new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId), previousBase);
    assert.deepEqual(fixture.cloud, previousCloud);
    assert.equal(fixture.patches, previousPatches);
  });

  test('recovers a public reference after a crash between SKILL.md and marker writes', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'crash-recovery', 'crash-recovery', 'published body');
    await fixture.sync();
    const beforeCrash = scanLocalBotSkill(path.join(fixture.skillsRoot, 'crash-recovery'));
    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    };
    const skillFile = path.join(beforeCrash.path, 'SKILL.md');
    const previousSkill = fs.readFileSync(skillFile, 'utf8');
    const previousMarker = fs.readFileSync(
      path.join(beforeCrash.path, BOT_SKILL_LOCAL_MARKER_FILE),
      'utf8',
    );
    fs.writeFileSync(
      skillFile,
      applySkillHubLocalMetadata(previousSkill, metadata),
      'utf8',
    );
    const afterSkillWrite = scanLocalBotSkill(beforeCrash.path);
    assert.equal(afterSkillWrite.reference, undefined);
    const publicReference = {
      source: 'skillhub' as const,
      skillId: 'alice/crash-recovery',
      version: metadata.version,
      contentHash: afterSkillWrite.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: { skillId: publicReference.skillId, version: publicReference.version },
      localSkillId: `public-${'a'.repeat(64)}`,
      name: afterSkillWrite.name,
      contentHash: afterSkillWrite.contentHash,
      createdAt: metadata.uploadedAt,
      files: afterSkillWrite.files,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(publicReference), publicPackage);
    fixture.cloud = {
      revision: fixture.cloud.revision + 1,
      skills: [publicReference],
    };
    const journalPath = writeFinalizeJournalFixture({
      runtimeRoot: fixture.runtimeRoot,
      skillsRoot: fixture.skillsRoot,
      botId: fixture.botId,
      before: beforeCrash,
      after: afterSkillWrite,
      reference: publicReference,
      previousSkill,
      previousMarker,
    });
    const uploadsBeforeRecovery = fixture.uploads;

    const recovered = await fixture.sync();

    assert.equal(recovered.direction, 'local_to_cloud');
    assert.equal(fixture.uploads, uploadsBeforeRecovery);
    assert.deepEqual(fixture.cloud.skills, [publicReference]);
    assert.deepEqual(readBotSkillLocalMarker(beforeCrash.path)?.reference, publicReference);
    assert.deepEqual(
      new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId)?.skills[0].reference,
      publicReference,
    );
    assert.equal(fs.existsSync(journalPath), false);
  });

  test('rolls back an interrupted public finalize when its cloud reference was removed', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'crash-rollback', 'crash-rollback', 'original body');
    await fixture.sync();
    const beforeCrash = scanLocalBotSkill(path.join(fixture.skillsRoot, 'crash-rollback'));
    const skillFile = path.join(beforeCrash.path, 'SKILL.md');
    const markerFile = path.join(beforeCrash.path, BOT_SKILL_LOCAL_MARKER_FILE);
    const previousSkill = fs.readFileSync(skillFile, 'utf8');
    const previousMarker = fs.readFileSync(markerFile, 'utf8');
    fs.writeFileSync(skillFile, applySkillHubLocalMetadata(previousSkill, {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    }), 'utf8');
    const afterSkillWrite = scanLocalBotSkill(beforeCrash.path);
    const removedReference = {
      source: 'skillhub' as const,
      skillId: 'alice/crash-rollback',
      version: '1.0.0',
      contentHash: afterSkillWrite.contentHash,
    };
    const journalPath = writeFinalizeJournalFixture({
      runtimeRoot: fixture.runtimeRoot,
      skillsRoot: fixture.skillsRoot,
      botId: fixture.botId,
      before: beforeCrash,
      after: afterSkillWrite,
      reference: removedReference,
      previousSkill,
      previousMarker,
    });
    const uploadsBeforeRecovery = fixture.uploads;

    const recovered = await fixture.sync();

    assert.equal(recovered.direction, 'none');
    assert.equal(fs.readFileSync(skillFile, 'utf8'), previousSkill);
    assert.equal(fs.readFileSync(markerFile, 'utf8'), previousMarker);
    assert.equal(fixture.uploads, uploadsBeforeRecovery);
    assert.equal(fs.existsSync(journalPath), false);
  });

  test('rolls forward a pre-write finalize without Base instead of uploading private', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'pre-write', 'pre-write', 'published body');
    await fixture.sync();
    const before = scanLocalBotSkill(path.join(fixture.skillsRoot, 'pre-write'));
    const skillFile = path.join(before.path, 'SKILL.md');
    const previousSkill = fs.readFileSync(skillFile, 'utf8');
    const previousMarker = fs.readFileSync(
      path.join(before.path, BOT_SKILL_LOCAL_MARKER_FILE),
      'utf8',
    );
    const nextSkill = applySkillHubLocalMetadata(previousSkill, {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    });
    fs.writeFileSync(skillFile, nextSkill, 'utf8');
    const after = scanLocalBotSkill(before.path);
    fs.writeFileSync(skillFile, previousSkill, 'utf8');
    const reference = {
      source: 'skillhub' as const,
      skillId: 'alice/pre-write',
      version: '1.0.0',
      contentHash: after.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: { skillId: reference.skillId, version: reference.version },
      localSkillId: `public-${'c'.repeat(64)}`,
      name: after.name,
      contentHash: after.contentHash,
      createdAt: '2026-08-06T00:00:00.000Z',
      files: after.files,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(reference), publicPackage);
    fixture.cloud = { revision: fixture.cloud.revision + 1, skills: [reference] };
    const journalPath = writeFinalizeJournalFixture({
      runtimeRoot: fixture.runtimeRoot,
      skillsRoot: fixture.skillsRoot,
      botId: fixture.botId,
      before,
      after,
      reference,
      previousSkill,
      nextSkill,
      previousMarker,
    });
    fs.rmSync(path.join(
      fixture.runtimeRoot,
      'data',
      'bot-skills',
      'sync-base',
      `${fixture.botId}.json`,
    ));
    const uploadsBeforeRecovery = fixture.uploads;

    await fixture.sync();

    assert.equal(fixture.uploads, uploadsBeforeRecovery);
    assert.equal(fs.readFileSync(skillFile, 'utf8'), nextSkill);
    assert.deepEqual(readBotSkillLocalMarker(before.path)?.reference, reference);
    assert.deepEqual(fixture.cloud.skills, [reference]);
    assert.deepEqual(
      new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId)?.skills[0].reference,
      reference,
    );
    assert.equal(fs.existsSync(journalPath), false);
  });

  test('does not attach a recovered public reference to an identical local sibling', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'selected-copy', 'duplicate-name', 'same body');
    writeSkill(fixture.skillsRoot, 'other-copy', 'duplicate-name', 'same body');
    await fixture.sync();
    const initial = scanBotSkillWorkspace(fixture.skillsRoot);
    const selectedBefore = initial.find(entry => entry.installName === 'selected-copy');
    const otherBefore = initial.find(entry => entry.installName === 'other-copy');
    assert.ok(selectedBefore);
    assert.ok(otherBefore);
    const baseBefore = new BotSkillBaseStore(fixture.runtimeRoot).read(fixture.botId);
    const selectedBase = baseBefore?.skills.find(entry => entry.localSkillId === selectedBefore.localSkillId);
    const otherBase = baseBefore?.skills.find(entry => entry.localSkillId === otherBefore.localSkillId);
    assert.ok(selectedBase);
    assert.ok(otherBase);
    const selectedSkillFile = path.join(selectedBefore.path, 'SKILL.md');
    const selectedPreviousSkill = fs.readFileSync(selectedSkillFile, 'utf8');
    const selectedPreviousMarker = fs.readFileSync(
      path.join(selectedBefore.path, BOT_SKILL_LOCAL_MARKER_FILE),
      'utf8',
    );

    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    };
    for (const entry of [selectedBefore, otherBefore]) {
      const skillFile = path.join(entry.path, 'SKILL.md');
      fs.writeFileSync(
        skillFile,
        applySkillHubLocalMetadata(fs.readFileSync(skillFile, 'utf8'), metadata),
        'utf8',
      );
    }
    const selectedAfter = scanLocalBotSkill(selectedBefore.path);
    const otherAfter = scanLocalBotSkill(otherBefore.path);
    assert.equal(selectedAfter.contentHash, otherAfter.contentHash);
    const publicReference = {
      source: 'skillhub' as const,
      skillId: 'alice/duplicate-name',
      version: metadata.version,
      contentHash: selectedAfter.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: { skillId: publicReference.skillId, version: publicReference.version },
      localSkillId: `public-${'b'.repeat(64)}`,
      name: selectedAfter.name,
      contentHash: selectedAfter.contentHash,
      createdAt: metadata.uploadedAt,
      files: selectedAfter.files,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(publicReference), publicPackage);
    fixture.cloud = {
      revision: fixture.cloud.revision + 1,
      skills: [publicReference, otherBase.reference],
    };
    writeFinalizeJournalFixture({
      runtimeRoot: fixture.runtimeRoot,
      skillsRoot: fixture.skillsRoot,
      botId: fixture.botId,
      before: selectedBefore,
      after: selectedAfter,
      reference: publicReference,
      previousSkill: selectedPreviousSkill,
      previousMarker: selectedPreviousMarker,
    });
    const uploadsBeforeRecovery = fixture.uploads;

    await fixture.sync();

    assert.deepEqual(readBotSkillLocalMarker(selectedAfter.path)?.reference, publicReference);
    const otherReference = readBotSkillLocalMarker(otherAfter.path)?.reference;
    assert.ok(otherReference);
    assert.notEqual(otherReference.skillId, publicReference.skillId);
    assert.equal(fixture.uploads, uploadsBeforeRecovery + 1);
    assert.equal(fixture.cloud.skills.some(reference => reference.skillId === publicReference.skillId), true);
    assert.equal(fixture.cloud.skills.some(reference => reference.skillId === otherReference.skillId), true);
  });

  test('lets local rename, move, and delete win over an interrupted finalize', async t => {
    for (const action of ['rename', 'move', 'delete'] as const) {
      await t.test(action, async () => {
        const fixture = createFixture(roots);
        const originalName = `journal-${action}`;
        writeSkill(fixture.skillsRoot, originalName, originalName, 'original body');
        await fixture.sync();
        const before = scanLocalBotSkill(path.join(fixture.skillsRoot, originalName));
        const skillFile = path.join(before.path, 'SKILL.md');
        const previousSkill = fs.readFileSync(skillFile, 'utf8');
        const previousMarker = fs.readFileSync(
          path.join(before.path, BOT_SKILL_LOCAL_MARKER_FILE),
          'utf8',
        );
        const nextSkill = applySkillHubLocalMetadata(previousSkill, {
          author: 'alice',
          version: '1.0.0',
          uploadedAt: '2026-08-06T00:00:00.000Z',
        });
        fs.writeFileSync(skillFile, nextSkill, 'utf8');
        const after = scanLocalBotSkill(before.path);
        const reference = {
          source: 'skillhub' as const,
          skillId: `alice/${originalName}`,
          version: '1.0.0',
          contentHash: after.contentHash,
        };
        fixture.cloud = { revision: fixture.cloud.revision + 1, skills: [reference] };
        const journalPath = writeFinalizeJournalFixture({
          runtimeRoot: fixture.runtimeRoot,
          skillsRoot: fixture.skillsRoot,
          botId: fixture.botId,
          before,
          after,
          reference,
          previousSkill,
          nextSkill,
          previousMarker,
        });
        let expectedPath = before.path;
        if (action === 'rename') {
          fs.writeFileSync(
            skillFile,
            nextSkill.replace(`name: ${originalName}`, `name: ${originalName}-renamed`),
            'utf8',
          );
        } else if (action === 'move') {
          expectedPath = `${before.path}-moved`;
          fs.renameSync(before.path, expectedPath);
        } else {
          fs.rmSync(before.path, { recursive: true, force: true });
        }
        const uploadsBeforeRecovery = fixture.uploads;

        await fixture.sync();

        assert.equal(fs.existsSync(journalPath), false);
        assert.equal(fixture.cloud.skills.some(item => item.skillId === reference.skillId), false);
        if (action === 'delete') {
          assert.equal(scanBotSkillWorkspace(fixture.skillsRoot).length, 0);
          assert.equal(fixture.uploads, uploadsBeforeRecovery);
          return;
        }
        const current = scanBotSkillWorkspace(fixture.skillsRoot).find(entry => (
          entry.localSkillId === before.localSkillId
        ));
        assert.ok(current);
        assert.equal(current.path, expectedPath);
        assert.equal(current.name, action === 'rename' ? `${originalName}-renamed` : originalName);
        assert.equal(fixture.uploads, uploadsBeforeRecovery + 1);
      });
    }
  });

  test('waits for a delayed public package and times out without changing Local or Base', async () => {
    const fixture = createFixture(roots);
    writeSkill(fixture.skillsRoot, 'shared-delay', 'shared-delay', 'delayed package');
    const target = scanLocalBotSkill(path.join(fixture.skillsRoot, 'shared-delay'));
    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    };
    const publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-public-delay-'));
    roots.push(publicRoot);
    writeSkill(publicRoot, 'shared-delay', 'shared-delay', 'delayed package');
    const publicSkillFile = path.join(publicRoot, 'shared-delay', 'SKILL.md');
    fs.writeFileSync(
      publicSkillFile,
      applySkillHubLocalMetadata(fs.readFileSync(publicSkillFile, 'utf8'), metadata),
    );
    const published = scanLocalBotSkill(path.join(publicRoot, 'shared-delay'));
    const reference = {
      source: 'skillhub' as const,
      skillId: 'alice/shared-delay',
      version: metadata.version,
      contentHash: published.contentHash,
    };
    const publicPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: { skillId: reference.skillId, version: reference.version },
      localSkillId: target.localSkillId,
      name: target.name,
      contentHash: reference.contentHash,
      createdAt: metadata.uploadedAt,
      files: published.files,
    };
    delete (publicPackage as Partial<BotSkillPackage>).schema;
    fixture.packages.set(refKey(reference), publicPackage);
    fixture.cloud = { revision: 1, skills: [reference] };
    fixture.publicDownloadMisses = 1;

    const ready = await fixture.finalize({
      localSkillId: target.localSkillId,
      skillName: target.name,
      reference,
    }, { publicationWaitMs: 100, pollDelayMs: 25 });
    assert.equal(ready.direction, 'local_to_cloud');
    assert.deepEqual(readBotSkillLocalMarker(target.path)?.reference, reference);

    const timeoutFixture = createFixture(roots);
    writeSkill(timeoutFixture.skillsRoot, 'shared-timeout', 'shared-timeout', 'never ready');
    const timeoutTarget = scanLocalBotSkill(path.join(timeoutFixture.skillsRoot, 'shared-timeout'));
    const timeoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-public-timeout-'));
    roots.push(timeoutRoot);
    writeSkill(timeoutRoot, 'shared-timeout', 'shared-timeout', 'never ready');
    const timeoutSkillFile = path.join(timeoutRoot, 'shared-timeout', 'SKILL.md');
    fs.writeFileSync(
      timeoutSkillFile,
      applySkillHubLocalMetadata(fs.readFileSync(timeoutSkillFile, 'utf8'), metadata),
    );
    const timeoutPublished = scanLocalBotSkill(path.join(timeoutRoot, 'shared-timeout'));
    const timeoutReference = {
      source: 'skillhub' as const,
      skillId: 'alice/shared-timeout',
      version: metadata.version,
      contentHash: timeoutPublished.contentHash,
    };
    const timeoutPackage: BotSkillPackage = {
      schema: 'catsco.private-skill-package.v1',
      source: 'public',
      reference: { skillId: timeoutReference.skillId, version: timeoutReference.version },
      localSkillId: timeoutTarget.localSkillId,
      name: timeoutTarget.name,
      contentHash: timeoutReference.contentHash,
      createdAt: metadata.uploadedAt,
      files: timeoutPublished.files,
    };
    delete (timeoutPackage as Partial<BotSkillPackage>).schema;
    timeoutFixture.packages.set(refKey(timeoutReference), timeoutPackage);
    timeoutFixture.cloud = { revision: 1, skills: [timeoutReference] };
    timeoutFixture.publicDownloadMisses = 100;
    const previousSkill = fs.readFileSync(path.join(timeoutTarget.path, 'SKILL.md'), 'utf8');
    const previousMarker = fs.readFileSync(path.join(timeoutTarget.path, '.xiaoba-bot-skill.json'), 'utf8');

    await assert.rejects(
      timeoutFixture.finalize({
        localSkillId: timeoutTarget.localSkillId,
        skillName: timeoutTarget.name,
        reference: timeoutReference,
      }, { publicationWaitMs: 30, pollDelayMs: 25 }),
      (error: any) => error?.code === 'PUBLIC_SKILL_NOT_READY',
    );
    assert.equal(fs.readFileSync(path.join(timeoutTarget.path, 'SKILL.md'), 'utf8'), previousSkill);
    assert.equal(fs.readFileSync(path.join(timeoutTarget.path, '.xiaoba-bot-skill.json'), 'utf8'), previousMarker);
    assert.equal(new BotSkillBaseStore(timeoutFixture.runtimeRoot).read(timeoutFixture.botId), undefined);
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
    removeSkillsOnConflict: false,
    cloudReadStatus: 200,
    patchStatus: 200,
    publicDownloadMisses: 0,
    packageDownloads: 0,
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
    finalize: async (input: {
      localSkillId: string;
      skillName: string;
      reference: BotSkillRef;
    }, options: {
      validateScope?: () => Promise<void> | void;
      publicationWaitMs?: number;
      pollDelayMs?: number;
    } = {}) => new BotSkillSyncService({
      runtimeRoot,
      skillsRoot,
      botId,
      workspaceExisted: true,
      auth: {
        apiKey: 'bot-key',
        httpBaseUrl: 'https://cats.test',
        serverUrl: 'wss://cats.test',
      },
      fetchImpl,
      skillHubBaseUrl: 'https://hub.test',
      definitionService,
    }).finalizePublicSkill(input, { publicationWaitMs: 0, ...options }),
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
          ...(fixture.removeSkillsOnConflict ? { skills: [] } : {}),
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
      fixture.packageDownloads += 1;
      const packageValue = [...fixture.packages.values()].find(item => (
        url.pathname.includes(item.reference.version)
        && url.pathname.includes(item.reference.skillId.split('/').at(-1) || '')
      ));
      if (packageValue?.source === 'public' && fixture.publicDownloadMisses > 0) {
        fixture.publicDownloadMisses -= 1;
        return Response.json({ error: 'not ready' }, { status: 404 });
      }
      return packageValue
        ? Response.json(packageValue)
        : Response.json({ error: 'not found' }, { status: 404 });
    }
    return Response.json({ error: 'unexpected request' }, { status: 500 });
  }

  return fixture;
}

function writeFinalizeJournalFixture(input: {
  runtimeRoot: string;
  skillsRoot: string;
  botId: string;
  before: LocalBotSkillManifestEntry;
  after: LocalBotSkillManifestEntry;
  reference: BotSkillRef;
  previousSkill: string;
  nextSkill?: string;
  previousMarker: string;
}): string {
  const journalDirectory = path.join(
    input.runtimeRoot,
    'data',
    'bot-skills',
    'finalize-journal',
    input.botId,
  );
  fs.mkdirSync(journalDirectory, { recursive: true });
  const journalPath = path.join(journalDirectory, `${input.after.localSkillId}.json`);
  fs.writeFileSync(journalPath, `${JSON.stringify({
    schema: 'xiaoba.bot-skill-finalize-journal.v1',
    botId: input.botId,
    skillsRoot: input.skillsRoot,
    skillPath: input.after.path,
    localSkillId: input.after.localSkillId,
    skillName: input.after.name,
    previousContentHash: input.before.contentHash,
    nextContentHash: input.after.contentHash,
    reference: input.reference,
    previousSkill: input.previousSkill,
    nextSkill: input.nextSkill ?? fs.readFileSync(path.join(input.after.path, 'SKILL.md'), 'utf8'),
    previousMarker: input.previousMarker,
  }, null, 2)}\n`, 'utf8');
  return journalPath;
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
