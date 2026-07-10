import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { GeneratedCurrentSkillIdentity, SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { EvidenceBundle, SkillEvolutionRuntime } from '../src/utils/skill-evolution';

function generatedSkill(handle: string): GeneratedCurrentSkillIdentity {
  return {
    capabilityHandle: handle,
    routingName: `generated-${handle}`,
    skillFilePath: `/runtime/skills/generated-distilled/${handle}/SKILL.md`,
    guidanceHash: `hash-${handle}`,
  };
}

function registry(...skills: GeneratedCurrentSkillIdentity[]): any {
  return {
    getRegistry: () => ({
      capabilities: Object.fromEntries(skills.map(skill => [skill.capabilityHandle, {
        ...skill,
        handle: skill.capabilityHandle,
        revision: 1,
        description: skill.routingName,
        evidenceRefs: [],
        referencedSkills: [],
      }])),
    }),
  };
}

describe('Skill Usage Ledger and Curator', () => {
  test('persists factual generated-load and same-episode outcome records without manual-skill ownership', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-usage-ledger-'));
    try {
      const ledger = new SkillUsageLedger(path.join(root, 'data', 'usage.jsonl'));
      assert.throws(() => ledger.recordGeneratedSkillLoad({
        runtimeSessionId: 'session-1', episodeId: 'episode-1',
        skill: { ...generatedSkill('cap-manual'), skillFilePath: '/runtime/skills/manual/SKILL.md' },
      }), /generated Current Skills only/);
      const load = ledger.recordGeneratedSkillLoad({ runtimeSessionId: 'session-1', episodeId: 'episode-1', skill: generatedSkill('cap-1') });
      const outcomes = ledger.recordOutcome({ episodeId: 'episode-1', outcome: 'verified-success', evidenceRefs: ['session.jsonl#7'] });
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.loadFactId, load.factId);
      assert.equal(ledger.listFacts().length, 2);
      assert.doesNotMatch(fs.readFileSync(path.join(root, 'data', 'usage.jsonl'), 'utf8'), /caused|followed/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('coalesces direct contradictions into one expedited wake and never suspends the skill', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-curator-wake-'));
    try {
      const skill = generatedSkill('cap-contradicted');
      const ledger = new SkillUsageLedger(path.join(root, 'data', 'usage.jsonl'));
      const curator = new SkillUsageCurator({
        ledger,
        statePath: path.join(root, 'data', 'curator.json'),
        intervalMs: 24 * 60 * 60 * 1000,
        runtime: registry(skill),
        reassess: async () => 'replace_current_skill',
      });
      for (const episodeId of ['episode-a', 'episode-b']) {
        ledger.recordGeneratedSkillLoad({ runtimeSessionId: 'session-1', episodeId, skill });
        const [outcome] = ledger.recordOutcome({ episodeId, outcome: 'contradicted', evidenceRefs: [`${episodeId}#2`] });
        curator.requestExpeditedWake(outcome!);
      }
      assert.equal(curator.pendingExpeditedWakes().length, 1);
      assert.equal(curator.pendingExpeditedWakes()[0]!.outcomeFactIds.length, 2);
      const result = await curator.runDue();
      assert.deepEqual(result.transitions, [{ capabilityHandle: 'cap-contradicted', transition: 'replace_current_skill' }]);
      assert.equal(curator.pendingExpeditedWakes().length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses verified success and deferral as reassessment evidence and delegates replace, merge, and retire', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-curator-transitions-'));
    try {
      const skills = ['cap-replace', 'cap-merge', 'cap-retire'].map(generatedSkill);
      const ledger = new SkillUsageLedger(path.join(root, 'data', 'usage.jsonl'));
      const transitions: Record<string, 'replace_current_skill' | 'merge_into_capability' | 'retire_capability'> = {
        'cap-replace': 'replace_current_skill', 'cap-merge': 'merge_into_capability', 'cap-retire': 'retire_capability',
      };
      const curator = new SkillUsageCurator({
        ledger,
        statePath: path.join(root, 'data', 'curator.json'),
        intervalMs: 0,
        runtime: registry(...skills),
        successThreshold: 1,
        deferThreshold: 1,
        reassess: async request => transitions[request.skill.capabilityHandle]!,
      });
      for (const [index, skill] of skills.entries()) {
        const episodeId = `episode-${index}`;
        ledger.recordGeneratedSkillLoad({ runtimeSessionId: 'session-1', episodeId, skill });
        ledger.recordOutcome({
          episodeId,
          outcome: index === 1 ? 'deferred' : 'verified-success',
          evidenceRefs: [`${episodeId}#4`],
        });
      }
      const result = await curator.runDue();
      assert.deepEqual(result.transitions.map(item => item.transition).sort(), [
        'merge_into_capability', 'replace_current_skill', 'retire_capability',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps an old revision outcome factual without reassessing its replacement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-curator-stale-load-'));
    try {
      const loaded = generatedSkill('cap-replaced');
      const replacement = { ...loaded, guidanceHash: 'hash-cap-replaced-v2' };
      const ledger = new SkillUsageLedger(path.join(root, 'data', 'usage.jsonl'));
      const reassessed: string[] = [];
      const curator = new SkillUsageCurator({
        ledger,
        statePath: path.join(root, 'data', 'curator.json'),
        intervalMs: 24 * 60 * 60 * 1000,
        runtime: registry(replacement),
        reassess: async request => {
          reassessed.push(request.skill.guidanceHash);
          return 'replace_current_skill';
        },
      });
      ledger.recordGeneratedSkillLoad({ runtimeSessionId: 'session-1', episodeId: 'episode-a', skill: loaded });
      const [outcome] = ledger.recordOutcome({ episodeId: 'episode-a', outcome: 'contradicted', evidenceRefs: ['episode-a#2'] });
      curator.requestExpeditedWake(outcome!);

      const result = await curator.runDue();

      assert.deepEqual(result.transitions, []);
      assert.deepEqual(reassessed, []);
      assert.equal(curator.pendingExpeditedWakes().length, 0);
      assert.equal(ledger.listFacts().filter(fact => fact.kind === 'episode-outcome').length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses the real Author/Verifier path for deferral and persists its same-episode fact', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-curator-runtime-'));
    try {
      const runtime = new SkillEvolutionRuntime({
        workingDirectory: root,
        outputDir: path.join(root, 'skills', 'generated-distilled'),
        registryPath: path.join(root, 'data', 'registry.json'),
        auditPath: path.join(root, 'data', 'audit.jsonl'),
        journalPath: path.join(root, 'data', 'journal.json'),
        reviewQueuePath: path.join(root, 'data', 'review-queue.json'),
        authorFixture: ({ bundle }) => ({
          body: 'Use bounded factual evidence only.',
          envelope: bundle.bundleId === 'create-current-skill'
            ? {
              decision: 'create_current_skill', routingName: 'curated-demo', description: 'A generated skill for curator testing.',
              evidenceRefs: ['create#1', 'create#2'],
            }
            : { decision: 'append_evidence', routingName: 'curated-demo' },
        }),
        verifierFixture: ({ bundle, draft }) => {
          if (bundle.bundleId !== 'create-current-skill') {
            const factualOutcomes = (bundle.episode as { factualOutcomes?: Array<{ outcome: string }> }).factualOutcomes;
            assert.deepEqual(factualOutcomes?.map(item => item.outcome), ['verified-success']);
            assert.match(bundle.sourceEvidence?.[1]?.content ?? '', /verified-success/);
            return { decision: 'defer', issues: [], rationale: 'Wait for more factual usage evidence.' };
          }
          return { decision: 'accept', transition: draft.envelope.decision, issues: [], rationale: 'Create the test skill.' };
        },
      });
      const createBundle: EvidenceBundle = {
        bundleId: 'create-current-skill',
        episode: { kind: 'bootstrap' },
        completionEvidence: [{ ref: 'create#1' }],
        settlementEvidence: [{ ref: 'create#2' }],
        boundedContinuity: [],
        referencedSkills: [],
        relatedCurrentSkills: [],
      };
      const created = await runtime.reviewAndApply(createBundle);
      assert.ok(created.record);
      const record = created.record!;
      const ledger = new SkillUsageLedger(path.join(root, 'data', 'usage.jsonl'));
      ledger.recordGeneratedSkillLoad({
        runtimeSessionId: 'session-1',
        episodeId: 'episode-1',
        skill: {
          capabilityHandle: record.handle,
          routingName: record.routingName,
          skillFilePath: record.skillFilePath,
          guidanceHash: record.guidanceHash,
        },
      });
      ledger.recordOutcome({ episodeId: 'episode-1', outcome: 'verified-success', evidenceRefs: ['episode-1#1'] });
      const curator = new SkillUsageCurator({
        ledger,
        statePath: path.join(root, 'data', 'curator.json'),
        intervalMs: 24 * 60 * 60 * 1000,
        successThreshold: 1,
        runtime,
      });

      const result = await curator.runDue();

      assert.deepEqual(result.transitions, [{ capabilityHandle: record.handle, transition: 'defer' }]);
      assert.equal(fs.existsSync(path.join(root, 'data', 'review-queue.json')), false);
      assert.equal(ledger.listFacts().filter(fact => fact.kind === 'episode-outcome' && fact.outcome === 'deferred').length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
