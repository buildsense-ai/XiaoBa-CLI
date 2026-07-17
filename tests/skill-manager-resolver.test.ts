import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillManager } from '../src/skills/skill-manager';
import {
  emptyCurrentSkillRegistryState,
  loadCurrentSkillRegistry,
  reconcileActiveGeneratedSkillArtifacts,
  saveCurrentSkillRegistry,
} from '../src/utils/skill-evolution';

describe('SkillManager canonical route resolution', () => {
  let root: string;
  let previousDataRoot: string | undefined;
  let previousSkillsDir: string | undefined;
  let previousRegistryPath: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-resolver-'));
    previousDataRoot = process.env.XIAOBA_USER_DATA_DIR;
    previousSkillsDir = process.env.XIAOBA_SKILLS_DIR;
    previousRegistryPath = process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE;
    process.env.XIAOBA_USER_DATA_DIR = root;
    process.env.XIAOBA_SKILLS_DIR = path.join(root, 'skills');
    process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE = path.join(root, 'data', 'current-skill-registry.json');
  });

  afterEach(() => {
    if (previousDataRoot === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousDataRoot;
    if (previousSkillsDir === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = previousSkillsDir;
    if (previousRegistryPath === undefined) delete process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE;
    else process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE = previousRegistryPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('follows a generated route redirect without listing the retired route', async () => {
    const handle = 'cap_123';
    const skillPath = path.join(root, 'skills', 'generated-distilled', handle, 'SKILL.md');
    const guidanceHash = writeSkill(skillPath, 'flashcard-image-generation');
    writeSkill(path.join(root, 'skills', 'generated-distilled', handle, 'history', 'old-hash', 'SKILL.md'), 'settled-artifact-delivery');
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.routeRedirects = { 'settled-artifact-delivery': handle };
    registry.capabilities[handle] = {
      handle,
      revision: 2,
      routingName: 'flashcard-image-generation',
      description: 'Generate flashcard images.',
      skillFilePath: skillPath,
      guidanceHash,
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);

    const manager = new SkillManager();
    await manager.loadSkills();
    const resolution = await manager.resolveSkill('settled-artifact-delivery');
    assert.equal(resolution?.redirected, true);
    assert.equal(resolution?.requestedName, 'settled-artifact-delivery');
    assert.equal(resolution?.resolvedName, 'flashcard-image-generation');
    assert.deepEqual(manager.getAllSkills().map(skill => skill.metadata.name), ['flashcard-image-generation']);
  });

  test('refreshes lazily when Registry catalogRevision changes', async () => {
    const handle = 'cap_456';
    const firstPath = path.join(root, 'skills', 'generated-distilled', handle, 'SKILL.md');
    const firstHash = writeSkill(firstPath, 'flashcard-image-delivery');
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.capabilities[handle] = {
      handle,
      revision: 1,
      routingName: 'flashcard-image-delivery',
      description: 'Generate flashcard images.',
      skillFilePath: firstPath,
      guidanceHash: firstHash,
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);

    const manager = new SkillManager();
    await manager.loadSkills();
    assert.equal((await manager.resolveSkill('flashcard-image-delivery'))?.resolvedName, 'flashcard-image-delivery');

    const nextPath = path.join(root, 'skills', 'generated-distilled', handle, 'SKILL.md');
    const nextHash = writeSkill(nextPath, 'flashcard-image-generation');
    registry.catalogRevision = 2;
    registry.capabilities[handle]!.routingName = 'flashcard-image-generation';
    registry.capabilities[handle]!.skillFilePath = nextPath;
    registry.capabilities[handle]!.guidanceHash = nextHash;
    registry.routeRedirects = { 'flashcard-image-delivery': handle };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);

    const resolution = await manager.resolveSkill('flashcard-image-delivery');
    assert.equal(resolution?.redirected, true);
    assert.equal(resolution?.resolvedName, 'flashcard-image-generation');
  });

  test('synchronous discovery refreshes active generated routes after catalog changes', async () => {
    const manualPath = path.join(root, 'skills', 'manual-workflow', 'SKILL.md');
    const retiredPath = path.join(root, 'skills', 'generated-distilled', 'cap_retired', 'SKILL.md');
    const activePath = path.join(root, 'skills', 'generated-distilled', 'cap_active', 'SKILL.md');
    writeSkill(manualPath, 'manual-workflow');
    const retiredHash = writeSkill(retiredPath, 'old-generated-route');
    const activeHash = writeSkill(activePath, 'current-generated-route');

    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.capabilities.cap_retired = {
      handle: 'cap_retired',
      revision: 1,
      routingName: 'old-generated-route',
      description: 'Retired generated route.',
      skillFilePath: retiredPath,
      guidanceHash: retiredHash,
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);

    const manager = new SkillManager();
    await manager.loadSkills();
    assert.deepEqual(
      manager.getAllSkills().map(skill => skill.metadata.name).sort(),
      ['manual-workflow', 'old-generated-route'],
    );

    delete registry.capabilities.cap_retired;
    registry.catalogRevision = 2;
    registry.capabilities.cap_active = {
      handle: 'cap_active',
      revision: 1,
      routingName: 'current-generated-route',
      description: 'Current generated route.',
      skillFilePath: activePath,
      guidanceHash: activeHash,
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);

    assert.deepEqual(
      manager.getAllSkills().map(skill => skill.metadata.name).sort(),
      ['current-generated-route', 'manual-workflow'],
    );
    assert.deepEqual(
      manager.getUserInvocableSkills().map(skill => skill.metadata.name).sort(),
      ['current-generated-route', 'manual-workflow'],
    );
  });

  test('resolves a retired route in one hop through the current Capability route', async () => {
    const firstHandle = 'cap_first';
    const secondHandle = 'cap_second';
    const firstPath = path.join(root, 'skills', 'generated-distilled', firstHandle, 'SKILL.md');
    const secondPath = path.join(root, 'skills', 'generated-distilled', secondHandle, 'SKILL.md');
    const firstHash = writeSkill(firstPath, 'intermediate-route');
    const secondHash = writeSkill(secondPath, 'current-route');
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.routeRedirects = {
      'retired-route': firstHandle,
    };
    registry.capabilities[firstHandle] = {
      handle: firstHandle,
      revision: 2,
      routingName: 'intermediate-route',
      description: 'Intermediate route.',
      skillFilePath: firstPath,
      guidanceHash: firstHash,
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    registry.capabilities[secondHandle] = {
      handle: secondHandle,
      revision: 1,
      routingName: 'current-route',
      description: 'Current route.',
      skillFilePath: secondPath,
      guidanceHash: secondHash,
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);

    const manager = new SkillManager();
    await manager.loadSkills();
    const resolution = await manager.resolveSkill('retired-route');
    assert.equal(resolution?.resolvedName, 'intermediate-route');
    assert.equal(resolution?.skill.content.includes('current-route'), false);
  });

  test('fails closed when a redirect points to a missing Capability Handle', async () => {
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.routeRedirects = { 'old-route': 'cap-missing' };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);
    const manager = new SkillManager();
    await manager.loadSkills();
    assert.equal(await manager.resolveSkill('old-route'), undefined);
  });

  test('excludes retired generated files from discovery when the Registry is authoritative', async () => {
    const activeHandle = 'cap_active';
    const retiredPath = path.join(root, 'skills', 'generated-distilled', 'cap_retired', 'SKILL.md');
    const activePath = path.join(root, 'skills', 'generated-distilled', activeHandle, 'SKILL.md');
    writeSkill(retiredPath, 'settled-artifact-delivery');
    const activeHash = writeSkill(activePath, 'flashcard-image-generation');
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 3;
    registry.routeRedirects = { 'settled-artifact-delivery': activeHandle };
    registry.capabilities[activeHandle] = {
      handle: activeHandle,
      revision: 2,
      routingName: 'flashcard-image-generation',
      description: 'Generate flashcard images.',
      skillFilePath: activePath,
      guidanceHash: activeHash,
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);

    const manager = new SkillManager();
    await manager.loadSkills();
    assert.deepEqual(manager.getAllSkills().map(skill => skill.metadata.name), ['flashcard-image-generation']);
    assert.equal((await manager.resolveSkill('settled-artifact-delivery'))?.resolvedName, 'flashcard-image-generation');
  });

  test('fails closed for invalid redirect state instead of discovering orphaned generated files', async () => {
    const orphanPath = path.join(root, 'skills', 'generated-distilled', 'cap-orphan', 'SKILL.md');
    writeSkill(orphanPath, 'orphan-generated-route');
    fs.mkdirSync(path.dirname(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!), { recursive: true });
    fs.writeFileSync(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, JSON.stringify({
      schemaVersion: 2,
      catalogRevision: 1,
      capabilities: {},
      routeRedirects: { 'retired-route': 'cap-missing' },
    }), 'utf8');

    const manager = new SkillManager();
    await manager.loadSkills();
    assert.deepEqual(manager.getAllSkills(), []);
    assert.equal(await manager.resolveSkill('orphan-generated-route'), undefined);
  });

  test('fails closed for a redirect that reuses an active route', async () => {
    const activePath = path.join(root, 'skills', 'generated-distilled', 'cap-active', 'SKILL.md');
    const activeHash = writeSkill(activePath, 'active-route');
    fs.mkdirSync(path.dirname(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!), { recursive: true });
    fs.writeFileSync(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, JSON.stringify({
      schemaVersion: 2,
      catalogRevision: 1,
      capabilities: {
        'cap-active': {
          handle: 'cap-active', revision: 1, routingName: 'active-route', description: 'Active',
          skillFilePath: activePath, guidanceHash: activeHash, evidenceRefs: [], referencedSkills: [],
          createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        },
      },
      routeRedirects: { 'active-route': 'cap-active' },
    }), 'utf8');

    const manager = new SkillManager();
    await manager.loadSkills();
    assert.deepEqual(manager.getAllSkills(), []);
  });

  test('fails closed for malformed Registry JSON without widening discovery on refresh', async () => {
    const orphanPath = path.join(root, 'skills', 'generated-distilled', 'cap-orphan', 'SKILL.md');
    writeSkill(orphanPath, 'orphan-generated-route');
    fs.mkdirSync(path.dirname(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!), { recursive: true });
    fs.writeFileSync(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, '{not-json', 'utf8');

    const manager = new SkillManager();
    await manager.loadSkills();
    assert.deepEqual(manager.getAllSkills(), []);
    assert.equal(await manager.resolveSkill('orphan-generated-route'), undefined);
  });

  test('fails closed for redirect cycles instead of following a multi-hop alias', async () => {
    const orphanPath = path.join(root, 'skills', 'generated-distilled', 'cap-a', 'SKILL.md');
    const aHash = writeSkill(orphanPath, 'orphan-generated-route');
    fs.mkdirSync(path.dirname(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!), { recursive: true });
    fs.writeFileSync(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, JSON.stringify({
      schemaVersion: 2,
      catalogRevision: 1,
      capabilities: {
        'cap-a': {
          handle: 'cap-a', revision: 1, routingName: 'route-a', description: 'A',
          skillFilePath: orphanPath, guidanceHash: aHash, evidenceRefs: [], referencedSkills: [],
          createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        },
        'cap-b': {
          handle: 'cap-b', revision: 1, routingName: 'route-b', description: 'B',
          skillFilePath: path.join(root, 'skills', 'generated-distilled', 'cap-b', 'SKILL.md'), guidanceHash: 'hash-b',
          evidenceRefs: [], referencedSkills: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        },
      },
      routeRedirects: { 'old-a': 'cap-b', 'cap-b': 'cap-a' },
    }), 'utf8');

    const manager = new SkillManager();
    await manager.loadSkills();
    assert.deepEqual(manager.getAllSkills(), []);
  });

  test('detects missing active SKILL.md and restores only from authoritative history', () => {
    const handle = 'cap_restore';
    const skillPath = path.join(root, 'skills', 'generated-distilled', handle, 'SKILL.md');
    const guidanceHash = writeSkill(skillPath, 'restored-route');
    const historyPath = path.join(root, 'skills', 'generated-distilled', handle, 'history', guidanceHash, 'SKILL.md');
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.copyFileSync(skillPath, historyPath);
    fs.rmSync(skillPath);

    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.capabilities[handle] = {
      handle,
      revision: 1,
      routingName: 'restored-route',
      description: 'Restored from history.',
      skillFilePath: skillPath,
      guidanceHash,
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);

    const loaded = loadCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!);
    const reconciled = reconcileActiveGeneratedSkillArtifacts(loaded);
    assert.equal(reconciled.repaired, true);
    assert.equal(fs.existsSync(skillPath), true);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex'),
      guidanceHash,
    );
  });

  test('fails closed when active SKILL.md is missing and no history snapshot exists', () => {
    const handle = 'cap_missing';
    const skillPath = path.join(root, 'skills', 'generated-distilled', handle, 'SKILL.md');
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.capabilities[handle] = {
      handle,
      revision: 1,
      routingName: 'missing-route',
      description: 'Missing artifact.',
      skillFilePath: skillPath,
      guidanceHash: 'deadbeef',
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);
    const loaded = loadCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!);
    assert.throws(
      () => reconcileActiveGeneratedSkillArtifacts(loaded),
      /Active generated skill invariant violated|SKILL\.md is missing/i,
    );
  });
});

function writeSkill(filePath: string, name: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = `---\nname: ${name}\ndescription: Generated skill\n---\n\nUse the capability.\n`;
  fs.writeFileSync(filePath, content, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex');
}
