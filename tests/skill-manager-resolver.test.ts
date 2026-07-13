import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillManager, StaleSkillRedirectError } from '../src/skills/skill-manager';
import { emptyCurrentSkillRegistryState, saveCurrentSkillRegistry } from '../src/utils/skill-evolution';

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
    writeSkill(skillPath, 'flashcard-image-generation');
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
      guidanceHash: 'hash',
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
    writeSkill(firstPath, 'flashcard-image-delivery');
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.capabilities[handle] = {
      handle,
      revision: 1,
      routingName: 'flashcard-image-delivery',
      description: 'Generate flashcard images.',
      skillFilePath: firstPath,
      guidanceHash: 'hash-a',
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
    writeSkill(nextPath, 'flashcard-image-generation');
    registry.catalogRevision = 2;
    registry.capabilities[handle]!.routingName = 'flashcard-image-generation';
    registry.capabilities[handle]!.skillFilePath = nextPath;
    registry.routeRedirects = { 'flashcard-image-delivery': handle };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);

    const resolution = await manager.resolveSkill('flashcard-image-delivery');
    assert.equal(resolution?.redirected, true);
    assert.equal(resolution?.resolvedName, 'flashcard-image-generation');
  });

  test('resolves a retired route in one hop through the current Capability route', async () => {
    const firstHandle = 'cap_first';
    const secondHandle = 'cap_second';
    const firstPath = path.join(root, 'skills', 'generated-distilled', firstHandle, 'SKILL.md');
    const secondPath = path.join(root, 'skills', 'generated-distilled', secondHandle, 'SKILL.md');
    writeSkill(firstPath, 'intermediate-route');
    writeSkill(secondPath, 'current-route');
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.routeRedirects = {
      'retired-route': firstHandle,
      'intermediate-route': secondHandle,
    };
    registry.capabilities[firstHandle] = {
      handle: firstHandle,
      revision: 2,
      routingName: 'intermediate-route',
      description: 'Intermediate route.',
      skillFilePath: firstPath,
      guidanceHash: 'hash-first',
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
      guidanceHash: 'hash-second',
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

  test('fails explicitly when a redirect points to a missing Capability Handle', async () => {
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.routeRedirects = { 'old-route': 'cap-missing' };
    saveCurrentSkillRegistry(process.env.XIAOBA_SKILL_EVOLUTION_REGISTRY_FILE!, registry);
    const manager = new SkillManager();
    await manager.loadSkills();
    await assert.rejects(
      () => manager.resolveSkill('old-route'),
      (error: unknown) => error instanceof StaleSkillRedirectError && error.code === 'STALE_SKILL_REDIRECT',
    );
  });

  test('excludes retired generated files from discovery when the Registry is authoritative', async () => {
    const activeHandle = 'cap_active';
    const retiredPath = path.join(root, 'skills', 'generated-distilled', 'cap_retired', 'SKILL.md');
    const activePath = path.join(root, 'skills', 'generated-distilled', activeHandle, 'SKILL.md');
    writeSkill(retiredPath, 'settled-artifact-delivery');
    writeSkill(activePath, 'flashcard-image-generation');
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 3;
    registry.routeRedirects = { 'settled-artifact-delivery': activeHandle };
    registry.capabilities[activeHandle] = {
      handle: activeHandle,
      revision: 2,
      routingName: 'flashcard-image-generation',
      description: 'Generate flashcard images.',
      skillFilePath: activePath,
      guidanceHash: 'hash',
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
});

function writeSkill(filePath: string, name: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: Generated skill\n---\n\nUse the capability.\n`, 'utf8');
}
