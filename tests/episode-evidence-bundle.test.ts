import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildEpisodeEvidenceBundle,
  MissingLearningEpisodeSourceEvidenceError,
  selectRuntimeOwnedReferencedSkills,
} from '../src/utils/episode-evidence-bundle';
import { EvidenceCapsuleStore, buildEvidenceCapsule } from '../src/utils/evidence-capsule';
import type {
  EvidenceBundle,
  ReferencedSkillSnapshot,
  SkillEvolutionRuntime,
} from '../src/utils/skill-evolution';
import {
  extractLearningEpisodes,
  LearningEpisodeStore,
  MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_CONTENT_BYTES,
  MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_ENTRIES,
  type LearningEpisode,
} from '../src/utils/learning-episode';
import type { DistillationUnit } from '../src/utils/distillation-unit';
import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import type { GeneratedSkillLoadFact } from '../src/utils/skill-usage-ledger';

/**
 * Focused tests for the extracted episode-evidence-bundle responsibility.
 *
 * buildEpisodeEvidenceBundle was previously a private function at the tail of
 * runtime-learning.ts (with late imports). It was extracted into
 * ./episode-evidence-bundle as a behavior-preserving move. These tests prove the
 * extracted module assembles the fixed Evidence Bundle correctly:
 *   - completion evidence excludes contradictions
 *   - settlement evidence is synthesized from the episode
 *   - related current skills are derived from the live registry
 *   - external-origin episodes require a persisted capsule (fail-fast)
 *   - a persisted capsule reconstructs the bundle instead of using raw episode data
 */

const SAMPLE_REFERENCED_SKILLS: ReferencedSkillSnapshot[] = [
  { capabilityHandle: 'cap-1', name: 'create-sticker-svg', revision: 3 },
];

function makeEpisode(overrides: Partial<LearningEpisode> = {}): LearningEpisode {
  return {
    schemaVersion: 3 as any,
    episodeId: 'episode-test-001',
    runtimeSessionId: 'sess-1',
    sourceFilePath: '/logs/sessions/chat/test.jsonl',
    deliveryTurn: 4,
    completionEvidence: [
      { ref: 'turn-1#completion', sourceFilePath: '/logs/sessions/chat/test.jsonl', turn: 1, kind: 'verified-tool-result' },
      { ref: 'turn-2#contradiction', sourceFilePath: '/logs/sessions/chat/test.jsonl', turn: 2, kind: 'contradiction' },
      { ref: 'turn-3#completion', sourceFilePath: '/logs/sessions/chat/test.jsonl', turn: 3, kind: 'artifact-delivery' },
    ],
    contradictionSignals: [],
    sourceEvidence: [
      {
        ref: 'turn-1#completion',
        role: 'problem-action',
        content: 'User:\nCreate a sticker.\n\nAssistant:\nI created the sticker.',
        sourceFilePath: '/logs/sessions/chat/test.jsonl',
        turn: 1,
      },
      {
        ref: 'turn-3#completion',
        role: 'problem-action',
        content: 'User:\nSend the sticker.\n\nAssistant:\nThe sticker was delivered.',
        sourceFilePath: '/logs/sessions/chat/test.jsonl',
        turn: 3,
      },
    ],
    semanticObservations: [
      { kind: 'user-intent', value: 'create a sticker', sourceRefs: ['turn-1#completion'] },
    ],
    settlementDeadline: '2026-01-01T00:00:00.000Z',
    status: 'settled',
    ...overrides,
  } as LearningEpisode;
}

function makeCandidate(): DistilledKnowledgeCandidate {
  return {
    capabilityId: 'episode-capability-test-001',
    title: 'Create Sticker',
    summary: 'A sticker creation capability.',
    evidenceSummary: ['turn-1#completion', 'turn-3#completion'],
    toolNames: ['create_sticker_svg'],
    generatedAt: '2026-01-01T00:00:00.000Z',
    provenance: [],
    observations: [],
  } as unknown as DistilledKnowledgeCandidate;
}

/**
 * Minimal SkillEvolutionRuntime stub: buildEpisodeEvidenceBundle only calls
 * getRegistry() and getReferencedSkillSnapshots(), so a structural stub is
 * sufficient and avoids constructing the full runtime with all its options.
 */
function makeSkillEvolutionStub(registry: {
  capabilities: Record<string, any>;
}, referencedSkills: ReferencedSkillSnapshot[] = SAMPLE_REFERENCED_SKILLS): SkillEvolutionRuntime {
  return {
    getRegistry: () => registry as any,
    getReferencedSkillSnapshots: () => referencedSkills,
  } as unknown as SkillEvolutionRuntime;
}

describe('episode-evidence-bundle (extracted responsibility)', () => {
  test('assembles a bundle with the v3 learning-episode bundleId', () => {
    const episode = makeEpisode();
    const candidate = makeCandidate();
    const skillEvolution = makeSkillEvolutionStub({ capabilities: {} });
    const bundle = buildEpisodeEvidenceBundle(episode, candidate, skillEvolution);

    assert.equal(bundle.bundleId, 'v3:learning-episode:episode-test-001');
    assert.deepEqual(bundle.authority, {
      kind: 'learning-episode',
      episodeId: 'episode-test-001',
    });
    assert.equal(bundle.episode, candidate);
  });

  test('completion evidence excludes contradictions and maps to SkillEvidenceRef', () => {
    const episode = makeEpisode();
    const skillEvolution = makeSkillEvolutionStub({ capabilities: {} });
    const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(episode, makeCandidate(), skillEvolution);

    assert.equal(bundle.completionEvidence.length, 2);
    assert.deepEqual(
      bundle.completionEvidence.map(e => e.ref),
      ['turn-1#completion', 'turn-3#completion'],
    );
    // Contradiction evidence must be filtered out.
    assert.ok(!bundle.completionEvidence.some(e => e.ref.includes('contradiction')));
  });

  test('settlement evidence is synthesized from the episode settlement deadline', () => {
    const episode = makeEpisode();
    const skillEvolution = makeSkillEvolutionStub({ capabilities: {} });
    const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(episode, makeCandidate(), skillEvolution);

    assert.equal(bundle.settlementEvidence.length, 1);
    const [settlement] = bundle.settlementEvidence;
    assert.equal(settlement.sourceFilePath, episode.sourceFilePath);
    assert.equal(settlement.turn, episode.deliveryTurn);
    assert.match(settlement.ref, /settlement-2026-01-01T00:00:00\.000Z/);
  });

  test('local completion and settlement refs have matching frozen source content', () => {
    const episode = makeEpisode({ status: 'eligible' });
    const bundle = buildEpisodeEvidenceBundle(
      episode,
      makeCandidate(),
      makeSkillEvolutionStub({ capabilities: {} }),
    );
    const sourceByRef = new Map(bundle.sourceEvidence!.map(source => [source.ref, source]));

    for (const ref of bundle.completionEvidence) {
      const source = sourceByRef.get(ref.ref);
      assert.ok(source, `missing completion source for ${ref.ref}`);
      assert.equal(source.role, 'problem-action');
      assert.equal(source.sourceFilePath, ref.sourceFilePath);
      assert.equal(source.turn, ref.turn);
      assert.ok(source.content.trim());
    }
    for (const ref of bundle.settlementEvidence) {
      const source = sourceByRef.get(ref.ref);
      assert.ok(source, `missing settlement source for ${ref.ref}`);
      assert.equal(source.role, 'verification');
      assert.match(source.content, /status: eligible/);
    }
  });

  test('legacy local episode without a frozen source snapshot fails closed', () => {
    const episode = makeEpisode({ sourceEvidence: undefined });
    assert.throws(
      () => buildEpisodeEvidenceBundle(
        episode,
        makeCandidate(),
        makeSkillEvolutionStub({ capabilities: {} }),
      ),
      (error: unknown) => (
        error instanceof MissingLearningEpisodeSourceEvidenceError
        && /has no frozen source evidence/.test(error.message)
      ),
    );
  });

  test('local episode with a missing completion snapshot fails closed', () => {
    const episode = makeEpisode({
      sourceEvidence: makeEpisode().sourceEvidence?.slice(0, 1),
    });
    assert.throws(
      () => buildEpisodeEvidenceBundle(
        episode,
        makeCandidate(),
        makeSkillEvolutionStub({ capabilities: {} }),
      ),
      /has no matching frozen source content for turn-3#completion/,
    );
  });

  test('relatedCurrentSkills include exact frozen route mentions but exclude the unrelated Registry', () => {
    const episode = makeEpisode({
      semanticObservations: [{
        kind: 'referenced-skill',
        value: 'Extend `route-a` with this evidence.',
        sourceRefs: ['turn-1#completion'],
      }],
    });
    const skillEvolution = makeSkillEvolutionStub({
      capabilities: {
        'cap-a': {
          handle: 'cap-a',
          revision: 2,
          routingName: 'route-a',
          description: 'Capability A',
          guidanceHash: 'hash-a',
          skillFilePath: '/skills/a.md',
          evidenceRefs: [],
          referencedSkills: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'cap-b': {
          handle: 'cap-b',
          revision: 1,
          routingName: 'route-b',
          description: 'Capability B',
          guidanceHash: 'hash-b',
          skillFilePath: '/skills/b.md',
          evidenceRefs: [],
          referencedSkills: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(episode, makeCandidate(), skillEvolution);

    assert.equal(bundle.relatedCurrentSkills.length, 1);
    assert.equal(bundle.relatedCurrentSkills[0].handle, 'cap-a');
    assert.equal(bundle.relatedCurrentSkills[0].routingName, 'route-a');
    assert.equal(bundle.relatedCurrentSkills[0].guidanceHash, 'hash-a');
  });

  test('relatedCurrentSkills do not inherit unrelated Registry membership', () => {
    const skillEvolution = makeSkillEvolutionStub({
      capabilities: {
        'cap-unrelated': {
          handle: 'cap-unrelated',
          revision: 1,
          routingName: 'unrelated-route',
          description: 'Unrelated capability',
          guidanceHash: 'hash-unrelated',
          skillFilePath: '/skills/unrelated.md',
          evidenceRefs: [],
          referencedSkills: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    const bundle = buildEpisodeEvidenceBundle(makeEpisode(), makeCandidate(), skillEvolution);

    assert.deepEqual(bundle.relatedCurrentSkills, []);
  });

  test('referencedSkills exclude the unrelated Skill catalog when no referenced-skill evidence exists', () => {
    const episode = makeEpisode();
    const skillEvolution = makeSkillEvolutionStub({ capabilities: {} });
    const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(episode, makeCandidate(), skillEvolution);

    // Progressive Trust: referencedSkills means actual/evidenced dependencies,
    // not the complete runtime catalog. The episode only carries a user-intent
    // observation, so no Skill snapshot is evidenced and the field is empty.
    assert.deepEqual(bundle.referencedSkills, []);
    assert.equal(bundle.semanticObservations, episode.semanticObservations);
    assert.deepEqual(bundle.boundedContinuity, []);
  });

  test('referencedSkills include only a Skill proven by a runtime-owned GeneratedSkillLoadFact tied to the same episode', () => {
    const evidencedSnapshot: ReferencedSkillSnapshot = {
      capabilityHandle: 'cap-sticker',
      name: 'create-sticker-svg',
      revision: 3,
      guidanceHash: 'hash-sticker',
    };
    const unrelatedSnapshot: ReferencedSkillSnapshot = {
      capabilityHandle: 'cap-unrelated',
      name: 'catsco-prompt-editor',
      revision: 1,
    };
    const episode = makeEpisode({
      agentTurnEpisodeId: 'turn-episode-001',
      semanticObservations: [
        { kind: 'user-intent', value: 'create a sticker', sourceRefs: ['turn-1#completion'] },
      ],
    });
    const skillLoadFacts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'skill-load_abc',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 'sess-1',
        episodeId: 'turn-episode-001',
        skill: {
          capabilityHandle: 'cap-sticker',
          routingName: 'create-sticker-svg',
          skillFilePath: '/skills/generated-distilled/cap-sticker/SKILL.md',
          guidanceHash: 'hash-sticker',
        },
      },
    ];
    const skillEvolution = makeSkillEvolutionStub(
      {
        capabilities: {
          'cap-sticker': {
            handle: 'cap-sticker',
            revision: 3,
            routingName: 'create-sticker-svg',
            description: 'Create sticker SVGs',
            guidanceHash: 'hash-sticker',
            skillFilePath: '/skills/generated-distilled/cap-sticker/SKILL.md',
            evidenceRefs: [],
            referencedSkills: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          'cap-unrelated': {
            handle: 'cap-unrelated',
            revision: 1,
            routingName: 'catsco-prompt-editor',
            description: 'Unrelated capability',
            guidanceHash: 'hash-unrelated',
            skillFilePath: '/skills/generated-distilled/cap-unrelated/SKILL.md',
            evidenceRefs: [],
            referencedSkills: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
      [evidencedSnapshot, unrelatedSnapshot],
    );
    const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
      episode,
      makeCandidate(),
      skillEvolution,
      undefined,
      undefined,
      skillLoadFacts,
    );

    // Only the dependency proven by the runtime-owned load fact is included;
    // the unrelated catalog entry is excluded from referencedSkills.
    assert.equal(bundle.referencedSkills.length, 1);
    assert.equal(bundle.referencedSkills[0]!.name, 'create-sticker-svg');
    assert.ok(!bundle.referencedSkills.some(skill => skill.name === 'catsco-prompt-editor'));
    assert.deepEqual(bundle.relatedCurrentSkills.map(skill => skill.handle), ['cap-sticker']);
    assert.deepEqual(bundle.referencedSkillProvenance, {
      kind: 'runtime-owned-generated-skill-load-v1',
      runtimeSessionId: 'sess-1',
      agentTurnEpisodeId: 'turn-episode-001',
      referencedSkills: [{
        capabilityHandle: 'cap-sticker',
        routingName: 'create-sticker-svg',
        guidanceHash: 'hash-sticker',
      }],
    });
  });

  test('referencedSkills stay empty when an episode has no agentTurnEpisodeId (legacy correlation)', () => {
    // Legacy episodes have no canonical AgentTurn correlation. Even if
    // runtime-owned load facts exist, they cannot be safely joined without
    // the episode correlation — never join by timestamp or session proximity.
    const episode = makeEpisode({
      agentTurnEpisodeId: undefined,
    });
    const skillLoadFacts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'skill-load_legacy',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 'sess-1',
        episodeId: 'some-other-episode',
        skill: {
          capabilityHandle: 'cap-1',
          routingName: 'create-sticker-svg',
          skillFilePath: '/skills/generated-distilled/cap-1/SKILL.md',
          guidanceHash: 'hash-1',
        },
      },
    ];
    const skillEvolution = makeSkillEvolutionStub({ capabilities: {} }, SAMPLE_REFERENCED_SKILLS);
    const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
      episode,
      makeCandidate(),
      skillEvolution,
      undefined,
      undefined,
      skillLoadFacts,
    );

    // No agentTurnEpisodeId = no join = no dependencies.
    assert.deepEqual(bundle.referencedSkills, []);
  });

  test('external-origin episode without a capsule fails fast', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-episode-bundle-'));
    try {
      const capsuleStorePath = path.join(root, 'capsules.json');
      const capsuleStore = new EvidenceCapsuleStore(capsuleStorePath);
      const episode = makeEpisode({ episodeId: 'episode-ext-001' });
      const skillEvolution = makeSkillEvolutionStub({ capabilities: {} });

      assert.throws(
        () => buildEpisodeEvidenceBundle(
          episode,
          makeCandidate(),
          skillEvolution,
          capsuleStore,
          () => true, // isExternalEpisode
        ),
        /External-origin Learning Episode episode-ext-001 requires a persisted Evidence Capsule before review\./,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('non-external episode with empty capsule store still builds a plain bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-episode-bundle-plain-'));
    try {
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'capsules.json'));
      const episode = makeEpisode();
      const skillEvolution = makeSkillEvolutionStub({ capabilities: {} });
      const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
        episode,
        makeCandidate(),
        skillEvolution,
        capsuleStore,
        () => false, // not external
      );

      assert.equal(bundle.bundleId, 'v3:learning-episode:episode-test-001');
      assert.equal(bundle.completionEvidence.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('local review basis remains identical after its source log changes and is deleted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-local-evidence-snapshot-'));
    try {
      const sourceFilePath = path.join(root, 'session.jsonl');
      const episodeStore = new LearningEpisodeStore(path.join(root, 'learning-episodes.json'));
      const originalTurn = {
        entry_type: 'turn' as const,
        turn: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        session_id: 'snapshot-session',
        session_type: 'cli',
        episode_id: 'snapshot-agent-turn',
        user: { text: 'Always use npm for this repository.' },
        assistant: {
          text: 'Understood. I will use npm for repository commands.',
          tool_calls: [],
        },
        tokens: { prompt: 20, completion: 12 },
      };
      const originalLine = `${JSON.stringify(originalTurn)}\n`;
      fs.writeFileSync(sourceFilePath, originalLine, 'utf8');
      const unit: DistillationUnit = {
        filePath: sourceFilePath,
        newTurns: [originalTurn],
        continuityTurns: [],
        byteRange: { start: 0, end: Buffer.byteLength(originalLine, 'utf8') },
        generatedAt: '2026-01-01T00:00:01.000Z',
      };
      const [extracted] = extractLearningEpisodes(unit, 0).episodes;
      assert.ok(extracted);
      const admitted: LearningEpisode = { ...extracted, status: 'eligible' };
      episodeStore.upsert([admitted]);

      const skillEvolution = makeSkillEvolutionStub({ capabilities: {} });
      const frozenEpisode = episodeStore.load().episodes[admitted.episodeId]!;
      const originalBundle = buildEpisodeEvidenceBundle(
        frozenEpisode,
        makeCandidate(),
        skillEvolution,
      );
      assert.match(originalBundle.sourceEvidence![0]!.content, /Always use npm/);
      assert.match(originalBundle.sourceEvidence![0]!.content, /I will use npm/);

      fs.writeFileSync(sourceFilePath, '{"changed":"upstream content"}\n', 'utf8');
      const afterMutation = buildEpisodeEvidenceBundle(
        episodeStore.load().episodes[admitted.episodeId]!,
        makeCandidate(),
        skillEvolution,
      );
      assert.deepEqual(afterMutation, originalBundle);
      assert.doesNotMatch(JSON.stringify(afterMutation), /upstream content/);

      fs.unlinkSync(sourceFilePath);
      const afterDeletion = buildEpisodeEvidenceBundle(
        episodeStore.load().episodes[admitted.episodeId]!,
        makeCandidate(),
        skillEvolution,
      );
      assert.deepEqual(afterDeletion, originalBundle);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Episode replay cannot replace evidence already frozen for the same refs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-local-evidence-replay-'));
    try {
      const store = new LearningEpisodeStore(path.join(root, 'learning-episodes.json'));
      const original = makeEpisode({ status: 'eligible' });
      store.upsert([original]);

      store.upsert([{
        ...original,
        completionEvidence: original.completionEvidence.map(item => ({
          ...item,
          detail: `MUTATED DETAIL FOR ${item.ref}`,
        })),
        sourceEvidence: original.sourceEvidence!.map(item => ({
          ...item,
          content: `MUTATED SOURCE FOR ${item.ref}`,
        })),
        semanticObservations: original.semanticObservations.map(item => ({
          ...item,
          value: 'mutated semantic observation',
        })),
      }]);

      const stored = store.load().episodes[original.episodeId]!;
      assert.deepEqual(stored.completionEvidence, original.completionEvidence);
      assert.deepEqual(stored.sourceEvidence, original.sourceEvidence);
      assert.deepEqual(stored.semanticObservations, original.semanticObservations);
      assert.doesNotMatch(JSON.stringify(stored), /MUTATED/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('Episode replay overflow preserves the already frozen source snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-local-evidence-overflow-'));
    try {
      const store = new LearningEpisodeStore(path.join(root, 'learning-episodes.json'));
      const original = makeEpisode({
        completionEvidence: Array.from(
          { length: MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_ENTRIES },
          (_, index) => ({
            ref: `turn-${index}#completion`,
            sourceFilePath: '/logs/sessions/chat/test.jsonl',
            turn: index,
            kind: 'verified-tool-result' as const,
          }),
        ),
        sourceEvidence: Array.from(
          { length: MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_ENTRIES },
          (_, index) => ({
            ref: `turn-${index}#completion`,
            role: 'problem-action' as const,
            content: `Frozen source ${index}`,
          }),
        ),
      });
      store.upsert([original]);

      store.upsert([{
        ...original,
        completionEvidence: [{
          ref: 'turn-new#completion',
          sourceFilePath: '/logs/sessions/chat/test.jsonl',
          turn: 100,
          kind: 'verified-tool-result',
        }],
        sourceEvidence: [{
          ref: 'turn-new#completion',
          role: 'problem-action',
          content: 'Later source that would exceed the entry bound.',
        }],
      }]);

      const stored = store.load().episodes[original.episodeId]!;
      assert.deepEqual(stored.sourceEvidence, original.sourceEvidence);
      assert.equal(stored.sourceEvidence?.some(item => item.ref === 'turn-new#completion'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('local source transcripts are bounded before the Episode is persisted', () => {
    const longText = '长'.repeat(MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_CONTENT_BYTES * 2);
    const unit: DistillationUnit = {
      filePath: '/logs/sessions/chat/bounded.jsonl',
      newTurns: [{
        entry_type: 'turn',
        turn: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        session_id: 'bounded-session',
        session_type: 'cli',
        user: { text: `Use npm. ${longText}` },
        assistant: { text: `Done. ${longText}`, tool_calls: [] },
        tokens: { prompt: 20, completion: 12 },
      }],
      continuityTurns: [],
      byteRange: { start: 0, end: 20_000 },
      generatedAt: '2026-01-01T00:00:01.000Z',
    };

    const [episode] = extractLearningEpisodes(unit, 0).episodes;
    assert.ok(episode?.sourceEvidence?.length);
    assert.ok(Buffer.byteLength(episode.sourceEvidence![0]!.content, 'utf8')
      <= MAX_LEARNING_EPISODE_SOURCE_EVIDENCE_CONTENT_BYTES);
    assert.match(episode.sourceEvidence![0]!.content, /middle omitted from bounded source evidence/);
  });

  test('same-name tool calls in one turn retain distinct evidence refs and snapshots', () => {
    const unit: DistillationUnit = {
      filePath: '/logs/sessions/chat/repeated-tools.jsonl',
      newTurns: [{
        entry_type: 'turn',
        turn: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        session_id: 'repeated-tools-session',
        session_type: 'cli',
        user: { text: 'Send both reports.' },
        assistant: {
          text: 'Both reports were sent.',
          tool_calls: [
            { id: 'send-1', name: 'send_file', arguments: { path: 'first.md' }, result: 'sent first' },
            { id: 'send-2', name: 'send_file', arguments: { path: 'second.md' }, result: 'sent second' },
          ],
        },
        tokens: { prompt: 20, completion: 12 },
      }],
      continuityTurns: [],
      byteRange: { start: 0, end: 500 },
      generatedAt: '2026-01-01T00:00:01.000Z',
    };
    const [episode] = extractLearningEpisodes(unit, 0).episodes;
    assert.ok(episode);
    assert.equal(episode.completionEvidence.filter(item => item.kind === 'artifact-delivery').length, 2);
    const refs = episode.completionEvidence
      .filter(item => item.kind === 'artifact-delivery')
      .map(item => item.ref);
    assert.equal(new Set(refs).size, 2);
    assert.equal(episode.sourceEvidence?.filter(item => refs.includes(item.ref)).length, 2);
    assert.match(JSON.stringify(episode.sourceEvidence), /first\.md/);
    assert.match(JSON.stringify(episode.sourceEvidence), /second\.md/);
  });

  test('an ambiguous folded verification does not erase an earlier frozen snapshot', () => {
    const unit: DistillationUnit = {
      filePath: '/logs/sessions/chat/folded-ambiguous.jsonl',
      newTurns: [
        {
          entry_type: 'turn',
          turn: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          session_id: 'folded-session',
          session_type: 'cli',
          user: { text: 'Send the report.' },
          assistant: {
            text: 'The report was sent.',
            tool_calls: [{ name: 'send_file', arguments: { path: 'report.md' }, result: 'sent' }],
          },
          tokens: { prompt: 20, completion: 12 },
        },
        {
          entry_type: 'turn',
          turn: 2,
          timestamp: '2026-01-01T00:00:01.000Z',
          session_id: 'folded-session',
          session_type: 'cli',
          user: { text: '' },
          assistant: {
            text: 'Validated the report.',
            tool_calls: [{ name: 'validate_artifact', arguments: { path: 'report.md' }, result: 'passed' }],
          },
          tokens: { prompt: 20, completion: 12 },
        },
        {
          entry_type: 'turn',
          turn: 2,
          timestamp: '2026-01-01T00:00:02.000Z',
          session_id: 'folded-session',
          session_type: 'cli',
          user: { text: '' },
          assistant: {
            text: 'Validated the alternate report.',
            tool_calls: [{ name: 'validate_artifact', arguments: { path: 'alternate.md' }, result: 'passed' }],
          },
          tokens: { prompt: 20, completion: 12 },
        },
      ],
      continuityTurns: [],
      byteRange: { start: 0, end: 1_500 },
      generatedAt: '2026-01-01T00:00:03.000Z',
    };

    const [episode] = extractLearningEpisodes(unit, 0).episodes;

    assert.ok(episode);
    const deliveryRef = episode.completionEvidence.find(item => item.kind === 'artifact-delivery')?.ref;
    assert.ok(deliveryRef);
    assert.ok(episode.sourceEvidence?.some(item => item.ref === deliveryRef));
  });

  test('source snapshots follow the AgentTurn identity when file and turn collide', () => {
    const unit: DistillationUnit = {
      filePath: '/logs/sessions/chat/colliding-turns.jsonl',
      newTurns: [
        {
          entry_type: 'turn',
          turn: 7,
          timestamp: '2026-01-01T00:00:00.000Z',
          session_id: 'same-runtime-session',
          episode_id: 'agent-turn-a',
          session_type: 'cli',
          user: { text: 'Always use npm for this task.' },
          assistant: { text: 'I will use npm for this task.', tool_calls: [] },
          tokens: { prompt: 20, completion: 12 },
        },
        {
          entry_type: 'turn',
          turn: 7,
          timestamp: '2026-01-01T00:00:01.000Z',
          session_id: 'same-runtime-session',
          episode_id: 'agent-turn-b',
          session_type: 'cli',
          user: { text: 'Always use pnpm for this task.' },
          assistant: { text: 'I will use pnpm for this task.', tool_calls: [] },
          tokens: { prompt: 20, completion: 12 },
        },
      ],
      continuityTurns: [],
      byteRange: { start: 0, end: 1_000 },
      generatedAt: '2026-01-01T00:00:02.000Z',
    };

    const episodes = extractLearningEpisodes(unit, 0).episodes;
    const npmEpisode = episodes.find(item => item.episodeId === 'agent-turn-a');
    const pnpmEpisode = episodes.find(item => item.episodeId === 'agent-turn-b');
    assert.ok(npmEpisode?.sourceEvidence?.length);
    assert.ok(pnpmEpisode?.sourceEvidence?.length);
    assert.equal(
      npmEpisode.completionEvidence[0]?.sourceAgentTurnEpisodeId,
      'agent-turn-a',
    );
    assert.equal(
      pnpmEpisode.completionEvidence[0]?.sourceAgentTurnEpisodeId,
      'agent-turn-b',
    );
    assert.match(JSON.stringify(npmEpisode.sourceEvidence), /\bnpm\b/);
    assert.doesNotMatch(JSON.stringify(npmEpisode.sourceEvidence), /\bpnpm\b/);
    assert.match(JSON.stringify(pnpmEpisode.sourceEvidence), /\bpnpm\b/);
    assert.doesNotMatch(JSON.stringify(pnpmEpisode.sourceEvidence), /\bnpm\b/);
  });

  test('ambiguous legacy same-turn records fail closed instead of crossing evidence', () => {
    const unit: DistillationUnit = {
      filePath: '/logs/sessions/chat/ambiguous-turns.jsonl',
      newTurns: [
        {
          entry_type: 'turn',
          turn: 8,
          timestamp: '2026-01-01T00:00:00.000Z',
          session_id: 'legacy-runtime-session',
          session_type: 'cli',
          user: { text: 'Use npm for this task.' },
          assistant: { text: 'I used npm for this task.', tool_calls: [] },
          tokens: { prompt: 20, completion: 12 },
        },
        {
          entry_type: 'turn',
          turn: 8,
          timestamp: '2026-01-01T00:00:01.000Z',
          session_id: 'legacy-runtime-session',
          session_type: 'cli',
          user: { text: 'Use pnpm for this task.' },
          assistant: { text: 'I used pnpm for this task.', tool_calls: [] },
          tokens: { prompt: 20, completion: 12 },
        },
      ],
      continuityTurns: [],
      byteRange: { start: 0, end: 1_000 },
      generatedAt: '2026-01-01T00:00:02.000Z',
    };

    const episodes = extractLearningEpisodes(unit, 0).episodes;
    assert.equal(episodes.length, 2);
    assert.ok(episodes.every(item => item.sourceEvidence === undefined));
  });

  test('local source transcript payloads fail closed when many refs exceed the total bound', () => {
    const oversizedResult = 'result '.repeat(1_000);
    const unit: DistillationUnit = {
      filePath: '/logs/sessions/chat/oversized.jsonl',
      newTurns: [{
        entry_type: 'turn',
        turn: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        session_id: 'oversized-session',
        session_type: 'cli',
        user: { text: 'Send these files.' },
        assistant: {
          text: 'I sent the files.',
          tool_calls: Array.from({ length: 40 }, (_, index) => ({
            id: `call-${index}`,
            name: `send_file_${index}`,
            arguments: { index },
            result: oversizedResult,
          })),
        },
        tokens: { prompt: 20, completion: 12 },
      }],
      continuityTurns: [],
      byteRange: { start: 0, end: 500_000 },
      generatedAt: '2026-01-01T00:00:01.000Z',
    };

    const [episode] = extractLearningEpisodes(unit, 0).episodes;
    assert.ok(episode, 'the Episode itself remains durable');
    // Every completion ref must have source content or review must fail
    // closed; silently dropping only the tail refs would be misleading.
    assert.equal(episode.sourceEvidence, undefined);
  });

  test('external capsule reconstruction excludes unrelated catalog Skills when no referenced-skill evidence is present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-episode-bundle-capsule-'));
    try {
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'capsules.json'));
      const episode = makeEpisode({ episodeId: 'episode-ext-002' });
      const bundleId = `v3:learning-episode:episode-ext-002`;
      const capsule = buildEvidenceCapsule({
        sourceIdentity: {
          sourceId: 'xurl-source-1',
          label: 'External Source (openai)',
          category: 'external',
          provider: 'openai',
          reader: 'xurl',
        },
        eventIdentity: {
          eventId: 'agents://openai/thread-1#3-6',
          position: 6,
          contentHash: 'hash-ext-002',
          conversationId: 'thread-1',
          branchId: 'branch-1',
          revision: 1,
        },
        episodeId: 'episode-ext-002',
        bundleId,
        completionEvidence: [
          {
            ref: 'xurl://openai/thread-1#5:problem-action',
            content: 'User asked to deploy to staging.',
            role: 'problem-action',
            sourceFilePath: 'xurl://openai/thread-1',
            turn: 5,
            byteRange: { start: 3, end: 5 },
          },
        ],
        settlementEvidence: [
          {
            ref: 'xurl://openai/thread-1#6:verification',
            content: 'User confirmed it worked.',
            role: 'verification',
            sourceFilePath: 'xurl://openai/thread-1',
            turn: 6,
            byteRange: { start: 3, end: 6 },
          },
        ],
        semanticObservations: [
          { kind: 'user-intent', value: 'deploy to staging', sourceRefs: ['xurl://openai/thread-1#5:problem-action'] },
        ],
        now: new Date('2026-07-15T12:00:00.000Z'),
      });
      capsuleStore.upsert(capsule);
      // The runtime catalog contains an unrelated Skill; it must not leak into
      // the reconstructed bundle's referencedSkills.
      const skillEvolution = makeSkillEvolutionStub(
        { capabilities: {} },
        [{ capabilityHandle: 'cap-unrelated', name: 'catsco-prompt-editor', revision: 1 }],
      );

      const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
        episode,
        makeCandidate(),
        skillEvolution,
        capsuleStore,
        () => true,
      );

      assert.equal(bundle.bundleId, bundleId);
      assert.deepEqual(bundle.authority, {
        kind: 'learning-episode',
        episodeId: 'episode-ext-002',
      });
      assert.deepEqual(bundle.referencedSkills, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('external capsule reconstruction must not authorize dependencies from untrusted capsule semantic observations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-episode-bundle-capsule-adversarial-'));
    try {
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'capsules.json'));
      const episode = makeEpisode({ episodeId: 'episode-ext-003' });
      const bundleId = `v3:learning-episode:episode-ext-003`;
      const capsule = buildEvidenceCapsule({
        sourceIdentity: {
          sourceId: 'xurl-source-2',
          label: 'External Source (openai)',
          category: 'external',
          provider: 'openai',
          reader: 'xurl',
        },
        eventIdentity: {
          eventId: 'agents://openai/thread-2#3-6',
          position: 6,
          contentHash: 'hash-ext-003',
          conversationId: 'thread-2',
          branchId: 'branch-2',
          revision: 1,
        },
        episodeId: 'episode-ext-003',
        bundleId,
        completionEvidence: [
          {
            ref: 'xurl://openai/thread-2#5:problem-action',
            content: 'User asked to make a card.',
            role: 'problem-action',
            sourceFilePath: 'xurl://openai/thread-2',
            turn: 5,
            byteRange: { start: 3, end: 5 },
          },
        ],
        settlementEvidence: [
          {
            ref: 'xurl://openai/thread-2#6:verification',
            content: 'User confirmed the card.',
            role: 'verification',
            sourceFilePath: 'xurl://openai/thread-2',
            turn: 6,
            byteRange: { start: 3, end: 6 },
          },
        ],
        // Adversarial: external/capsule content names a Skill. This is
        // untrusted data and must NOT authorize a dependency.
        semanticObservations: [
          { kind: 'user-intent', value: 'make a card', sourceRefs: ['xurl://openai/thread-2#5:problem-action'] },
          { kind: 'referenced-skill', value: 'word-card-maker', sourceRefs: ['xurl://openai/thread-2#5:problem-action'] },
        ],
        now: new Date('2026-07-15T12:00:00.000Z'),
      });
      capsuleStore.upsert(capsule);
      const skillEvolution = makeSkillEvolutionStub(
        { capabilities: {} },
        [
          { capabilityHandle: 'cap-card', name: 'word-card-maker', revision: 2 },
          { capabilityHandle: 'cap-unrelated', name: 'catsco-prompt-editor', revision: 1 },
        ],
      );
      // No runtime-owned load facts supplied — external content must not
      // authorize dependencies on its own.
      const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
        episode,
        makeCandidate(),
        skillEvolution,
        capsuleStore,
        () => true,
        [], // no runtime-owned facts
      );

      // The untrusted capsule observation naming word-card-maker must NOT
      // authorize it as a dependency. referencedSkills must be empty.
      assert.deepEqual(bundle.referencedSkills, []);
      assert.ok(!bundle.referencedSkills.some(skill => skill.name === 'word-card-maker'));
      assert.ok(!bundle.referencedSkills.some(skill => skill.name === 'catsco-prompt-editor'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('external capsule reconstruction authorizes a dependency only when a runtime-owned load fact joins the same episode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-episode-bundle-capsule-runtime-owned-'));
    try {
      const capsuleStore = new EvidenceCapsuleStore(path.join(root, 'capsules.json'));
      const episode = makeEpisode({
        episodeId: 'episode-ext-004',
        agentTurnEpisodeId: 'turn-episode-ext-004',
        runtimeSessionId: 'sess-ext',
      });
      const bundleId = `v3:learning-episode:episode-ext-004`;
      const capsule = buildEvidenceCapsule({
        sourceIdentity: {
          sourceId: 'xurl-source-3',
          label: 'External Source (openai)',
          category: 'external',
          provider: 'openai',
          reader: 'xurl',
        },
        eventIdentity: {
          eventId: 'agents://openai/thread-3#3-6',
          position: 6,
          contentHash: 'hash-ext-004',
          conversationId: 'thread-3',
          branchId: 'branch-3',
          revision: 1,
        },
        episodeId: 'episode-ext-004',
        bundleId,
        completionEvidence: [
          {
            ref: 'xurl://openai/thread-3#5:problem-action',
            content: 'User asked to make a card.',
            role: 'problem-action',
            sourceFilePath: 'xurl://openai/thread-3',
            turn: 5,
            byteRange: { start: 3, end: 5 },
          },
        ],
        settlementEvidence: [
          {
            ref: 'xurl://openai/thread-3#6:verification',
            content: 'User confirmed the card.',
            role: 'verification',
            sourceFilePath: 'xurl://openai/thread-3',
            turn: 6,
            byteRange: { start: 3, end: 6 },
          },
        ],
        semanticObservations: [
          { kind: 'user-intent', value: 'make a card', sourceRefs: ['xurl://openai/thread-3#5:problem-action'] },
        ],
        now: new Date('2026-07-15T12:00:00.000Z'),
      });
      capsuleStore.upsert(capsule);
      const skillEvolution = makeSkillEvolutionStub(
        { capabilities: {} },
        [
          { capabilityHandle: 'cap-card', name: 'word-card-maker', revision: 2, guidanceHash: 'hash-card' },
          { capabilityHandle: 'cap-unrelated', name: 'catsco-prompt-editor', revision: 1 },
        ],
      );
      // A runtime-owned load fact tied to the same episode authorizes the
      // dependency — the external capsule content did not name it.
      const skillLoadFacts: GeneratedSkillLoadFact[] = [
        {
          schemaVersion: 1,
          kind: 'generated-skill-load',
          factId: 'skill-load_ext',
          recordedAt: '2026-07-15T12:00:00.000Z',
          runtimeSessionId: 'sess-ext',
          episodeId: 'turn-episode-ext-004',
          skill: {
            capabilityHandle: 'cap-card',
            routingName: 'word-card-maker',
            skillFilePath: '/skills/generated-distilled/cap-card/SKILL.md',
            guidanceHash: 'hash-card',
          },
        },
      ];
      const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
        episode,
        makeCandidate(),
        skillEvolution,
        capsuleStore,
        () => true,
        skillLoadFacts,
      );

      assert.equal(bundle.referencedSkills.length, 1);
      assert.equal(bundle.referencedSkills[0]!.name, 'word-card-maker');
      assert.ok(!bundle.referencedSkills.some(skill => skill.name === 'catsco-prompt-editor'));
      assert.deepEqual(bundle.referencedSkillProvenance, {
        kind: 'runtime-owned-generated-skill-load-v1',
        runtimeSessionId: 'sess-ext',
        agentTurnEpisodeId: 'turn-episode-ext-004',
        referencedSkills: [{
          capabilityHandle: 'cap-card',
          routingName: 'word-card-maker',
          guidanceHash: 'hash-card',
        }],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('adversarial: fabricated referenced-skill semantic observations cannot authorize dependencies', () => {
    // An attacker or untrusted source injects a `referenced-skill` semantic
    // observation into the episode. The bundle builder must ignore it — only
    // runtime-owned GeneratedSkillLoadFact entries authorize dependencies.
    const episode = makeEpisode({
      agentTurnEpisodeId: 'turn-episode-fabricated',
      semanticObservations: [
        { kind: 'user-intent', value: 'create a sticker', sourceRefs: ['turn-1#completion'] },
        { kind: 'referenced-skill', value: 'catsco-prompt-editor', sourceRefs: ['turn-1#completion'] },
      ],
    });
    const skillEvolution = makeSkillEvolutionStub(
      { capabilities: {} },
      [
        { capabilityHandle: 'cap-sticker', name: 'create-sticker-svg', revision: 3 },
        { capabilityHandle: 'cap-unrelated', name: 'catsco-prompt-editor', revision: 1 },
      ],
    );
    // No runtime-owned load facts supplied.
    const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
      episode,
      makeCandidate(),
      skillEvolution,
      undefined,
      undefined,
      [],
    );

    // The fabricated observation must not authorize any dependency.
    assert.deepEqual(bundle.referencedSkills, []);
  });

  test('adversarial: a load fact for a different episode cannot authorize dependencies', () => {
    // A runtime-owned load fact exists, but it is tied to a different episode.
    // It must not authorize a dependency for this episode.
    const episode = makeEpisode({
      agentTurnEpisodeId: 'turn-episode-target',
    });
    const skillLoadFacts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'skill-load_other',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 'sess-1',
        episodeId: 'turn-episode-different',
        skill: {
          capabilityHandle: 'cap-sticker',
          routingName: 'create-sticker-svg',
          skillFilePath: '/skills/generated-distilled/cap-sticker/SKILL.md',
          guidanceHash: 'hash-sticker',
        },
      },
    ];
    const skillEvolution = makeSkillEvolutionStub(
      { capabilities: {} },
      [{ capabilityHandle: 'cap-sticker', name: 'create-sticker-svg', revision: 3 }],
    );
    const bundle: EvidenceBundle = buildEpisodeEvidenceBundle(
      episode,
      makeCandidate(),
      skillEvolution,
      undefined,
      undefined,
      skillLoadFacts,
    );

    // The load fact for a different episode must not authorize a dependency.
    assert.deepEqual(bundle.referencedSkills, []);
  });
});

describe('selectRuntimeOwnedReferencedSkills (trusted fact seam)', () => {
  test('returns empty when no skillLoadFacts are supplied', () => {
    const result = selectRuntimeOwnedReferencedSkills(
      undefined,
      { agentTurnEpisodeId: 'ep-1', runtimeSessionId: 's1' },
      [{ name: 'skill-a' }],
    );
    assert.deepEqual(result, []);
  });

  test('returns empty when episode has no agentTurnEpisodeId', () => {
    const facts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'f1',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 's1',
        episodeId: 'ep-1',
        skill: {
          capabilityHandle: 'cap-a',
          routingName: 'skill-a',
          skillFilePath: '/skills/generated-distilled/cap-a/SKILL.md',
          guidanceHash: 'h1',
        },
      },
    ];
    const result = selectRuntimeOwnedReferencedSkills(
      facts,
      { agentTurnEpisodeId: undefined, runtimeSessionId: 's1' },
      [{ name: 'skill-a' }],
    );
    assert.deepEqual(result, []);
  });

  test('returns empty when episode has no runtimeSessionId', () => {
    const facts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'f1',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 's1',
        episodeId: 'ep-1',
        skill: {
          capabilityHandle: 'cap-a',
          routingName: 'skill-a',
          skillFilePath: '/skills/generated-distilled/cap-a/SKILL.md',
          guidanceHash: 'h1',
        },
      },
    ];
    // Both correlation fields are required — a missing runtimeSessionId fails closed.
    const result = selectRuntimeOwnedReferencedSkills(
      facts,
      { agentTurnEpisodeId: 'ep-1', runtimeSessionId: undefined },
      [{ name: 'skill-a', capabilityHandle: 'cap-a', guidanceHash: 'h1' }],
    );
    assert.deepEqual(result, []);
  });

  test('authorizes a snapshot only on exact capabilityHandle + routingName + guidanceHash agreement', () => {
    const facts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'f1',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 's1',
        episodeId: 'ep-1',
        skill: {
          capabilityHandle: 'cap-a',
          routingName: 'skill-a',
          skillFilePath: '/skills/generated-distilled/cap-a/SKILL.md',
          guidanceHash: 'h1',
        },
      },
    ];
    const snapshots: ReferencedSkillSnapshot[] = [
      { name: 'skill-a', capabilityHandle: 'cap-a', guidanceHash: 'h1' },
      { name: 'skill-b', capabilityHandle: 'cap-b', guidanceHash: 'h2' },
    ];
    const result = selectRuntimeOwnedReferencedSkills(
      facts,
      { agentTurnEpisodeId: 'ep-1', runtimeSessionId: 's1' },
      snapshots,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'skill-a');
    assert.equal(result[0]!.guidanceHash, 'h1');
  });

  test('rejects a snapshot that omits any identity field', () => {
    const facts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'f1',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 's1',
        episodeId: 'ep-1',
        skill: {
          capabilityHandle: 'cap-a',
          routingName: 'skill-a',
          skillFilePath: '/skills/generated-distilled/cap-a/SKILL.md',
          guidanceHash: 'h1',
        },
      },
    ];
    // None of these carry the full identity triple, so none can be authorized.
    const snapshots: ReferencedSkillSnapshot[] = [
      { name: 'skill-a', capabilityHandle: 'cap-a' }, // missing guidanceHash
      { name: 'skill-a', guidanceHash: 'h1' }, // missing capabilityHandle
      { capabilityHandle: 'cap-a', guidanceHash: 'h1' }, // missing name
    ];
    const result = selectRuntimeOwnedReferencedSkills(
      facts,
      { agentTurnEpisodeId: 'ep-1', runtimeSessionId: 's1' },
      snapshots,
    );
    assert.deepEqual(result, []);
  });

  test('adversarial: route-reuse fails closed — same capabilityHandle + guidanceHash but a different routingName is not authorized', () => {
    // A stale load fact recorded under an old route must not authorize the
    // current successor snapshot that reuses the handle+hash under a new route.
    const facts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'f1',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 's1',
        episodeId: 'ep-1',
        skill: {
          capabilityHandle: 'cap-a',
          routingName: 'skill-a-old',
          skillFilePath: '/skills/generated-distilled/cap-a/SKILL.md',
          guidanceHash: 'h1',
        },
      },
    ];
    const snapshots: ReferencedSkillSnapshot[] = [
      { name: 'skill-a-new', capabilityHandle: 'cap-a', guidanceHash: 'h1' },
    ];
    const result = selectRuntimeOwnedReferencedSkills(
      facts,
      { agentTurnEpisodeId: 'ep-1', runtimeSessionId: 's1' },
      snapshots,
    );
    assert.deepEqual(result, []);
  });

  test('adversarial: handle-reuse fails closed — same routingName + guidanceHash but a different capabilityHandle is not authorized', () => {
    const facts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'f1',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 's1',
        episodeId: 'ep-1',
        skill: {
          capabilityHandle: 'cap-a',
          routingName: 'skill-a',
          skillFilePath: '/skills/generated-distilled/cap-a/SKILL.md',
          guidanceHash: 'h1',
        },
      },
    ];
    // A different capability reuses the route+hash; it must not be authorized.
    const snapshots: ReferencedSkillSnapshot[] = [
      { name: 'skill-a', capabilityHandle: 'cap-impostor', guidanceHash: 'h1' },
    ];
    const result = selectRuntimeOwnedReferencedSkills(
      facts,
      { agentTurnEpisodeId: 'ep-1', runtimeSessionId: 's1' },
      snapshots,
    );
    assert.deepEqual(result, []);
  });

  test('adversarial: stale-hash fails closed — a successor snapshot whose guidanceHash differs from the loaded fact is not authorized', () => {
    const facts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'f1',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 's1',
        episodeId: 'ep-1',
        skill: {
          capabilityHandle: 'cap-a',
          routingName: 'skill-a',
          skillFilePath: '/skills/generated-distilled/cap-a/SKILL.md',
          guidanceHash: 'h1-old',
        },
      },
    ];
    // The current successor snapshot carries a newer guidanceHash. The stale
    // load fact must not authorize current successor guidance.
    const snapshots: ReferencedSkillSnapshot[] = [
      { name: 'skill-a', capabilityHandle: 'cap-a', guidanceHash: 'h1-new' },
    ];
    const result = selectRuntimeOwnedReferencedSkills(
      facts,
      { agentTurnEpisodeId: 'ep-1', runtimeSessionId: 's1' },
      snapshots,
    );
    assert.deepEqual(result, []);
  });

  test('adversarial: wrong-session fails closed — a load fact recorded under a different runtimeSessionId is not authorized', () => {
    const facts: GeneratedSkillLoadFact[] = [
      {
        schemaVersion: 1,
        kind: 'generated-skill-load',
        factId: 'f1',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runtimeSessionId: 's-other',
        episodeId: 'ep-1',
        skill: {
          capabilityHandle: 'cap-a',
          routingName: 'skill-a',
          skillFilePath: '/skills/generated-distilled/cap-a/SKILL.md',
          guidanceHash: 'h1',
        },
      },
    ];
    const snapshots: ReferencedSkillSnapshot[] = [
      { name: 'skill-a', capabilityHandle: 'cap-a', guidanceHash: 'h1' },
    ];
    // Same episodeId but a different runtimeSessionId must fail closed.
    const result = selectRuntimeOwnedReferencedSkills(
      facts,
      { agentTurnEpisodeId: 'ep-1', runtimeSessionId: 's1' },
      snapshots,
    );
    assert.deepEqual(result, []);
  });
});
