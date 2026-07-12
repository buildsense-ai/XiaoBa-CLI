import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LearningEpisode,
  LearningEpisodeStore,
  buildFlashcardEvidenceBundle,
  extractLearningEpisodes,
  listDiscoverableGeneratedSkills,
  promoteFlashcardComposition,
  readImmediatePredecessorContinuity,
  settleLearningEpisodes,
} from '../src/utils/learning-episode';
import { DistillationUnit, extractDistillationUnit } from '../src/utils/distillation-unit';
import { distillCapabilityCandidates } from '../src/utils/capability-distiller';
import { SessionToolCallLog, SessionTurnLogEntry } from '../src/utils/session-log-schema';
import { DistillationPipeline } from '../src/utils/distillation-pipeline';
import { SkillEvolutionRuntime } from '../src/utils/skill-evolution';

function tool(id: string, name: string, result: string): SessionToolCallLog {
  return { id, name, arguments: {}, result };
}

function turn(
  number: number,
  user: string,
  tools: SessionToolCallLog[],
  runtimeSessionId = 'runtime-session-1',
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn: number,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString(),
    session_id: runtimeSessionId,
    session_type: 'chat',
    user: { text: user },
    assistant: { text: 'completed', tool_calls: tools },
    tokens: { prompt: 1, completion: 1 },
  };
}

function unit(turns: SessionTurnLogEntry[], filePath = '/logs/flashcards.jsonl'): DistillationUnit {
  return {
    filePath,
    newTurns: turns,
    continuityTurns: [],
    byteRange: { start: 0, end: 100 },
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('V3 independent Learning Episodes', () => {
  test('turns a direct correction into a Contradiction Signal and keeps a verified retry independent', () => {
    const result = extractLearningEpisodes(unit([
      turn(1, 'Make a flashcard for ephemeral.', [tool('1', 'send_file', 'delivered unsuitable card')]),
      turn(2, 'Redo it; the result is unsuitable.', []),
      turn(3, 'Continue with the corrected card.', [
        tool('3a', 'opencli_select_image', 'selected image'),
        tool('3b', 'validate_artifact', 'valid dimensions and content'),
        tool('3c', 'send_file', 'delivered corrected card'),
      ]),
      turn(4, 'Verified, this one works.', []),
    ], '/logs/flashcards/session.jsonl'));

    assert.equal(result.episodes.length, 2);
    const [first, retry] = result.episodes;
    assert.equal(first.status, 'contradicted');
    assert.equal(first.contradictionSignals.length, 1);
    assert.equal(first.contradictionSignals[0].kind, 'direct-correction');
    assert.equal(first.contradictionSignals[0].preventsPromotion, true);
    assert.equal(retry.status, 'settling');
    assert.equal(retry.retryOfEpisodeId, first.episodeId);
    assert.notEqual(retry.episodeId, first.episodeId);
    assert.ok(retry.completionEvidence.some(evidence => evidence.kind === 'artifact-validation'));

    const settled = settleLearningEpisodes(result.episodes, { now: new Date('2026-01-01T04:00:00.000Z') });
    assert.equal(settled[0].status, 'contradicted');
    assert.equal(settled[1].status, 'eligible');
  });

  test('captures ordinary failure feedback as a durable failure Contradiction Signal', () => {
    const result = extractLearningEpisodes(unit([
      turn(1, 'Deliver the artifact.', [tool('1', 'send_file', 'sent')]),
      turn(2, 'The delivery failed with an error.', []),
    ], '/logs/failure.jsonl'));

    assert.equal(result.episodes.length, 1);
    assert.equal(result.episodes[0].status, 'contradicted');
    assert.equal(result.episodes[0].contradictionSignals[0].kind, 'failure-report');
    assert.equal(result.episodes[0].contradictionSignals[0].preventsPromotion, true);
  });

  test('persists and settles episodes independently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-learning-episodes-'));
    try {
      const store = new LearningEpisodeStore(path.join(root, 'episodes.json'));
      const episodes = extractLearningEpisodes(unit([
        turn(1, 'Deliver the first artifact.', [tool('1', 'send_file', 'sent')]),
        turn(2, 'No, redo it.', []),
        turn(3, 'Deliver the retry.', [tool('3', 'send_file', 'sent')]),
      ], path.join(root, 'session.jsonl'))).episodes;
      store.upsert(episodes);
      const state = store.settle({ now: new Date('2026-01-01T04:00:00.000Z') });
      assert.equal(Object.keys(state.episodes).length, 2);
      assert.deepEqual(
        Object.values(state.episodes).map(episode => episode.status),
        ['contradicted', 'eligible'],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('applies a correction discovered at the next cursor to an already persisted predecessor', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-learning-cursor-'));
    try {
      const source = path.join(root, 'session.jsonl');
      const store = new LearningEpisodeStore(path.join(root, 'episodes.json'));
      const first = extractLearningEpisodes(unit([
        turn(1, 'Deliver a card.', [tool('1', 'send_file', 'sent')]),
      ], source));
      store.upsert(first.episodes);
      const correction = extractLearningEpisodes({
        ...unit([turn(2, 'Redo it, this is unsuitable.', [])], source),
        continuityTurns: [turn(1, 'Deliver a card.', [tool('1', 'send_file', 'sent')])],
      });
      const state = store.applyExtraction(correction);
      const persisted = Object.values(state.episodes)[0];
      assert.equal(persisted.status, 'contradicted');
      assert.equal(persisted.contradictionSignals[0].precedingDeliveryTurn, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a late contradiction revokes a previously eligible episode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-learning-late-contradiction-'));
    try {
      const source = path.join(root, 'session.jsonl');
      const store = new LearningEpisodeStore(path.join(root, 'episodes.json'));
      const first = extractLearningEpisodes(unit([
        turn(1, 'Deliver a card.', [tool('1', 'send_file', 'sent')]),
        turn(2, 'Verified, works.', []),
      ], source));
      const eligible = settleLearningEpisodes(first.episodes, {
        now: new Date('2026-01-01T04:00:00.000Z'),
      });
      store.upsert(eligible);

      const lateCorrection = extractLearningEpisodes({
        ...unit([turn(3, 'The previous delivery failed.', [])], source),
        continuityTurns: [turn(2, 'Verified, works.', []), turn(1, 'Deliver a card.', [tool('1', 'send_file', 'sent')])],
      });
      const state = store.applyExtraction(lateCorrection);
      assert.equal(Object.values(state.episodes)[0].status, 'contradicted');
      assert.equal(Object.values(state.episodes)[0].contradictionSignals.length, 1);
      assert.equal(store.settle().episodes[Object.values(state.episodes)[0].episodeId].status, 'contradicted');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not create an episode from validation-only activity but keeps validation with delivery evidence', () => {
    const validationOnly = extractLearningEpisodes(unit([
      turn(1, 'Validate the card.', [tool('1', 'validate_artifact', 'valid')]),
      turn(2, 'The validation failed.', []),
    ], '/logs/validation-only.jsonl'));
    assert.deepEqual(validationOnly.episodes, []);
    assert.deepEqual(validationOnly.contradictions, []);

    const deliveredAndValidated = extractLearningEpisodes(unit([
      turn(1, 'Deliver the card.', [
        tool('1a', 'validate_artifact', 'valid'),
        tool('1b', 'send_file', 'sent'),
      ]),
    ], '/logs/validated-delivery.jsonl'));
    assert.equal(deliveredAndValidated.episodes.length, 1);
    assert.equal(deliveredAndValidated.episodes[0].completionEvidence.some(item => item.kind === 'artifact-validation'), true);
    assert.equal(deliveredAndValidated.episodes[0].completionEvidence.some(item => item.kind === 'artifact-delivery'), true);
  });

  test('links a later heartbeat retry to an immediate rejected predecessor and keeps its own settlement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-learning-retry-heartbeat-'));
    try {
      const source = path.join(root, 'session.jsonl');
      const store = new LearningEpisodeStore(path.join(root, 'episodes.json'));
      const first = extractLearningEpisodes(unit([
        turn(1, 'Deliver the first card.', [tool('1', 'send_file', 'sent')]),
        turn(2, 'No, the result failed.', []),
      ], source));
      const rejected = store.upsert(first.episodes);
      store.settle({ now: new Date('2026-01-01T04:00:00.000Z') });
      assert.equal(Object.values(store.load().episodes)[0].status, 'contradicted');

      const retry = extractLearningEpisodes({
        ...unit([turn(3, 'Deliver the corrected card.', [tool('3', 'send_file', 'sent')])], source),
        continuityTurns: [
          turn(1, 'Deliver the first card.', [tool('1', 'send_file', 'sent')]),
          turn(2, 'No, the result failed.', []),
        ],
      });
      const state = store.upsert(retry.episodes);
      const storedRetry = Object.values(state.episodes).find(item => item.deliveryTurn === 3)!;
      assert.equal(storedRetry.retryOfEpisodeId, Object.values(rejected.episodes)[0]?.episodeId);
      assert.equal(storedRetry.status, 'settling');
      assert.notEqual(storedRetry.settlementDeadline, Object.values(state.episodes)[0].settlementDeadline);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('creates the predecessor episode when newly appended acceptance closes continuity context', () => {
    const source = '/logs/session.jsonl';
    const result = extractLearningEpisodes({
      ...unit([turn(2, 'Verified, works.', [])], source),
      continuityTurns: [turn(1, 'Deliver a card.', [tool('1', 'send_file', 'sent')])],
    });
    assert.equal(result.episodes.length, 1);
    assert.equal(result.episodes[0].deliveryTurn, 1);
    assert.equal(result.episodes[0].completionEvidence.some(evidence => evidence.kind === 'user-acceptance'), true);
  });
});

describe('V3 bounded cross-file continuity', () => {
  test('reads only the immediate predecessor with matching identity and a continuation signal', () => {
    const predecessor = Array.from({ length: 12 }, (_, index) => turn(index + 1, `prior ${index + 1}`, []));
    const current = [turn(13, 'Continue the flashcard task.', [], 'runtime-session-1')];
    const files = [
      { filePath: '/logs/older.jsonl', entries: [turn(1, 'older unrelated work', [])] },
      { filePath: '/logs/predecessor.jsonl', entries: predecessor },
      { filePath: '/logs/current.jsonl', entries: current },
    ];

    const continuity = readImmediatePredecessorContinuity({
      files,
      currentFilePath: '/logs/current.jsonl',
      runtimeSessionId: 'runtime-session-1',
    });
    assert.equal(continuity.length, 10);
    assert.deepEqual(continuity.map(entry => entry.turn), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    assert.deepEqual(readImmediatePredecessorContinuity({
      files,
      currentFilePath: '/logs/current.jsonl',
      runtimeSessionId: 'different-runtime',
    }), []);
    assert.deepEqual(readImmediatePredecessorContinuity({
      files: [
        files[0],
        files[1],
        { filePath: '/logs/current.jsonl', entries: [turn(13, 'New task, no continuation.', [])] },
      ],
      currentFilePath: '/logs/current.jsonl',
      runtimeSessionId: 'runtime-session-1',
    }), []);
  });

  test('distillation extraction applies the same ten-turn predecessor boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-continuity-'));
    try {
      const predecessorPath = path.join(root, '01-predecessor.jsonl');
      const currentPath = path.join(root, '02-current.jsonl');
      const predecessor = Array.from({ length: 11 }, (_, index) => turn(index + 1, `prior ${index + 1}`, []));
      const current = [turn(12, 'Continue the previous flashcard task.', [], 'runtime-session-1')];
      fs.writeFileSync(predecessorPath, predecessor.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
      fs.writeFileSync(currentPath, current.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

      const extracted = extractDistillationUnit(currentPath, {
        filePath: currentPath,
        byteOffset: 0,
        processedTurnCount: 0,
        updatedAt: '',
        status: 'pending',
      }, {
        crossFileContinuity: {
          orderedFilePaths: [predecessorPath, currentPath],
          runtimeSessionId: 'runtime-session-1',
        },
      });
      assert.deepEqual(extracted.distillationUnit?.continuityTurns.map(entry => entry.turn), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('normalizes NaN and Infinity continuity limits before the ten-turn cap', () => {
    const predecessor = Array.from({ length: 12 }, (_, index) => turn(index + 1, `prior ${index + 1}`, []));
    const current = [turn(13, 'Continue the flashcard task.', [], 'runtime-session-1')];
    const files = [
      { filePath: '/logs/predecessor.jsonl', entries: predecessor },
      { filePath: '/logs/current.jsonl', entries: current },
    ];
    for (const maxTurns of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(readImmediatePredecessorContinuity({
        files,
        currentFilePath: '/logs/current.jsonl',
        runtimeSessionId: 'runtime-session-1',
        maxTurns,
      }).length, 10);
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-continuity-limits-'));
    try {
      const predecessorPath = path.join(root, '01-predecessor.jsonl');
      const currentPath = path.join(root, '02-current.jsonl');
      fs.writeFileSync(predecessorPath, predecessor.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
      fs.writeFileSync(currentPath, current.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
      for (const maxTurns of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const extracted = extractDistillationUnit(currentPath, {
          filePath: currentPath,
          byteOffset: 0,
          processedTurnCount: 0,
          updatedAt: '',
          status: 'pending',
        }, {
          crossFileContinuity: { orderedFilePaths: [predecessorPath, currentPath], maxTurns },
        });
        assert.equal(extracted.distillationUnit?.continuityTurns.length, 10);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('cross-file correction updates the predecessor episode and preserves origin provenance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cross-file-origin-'));
    try {
      const predecessorPath = path.join(root, '01-predecessor.jsonl');
      const currentPath = path.join(root, '02-current.jsonl');
      const predecessorTurn = turn(1, 'Deliver the flashcard.', [tool('1', 'send_file', 'sent')], 'cross-file-runtime');
      const correctionTurn = turn(2, 'Continue; the previous delivery failed.', [], 'cross-file-runtime');
      fs.writeFileSync(predecessorPath, JSON.stringify(predecessorTurn) + '\n', 'utf8');
      fs.writeFileSync(currentPath, JSON.stringify(correctionTurn) + '\n', 'utf8');
      const store = new LearningEpisodeStore(path.join(root, 'episodes.json'));
      const predecessorEpisode = extractLearningEpisodes(unit([predecessorTurn], predecessorPath));
      store.upsert(predecessorEpisode.episodes);

      const extracted = extractDistillationUnit(currentPath, {
        filePath: currentPath,
        byteOffset: 0,
        processedTurnCount: 0,
        updatedAt: '',
        status: 'pending',
      }, { crossFileContinuity: { orderedFilePaths: [predecessorPath, currentPath] } });
      const correction = extractLearningEpisodes(extracted.distillationUnit!);
      const state = store.applyExtraction(correction);
      const updated = Object.values(state.episodes)[0];
      assert.equal(updated.sourceFilePath, predecessorPath);
      assert.equal(updated.episodeId, predecessorEpisode.episodes[0].episodeId);
      assert.equal(updated.contradictionSignals[0].source.sourceFilePath, currentPath);
      assert.equal(updated.contradictionSignals[0].precedingSourceFilePath, predecessorPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('candidate provenance keeps the predecessor origin file across continuity', () => {
    const predecessorPath = '/logs/01-predecessor.jsonl';
    const currentPath = '/logs/02-current.jsonl';
    const candidate = distillCapabilityCandidates({
      filePath: currentPath,
      continuityTurns: [{
        ...turn(1, 'Create a useful flashcard artifact for the study session.', [tool('1', 'send_file', 'sent')], 'origin-runtime'),
        origin: { filePath: predecessorPath },
      }],
      newTurns: [turn(2, 'Thanks, that works perfectly.', [], 'origin-runtime')],
      byteRange: { start: 100, end: 200 },
      generatedAt: '2026-01-01T00:00:00.000Z',
    })[0];
    assert.ok(candidate);
    assert.equal(candidate.provenance[0].filePath, predecessorPath);
    assert.equal(candidate.provenance[1].filePath, currentPath);
    assert.equal(candidate.sourceUnit.filePath, currentPath);
  });
});

describe('V3 flashcard Composition Capability regression', () => {
  const originalRuntimeRoot = process.env.XIAOBA_RUNTIME_ROOT;
  const originalSkillsDir = process.env.XIAOBA_SKILLS_DIR;

  afterEach(() => {
    if (originalRuntimeRoot === undefined) delete process.env.XIAOBA_RUNTIME_ROOT;
    else process.env.XIAOBA_RUNTIME_ROOT = originalRuntimeRoot;
    if (originalSkillsDir === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsDir;
  });

  test('creates a discoverable semantic composition while leaving word-card-maker untouched', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-flashcard-v3-'));
    process.env.XIAOBA_RUNTIME_ROOT = root;
    process.env.XIAOBA_SKILLS_DIR = path.join(root, 'skills');
    try {
      const sourceLog = path.join(root, 'logs', 'sessions', 'flashcards.jsonl');
      fs.mkdirSync(path.dirname(sourceLog), { recursive: true });
      fs.writeFileSync(sourceLog, 'controlled flashcard source log\n', 'utf8');
      const manualSkill = path.join(root, 'manual-skills', 'word-card-maker', 'SKILL.md');
      fs.mkdirSync(path.dirname(manualSkill), { recursive: true });
      fs.writeFileSync(manualSkill, '---\nname: word-card-maker\ndescription: Make word cards\n---\n\nmanual\n', 'utf8');
      const before = fs.readFileSync(manualSkill, 'utf8');
      const extractedEpisodes = extractLearningEpisodes(unit([
        turn(1, 'Make a flashcard for ephemeral.', [tool('1', 'send_file', 'delivered unsuitable card')], 'flashcard-runtime'),
        turn(2, 'Redo it; the first result failed.', [], 'flashcard-runtime'),
        turn(3, 'Make the corrected flashcard.', [
          tool('3a', 'opencli_select_image', 'selected'),
          tool('3b', 'validate_artifact', 'valid'),
          tool('3c', 'send_file', 'delivered'),
        ], 'flashcard-runtime'),
        turn(4, 'Verified, works.', [], 'flashcard-runtime'),
      ], sourceLog)).episodes;
      assert.equal(extractedEpisodes.length, 2);
      assert.equal(extractedEpisodes[0].status, 'contradicted');
      const episode = settleLearningEpisodes(extractedEpisodes, {
        now: new Date('2026-01-01T04:00:00.000Z'),
      })[1];
      assert.equal(episode.status, 'eligible');
      await assert.rejects(() => promoteFlashcardComposition({
        episode: { ...episode, status: 'settling' },
        sourceFilePath: sourceLog,
        outputDir: path.join(root, 'skills', 'generated-distilled'),
        registryPath: path.join(root, 'data', 'unsettled.json'),
        auditPath: path.join(root, 'logs', 'unsettled-audit.jsonl'),
        journalPath: path.join(root, 'data', 'unsettled-journal.json'),
        workingDirectory: root,
      }), /eligible retry episode/);
      await assert.rejects(() => promoteFlashcardComposition({
        episode: extractedEpisodes[0],
        sourceFilePath: sourceLog,
        outputDir: path.join(root, 'skills', 'generated-distilled'),
        registryPath: path.join(root, 'data', 'rejected.json'),
        auditPath: path.join(root, 'logs', 'rejected-audit.jsonl'),
        journalPath: path.join(root, 'data', 'rejected-journal.json'),
        workingDirectory: root,
      }), /eligible retry episode/);

      const result = await promoteFlashcardComposition({
        episode,
        sourceFilePath: sourceLog,
        outputDir: path.join(root, 'skills', 'generated-distilled'),
        registryPath: path.join(root, 'data', 'current-skills.json'),
        auditPath: path.join(root, 'logs', 'transition-audit.jsonl'),
        journalPath: path.join(root, 'data', 'transition-journal.json'),
        workingDirectory: root,
        wordCardMakerVersion: 'manual-v1',
        wordCardMakerPath: manualSkill,
        logEnabled: true,
      });

      assert.equal(result.evolution.verified, true);
      assert.equal(result.evolution.transition, 'create_current_skill');
      assert.ok(result.evolution.record?.referencedSkills.some(skill => skill.name === 'word-card-maker'));
      assert.equal(fs.readFileSync(manualSkill, 'utf8'), before);
      assert.equal(result.manualSkillHashBefore, result.manualSkillHashAfter);

      const skillPath = result.evolution.record!.skillFilePath;
      const skill = fs.readFileSync(skillPath, 'utf8');
      assert.match(skill, /flashcard-image-delivery/);
      assert.match(skill, /word-card-maker/);
      assert.match(skill, /opencli/);
      assert.ok(listDiscoverableGeneratedSkills(path.join(root, 'skills')).some(item => item.name === 'flashcard-image-delivery'));

      const audit = result.evolution.audit!;
      assert.ok(audit.evidenceRefs.some(ref => ref.includes(sourceLog)));
      assert.ok(audit.branchTranscriptPaths.length >= 2);
      assert.ok(audit.branchTranscriptPaths.every(filePath => fs.existsSync(filePath)));
      assert.ok(fs.existsSync(path.join(root, 'logs', 'branches', 'skill-author')));
      assert.ok(fs.existsSync(path.join(root, 'logs', 'branches', 'skill-verifier')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('runtime pipeline gates V3 promotion on an independently settled episode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-flashcard-pipeline-'));
    process.env.XIAOBA_RUNTIME_ROOT = root;
    try {
      const sourceLog = path.join(root, 'logs', 'sessions', 'flashcards.jsonl');
      const episodeUnit = unit([
        turn(1, 'Make the initial flashcard.', [tool('1', 'send_file', 'delivered')], 'flashcard-runtime'),
        turn(2, 'Redo it; the initial result failed.', [], 'flashcard-runtime'),
        turn(3, 'Make the corrected flashcard.', [tool('3a', 'validate_artifact', 'valid'), tool('3b', 'send_file', 'delivered')], 'flashcard-runtime'),
        turn(4, 'Verified, works.', [], 'flashcard-runtime'),
      ], sourceLog);
      const candidate = {
        schemaVersion: 1 as const,
        kind: 'capability' as const,
        capabilityId: 'flashcard-pipeline-candidate',
        title: 'Flashcard image delivery',
        applicability: 'When a user asks for a flashcard image delivery.',
        actionPattern: 'Use word-card-maker and opencli to select, validate, and deliver the artifact.',
        boundaries: ['Do not deliver an unvalidated artifact.'],
        risks: ['A single controlled episode may not generalize.'],
        solvedLoop: {
          problem: 'Make the corrected flashcard.',
          action: 'Used send_file with word-card-maker and opencli.',
          verification: 'Verified, works.',
          noCorrection: 'Verified retry completed without correction.',
        },
        provenance: [
          { filePath: sourceLog, turn: 3, role: 'problem-action' as const, unitByteRange: episodeUnit.byteRange },
          { filePath: sourceLog, turn: 4, role: 'verification' as const, unitByteRange: episodeUnit.byteRange },
        ],
        generatedAt: '2026-01-01T00:00:00.000Z',
        sourceUnit: { filePath: sourceLog, byteRange: episodeUnit.byteRange, generatedAt: episodeUnit.generatedAt },
      };
      const skillEvolution = new SkillEvolutionRuntime({
        workingDirectory: root,
        outputDir: path.join(root, 'skills', 'generated-distilled'),
        registryPath: path.join(root, 'data', 'current-skills.json'),
        auditPath: path.join(root, 'data', 'transition-audit.jsonl'),
        journalPath: path.join(root, 'data', 'transition-journal.json'),
        authorFixture: ({ bundle }) => ({
          body: 'Compose word-card-maker with opencli image selection, validation, and delivery.',
          envelope: {
            decision: 'create_current_skill',
            routingName: 'flashcard-image-delivery',
            description: 'Validated flashcard image delivery composition.',
            referencedSkills: ['word-card-maker'],
            evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
          },
        }),
        verifierFixture: () => ({
          decision: 'accept',
          transition: 'create_current_skill',
          issues: [],
          rationale: 'Controlled flashcard episode is verified.',
        }),
      });
      const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
      const pipeline = new DistillationPipeline({
        outputDir: path.join(root, 'skills', 'generated-distilled'),
        reviewOutcomesPath: path.join(root, 'data', 'review-outcomes.json'),
        learningEpisodeStorePath: episodeStorePath,
        skillEvolution,
        distiller: () => [
          candidate,
          {
            ...candidate,
            capabilityId: 'wrong-source-candidate',
            provenance: candidate.provenance.map(ref => ({ ...ref, filePath: path.join(root, 'other-session.jsonl') })),
          },
        ],
        v3EvidenceBundleBuilder: (_unit, _candidate) => {
          const episode = Object.values(new LearningEpisodeStore(episodeStorePath).load().episodes)
            .find(item => item.status === 'eligible');
          if (!episode) throw new Error('settled flashcard episode was not persisted');
          return buildFlashcardEvidenceBundle(episode, sourceLog, { name: 'word-card-maker', version: 'manual-v1' });
        },
      });

      const result = await pipeline.processUnitAsync(episodeUnit);
      assert.equal('evolutions' in result, true);
      assert.equal((result as any).evolutions.length, 1, 'candidate matching must include source file and delivery turn');
      assert.equal((result as any).evolutions[0].transition, 'create_current_skill');
      assert.equal(Object.values(new LearningEpisodeStore(episodeStorePath).load().episodes)
        .find(item => item.status === 'eligible')?.deliveryTurn, 3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('admits an artifact-backed flashcard episode without V1 acceptance or a legacy distiller', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-flashcard-v3-no-acceptance-'));
    try {
      const sourceLog = path.join(root, 'logs', 'sessions', 'flashcards.jsonl');
      const episodeStorePath = path.join(root, 'data', 'learning-episodes.json');
      let authorCalls = 0;
      fs.mkdirSync(path.dirname(sourceLog), { recursive: true });

      const episodeUnit = unit([
        turn(1, 'Make a flashcard image for ephemeral.', [
          tool('1a', 'word_card_maker', 'base card created'),
          tool('1b', 'opencli_select_image', 'selected image'),
          tool('1c', 'validate_artifact', 'valid dimensions and content'),
          tool('1d', 'send_file', 'delivered flashcard artifact'),
        ], 'flashcard-no-acceptance'),
      ], sourceLog);
      fs.writeFileSync(sourceLog, JSON.stringify(episodeUnit.newTurns[0]) + '\n', 'utf8');

      const skillEvolution = new SkillEvolutionRuntime({
        workingDirectory: root,
        outputDir: path.join(root, 'skills', 'generated-distilled'),
        registryPath: path.join(root, 'data', 'current-skills.json'),
        auditPath: path.join(root, 'data', 'transition-audit.jsonl'),
        journalPath: path.join(root, 'data', 'transition-journal.json'),
        authorFixture: ({ bundle }) => {
          authorCalls++;
          const candidate = bundle.episode as { actionPattern: string };
          assert.match(candidate.actionPattern, /opencli_select_image/);
          assert.equal(bundle.completionEvidence.length >= 2, true);
          return {
            body: 'Compose word-card-maker with opencli image selection, validation, and delivery.',
            envelope: {
              decision: 'create_current_skill',
              routingName: 'flashcard-image-delivery',
              description: 'Validated flashcard image delivery composition.',
              evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(ref => ref.ref),
            },
          };
        },
        verifierFixture: () => ({
          decision: 'accept',
          transition: 'create_current_skill',
          issues: [],
          rationale: 'Settled artifact evidence supports the bounded composition.',
        }),
      });
      const pipeline = new DistillationPipeline({
        outputDir: path.join(root, 'skills', 'generated-distilled'),
        reviewOutcomesPath: path.join(root, 'data', 'review-outcomes.json'),
        learningEpisodeStorePath: episodeStorePath,
        learningEpisodeSettlementWindowMs: 0,
        skillEvolution,
      });

      const result = await pipeline.processUnitAsync(episodeUnit);
      assert.ok('evolutions' in result);
      assert.equal(result.candidates.length, 1);
      assert.equal(result.evolutions.length, 1);
      assert.equal(result.evolutions[0]!.transition, 'create_current_skill');
      assert.equal(authorCalls, 1);
      assert.equal(Object.values(new LearningEpisodeStore(episodeStorePath).load().episodes)[0]!.status, 'eligible');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  describe('eligible is distinct from a committed Capability Transition', () => {
    test('an eligible episode exists without a Current Skill or Capability Transition', () => {
      const episodes = extractLearningEpisodes(unit([
        turn(1, 'Generate a report.', [tool('1', 'send_file', 'report created')]),
        turn(2, 'Great, works fine.', []),
      ])).episodes;
      const settled = settleLearningEpisodes(episodes, {
        now: new Date('2026-01-01T04:00:00.000Z'),
      });
      assert.equal(settled.length, 1);
      assert.equal(settled[0]!.status, 'eligible');
      // No Capability Transition exists — no Current Skill, no Registry entry,
      // no Transition Audit. The episode is merely available for review.
      assert.equal(settled[0]!.contradictionSignals.length, 0);
      assert.ok(settled[0]!.completionEvidence.length >= 1);
      assert.ok(settled[0]!.settlementDeadline < '2026-01-01T04:00:00.000Z');
    });

    test('legacy promoted status migrates to eligible on load', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-promoted-migration-'));
      try {
        const storePath = path.join(root, 'episodes.json');
        // Persist a legacy schema-v1 episode with 'promoted' status
        const legacyState = {
          schemaVersion: 1,
          episodes: {
            'episode-legacy-001': {
              schemaVersion: 1,
              episodeId: 'episode-legacy-001',
              runtimeSessionId: 'legacy-session',
              sourceFilePath: path.join(root, 'session.jsonl'),
              deliveryTurn: 1,
              completionEvidence: [{ ref: 'legacy#turn-1:delivery', sourceFilePath: root, turn: 1, kind: 'artifact-delivery' as const, detail: 'send_file: legacy report' }],
              contradictionSignals: [],
              settlementDeadline: '2026-01-01T04:00:00.000Z',
              status: 'promoted' as any,
            } as LearningEpisode,
          },
        };
        fs.writeFileSync(storePath, JSON.stringify(legacyState), 'utf8');
        const store = new LearningEpisodeStore(storePath);
        const loaded = store.load();
        const episode = Object.values(loaded.episodes)[0]!;
        assert.equal(episode.status, 'eligible');
        assert.equal(episode.episodeId, 'episode-legacy-001');
        assert.ok(episode.completionEvidence.length >= 1);
        assert.equal(episode.contradictionSignals.length, 0);
        // The migration auto-saved the state — the store now has schemaVersion 2
        const reloaded = new LearningEpisodeStore(storePath).load();
        assert.equal(reloaded.schemaVersion, 2);
        assert.equal(Object.values(reloaded.episodes)[0]!.status, 'eligible');
        assert.equal(Object.values(reloaded.episodes)[0]!.schemaVersion, 2, 'per-episode schemaVersion must migrate to v2 on a raw v1 fixture');
        // Evidence, settlement deadline, and linkage are preserved
        assert.equal(Object.values(reloaded.episodes)[0]!.settlementDeadline, '2026-01-01T04:00:00.000Z');
        assert.equal(Object.values(reloaded.episodes)[0]!.completionEvidence.length, 1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('legacy rejected status migrates to contradicted on load', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-rejected-migration-'));
      try {
        const storePath = path.join(root, 'episodes.json');
        // Persist a legacy schema-v1 episode with 'rejected' status
        const legacyState = {
          schemaVersion: 1,
          episodes: {
            'episode-rejected-001': {
              schemaVersion: 1,
              episodeId: 'episode-rejected-001',
              runtimeSessionId: 'legacy-session',
              sourceFilePath: path.join(root, 'session.jsonl'),
              deliveryTurn: 1,
              completionEvidence: [{ ref: 'legacy#turn-1:delivery', sourceFilePath: root, turn: 1, kind: 'artifact-delivery' as const, detail: 'send_file: legacy delivery' }],
              contradictionSignals: [{ signalId: 'legacy-contradiction-1', kind: 'failure-report' as const, message: 'Failed.', source: { ref: 'legacy#turn-2:contradiction', sourceFilePath: root, turn: 2, kind: 'contradiction' as const, detail: 'Failed.' }, precedingDeliveryTurn: 1, precedingSourceFilePath: root, runtimeSessionId: 'legacy-session', preventsPromotion: true as const }],
              settlementDeadline: '2026-01-01T04:00:00.000Z',
              status: 'rejected' as any,
            } as LearningEpisode,
          },
        };
        fs.writeFileSync(storePath, JSON.stringify(legacyState), 'utf8');
        const store = new LearningEpisodeStore(storePath);
        const loaded = store.load();
        const episode = Object.values(loaded.episodes)[0]!;
        assert.equal(episode.status, 'contradicted');
        assert.equal(episode.episodeId, 'episode-rejected-001');
        // Contradiction signals are preserved
        assert.equal(episode.contradictionSignals.length, 1);
        assert.equal(episode.contradictionSignals[0]!.signalId, 'legacy-contradiction-1');
        // Evidence is preserved
        assert.ok(episode.completionEvidence.length >= 1);
        // Auto-save persisted the migration
        const reloaded = new LearningEpisodeStore(storePath).load();
        assert.equal(reloaded.schemaVersion, 2);
        assert.equal(Object.values(reloaded.episodes)[0]!.status, 'contradicted');
        assert.equal(Object.values(reloaded.episodes)[0]!.schemaVersion, 2, 'per-episode schemaVersion must migrate to v2 on a raw v1 fixture');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('legacy rejected predecessor correctly links retry after migration', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-rejected-retry-link-'));
      try {
        const sourcePath = path.join(root, 'session.jsonl');
        const storePath = path.join(root, 'episodes.json');
        const runtimeSessionId = 'retry-link-session';
        // Persist a legacy schema-v1 episode with 'rejected' status as predecessor
        const predecessorId = 'episode-rejected-predecessor';
        const legacyState = {
          schemaVersion: 1,
          episodes: {
            [predecessorId]: {
              schemaVersion: 1,
              episodeId: predecessorId,
              runtimeSessionId,
              sourceFilePath: sourcePath,
              deliveryTurn: 1,
              completionEvidence: [{ ref: 'legacy#turn-1:delivery', sourceFilePath: sourcePath, turn: 1, kind: 'artifact-delivery' as const, detail: 'send_file: legacy delivery' }],
              contradictionSignals: [{ signalId: 'legacy-sig-1', kind: 'failure-report' as const, message: 'Failed.', source: { ref: 'legacy#turn-2:contradiction', sourceFilePath: sourcePath, turn: 2, kind: 'contradiction' as const, detail: 'Failed.' }, precedingDeliveryTurn: 1, precedingSourceFilePath: sourcePath, runtimeSessionId, preventsPromotion: true as const }],
              settlementDeadline: '2026-01-01T04:00:00.000Z',
              status: 'rejected' as any,
            } as LearningEpisode,
          },
        };
        fs.writeFileSync(storePath, JSON.stringify(legacyState), 'utf8');
        const store = new LearningEpisodeStore(storePath);

        // After migration load, the legacy 'rejected' is now 'contradicted'
        const preLink = store.load();
        assert.equal(Object.values(preLink.episodes)[0]!.status, 'contradicted');

        // Extract a new retry episode that shares the runtime session and
        // should link to the migrated predecessor
        const retryEpisode = extractLearningEpisodes(unit([
          turn(3, 'Deliver the corrected artifact.', [tool('3', 'send_file', 'sent')], runtimeSessionId),
        ], sourcePath)).episodes[0];

        // Upsert triggers linkRetryToStoredPredecessor which needs 'contradicted' status
        const state = store.upsert([retryEpisode]);
        const storedRetry = Object.values(state.episodes).find(e => e.deliveryTurn === 3)!;
        assert.equal(storedRetry.retryOfEpisodeId, predecessorId);
        assert.equal(storedRetry.predecessorEpisodeId, predecessorId);

        // Verify migration is durable and retry linkage works across reload
        const reloaded = new LearningEpisodeStore(storePath).load();
        assert.equal(reloaded.schemaVersion, 2);
        const migratedPredecessor = Object.values(reloaded.episodes).find(e => e.episodeId === predecessorId)!;
        assert.equal(migratedPredecessor.status, 'contradicted');
        assert.equal(migratedPredecessor.schemaVersion, 2, 'migrated predecessor per-episode schemaVersion must be v2');
        const reloadedRetry = Object.values(reloaded.episodes).find(e => e.deliveryTurn === 3)!;
        assert.equal(reloadedRetry.retryOfEpisodeId, predecessorId);
        assert.equal(reloadedRetry.schemaVersion, 2, 'retry episode per-episode schemaVersion must be v2');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('a controlled rejecting reviewer end-to-end leaves episode eligible and persists reject_candidate audit', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reject-candidate-e2e-'));
      process.env.XIAOBA_SKILLS_DIR = path.join(root, 'skills');
      try {
        // ── Source unit that produces a durable Learning Episode ──────────
        const storePath = path.join(root, 'data', 'learning-episodes.json');
        const sourcePath = path.join(root, 'session.jsonl');
        const sourceUnit = unit([
          turn(1, 'Deliver a report.', [tool('1', 'send_file', 'report sent')], 'test-reject-rt'),
          turn(2, 'Verified, works.', [], 'test-reject-rt'),
        ], sourcePath);

        // ── Controlled rejecting V3 seam wired through the real pipeline ──
        const skillEvolution = new SkillEvolutionRuntime({
          workingDirectory: root,
          outputDir: path.join(root, 'skills', 'generated-distilled'),
          registryPath: path.join(root, 'data', 'current-skills.json'),
          auditPath: path.join(root, 'data', 'transition-audit.jsonl'),
          journalPath: path.join(root, 'data', 'transition-journal.json'),
          authorFixture: () => ({
            body: 'Deliver a report when requested and wait for user verification.',
            envelope: {
              decision: 'create_current_skill' as const,
              routingName: 'test-report-delivery',
              description: 'Deliver a report and wait for user verification.',
            },
          }),
          verifierFixture: () => ({
            decision: 'reject' as const,
            issues: [{ code: 'test-controlled-rejection', message: 'Controlled rejection for integration test.', severity: 'error' as const }],
            rationale: 'Controlled rejection: the verifier rejects this candidate in the integration test.',
          }),
        });

        const pipeline = new DistillationPipeline({
          outputDir: path.join(root, 'skills', 'generated-distilled'),
          reviewOutcomesPath: path.join(root, 'data', 'review-outcomes.json'),
          learningEpisodeStorePath: storePath,
          learningEpisodeSettlementWindowMs: 0,
          skillEvolution,
        });

        // ── Real processUnitAsync / settled path: extract → persist → settle → review ──
        const result = await pipeline.processUnitAsync(sourceUnit);
        assert.ok('evolutions' in result, 'processUnitAsync must use the V3 evolution path when skillEvolution and the episode store are configured');
        const v3Result = result as import('../src/utils/distillation-pipeline').V3PipelineUnitResult;
        assert.equal(v3Result.evolutions.length, 1, 'the one newly settled eligible episode is reviewed exactly once');
        assert.equal(v3Result.evolutions[0]!.transition, 'reject_candidate');
        assert.equal(v3Result.evolutions[0]!.verified, false);

        // ── The same episode remains eligible in the durable store ────────
        const episodeAfter = Object.values(new LearningEpisodeStore(storePath).load().episodes)[0]!;
        assert.equal(episodeAfter.status, 'eligible');
        assert.equal(episodeAfter.schemaVersion, 2);
        assert.ok(episodeAfter.completionEvidence.some(ev => ev.kind === 'artifact-delivery'));

        // ── No Current Skill or Capability Registry entry is created ──────
        assert.deepEqual(skillEvolution.getRegistry().capabilities, {}, 'reject_candidate must not create a Capability Registry entry');
        assert.deepEqual(fs.readdirSync(path.join(root, 'skills', 'generated-distilled')), [], 'reject_candidate must not install a Current Skill SKILL.md');

        // ── reject_candidate Transition Audit is persisted (audit semantics) ──
        const audits = skillEvolution.getAudit();
        assert.equal(audits.length, 1, 'exactly one Transition Audit entry is written');
        const rejectAudit = audits[0]!;
        assert.equal(rejectAudit.transition, 'reject_candidate');
        assert.ok(typeof rejectAudit.transitionId === 'string' && rejectAudit.transitionId.startsWith('transition-'));
        assert.ok(typeof rejectAudit.occurredAt === 'string');
        assert.ok(Array.isArray(rejectAudit.branchTranscriptPaths));
        assert.ok(Array.isArray(rejectAudit.involvedCapabilityHandles));
        assert.deepEqual(rejectAudit.involvedCapabilityHandles, [], 'reject_candidate with no target involves no Capability Handles');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('migration write failure throws a durable migration I/O error and retains source evidence', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-migration-write-failure-'));
      try {
        const storePath = path.join(root, 'episodes.json');
        const legacyState = {
          schemaVersion: 1,
          episodes: {
            'episode-legacy-fail': {
              schemaVersion: 1,
              episodeId: 'episode-legacy-fail',
              runtimeSessionId: 'legacy-session',
              sourceFilePath: path.join(root, 'session.jsonl'),
              deliveryTurn: 1,
              completionEvidence: [{ ref: 'legacy#turn-1:delivery', sourceFilePath: root, turn: 1, kind: 'artifact-delivery' as const, detail: 'send_file: legacy report' }],
              contradictionSignals: [],
              settlementDeadline: '2026-01-01T04:00:00.000Z',
              status: 'promoted' as any,
            } as LearningEpisode,
          },
        };
        fs.writeFileSync(storePath, JSON.stringify(legacyState), 'utf8');
        const originalRaw = fs.readFileSync(storePath, 'utf8');

        // Safe, deterministic test seam: the atomic migration writer fails
        // without touching the source file, simulating a durable I/O failure.
        const store = new LearningEpisodeStore(storePath, {
          atomicWrite: () => {
            throw new Error('deterministic migration write failure');
          },
        });
        assert.throws(
          () => store.load(),
          /Learning Episode store migration write failed: deterministic migration write failure/,
        );

        // Source evidence is retained verbatim — the failed writer left no
        // partial state, so a later caller can diagnose/retry rather than
        // overwrite the legacy store with an empty state.
        assert.equal(fs.readFileSync(storePath, 'utf8'), originalRaw);
        // A later successful migration (after the I/O issue is resolved) still
        // migrates the retained store cleanly: both store- and episode-level
        // schemaVersion upgrade to v2.
        const recovered = new LearningEpisodeStore(storePath).load();
        assert.equal(recovered.schemaVersion, 2);
        assert.equal(Object.values(recovered.episodes)[0]!.status, 'eligible');
        assert.equal(Object.values(recovered.episodes)[0]!.schemaVersion, 2);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('malformed and unknown-schema stores remain safely separated from migration failures', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-malformed-store-'));
      try {
        // Malformed JSON returns an empty state without throwing and
        // crucially never engages the migration writer.
        const malformedPath = path.join(root, 'malformed.json');
        fs.writeFileSync(malformedPath, '{ not valid json', 'utf8');
        let writerCalled = false;
        const malformedStore = new LearningEpisodeStore(malformedPath, {
          atomicWrite: () => { writerCalled = true; },
        });
        assert.deepEqual(malformedStore.load(), { schemaVersion: 2, episodes: {} });
        assert.equal(writerCalled, false, 'malformed store must not engage the migration writer');

        // Unknown schema version also returns an empty state without writing.
        const unknownPath = path.join(root, 'unknown.json');
        fs.writeFileSync(unknownPath, JSON.stringify({ schemaVersion: 99, episodes: {} }), 'utf8');
        let unknownWriterCalled = false;
        const unknownStore = new LearningEpisodeStore(unknownPath, {
          atomicWrite: () => { unknownWriterCalled = true; },
        });
        assert.deepEqual(unknownStore.load(), { schemaVersion: 2, episodes: {} });
        assert.equal(unknownWriterCalled, false, 'unknown-schema store must not engage the migration writer');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('a Contradiction Signal after eligibility invalidates the episode while preserving source evidence', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-eligible-contradiction-'));
      try {
        const source = path.join(root, 'session.jsonl');
        const store = new LearningEpisodeStore(path.join(root, 'episodes.json'));
        const first = extractLearningEpisodes(unit([
          turn(1, 'Deliver the asset.', [tool('1', 'send_file', 'sent')]),
          turn(2, 'Verified, accepted.', []),
        ], source));
        store.upsert(settleLearningEpisodes(first.episodes, {
          now: new Date('2026-01-01T04:00:00.000Z'),
        }));
        // Episode is eligible
        assert.equal(Object.values(store.load().episodes)[0]!.status, 'eligible');

        // Late contradiction arrives
        const late = extractLearningEpisodes({
          ...unit([turn(3, 'The delivery failed.', [])], source),
          continuityTurns: [
            turn(2, 'Verified, accepted.', []),
            turn(1, 'Deliver the asset.', [tool('1', 'send_file', 'sent')]),
          ],
        });
        const result = store.applyExtraction(late);
        const episode = Object.values(result.episodes)[0]!;
        assert.equal(episode.status, 'contradicted');
        // Source evidence is preserved despite invalidation
        assert.equal(episode.contradictionSignals.length, 1);
        assert.equal(episode.contradictionSignals[0]!.kind, 'failure-report');
        assert.ok(episode.completionEvidence.some(ev => ev.kind === 'artifact-delivery'));
        assert.ok(episode.completionEvidence.some(ev => ev.kind === 'user-acceptance'));
        // No Capability Transition timeline exists — this is an episode-level
        // invalidation, not a Current Skill retirement.
        assert.ok(episode.settlementDeadline < '2026-01-01T04:00:00.000Z');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test('eligible status does not create a review outcome or audit entry outside the store', () => {
      const episodes = extractLearningEpisodes(unit([
        turn(1, 'Build the widget.', [tool('1', 'send_file', 'widget sent')]),
        turn(2, 'Perfect.', []),
      ])).episodes;
      const settled = settleLearningEpisodes(episodes, {
        now: new Date('2026-01-01T04:00:00.000Z'),
      });
      assert.equal(settled[0]!.status, 'eligible');
      // An eligible episode is just a store-level state. No review pipeline
      // was invoked, no SkillEvolution audit produced, no registry entry
      // created, no SKILL.md file written.
      assert.equal(settled[0]!.schemaVersion, 2);
      assert.ok(settled[0]!.episodeId.startsWith('episode-'));
      assert.equal(settled[0]!.contradictionSignals.length, 0);
    });
  });
});
