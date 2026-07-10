import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadSkillUsageLedger,
  saveSkillUsageLedger,
  SkillUsageLedger,
} from '../src/utils/skill-usage-ledger';

describe('V3 Skill Usage Ledger', () => {
  test('persists facts atomically and restores them across a new ledger instance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-usage-ledger-'));
    try {
      const generatedRoot = path.join(root, 'skills', 'generated-distilled');
      const filePath = path.join(root, 'data', 'ledger.json');
      const skillPath = path.join(generatedRoot, 'cap_one', 'SKILL.md');
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(skillPath, '---\nname: one\ndescription: One\n---\n\nGuidance.\n');

      const first = new SkillUsageLedger(filePath, generatedRoot);
      const load = first.recordGeneratedSkillLoad({
        skillName: 'one',
        skillFilePath: skillPath,
        capabilityHandle: 'cap_one',
        runtimeSessionId: 'runtime-1',
        episodeId: 'episode-1',
        loadedAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      const outcome = first.recordSameEpisodeOutcome({
        loadFactId: load.factId,
        episodeId: 'episode-1',
        outcome: 'verified_success',
        evidenceRefs: ['session.jsonl#12:acceptance'],
        observedAt: new Date('2026-07-01T00:01:00.000Z'),
      });

      const restored = new SkillUsageLedger(filePath, generatedRoot).load();
      assert.equal(restored.loads.length, 1);
      assert.deepEqual(restored.outcomes, [outcome]);
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('isolates corrupt state and never accepts a manual skill as a generated fact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-usage-ledger-corrupt-'));
    try {
      const generatedRoot = path.join(root, 'skills', 'generated-distilled');
      const filePath = path.join(root, 'data', 'ledger.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{not-json');
      const isolated = loadSkillUsageLedger(filePath);
      assert.equal(isolated.stateCorrupt, true);
      assert.equal(fs.existsSync(filePath), false);
      assert.equal(fs.readdirSync(path.dirname(filePath)).some(name => name.startsWith('ledger.json.corrupt.')), true);

      const manualPath = path.join(root, 'skills', 'manual', 'SKILL.md');
      fs.mkdirSync(path.dirname(manualPath), { recursive: true });
      const ledger = new SkillUsageLedger(filePath, generatedRoot);
      assert.throws(() => ledger.recordGeneratedSkillLoad({ skillName: 'manual', skillFilePath: manualPath }), /Only generated Current Skills/);
      saveSkillUsageLedger(filePath, isolated);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects an outcome whose episode is not the load episode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-usage-ledger-boundary-'));
    try {
      const generatedRoot = path.join(root, 'skills', 'generated-distilled');
      const skillPath = path.join(generatedRoot, 'cap_one', 'SKILL.md');
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      const ledger = new SkillUsageLedger(path.join(root, 'ledger.json'), generatedRoot);
      const load = ledger.recordGeneratedSkillLoad({ skillName: 'one', skillFilePath: skillPath, episodeId: 'episode-1' });
      assert.throws(() => ledger.recordSameEpisodeOutcome({
        loadFactId: load.factId,
        episodeId: 'episode-2',
        outcome: 'contradiction',
      }), /same Learning Episode/);
      assert.deepEqual(ledger.load().outcomes, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
