import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BotSkillRef } from '../src/bot-definition/types';
import {
  BotSkillActivationStateStore,
  computeCanonicalBotSkillSetHash,
} from '../src/bot-skills/activation-state';
import {
  scanLocalBotSkill,
  writeBotSkillLocalMarker,
} from '../src/bot-skills/local-manifest';

describe('Bot Skill activation state v2', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('hashes a complete reference set canonically without paths or source text', () => {
    const a = reference('skill-a', 'v1.0.0', 'a');
    const b = reference('skill-b', 'v2.0.0', 'b');
    assert.equal(
      computeCanonicalBotSkillSetHash([b, a]),
      computeCanonicalBotSkillSetHash([a, b]),
    );
    assert.notEqual(
      computeCanonicalBotSkillSetHash([a, b]),
      computeCanonicalBotSkillSetHash([a, { ...b, version: 'v2.0.1' }]),
    );
  });

  test('records an applied marker before ACK and retains backup evidence after ACK', () => {
    const fixture = createFixture(roots);
    const journal = fixture.store.begin(fixture.begin);
    assert.equal(journal.phase, 'prepared');
    fixture.store.advance(fixture.botId, fixture.skillsRoot, journal, 'backup_moved');
    fixture.store.advance(fixture.botId, fixture.skillsRoot, journal, 'live_switched');
    fixture.store.advance(fixture.botId, fixture.skillsRoot, journal, 'catalog_switched');
    const marker = fixture.store.recordLocallyApplied(
      fixture.botId,
      fixture.skillsRoot,
      journal,
      '2026-08-25T12:00:00.000Z',
    );
    assert.equal(marker.definitionRevision, 12);
    assert.equal(marker.skillSetHash, fixture.skillSetHash);
    assert.deepStrictEqual(marker.skills, fixture.skills);
    assert.equal(fixture.store.readJournal(fixture.botId, fixture.skillsRoot)?.phase, 'locally_applied');

    fs.mkdirSync(fixture.backup, { recursive: true });
    fixture.store.markAcked(fixture.botId, fixture.skillsRoot, journal);
    assert.equal(fixture.store.readJournal(fixture.botId, fixture.skillsRoot)?.phase, 'acked');
    assert.equal(fs.existsSync(fixture.backup), true);
    fs.rmSync(fixture.skillsRoot, { recursive: true, force: true });
    assert.equal(fixture.store.inspectForAck(fixture.botId, fixture.skillsRoot).status, 'acked');
  });

  test('rejects phase skips, conflicting activation identities, and ACK without an applied marker', () => {
    const fixture = createFixture(roots);
    const journal = fixture.store.begin(fixture.begin);
    assert.throws(
      () => fixture.store.advance(fixture.botId, fixture.skillsRoot, journal, 'locally_applied'),
      /Invalid Bot Skill activation transition/,
    );
    assert.throws(
      () => fixture.store.begin({ ...fixture.begin, definitionRevision: 13 }),
      /different Bot Skill activation/,
    );
    fixture.store.advance(fixture.botId, fixture.skillsRoot, journal, 'live_switched');
    fixture.store.advance(fixture.botId, fixture.skillsRoot, journal, 'catalog_switched');
    assert.throws(
      () => fixture.store.markAcked(fixture.botId, fixture.skillsRoot, journal),
      /during phase catalog_switched/,
    );
  });

  test('discards a prepared stage while leaving the live workspace untouched', () => {
    const fixture = createFixture(roots);
    fs.mkdirSync(fixture.skillsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixture.skillsRoot, 'keep.txt'), 'old live');
    fs.mkdirSync(fixture.stage, { recursive: true });
    fs.writeFileSync(path.join(fixture.stage, 'discard.txt'), 'not active');
    fixture.store.begin(fixture.begin);

    const result = fixture.store.recover(fixture.botId, fixture.skillsRoot);
    assert.equal(result.status, 'discarded_prepared');
    assert.equal(fs.readFileSync(path.join(fixture.skillsRoot, 'keep.txt'), 'utf8'), 'old live');
    assert.equal(fs.existsSync(fixture.stage), false);
    assert.equal(fixture.store.readJournal(fixture.botId, fixture.skillsRoot), undefined);
  });

  test('restores the backup when a crash happens after rename but before phase persistence', () => {
    const fixture = createFixture(roots);
    fs.mkdirSync(fixture.backup, { recursive: true });
    fs.writeFileSync(path.join(fixture.backup, 'old.txt'), 'old live');
    fs.mkdirSync(fixture.stage, { recursive: true });
    fixture.store.begin(fixture.begin);

    const result = fixture.store.recover(fixture.botId, fixture.skillsRoot);
    assert.equal(result.status, 'restored_backup');
    assert.equal(fs.readFileSync(path.join(fixture.skillsRoot, 'old.txt'), 'utf8'), 'old live');
    assert.equal(fs.existsSync(fixture.stage), false);
    assert.equal(fixture.store.readJournal(fixture.botId, fixture.skillsRoot), undefined);
  });

  test('recognizes a completed stage rename and resumes local metadata commit', () => {
    const fixture = createFixture(roots);
    adoptWorkspaceReference(fixture, writeReferencedWorkspace(fixture.skillsRoot, fixture.skills[0]));
    fixture.store.begin(fixture.begin);
    fixture.store.advance(fixture.botId, fixture.skillsRoot, fixture.begin, 'backup_moved');
    fs.mkdirSync(fixture.backup, { recursive: true });

    const result = fixture.store.recover(fixture.botId, fixture.skillsRoot);
    assert.equal(result.status, 'resume_local_apply');
    assert.equal(result.status === 'resume_local_apply' && result.journal.phase, 'live_switched');
    assert.equal(fs.existsSync(fixture.backup), true);
  });

  test('uses a matching applied marker to recover an ACK lost after local commit', () => {
    const fixture = createFixture(roots);
    adoptWorkspaceReference(fixture, writeReferencedWorkspace(fixture.skillsRoot, fixture.skills[0]));
    const journal = fixture.store.begin(fixture.begin);
    fixture.store.advance(fixture.botId, fixture.skillsRoot, journal, 'live_switched');
    fixture.store.advance(fixture.botId, fixture.skillsRoot, journal, 'catalog_switched');
    fixture.store.recordLocallyApplied(fixture.botId, fixture.skillsRoot, journal);

    const result = fixture.store.recover(fixture.botId, fixture.skillsRoot);
    assert.equal(result.status, 'retry_ack');
    assert.equal(result.status === 'retry_ack' && result.marker.definitionRevision, 12);
  });

  test('inspects ACK readiness without recovering or changing earlier phases', () => {
    const fixture = createFixture(roots);
    fs.mkdirSync(fixture.skillsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixture.skillsRoot, 'keep.txt'), 'old live');
    fs.mkdirSync(fixture.stage, { recursive: true });
    fs.writeFileSync(path.join(fixture.stage, 'keep-stage.txt'), 'not active');
    fixture.store.begin(fixture.begin);

    const result = fixture.store.inspectForAck(fixture.botId, fixture.skillsRoot);

    assert.equal(result.status, 'not_ready');
    assert.equal(fixture.store.readJournal(fixture.botId, fixture.skillsRoot)?.phase, 'prepared');
    assert.equal(fs.existsSync(fixture.stage), true);
    assert.equal(fs.readFileSync(path.join(fixture.skillsRoot, 'keep.txt'), 'utf8'), 'old live');
  });

  test('fails closed on a mismatched live workspace and preserves backup evidence', () => {
    const fixture = createFixture(roots);
    fixture.store.begin(fixture.begin);
    fixture.store.advance(fixture.botId, fixture.skillsRoot, fixture.begin, 'live_switched');
    writeReferencedWorkspace(fixture.skillsRoot, reference('other-skill', 'v1', 'z'));
    fs.mkdirSync(fixture.backup, { recursive: true });
    fs.writeFileSync(path.join(fixture.backup, 'old.txt'), 'recoverable');

    assert.throws(
      () => fixture.store.recover(fixture.botId, fixture.skillsRoot),
      /does not match its journal/,
    );
    assert.equal(fs.readFileSync(path.join(fixture.backup, 'old.txt'), 'utf8'), 'recoverable');
    assert.equal(fixture.store.readJournal(fixture.botId, fixture.skillsRoot)?.phase, 'live_switched');
  });

  test('rejects journal paths outside the exact live workspace parent', () => {
    const fixture = createFixture(roots);
    assert.throws(
      () => fixture.store.begin({
        ...fixture.begin,
        stage: path.join(fixture.runtimeRoot, 'outside', '.bot-skills-stage-attack'),
      }),
      /activation journal is invalid/,
    );
  });

  test('does not remove a staged path whose type is not a verified directory', () => {
    const fixture = createFixture(roots);
    fixture.store.begin(fixture.begin);
    fs.writeFileSync(fixture.stage, 'must survive');

    assert.throws(
      () => fixture.store.recover(fixture.botId, fixture.skillsRoot),
      /stage path is not a safe directory/,
    );
    assert.equal(fs.readFileSync(fixture.stage, 'utf8'), 'must survive');
    assert.equal(fixture.store.readJournal(fixture.botId, fixture.skillsRoot)?.phase, 'prepared');
  });
});

function createFixture(roots: string[]) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-skill-activation-state-'));
  roots.push(runtimeRoot);
  const botId = 'bot-activation-test';
  const skillsRoot = path.join(runtimeRoot, 'skills');
  const stage = path.join(runtimeRoot, '.bot-skills-stage-test');
  const backup = path.join(runtimeRoot, '.bot-skills-backup-test');
  const skills = [reference('image-skill', 'v1.2.3', 'a')];
  const skillSetHash = computeCanonicalBotSkillSetHash(skills);
  const store = new BotSkillActivationStateStore(runtimeRoot);
  return {
    runtimeRoot,
    botId,
    skillsRoot,
    stage,
    backup,
    skills,
    skillSetHash,
    store,
    begin: {
      botId,
      skillsRoot,
      stage,
      backup,
      definitionRevision: 12,
      skillSetHash,
      skills,
      mutationId: 'mutation-12',
      runtimeBodyIdHash: crypto.createHash('sha256').update('runtime-body').digest('hex'),
      startedAt: '2026-08-25T11:00:00.000Z',
    },
  };
}

function reference(skillId: string, version: string, hashSeed: string): BotSkillRef {
  return {
    source: 'skillhub',
    skillId,
    version,
    contentHash: crypto.createHash('sha256').update(hashSeed).digest('hex'),
  };
}

function writeReferencedWorkspace(skillsRoot: string, expected: BotSkillRef): BotSkillRef {
  const skillDir = path.join(skillsRoot, expected.skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${expected.skillId}\ndescription: activation state test skill\n---\n\nTest.\n`,
    'utf8',
  );
  const local = scanLocalBotSkill(skillDir, skillsRoot);
  const referenceWithActualHash = { ...expected, contentHash: local.contentHash };
  writeBotSkillLocalMarker(skillDir, {
    schema: 'xiaoba.bot-skill-local.v1',
    localSkillId: `local:${expected.skillId}`,
    reference: referenceWithActualHash,
  });
  return referenceWithActualHash;
}

function adoptWorkspaceReference(
  fixture: ReturnType<typeof createFixture>,
  actual: BotSkillRef,
): void {
  fixture.skills[0] = actual;
  fixture.skillSetHash = computeCanonicalBotSkillSetHash(fixture.skills);
  fixture.begin.skills = fixture.skills;
  fixture.begin.skillSetHash = fixture.skillSetHash;
}
