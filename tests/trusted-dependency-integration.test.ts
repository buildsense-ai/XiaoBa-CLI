import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillTool } from '../src/tools/skill-tool';
import { buildEpisodeEvidenceBundle } from '../src/utils/episode-evidence-bundle';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import type { LearningEpisode } from '../src/utils/learning-episode';
import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import {
  emptyCurrentSkillRegistryState,
  saveCurrentSkillRegistry,
  type ReferencedSkillSnapshot,
  type SkillEvolutionRuntime,
} from '../src/utils/skill-evolution';

let root = '';
let originalCwd = '';
let originalSkillsEnv: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-trusted-dependency-integration-'));
  originalCwd = process.cwd();
  originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
  process.chdir(root);
  process.env.XIAOBA_SKILLS_DIR = path.join(root, 'skills');
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalSkillsEnv === undefined) delete process.env.XIAOBA_SKILLS_DIR;
  else process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

function makeSkillEvolutionStub(
  referencedSkills: ReferencedSkillSnapshot[],
): SkillEvolutionRuntime {
  return {
    getRegistry: () => ({ capabilities: {} }) as any,
    getReferencedSkillSnapshots: () => referencedSkills,
  } as unknown as SkillEvolutionRuntime;
}

function makeEpisode(): LearningEpisode {
  return {
    schemaVersion: 3 as any,
    episodeId: 'distilled-ep-1',
    agentTurnEpisodeId: 'turn-ep-1',
    runtimeSessionId: 'sess-1',
    sourceFilePath: 'session.jsonl',
    deliveryTurn: 5,
    completionEvidence: [
      { ref: 'session.jsonl#4:problem-action', sourceFilePath: 'session.jsonl', turn: 4, kind: 'verified-tool-result' },
      { ref: 'session.jsonl#5:artifact-delivery', sourceFilePath: 'session.jsonl', turn: 5, kind: 'artifact-delivery' },
    ],
    contradictionSignals: [],
    sourceEvidence: [
      {
        ref: 'session.jsonl#4:problem-action',
        role: 'problem-action',
        content: 'User:\nApply the generated helper.\n\nAssistant:\nI loaded the helper.',
        sourceFilePath: 'session.jsonl',
        turn: 4,
      },
      {
        ref: 'session.jsonl#5:artifact-delivery',
        role: 'problem-action',
        content: 'User:\nDeliver the result.\n\nAssistant:\nThe result was delivered.',
        sourceFilePath: 'session.jsonl',
        turn: 5,
      },
    ],
    semanticObservations: [
      { kind: 'user-intent', value: 'apply the generated helper', sourceRefs: ['session.jsonl#4:problem-action'] },
    ],
    settlementDeadline: '2026-07-20T00:00:00.000Z',
    status: 'settled',
  } as LearningEpisode;
}

function makeCandidate(): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: 'trusted-dependency-example',
    title: 'Trusted dependency example',
    applicability: 'When the user asks to reuse the generated helper workflow.',
    actionPattern: 'Load the generated helper and apply its bounded guidance.',
    boundaries: ['Only for this bounded helper workflow.'],
    risks: ['Do not assume unrelated helpers are dependencies.'],
    solvedLoop: {
      problem: 'Need generated helper guidance',
      action: 'Loaded the helper skill',
      verification: 'User accepted the result',
      noCorrection: 'No contradiction observed',
    },
    provenance: [
      { filePath: 'session.jsonl', turn: 4, role: 'problem-action', unitByteRange: { start: 0, end: 10 } },
      { filePath: 'session.jsonl', turn: 5, role: 'verification', unitByteRange: { start: 11, end: 20 } },
    ],
    generatedAt: '2026-07-19T00:00:00.000Z',
    sourceUnit: { filePath: 'session.jsonl', byteRange: { start: 0, end: 20 }, generatedAt: '2026-07-19T00:00:00.000Z' },
  };
}

describe('trusted dependency public-seam integration', () => {
  test('SkillTool load -> SkillUsageLedger persistence -> SkillUsageCurator lookup -> ordinary Evidence Bundle selection', async () => {
    const ledgerPath = path.join(root, 'data', 'skill-usage-ledger.jsonl');
    const ledger = new SkillUsageLedger(ledgerPath);
    const generatedSkillPath = path.join(
      root,
      'skills',
      'generated-distilled',
      'cap-helper',
      'SKILL.md',
    );
    fs.mkdirSync(path.dirname(generatedSkillPath), { recursive: true });
    fs.writeFileSync(
      generatedSkillPath,
      [
        '---',
        'name: generated-helper',
        'description: Generated helper',
        '---',
        '',
        'Use the generated helper workflow.',
      ].join('\n'),
      'utf8',
    );
    const guidanceHash = crypto.createHash('sha256')
      .update(fs.readFileSync(generatedSkillPath))
      .digest('hex');
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.capabilities['cap-helper'] = {
      handle: 'cap-helper',
      revision: 1,
      routingName: 'generated-helper',
      description: 'Generated helper',
      skillFilePath: generatedSkillPath,
      guidanceHash,
      evidenceRefs: [],
      referencedSkills: [],
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    };
    saveCurrentSkillRegistry(
      path.join(root, 'data', 'current-skill-registry.json'),
      registry,
    );

    const tool = new SkillTool(ledger);
    const toolResult = await tool.execute(
      { skill: 'generated-helper' },
      {
        sessionId: 'sess-1',
        episodeId: 'turn-ep-1',
        surface: 'test',
      } as any,
    );
    assert.equal(toolResult.ok, true);

    const curator = new SkillUsageCurator({
      ledger,
      statePath: path.join(root, 'data', 'curator-state.json'),
      intervalMs: 24 * 60 * 60 * 1000,
    });
    const loadFacts = curator.listLoadFactsForEpisode({
      agentTurnEpisodeId: 'turn-ep-1',
      runtimeSessionId: 'sess-1',
    });

    assert.equal(loadFacts.length, 1);
    assert.equal(loadFacts[0]!.runtimeSessionId, 'sess-1');
    assert.equal(loadFacts[0]!.skill.capabilityHandle, 'cap-helper');
    assert.equal(loadFacts[0]!.skill.routingName, 'generated-helper');

    const skillEvolution = makeSkillEvolutionStub([
      {
        name: 'generated-helper',
        capabilityHandle: 'cap-helper',
        guidanceHash: loadFacts[0]!.skill.guidanceHash,
      },
      {
        name: 'catsco-prompt-editor',
        capabilityHandle: 'cap-unrelated',
        guidanceHash: 'hash-unrelated',
      },
    ]);

    const bundle = buildEpisodeEvidenceBundle(
      makeEpisode(),
      makeCandidate(),
      skillEvolution,
      undefined,
      undefined,
      loadFacts,
    );

    assert.deepEqual(
      bundle.referencedSkills.map(skill => skill.name),
      ['generated-helper'],
    );
    assert.equal(bundle.referencedSkills[0]!.capabilityHandle, 'cap-helper');
    assert.equal(bundle.referencedSkills[0]!.guidanceHash, loadFacts[0]!.skill.guidanceHash);
  });
});
