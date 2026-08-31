import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createBotSkillCandidate,
  discardBotSkillCandidate,
  inspectBotSkillCandidate,
  recoverBotSkillCandidates,
} from '../src/bot-skills/candidate-workspace';

describe('isolated Bot Skill candidate workspace', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('creates and verifies an atomic candidate without changing the active workspace', () => {
    const root = createRuntimeRoot(roots);
    const active = createSkill(path.join(root, 'skills'), 'formal-skill', 'formal');
    const source = createSkill(path.join(root, 'source'), 'draft-skill', 'candidate');
    const activeBefore = treeFingerprint(path.join(root, 'skills'));

    const candidate = createBotSkillCandidate({
      runtimeRoot: root,
      botId: 'bot-a',
      mutationId: 'mutation-1',
      sourceSkillPath: source,
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });

    assert.equal(candidate.manifest.state, 'prepared');
    assert.equal(candidate.manifest.installName, 'draft-skill');
    assert.equal(candidate.skill.name, 'draft-skill');
    assert.equal(fs.readFileSync(path.join(candidate.packagePath, 'body.txt'), 'utf8'), 'candidate');
    assert.deepEqual(treeFingerprint(path.join(root, 'skills')), activeBefore);
    assert.equal(fs.readFileSync(path.join(active, 'body.txt'), 'utf8'), 'formal');
    assert.equal(fs.existsSync(path.join(source, '.xiaoba-bot-skill.json')), false);
  });

  test('is idempotent for the same mutation and rejects conflicting content', () => {
    const root = createRuntimeRoot(roots);
    const source = createSkill(path.join(root, 'source'), 'draft-skill', 'one');
    const first = createBotSkillCandidate({
      runtimeRoot: root,
      botId: 'bot-a',
      mutationId: 'mutation-1',
      sourceSkillPath: source,
    });
    const second = createBotSkillCandidate({
      runtimeRoot: root,
      botId: 'bot-a',
      mutationId: 'mutation-1',
      sourceSkillPath: source,
    });
    assert.equal(first.path, second.path);
    assert.equal(second.deduplicated, true);

    fs.writeFileSync(path.join(source, 'body.txt'), 'two');
    assert.throws(() => createBotSkillCandidate({
      runtimeRoot: root,
      botId: 'bot-a',
      mutationId: 'mutation-1',
      sourceSkillPath: source,
    }), /already exists with different content/i);
  });

  test('does not deduplicate a different local Skill identity with identical files', () => {
    const root = createRuntimeRoot(roots);
    const firstSource = createSkill(path.join(root, 'source-a'), 'draft-skill', 'same');
    const secondSource = createSkill(path.join(root, 'source-b'), 'draft-skill', 'same');
    writeMarker(firstSource, 'local-one');
    writeMarker(secondSource, 'local-two');
    createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one', sourceSkillPath: firstSource,
    });
    assert.throws(() => createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one', sourceSkillPath: secondSource,
    }), /already exists with different content/i);
  });

  test('isolates candidates by Bot and mutation', () => {
    const root = createRuntimeRoot(roots);
    const source = createSkill(path.join(root, 'source'), 'draft-skill', 'candidate');
    const botAOne = createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one', sourceSkillPath: source,
    });
    const botATwo = createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'two', sourceSkillPath: source,
    });
    const botBOne = createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-b', mutationId: 'one', sourceSkillPath: source,
    });
    assert.notEqual(botAOne.path, botATwo.path);
    assert.notEqual(botAOne.path, botBOne.path);
    assert.equal(inspectBotSkillCandidate({ runtimeRoot: root, botId: 'bot-b', mutationId: 'one' }).skill.name, 'draft-skill');
  });

  test('rejects unsafe identifiers, install paths, and source symlinks', (t) => {
    const root = createRuntimeRoot(roots);
    const source = createSkill(path.join(root, 'source'), 'draft-skill', 'candidate');
    for (const botId of ['..', '.', 'bot/other', 'C:\\bot', 'bot.', 'CON']) {
      assert.throws(() => createBotSkillCandidate({
        runtimeRoot: root, botId, mutationId: 'one', sourceSkillPath: source,
      }), /invalid Bot ID/i);
    }
    for (const mutationId of ['..', '.', 'one/two', 'C:\\mutation', 'mutation.', 'NUL']) {
      assert.throws(() => createBotSkillCandidate({
        runtimeRoot: root, botId: 'bot-a', mutationId, sourceSkillPath: source,
      }), /invalid mutation ID/i);
    }
    assert.throws(() => createBotSkillCandidate({
      runtimeRoot: root,
      botId: 'bot-a',
      mutationId: 'one',
      sourceSkillPath: source,
      installName: '../escape',
    }), /invalid install name/i);

    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    const link = path.join(source, 'linked.txt');
    try {
      fs.symlinkSync(outside, link, 'file');
    } catch (error: any) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(String(error?.code))) {
        t.skip('Windows symlink creation is unavailable for this user');
        return;
      }
      throw error;
    }
    assert.throws(() => createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'two', sourceSkillPath: source,
    }), /symbolic link/i);
  });

  test('reports interrupted and corrupt candidates without deleting evidence', () => {
    const root = createRuntimeRoot(roots);
    const source = createSkill(path.join(root, 'source'), 'draft-skill', 'candidate');
    const valid = createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'ready', sourceSkillPath: source,
    });
    const botRoot = path.dirname(valid.path);
    const interrupted = path.join(botRoot, '.tmp-interrupted');
    const corrupt = path.join(botRoot, 'corrupt');
    fs.mkdirSync(interrupted);
    fs.mkdirSync(corrupt);
    fs.writeFileSync(path.join(corrupt, 'candidate.json'), '{broken');

    const recovery = recoverBotSkillCandidates(root, 'bot-a');
    assert.deepEqual(recovery.map(entry => entry.status), ['incomplete', 'invalid', 'ready']);
    assert.equal(fs.existsSync(interrupted), true);
    assert.equal(fs.existsSync(corrupt), true);
    assert.equal(fs.existsSync(valid.path), true);
  });

  test('discard removes only the exact verified candidate', () => {
    const root = createRuntimeRoot(roots);
    const active = createSkill(path.join(root, 'skills'), 'formal-skill', 'formal');
    const source = createSkill(path.join(root, 'source'), 'draft-skill', 'candidate');
    const first = createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one', sourceSkillPath: source,
    });
    const sibling = createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'two', sourceSkillPath: source,
    });

    assert.equal(discardBotSkillCandidate({ runtimeRoot: root, botId: 'bot-a', mutationId: 'one' }), true);
    assert.equal(fs.existsSync(first.path), false);
    assert.equal(fs.existsSync(sibling.path), true);
    assert.equal(fs.readFileSync(path.join(active, 'body.txt'), 'utf8'), 'formal');
    assert.equal(discardBotSkillCandidate({ runtimeRoot: root, botId: 'bot-a', mutationId: 'one' }), false);
  });

  test('refuses to discard invalid evidence', () => {
    const root = createRuntimeRoot(roots);
    const source = createSkill(path.join(root, 'source'), 'draft-skill', 'candidate');
    const candidate = createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one', sourceSkillPath: source,
    });
    fs.writeFileSync(path.join(candidate.packagePath, 'body.txt'), 'tampered');
    assert.throws(() => discardBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one',
    }), /no longer matches/i);
    assert.equal(fs.existsSync(candidate.path), true);
  });

  test('detects candidate provenance marker tampering', () => {
    const root = createRuntimeRoot(roots);
    const source = createSkill(path.join(root, 'source'), 'draft-skill', 'candidate');
    const candidate = createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one', sourceSkillPath: source,
    });
    writeMarker(candidate.packagePath, candidate.manifest.localSkillId, {
      skillId: 'owner/other-skill',
      version: 'v1',
    });
    assert.throws(() => inspectBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one',
    }), /no longer matches/i);
    assert.equal(fs.existsSync(candidate.path), true);
  });

  test('inspection does not recreate a missing candidate marker', () => {
    const root = createRuntimeRoot(roots);
    const source = createSkill(path.join(root, 'source'), 'draft-skill', 'candidate');
    const candidate = createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one', sourceSkillPath: source,
    });
    const markerPath = path.join(candidate.packagePath, '.xiaoba-bot-skill.json');
    fs.rmSync(markerPath);
    assert.throws(() => inspectBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one',
    }), /marker cannot be read safely/i);
    assert.equal(fs.existsSync(markerPath), false);
  });

  test('refuses a corrupt source marker instead of assigning a new identity', () => {
    const root = createRuntimeRoot(roots);
    const source = createSkill(path.join(root, 'source'), 'draft-skill', 'candidate');
    const markerPath = path.join(source, '.xiaoba-bot-skill.json');
    fs.writeFileSync(markerPath, '{broken');
    assert.throws(() => createBotSkillCandidate({
      runtimeRoot: root, botId: 'bot-a', mutationId: 'one', sourceSkillPath: source,
    }), /source Skill local marker cannot be read safely/i);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), '{broken');
  });
});

function createRuntimeRoot(roots: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-candidate-'));
  roots.push(root);
  return root;
}

function createSkill(parent: string, name: string, body: string): string {
  const root = path.join(parent, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: candidate test\n---\n`);
  fs.writeFileSync(path.join(root, 'body.txt'), body);
  return root;
}

function writeMarker(
  skillRoot: string,
  localSkillId: string,
  origin?: { skillId: string; version: string },
): void {
  fs.writeFileSync(path.join(skillRoot, '.xiaoba-bot-skill.json'), `${JSON.stringify({
    schema: 'xiaoba.bot-skill-local.v1',
    localSkillId,
    ...(origin ? { origin } : {}),
  })}\n`);
}

function treeFingerprint(root: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({
        path: path.relative(root, absolute).replace(/\\/g, '/'),
        content: fs.readFileSync(absolute).toString('base64'),
      });
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
