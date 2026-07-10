import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';

function fixtureRoot(): { root: string; generatedRoot: string; ledger: SkillUsageLedger; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-usage-curator-'));
  const generatedRoot = path.join(root, 'skills', 'generated-distilled');
  fs.mkdirSync(generatedRoot, { recursive: true });
  const ledger = new SkillUsageLedger(path.join(root, 'data', 'ledger.json'), generatedRoot);
  return { root, generatedRoot, ledger, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function skillPath(root: string, handle: string): string {
  const filePath = path.join(root, handle, 'SKILL.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nname: ${handle}\ndescription: ${handle}\n---\n\nGuidance.\n`);
  return filePath;
}

describe('V3 Skill Usage Curator', () => {
  test('uses outcomes plus staleness, while load count or age alone only observes', () => {
    const env = fixtureRoot();
    try {
      const stalePath = skillPath(env.generatedRoot, 'cap_stale');
      const noEvidencePath = skillPath(env.generatedRoot, 'cap_no_evidence');
      const staleLoad = env.ledger.recordGeneratedSkillLoad({
        skillName: 'stale', skillFilePath: stalePath, capabilityHandle: 'cap_stale',
        episodeId: 'episode-stale', loadedAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      env.ledger.recordSameEpisodeOutcome({
        loadFactId: staleLoad.factId, episodeId: 'episode-stale', outcome: 'verified_success',
        evidenceRefs: ['session#1'], observedAt: new Date('2026-06-01T00:01:00.000Z'),
      });
      env.ledger.recordGeneratedSkillLoad({
        skillName: 'no-evidence', skillFilePath: noEvidencePath, capabilityHandle: 'cap_no_evidence',
        episodeId: 'episode-no-evidence', loadedAt: new Date('2026-06-01T00:00:00.000Z'),
      });

      const summaries = new SkillUsageCurator({
        ledger: env.ledger,
        generatedSkillsRoot: env.generatedRoot,
        statePath: path.join(env.root, 'data', 'curator.json'),
        staleAfterMs: 24 * 60 * 60 * 1000,
        now: () => new Date('2026-07-10T00:00:00.000Z'),
      }).classify();
      assert.equal(summaries.find(item => item.skillKey === 'cap_stale')!.classification, 'reassess');
      assert.equal(summaries.find(item => item.skillKey === 'cap_no_evidence')!.classification, 'observe');
    } finally {
      env.cleanup();
    }
  });

  test('coalesces direct contradiction wakes and never mutates the generated skill', () => {
    const env = fixtureRoot();
    try {
      const filePath = skillPath(env.generatedRoot, 'cap_contradicted');
      const first = env.ledger.recordGeneratedSkillLoad({
        skillName: 'contradicted', skillFilePath: filePath, capabilityHandle: 'cap_contradicted', episodeId: 'episode-1',
      });
      const second = env.ledger.recordGeneratedSkillLoad({
        skillName: 'contradicted', skillFilePath: filePath, capabilityHandle: 'cap_contradicted', episodeId: 'episode-2',
      });
      env.ledger.recordSameEpisodeOutcome({ loadFactId: first.factId, episodeId: 'episode-1', outcome: 'contradiction', evidenceRefs: ['session#2'] });
      env.ledger.recordSameEpisodeOutcome({ loadFactId: second.factId, episodeId: 'episode-2', outcome: 'contradiction', evidenceRefs: ['session#4'] });

      const curator = new SkillUsageCurator({ ledger: env.ledger, generatedSkillsRoot: env.generatedRoot, statePath: path.join(env.root, 'data', 'curator.json') });
      const wakes = curator.getPendingExpeditedWakes();
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.outcomeFactIds.length, 2);
      assert.equal(curator.classify()[0]!.classification, 'expedited_reassess');
      assert.match(fs.readFileSync(filePath, 'utf8'), /Guidance/);
    } finally {
      env.cleanup();
    }
  });

  test('dispatches replace/merge/retire decisions through the supplied transition seam only', async () => {
    const env = fixtureRoot();
    try {
      for (const handle of ['cap_replace', 'cap_merge', 'cap_retire']) {
        const filePath = skillPath(env.generatedRoot, handle);
        const load = env.ledger.recordGeneratedSkillLoad({
          skillName: handle, skillFilePath: filePath, capabilityHandle: handle, episodeId: `episode-${handle}`,
          loadedAt: new Date('2026-06-01T00:00:00.000Z'),
        });
        env.ledger.recordSameEpisodeOutcome({ loadFactId: load.factId, episodeId: `episode-${handle}`, outcome: 'deferred', evidenceRefs: [`session#${handle}`] });
      }
      const transitions = ['replace_current_skill', 'merge_into_capability', 'retire_capability'] as const;
      let index = 0;
      const curator = new SkillUsageCurator({
        ledger: env.ledger,
        generatedSkillsRoot: env.generatedRoot,
        statePath: path.join(env.root, 'data', 'curator.json'),
        staleAfterMs: 1,
        evidenceBundleBuilder: summary => ({
          bundleId: `bundle-${summary.skillKey}`,
          episode: { episodeId: summary.skillKey },
          completionEvidence: [{ ref: 'session#5' }],
          settlementEvidence: [],
          boundedContinuity: [],
          referencedSkills: [],
          relatedCurrentSkills: [],
        }),
        review: async request => {
          assert.match(request.summary.skillKey, /^cap_(replace|merge|retire)$/);
          return { transition: transitions[index++ % transitions.length], verified: true, rounds: 1 };
        },
      });
      const result = await curator.reviewDue();
      assert.deepEqual(result.transitions, ['replace_current_skill', 'merge_into_capability', 'retire_capability']);
      // The Curator never invents a registry mutation. The supplied transition
      // seam is the only mutation authority, and source files remain intact.
      for (const handle of ['cap_replace', 'cap_merge', 'cap_retire']) {
        assert.equal(fs.existsSync(path.join(env.generatedRoot, handle, 'SKILL.md')), true);
      }
    } finally {
      env.cleanup();
    }
  });

  test('excludes manual, bundled, and user paths even when a malformed caller tries to add them', () => {
    const env = fixtureRoot();
    try {
      const manualPath = path.join(env.root, 'skills', 'manual', 'SKILL.md');
      fs.mkdirSync(path.dirname(manualPath), { recursive: true });
      assert.throws(() => env.ledger.recordGeneratedSkillLoad({ skillName: 'manual', skillFilePath: manualPath }), /Only generated Current Skills/);
      assert.equal(new SkillUsageCurator({ ledger: env.ledger, generatedSkillsRoot: env.generatedRoot, statePath: path.join(env.root, 'data', 'curator.json') }).classify().length, 0);
    } finally {
      env.cleanup();
    }
  });
});
