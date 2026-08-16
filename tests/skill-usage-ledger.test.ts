import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SkillUsageLedger,
  type SkillUsageLedgerFact,
} from '../src/utils/skill-usage-ledger';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import type { LearningEpisode } from '../src/utils/learning-episode';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function makeLedgerPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-usage-ledger-'));
  tempRoots.push(root);
  return path.join(root, 'skill-usage-ledger.jsonl');
}

describe('skill-usage-ledger read validation', () => {
  test('listFacts ignores malformed JSONL and generated-skill-load facts that fail write-side invariants', () => {
    const ledgerPath = makeLedgerPath();
    const validLoad: SkillUsageLedgerFact = {
      schemaVersion: 1,
      kind: 'generated-skill-load',
      factId: 'load-valid',
      recordedAt: '2026-07-19T00:00:00.000Z',
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      requestedRoutingName: 'skill-a',
      skill: {
        capabilityHandle: 'cap-a',
        routingName: 'skill-a',
        skillFilePath: '/tmp/skills/generated-distilled/cap-a/SKILL.md',
        guidanceHash: 'hash-a',
      },
    };

    const invalidMissingRoutingName = {
      ...validLoad,
      factId: 'load-missing-route',
      skill: {
        ...validLoad.skill,
        routingName: '',
      },
    };
    const invalidMissingGuidanceHash = {
      ...validLoad,
      factId: 'load-missing-hash',
      skill: {
        ...validLoad.skill,
        guidanceHash: '   ',
      },
    };
    const invalidMissingCapabilityHandle = {
      ...validLoad,
      factId: 'load-missing-handle',
      skill: {
        ...validLoad.skill,
        capabilityHandle: '',
      },
    };
    const invalidBadPath = {
      ...validLoad,
      factId: 'load-bad-path',
      skill: {
        ...validLoad.skill,
        skillFilePath: '/tmp/skills/manual/cap-a/SKILL.md',
      },
    };
    const invalidMissingSession = {
      ...validLoad,
      factId: 'load-missing-session',
      runtimeSessionId: '   ',
    };

    fs.writeFileSync(
      ledgerPath,
      [
        JSON.stringify(validLoad),
        '{not-json',
        JSON.stringify(invalidMissingRoutingName),
        JSON.stringify(invalidMissingGuidanceHash),
        JSON.stringify(invalidMissingCapabilityHandle),
        JSON.stringify(invalidBadPath),
        JSON.stringify(invalidMissingSession),
      ].join('\n') + '\n',
      'utf8',
    );

    const facts = new SkillUsageLedger(ledgerPath).listFacts();

    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0], validLoad);
  });

  test('listFacts ignores malformed episode-outcome facts and preserves valid ones', () => {
    const ledgerPath = makeLedgerPath();
    const validOutcome: SkillUsageLedgerFact = {
      schemaVersion: 1,
      kind: 'episode-outcome',
      factId: 'outcome-valid',
      recordedAt: '2026-07-19T00:00:00.000Z',
      loadFactId: 'load-valid',
      episodeId: 'turn-ep-1',
      outcome: 'verified-success',
      evidenceRefs: ['session.jsonl#12', 'session.jsonl#13'],
    };
    const invalidMissingLoadFactId = {
      ...validOutcome,
      factId: 'outcome-missing-load',
      loadFactId: '',
    };
    const invalidBadOutcome = {
      ...validOutcome,
      factId: 'outcome-bad-kind',
      outcome: 'accepted',
    };
    const invalidEvidenceRefs = {
      ...validOutcome,
      factId: 'outcome-bad-evidence',
      evidenceRefs: ['session.jsonl#12', 42],
    };

    fs.writeFileSync(
      ledgerPath,
      [
        JSON.stringify(validOutcome),
        JSON.stringify(invalidMissingLoadFactId),
        JSON.stringify(invalidBadOutcome),
        JSON.stringify(invalidEvidenceRefs),
      ].join('\n') + '\n',
      'utf8',
    );

    const facts = new SkillUsageLedger(ledgerPath).listFacts();

    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0], validOutcome);
  });
});

describe('skill usage feedback admission', () => {
  test('an eligible episode without an explicit correction does not create a success outcome', () => {
    const ledger = new SkillUsageLedger(makeLedgerPath());
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });

    const facts = ledger.recordEpisodeOutcome(makeEpisode({ status: 'eligible' }));

    assert.deepEqual(facts, []);
    assert.equal(ledger.listFacts().filter(fact => fact.kind === 'episode-outcome').length, 0);
  });

  test('outcome idempotency is set-based while new correction refs append immutable facts', () => {
    const ledger = new SkillUsageLedger(makeLedgerPath());
    const load = ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });

    const first = ledger.recordOutcome({
      episodeId: 'turn-ep-1',
      runtimeSessionId: 'sess-1',
      outcome: 'contradicted',
      evidenceRefs: ['session.jsonl#turn-3:contradiction', 'session.jsonl#turn-2:contradiction', 'session.jsonl#turn-2:contradiction'],
      targetLoadFactIds: [load.factId],
    });
    const replay = ledger.recordOutcome({
      episodeId: 'turn-ep-1',
      runtimeSessionId: 'sess-1',
      outcome: 'contradicted',
      evidenceRefs: ['session.jsonl#turn-2:contradiction', 'session.jsonl#turn-3:contradiction'],
      targetLoadFactIds: [load.factId],
    });
    const expanded = ledger.recordOutcome({
      episodeId: 'turn-ep-1',
      runtimeSessionId: 'sess-1',
      outcome: 'contradicted',
      evidenceRefs: [
        'session.jsonl#turn-4:contradiction',
        'session.jsonl#turn-3:contradiction',
        'session.jsonl#turn-2:contradiction',
      ],
      targetLoadFactIds: [load.factId],
    });

    assert.equal(first.length, 1);
    assert.deepEqual(replay, []);
    assert.equal(expanded.length, 1);
    assert.notEqual(first[0]!.factId, expanded[0]!.factId);
    assert.deepEqual(
      ledger.listFacts()
        .filter((fact): fact is Extract<SkillUsageLedgerFact, { kind: 'episode-outcome' }> => fact.kind === 'episode-outcome')
        .map(fact => fact.evidenceRefs),
      [
        ['session.jsonl#turn-2:contradiction', 'session.jsonl#turn-3:contradiction'],
        ['session.jsonl#turn-2:contradiction', 'session.jsonl#turn-3:contradiction', 'session.jsonl#turn-4:contradiction'],
      ],
    );
  });

  test('an unqualified correction remains unbound when multiple Skills are loaded', () => {
    const ledgerPath = makeLedgerPath();
    const ledger = new SkillUsageLedger(ledgerPath);
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: {
        ...generatedSkillIdentity(),
        capabilityHandle: 'cap-b',
        routingName: 'skill-b',
      },
    });
    const curator = new SkillUsageCurator({
      ledger,
      statePath: path.join(path.dirname(ledgerPath), 'curator-state.json'),
      intervalMs: 86_400_000,
    });
    const episode = makeEpisode({
      status: 'contradicted',
      contradictionSignals: [{
        signalId: 'signal-unrelated',
        kind: 'direct-correction',
        message: 'The report title is wrong; use the customer name instead.',
        source: {
          ref: 'session.jsonl#turn-2:unrelated-contradiction',
          sourceFilePath: 'session.jsonl',
          turn: 2,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'session.jsonl',
        runtimeSessionId: 'sess-1',
        preventsPromotion: true,
      }],
    });

    const outcomes = curator.observeEpisode(episode);

    assert.equal(episode.contradictionSignals.length, 1);
    assert.deepEqual(outcomes, []);
    assert.deepEqual(curator.pendingExpeditedWakes(), []);
  });

  test('an explicit Skill correction binds only the named load in a multi-Skill episode', () => {
    const ledgerPath = makeLedgerPath();
    const ledger = new SkillUsageLedger(ledgerPath);
    const loadA = ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });
    const loadB = ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      requestedRoutingName: 'package-rule',
      skill: {
        ...generatedSkillIdentity(),
        capabilityHandle: 'cap-b',
        routingName: 'skill-b',
      },
    });
    const curator = new SkillUsageCurator({
      ledger,
      statePath: path.join(path.dirname(ledgerPath), 'curator-state.json'),
      intervalMs: 86_400_000,
    });

    const outcomes = curator.observeEpisode(makeEpisode({
      status: 'contradicted',
      contradictionSignals: [{
        signalId: 'signal-targeted',
        kind: 'direct-correction',
        message: 'The `package-rule` Skill is wrong; this project requires npm.',
        source: {
          ref: 'session.jsonl#turn-2:targeted-contradiction',
          sourceFilePath: 'session.jsonl',
          turn: 2,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'session.jsonl',
        runtimeSessionId: 'sess-1',
        preventsPromotion: true,
      }],
    }));

    assert.deepEqual(outcomes.map(outcome => outcome.loadFactId), [loadB.factId]);
    assert.equal(outcomes.some(outcome => outcome.loadFactId === loadA.factId), false);
    assert.deepEqual(curator.pendingExpeditedWakes().map(wake => wake.capabilityHandle), ['cap-b']);
  });

  test('a single loaded Skill receives an unqualified contradiction', () => {
    const ledger = new SkillUsageLedger(makeLedgerPath());
    const load = ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });

    const outcomes = ledger.recordEpisodeOutcome(makeEpisode({
      status: 'contradicted',
      contradictionSignals: [{
        signalId: 'signal-unqualified',
        kind: 'direct-correction',
        message: 'That is not what I requested; use npm for this project.',
        source: {
          ref: 'session.jsonl#turn-2:unqualified-contradiction',
          sourceFilePath: 'session.jsonl',
          turn: 2,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'session.jsonl',
        runtimeSessionId: 'sess-1',
        preventsPromotion: true,
      }],
    }));

    assert.deepEqual(outcomes.map(outcome => outcome.loadFactId), [load.factId]);
    assert.deepEqual(outcomes[0]!.evidenceRefs, ['session.jsonl#turn-2:unqualified-contradiction']);
  });

  test('repeated loads of one stable Capability Handle across route/revision changes produce one correction outcome', () => {
    const ledger = new SkillUsageLedger(makeLedgerPath());
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      requestedRoutingName: 'first-alias',
      skill: generatedSkillIdentity(),
    });
    const latestLoad = ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      requestedRoutingName: 'second-alias',
      skill: {
        ...generatedSkillIdentity(),
        routingName: 'skill-a-v2',
        guidanceHash: 'hash-a-v2',
      },
    });

    const outcomes = ledger.recordEpisodeOutcome(makeEpisode({
      status: 'contradicted',
      contradictionSignals: [
        {
          signalId: 'signal-unqualified-repeat',
          kind: 'direct-correction',
          message: 'That is wrong; use npm for this project.',
          source: {
            ref: 'session.jsonl#turn-2:unqualified-repeat',
            sourceFilePath: 'session.jsonl',
            turn: 2,
            kind: 'contradiction',
          },
          precedingDeliveryTurn: 1,
          precedingSourceFilePath: 'session.jsonl',
          runtimeSessionId: 'sess-1',
          preventsPromotion: true,
        },
        {
          signalId: 'signal-second-alias-repeat',
          kind: 'direct-correction',
          message: 'The `second-alias` Skill also used the wrong package manager.',
          source: {
            ref: 'session.jsonl#turn-3:second-alias-repeat',
            sourceFilePath: 'session.jsonl',
            turn: 3,
            kind: 'contradiction',
          },
          precedingDeliveryTurn: 1,
          precedingSourceFilePath: 'session.jsonl',
          runtimeSessionId: 'sess-1',
          preventsPromotion: true,
        },
      ],
    }));

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.loadFactId, latestLoad.factId);
    assert.deepEqual(outcomes[0]!.evidenceRefs, [
      'session.jsonl#turn-2:unqualified-repeat',
      'session.jsonl#turn-3:second-alias-repeat',
    ]);
  });

  test('Skill identity binding handles Unicode wrappers and regex punctuation without partial matches', () => {
    const ledger = new SkillUsageLedger(makeLedgerPath());
    const load = ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      requestedRoutingName: '规则+(npm)',
      skill: generatedSkillIdentity(),
    });
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: {
        ...generatedSkillIdentity(),
        capabilityHandle: 'cap-b',
        routingName: 'skill-b',
      },
    });

    const partial = ledger.recordEpisodeOutcome(makeEpisode({
      status: 'contradicted',
      contradictionSignals: [{
        signalId: 'signal-partial-identity',
        kind: 'direct-correction',
        message: '请修正「规则+(npm)-extra」里的包管理器。',
        source: {
          ref: 'session.jsonl#turn-2:partial-identity',
          sourceFilePath: 'session.jsonl',
          turn: 2,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'session.jsonl',
        runtimeSessionId: 'sess-1',
        preventsPromotion: true,
      }],
    }));
    const exact = ledger.recordEpisodeOutcome(makeEpisode({
      status: 'contradicted',
      contradictionSignals: [{
        signalId: 'signal-unicode-identity',
        kind: 'direct-correction',
        message: '请修正「规则+(npm)」：这个项目要求 npm。',
        source: {
          ref: 'session.jsonl#turn-3:unicode-identity',
          sourceFilePath: 'session.jsonl',
          turn: 3,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'session.jsonl',
        runtimeSessionId: 'sess-1',
        preventsPromotion: true,
      }],
    }));

    assert.deepEqual(partial, []);
    assert.deepEqual(exact.map(outcome => outcome.loadFactId), [load.factId]);
  });

  test('a substring collision does not suppress fallback for one stable Skill identity', () => {
    const ledger = new SkillUsageLedger(makeLedgerPath());
    const load = ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: {
        ...generatedSkillIdentity(),
        routingName: 'test',
      },
    });

    const outcomes = ledger.recordEpisodeOutcome(makeEpisode({
      status: 'contradicted',
      contradictionSignals: [{
        signalId: 'signal-substring-collision',
        kind: 'direct-correction',
        message: 'The contest output is wrong; use the requested title.',
        source: {
          ref: 'session.jsonl#turn-2:substring-collision',
          sourceFilePath: 'session.jsonl',
          turn: 2,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'session.jsonl',
        runtimeSessionId: 'sess-1',
        preventsPromotion: true,
      }],
    }));

    assert.deepEqual(outcomes.map(outcome => outcome.loadFactId), [load.factId]);
  });

  test('observing an unsettled episode does not hide a later explicit contradiction', () => {
    const ledgerPath = makeLedgerPath();
    const ledger = new SkillUsageLedger(ledgerPath);
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });
    const curator = new SkillUsageCurator({
      ledger,
      statePath: path.join(path.dirname(ledgerPath), 'curator-state.json'),
      intervalMs: 86_400_000,
    });

    assert.deepEqual(curator.observeEpisode(makeEpisode({ status: 'settling' })), []);
    const outcomes = curator.observeEpisode(makeEpisode({
      status: 'contradicted',
      contradictionSignals: [{
        signalId: 'signal-1',
        kind: 'direct-correction',
        message: 'The skill-a guidance is not what I requested.',
        source: {
          ref: 'session.jsonl#turn-2:contradiction',
          sourceFilePath: 'session.jsonl',
          turn: 2,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'session.jsonl',
        runtimeSessionId: 'sess-1',
        preventsPromotion: true,
      }],
    }));

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.outcome, 'contradicted');
  });

  test('legacy observed-episode state does not hide a later explicit contradiction', () => {
    const ledgerPath = makeLedgerPath();
    const statePath = path.join(path.dirname(ledgerPath), 'curator-state.json');
    const ledger = new SkillUsageLedger(ledgerPath);
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });
    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1,
      lastRoutineRunAt: null,
      reviewedOutcomeFactIds: [],
      observedEpisodeIds: ['episode-1'],
      expedited: {},
    }), 'utf8');
    const curator = new SkillUsageCurator({
      ledger,
      statePath,
      intervalMs: 86_400_000,
    });

    const outcomes = curator.observeEpisode(makeEpisode({
      status: 'contradicted',
      contradictionSignals: [{
        signalId: 'signal-legacy-state',
        kind: 'direct-correction',
        message: 'The skill-a guidance is not what I requested.',
        source: {
          ref: 'session.jsonl#turn-2:legacy-contradiction',
          sourceFilePath: 'session.jsonl',
          turn: 2,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'session.jsonl',
        runtimeSessionId: 'sess-1',
        preventsPromotion: true,
      }],
    }));

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.outcome, 'contradicted');
  });

  test('legacy success and deferred outcomes do not trigger automatic reassessment', async () => {
    const ledgerPath = makeLedgerPath();
    const ledger = new SkillUsageLedger(ledgerPath);
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });
    ledger.recordOutcome({
      episodeId: 'turn-ep-1',
      runtimeSessionId: 'sess-1',
      outcome: 'verified-success',
      evidenceRefs: ['session.jsonl#turn-1:delivery:send_file'],
    });
    ledger.recordOutcome({
      episodeId: 'turn-ep-1',
      runtimeSessionId: 'sess-1',
      outcome: 'deferred',
      evidenceRefs: ['usage-curation:legacy'],
    });
    let reassessments = 0;
    const curator = new SkillUsageCurator({
      ledger,
      statePath: path.join(path.dirname(ledgerPath), 'curator-state.json'),
      intervalMs: 0,
      runtime: {
        getRegistry: () => ({
          capabilities: {
            'cap-a': {
              ...generatedSkillIdentity(),
              handle: 'cap-a',
            },
          },
        }),
      } as any,
      reassess: async () => {
        reassessments++;
        return 'reject_candidate';
      },
    });

    const result = await curator.runDue();

    assert.equal(reassessments, 0);
    assert.deepEqual(result.transitions, []);
  });

  test('expedited wake state is rebuilt when the ledger append survived a crash', () => {
    const ledgerPath = makeLedgerPath();
    const statePath = path.join(path.dirname(ledgerPath), 'curator-state.json');
    const ledger = new SkillUsageLedger(ledgerPath);
    const load = ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });
    const [outcome] = ledger.recordOutcome({
      episodeId: 'turn-ep-1',
      runtimeSessionId: 'sess-1',
      outcome: 'contradicted',
      evidenceRefs: ['session.jsonl#turn-2:contradiction'],
      targetLoadFactIds: [load.factId],
    });
    assert.ok(outcome);
    assert.equal(fs.existsSync(statePath), false, 'simulate crash before curator state persistence');

    const restarted = new SkillUsageCurator({
      ledger,
      statePath,
      intervalMs: 86_400_000,
    });
    restarted.recoverExpeditedWakes();
    restarted.recoverExpeditedWakes();

    assert.deepEqual(restarted.pendingExpeditedWakes(), [{
      capabilityHandle: 'cap-a',
      outcomeFactIds: [outcome.factId],
      requestedAt: restarted.pendingExpeditedWakes()[0]!.requestedAt,
    }]);
  });

  test('an explicit contradiction triggers exactly one reassessment', async () => {
    const ledgerPath = makeLedgerPath();
    const ledger = new SkillUsageLedger(ledgerPath);
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });
    let reassessments = 0;
    const curator = new SkillUsageCurator({
      ledger,
      statePath: path.join(path.dirname(ledgerPath), 'curator-state.json'),
      intervalMs: 0,
      runtime: {
        getRegistry: () => ({
          capabilities: {
            'cap-unrelated': {
              ...generatedSkillIdentity(),
              capabilityHandle: 'cap-unrelated',
              handle: 'cap-unrelated',
              routingName: 'unrelated-skill',
              description: 'Unrelated capability.',
              revision: 7,
              guidanceHash: 'hash-unrelated',
              referencedSkills: [],
            },
            'cap-a': {
              ...generatedSkillIdentity(),
              handle: 'cap-a',
              description: 'Affected capability.',
              revision: 3,
              referencedSkills: [],
            },
          },
        }),
      } as any,
      reassess: async request => {
        reassessments++;
        assert.deepEqual(request.outcomeFacts.map(fact => fact.outcome), ['contradicted']);
        assert.deepEqual(request.bundle.relatedCurrentSkills.map(skill => skill.handle), ['cap-a']);
        assert.deepEqual(request.bundle.authority, {
          kind: 'usage-reassessment',
          targetCapabilityHandle: 'cap-a',
        });
        return 'reject_candidate';
      },
    });
    curator.observeEpisode(makeEpisode({
      status: 'contradicted',
      contradictionSignals: [{
        signalId: 'signal-1',
        kind: 'direct-correction',
        message: 'The skill-a guidance is not what I requested.',
        source: {
          ref: 'session.jsonl#turn-2:contradiction',
          sourceFilePath: 'session.jsonl',
          turn: 2,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'session.jsonl',
        runtimeSessionId: 'sess-1',
        preventsPromotion: true,
      }],
    }));

    const first = await curator.runDue();
    const second = await curator.runDue();

    assert.equal(reassessments, 1);
    assert.equal(first.transitions.length, 1);
    assert.deepEqual(second.transitions, []);
  });

  test('a new correction rebuilds a deferred reassessment with prior active-revision evidence', async () => {
    const ledgerPath = makeLedgerPath();
    const ledger = new SkillUsageLedger(ledgerPath);
    const load = ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });
    const observedBundles: string[][] = [];
    const curator = new SkillUsageCurator({
      ledger,
      statePath: path.join(path.dirname(ledgerPath), 'curator-state.json'),
      intervalMs: 86_400_000,
      runtime: {
        getRegistry: () => ({
          capabilities: {
            'cap-a': {
              ...generatedSkillIdentity(),
              handle: 'cap-a',
              description: 'Affected capability.',
              revision: 3,
              referencedSkills: [],
            },
          },
        }),
      } as any,
      reassess: async request => {
        observedBundles.push(request.outcomeFacts.map(fact => fact.factId).sort());
        return observedBundles.length === 1 ? 'defer' : 'reject_candidate';
      },
    });
    const first = ledger.recordOutcome({
      episodeId: 'turn-ep-1',
      runtimeSessionId: 'sess-1',
      outcome: 'contradicted',
      evidenceRefs: ['session.jsonl#turn-2:first-correction'],
      targetLoadFactIds: [load.factId],
    })[0]!;
    curator.requestExpeditedWake(first);
    await curator.runDue();

    const second = ledger.recordOutcome({
      episodeId: 'turn-ep-1',
      runtimeSessionId: 'sess-1',
      outcome: 'contradicted',
      evidenceRefs: ['session.jsonl#turn-3:second-correction'],
      targetLoadFactIds: [load.factId],
    })[0]!;
    curator.requestExpeditedWake(second);
    await curator.runDue();

    assert.deepEqual(observedBundles, [
      [first.factId],
      [first.factId, second.factId].sort(),
    ]);
  });

  test('load facts with the same AgentTurn id do not cross runtime sessions', () => {
    const ledgerPath = makeLedgerPath();
    const ledger = new SkillUsageLedger(ledgerPath);
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-1',
      episodeId: 'turn-ep-1',
      skill: generatedSkillIdentity(),
    });
    ledger.recordGeneratedSkillLoad({
      runtimeSessionId: 'sess-2',
      episodeId: 'turn-ep-1',
      skill: {
        ...generatedSkillIdentity(),
        capabilityHandle: 'cap-b',
        routingName: 'skill-b',
      },
    });
    const curator = new SkillUsageCurator({
      ledger,
      statePath: path.join(path.dirname(ledgerPath), 'curator-state.json'),
      intervalMs: 86_400_000,
    });

    const facts = curator.listLoadFactsForEpisode(makeEpisode());
    const outcomes = ledger.recordEpisodeOutcome(makeEpisode({
      status: 'contradicted',
      contradictionSignals: [{
        signalId: 'signal-cross-session',
        kind: 'direct-correction',
        message: 'The skill-a delivery guidance is incorrect.',
        source: {
          ref: 'session.jsonl#turn-2:contradiction',
          sourceFilePath: 'session.jsonl',
          turn: 2,
          kind: 'contradiction',
        },
        precedingDeliveryTurn: 1,
        precedingSourceFilePath: 'session.jsonl',
        runtimeSessionId: 'sess-1',
        preventsPromotion: true,
      }],
    }));

    assert.deepEqual(facts.map(fact => fact.skill.capabilityHandle), ['cap-a']);
    assert.deepEqual(outcomes.map(outcome => outcome.loadFactId), [facts[0]!.factId]);
  });
});

function generatedSkillIdentity() {
  return {
    capabilityHandle: 'cap-a',
    routingName: 'skill-a',
    skillFilePath: '/tmp/skills/generated-distilled/cap-a/SKILL.md',
    guidanceHash: 'hash-a',
  };
}

function makeEpisode(overrides: Partial<LearningEpisode> = {}): LearningEpisode {
  return {
    schemaVersion: 3,
    episodeId: 'episode-1',
    agentTurnEpisodeId: 'turn-ep-1',
    runtimeSessionId: 'sess-1',
    sourceFilePath: 'session.jsonl',
    deliveryTurn: 1,
    completionEvidence: [{
      ref: 'session.jsonl#turn-1:delivery:send_file',
      sourceFilePath: 'session.jsonl',
      turn: 1,
      kind: 'artifact-delivery',
    }],
    contradictionSignals: [],
    semanticObservations: [],
    settlementDeadline: '2026-07-19T00:00:00.000Z',
    status: 'settling',
    ...overrides,
  };
}
