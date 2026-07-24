import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';

import { registerSkillCommand } from '../src/commands/skill';
import { SkillManager } from '../src/skills/skill-manager';
import { Logger } from '../src/utils/logger';
import { defaultDistilledOutputDir } from '../src/utils/path-resolver';
import {
  computeCurrentSkillRegistryHash,
  emptyCurrentSkillRegistryState,
  loadCurrentSkillRegistry,
  loadTransitionAudit,
  reconcileActiveGeneratedSkillArtifacts,
  saveCurrentSkillRegistry,
  type CurrentSkillRecord,
} from '../src/utils/skill-evolution';
import {
  inspectGeneratedSkillRetirement,
  retireGeneratedSkill,
  type GeneratedSkillControlOptions,
} from '../src/utils/generated-skill-control';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function seedGeneratedSkill(root: string, routingName = 'validated-report-delivery') {
  const skillsRoot = path.join(root, 'skills');
  const outputDir = defaultDistilledOutputDir(skillsRoot);
  const handle = 'cap_control_test';
  const skillFilePath = path.join(outputDir, handle, 'SKILL.md');
  const content = [
    '---',
    `name: ${routingName}`,
    'description: Deliver a validated report.',
    'user-invocable: true',
    `x-xiaoba-capability-handle: ${handle}`,
    '---',
    '',
    'Use the bounded report workflow and verify the delivered artifact.',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(skillFilePath), { recursive: true });
  fs.writeFileSync(skillFilePath, content, 'utf8');
  const record: CurrentSkillRecord = {
    handle,
    revision: 1,
    routingName,
    description: 'Deliver a validated report.',
    skillFilePath,
    guidanceHash: hash(content),
    evidenceRefs: [{ ref: 'episode:control:request' }],
    referencedSkills: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const registryPath = path.join(root, 'data', 'current-skill-registry.json');
  const auditPath = path.join(root, 'data', 'transition-audit.jsonl');
  const journalPath = path.join(root, 'data', 'transition-journal.json');
  const registry = emptyCurrentSkillRegistryState();
  registry.capabilities[handle] = record;
  registry.routeRedirects[`${routingName}-legacy`] = handle;
  saveCurrentSkillRegistry(registryPath, registry);
  return {
    skillsRoot,
    outputDir,
    content,
    record,
    registryPath,
    auditPath,
    journalPath,
    options: {
      workingDirectory: root,
      outputDir,
      registryPath,
      auditPath,
      journalPath,
      branchLogRoot: path.join(root, 'logs', 'branches'),
    } satisfies GeneratedSkillControlOptions,
  };
}

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSkillCommand(program);
  await program.parseAsync(['node', 'test', ...args]);
}

test('retiring a generated Current Skill removes discovery, preserves immutable history, and is idempotent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-generated-control-'));
  try {
    const seeded = seedGeneratedSkill(root);
    const originalRegistry = loadCurrentSkillRegistry(seeded.registryPath);
    const first = retireGeneratedSkill(seeded.record.routingName, seeded.options);

    assert.equal(first.status, 'retired');
    assert.equal(fs.existsSync(seeded.record.skillFilePath), false);
    assert.equal(fs.existsSync(first.historyPath), true);
    assert.equal(fs.readFileSync(first.historyPath, 'utf8'), seeded.content);
    assert.equal(loadCurrentSkillRegistry(seeded.registryPath).capabilities[seeded.record.handle], undefined);
    assert.deepEqual(loadCurrentSkillRegistry(seeded.registryPath).routeRedirects, {});
    assert.deepEqual(loadTransitionAudit(seeded.auditPath).map(entry => entry.transition), ['retire_capability']);

    const second = retireGeneratedSkill(seeded.record.routingName, seeded.options);
    assert.equal(second.status, 'already-retired');
    assert.equal(second.transition.transitionId, first.transition.transitionId);
    assert.equal(loadTransitionAudit(seeded.auditPath).length, 1);

    await withEnv({
      XIAOBA_USER_DATA_DIR: root,
      XIAOBA_SKILLS_DIR: seeded.skillsRoot,
    }, async () => {
      const manager = new SkillManager();
      await manager.loadSkills();
      assert.equal(manager.getSkill(seeded.record.routingName), undefined);
    });

    // Recovery remains an explicit Registry action. The immutable snapshot is
    // sufficient for the existing reconciliation seam to restore the exact
    // body without inventing guidance.
    const restored = reconcileActiveGeneratedSkillArtifacts(originalRegistry, seeded.outputDir);
    assert.equal(restored.repaired, true);
    assert.equal(fs.readFileSync(seeded.record.skillFilePath, 'utf8'), fs.readFileSync(first.historyPath, 'utf8'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retirement inspection does not repair artifacts or rewrite the Registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-generated-control-inspect-'));
  try {
    const seeded = seedGeneratedSkill(root, 'inspect-without-repair');
    const historyPath = path.join(
      path.dirname(seeded.record.skillFilePath),
      'history',
      seeded.record.guidanceHash,
      'SKILL.md',
    );
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, seeded.content, 'utf8');
    fs.rmSync(seeded.record.skillFilePath);
    const registryBefore = fs.readFileSync(seeded.registryPath, 'utf8');

    const inspected = inspectGeneratedSkillRetirement(
      seeded.record.routingName,
      seeded.options,
    );

    assert.equal(inspected.state, 'active');
    assert.equal(fs.existsSync(seeded.record.skillFilePath), false);
    assert.equal(fs.readFileSync(seeded.registryPath, 'utf8'), registryBefore);
    assert.equal(loadTransitionAudit(seeded.auditPath).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retirement does not reconcile an unrelated active generated Skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-generated-control-thin-'));
  try {
    const seeded = seedGeneratedSkill(root, 'retire-only-this-route');
    const unrelatedHandle = 'cap_unrelated_missing';
    const unrelatedPath = path.join(seeded.outputDir, unrelatedHandle, 'SKILL.md');
    const unrelatedContent = [
      '---',
      'name: unrelated-missing-route',
      'description: An unrelated generated Skill.',
      'user-invocable: true',
      `x-xiaoba-capability-handle: ${unrelatedHandle}`,
      '---',
      '',
      'Keep this unrelated guidance unchanged.',
      '',
    ].join('\n');
    const unrelatedHash = hash(unrelatedContent);
    const unrelatedHistoryPath = path.join(
      path.dirname(unrelatedPath),
      'history',
      unrelatedHash,
      'SKILL.md',
    );
    fs.mkdirSync(path.dirname(unrelatedHistoryPath), { recursive: true });
    fs.writeFileSync(unrelatedHistoryPath, unrelatedContent, 'utf8');

    const registry = loadCurrentSkillRegistry(seeded.registryPath);
    registry.capabilities[unrelatedHandle] = {
      handle: unrelatedHandle,
      revision: 1,
      routingName: 'unrelated-missing-route',
      description: 'An unrelated generated Skill.',
      skillFilePath: unrelatedPath,
      guidanceHash: unrelatedHash,
      evidenceRefs: [{ ref: 'episode:unrelated:request' }],
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(seeded.registryPath, registry);

    const result = retireGeneratedSkill(seeded.record.routingName, seeded.options);

    assert.equal(result.status, 'retired');
    assert.equal(fs.existsSync(unrelatedPath), false);
    assert.equal(fs.existsSync(unrelatedHistoryPath), true);
    assert.ok(loadCurrentSkillRegistry(seeded.registryPath).capabilities[unrelatedHandle]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI remove rejects generated Skills and points to audited retire while manual remove stays destructive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-command-control-'));
  try {
    const seeded = seedGeneratedSkill(root, 'cli-generated-report');
    const manualDir = path.join(seeded.skillsRoot, 'manual-helper');
    const manualFile = path.join(manualDir, 'SKILL.md');
    fs.mkdirSync(manualDir, { recursive: true });
    fs.writeFileSync(manualFile, '---\nname: manual-helper\ndescription: Manual helper\n---\n\nManual guidance.\n', 'utf8');

    await withEnv({
      XIAOBA_USER_DATA_DIR: root,
      XIAOBA_SKILLS_DIR: seeded.skillsRoot,
    }, async () => {
      const messages: string[] = [];
      const originalExit = process.exit;
      const originalError = Logger.error;
      const originalInfo = Logger.info;
      process.exit = ((code?: string | number | null) => {
        throw new Error(`CLI_EXIT_${code ?? 0}`);
      }) as typeof process.exit;
      Logger.error = ((message: string) => {
        messages.push(message);
      }) as typeof Logger.error;
      Logger.info = ((message: string) => {
        messages.push(message);
      }) as typeof Logger.info;
      try {
        await assert.rejects(
          runCli(['skill', 'remove', seeded.record.routingName, '--force']),
          /CLI_EXIT_1/,
        );
      } finally {
        process.exit = originalExit;
        Logger.error = originalError;
        Logger.info = originalInfo;
      }

      assert.match(messages.join('\n'), /skill retire cli-generated-report/);
      assert.equal(fs.existsSync(seeded.record.skillFilePath), true);
      assert.equal(loadTransitionAudit(seeded.auditPath).length, 0);

      await runCli(['skill', 'retire', seeded.record.routingName, '--force']);
      assert.equal(fs.existsSync(seeded.record.skillFilePath), false);
      assert.equal(fs.existsSync(path.join(seeded.outputDir, seeded.record.handle, 'history', seeded.record.guidanceHash, 'SKILL.md')), true);
      assert.equal(loadTransitionAudit(seeded.auditPath).length, 1);

      // Repeating explicit retire is a durable no-op, not an additional audit.
      await runCli(['skill', 'retire', seeded.record.routingName, '--force']);
      assert.equal(loadTransitionAudit(seeded.auditPath).length, 1);

      const registrySnapshot = fs.readFileSync(seeded.registryPath, 'utf8');
      fs.writeFileSync(seeded.registryPath, '{corrupt-registry', 'utf8');
      try {
        await runCli(['skill', 'remove', 'manual-helper', '--force']);
      } finally {
        fs.writeFileSync(seeded.registryPath, registrySnapshot, 'utf8');
      }
      assert.equal(
        fs.existsSync(manualDir),
        false,
        'a broken generated Registry must not block removal of a resolved manual Skill',
      );
      assert.equal(loadTransitionAudit(seeded.auditPath).length, 1);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retirement fails closed when a Registry record points outside generated output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-control-boundary-'));
  try {
    const seeded = seedGeneratedSkill(root, 'outside-output-boundary');
    const outsidePath = path.join(root, 'skills', 'manual-owned', 'SKILL.md');
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
    fs.writeFileSync(outsidePath, seeded.content, 'utf8');
    const registry = loadCurrentSkillRegistry(seeded.registryPath);
    registry.capabilities[seeded.record.handle] = {
      ...registry.capabilities[seeded.record.handle]!,
      skillFilePath: outsidePath,
    };
    saveCurrentSkillRegistry(seeded.registryPath, registry);

    assert.throws(
      () => retireGeneratedSkill(seeded.record.routingName, seeded.options),
      /points outside the generated Skill root/,
    );
    assert.equal(fs.existsSync(outsidePath), true);
    assert.equal(loadTransitionAudit(seeded.auditPath).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('journal recovery rejects an external operation before touching its target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-control-journal-boundary-'));
  try {
    const seeded = seedGeneratedSkill(root, 'journal-boundary');
    const outsidePath = path.join(root, 'manual-owned', 'SKILL.md');
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
    fs.writeFileSync(outsidePath, 'manual guidance\n', 'utf8');
    const targetRegistry = emptyCurrentSkillRegistryState();
    const transitionId = 'transition-malformed-boundary';
    fs.writeFileSync(seeded.journalPath, JSON.stringify({
      schemaVersion: targetRegistry.schemaVersion,
      transitionId,
      targetRegistryHash: computeCurrentSkillRegistryHash(targetRegistry),
      targetRegistry,
      skillOperations: [{ path: outsidePath, delete: true }],
      audit: { transitionId },
    }), 'utf8');

    assert.throws(
      () => retireGeneratedSkill(seeded.record.routingName, seeded.options),
      /unsafe or malformed Skill operation/,
    );
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'manual guidance\n');
    assert.equal(fs.existsSync(seeded.journalPath), true, 'unsafe journal remains available for inspection');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retirement rejects a generated path whose parent symlink escapes the output root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-control-symlink-boundary-'));
  try {
    const seeded = seedGeneratedSkill(root, 'symlink-boundary');
    const outsideDir = path.join(root, 'manual-owned');
    const outsidePath = path.join(outsideDir, 'SKILL.md');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsidePath, seeded.content, 'utf8');

    const generatedCapabilityDir = path.dirname(seeded.record.skillFilePath);
    fs.rmSync(generatedCapabilityDir, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, generatedCapabilityDir, 'dir');

    assert.throws(
      () => retireGeneratedSkill(seeded.record.routingName, seeded.options),
      /points outside the generated Skill root/,
    );
    assert.equal(fs.existsSync(outsidePath), true);
    assert.equal(fs.existsSync(path.join(outsideDir, 'history')), false);
    assert.equal(loadTransitionAudit(seeded.auditPath).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
