import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { extractLearningEpisodes, LearningEpisodeStore } from '../src/utils/learning-episode';
import { applyCapabilityTransition, SkillEvolutionRuntime, emptyCurrentSkillRegistryState, saveCurrentSkillRegistry } from '../src/utils/skill-evolution';
import { bootstrapSemanticReassessmentOnce } from '../src/utils/distilled-skill-bootstrap';
import {
  SemanticReassessmentManifestStore,
  semanticObservationHash,
  semanticReassessmentTaskId,
  shouldReassessCurrentSkill,
} from '../src/utils/semantic-reassessment';

test('semantic reassessment identity is stable and supersedes stale revisions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reassessment-'));
  try {
    const store = new SemanticReassessmentManifestStore(path.join(root, 'manifest.json'));
    const observations = [{ kind: 'user-intent' as const, value: 'Generate a flashcard image.', sourceRefs: ['session#1'] }];
    assert.equal(semanticObservationHash(observations), semanticObservationHash([...observations]), 'observation hash is order-stable');
    const first = store.upsertForRecord({
      handle: 'cap-1',
      routingName: 'settled-artifact-delivery',
      guidanceHash: 'guidance-a',
      semanticObservations: observations,
    });
    assert.ok(first);
    assert.equal(first!.taskId, semanticReassessmentTaskId('cap-1', 'guidance-a', observations));
    assert.equal(first!.status, 'pending');

    const second = store.upsertForRecord({
      handle: 'cap-1',
      routingName: 'settled-artifact-delivery-v2',
      guidanceHash: 'guidance-b',
      semanticObservations: observations,
    });
    assert.ok(second);
    const state = store.load();
    assert.equal(state.entries[first!.taskId]!.status, 'superseded');
    assert.equal(state.entries[second!.taskId]!.status, 'pending');
    assert.deepEqual(state.entries[second!.taskId]!.sourceRefs, ['session#1']);
    assert.equal(shouldReassessCurrentSkill({ routingName: 'flashcard-image-delivery', semanticObservations: observations }), false);
    assert.equal(shouldReassessCurrentSkill({ routingName: 'settled-artifact-delivery', semanticObservations: observations }), true);
    assert.equal(shouldReassessCurrentSkill({ routingName: 'flashcard-image-delivery', semanticObservations: [] }), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deferred reassessment remains durable across repeated wakes until input changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reassessment-deferred-'));
  try {
    const store = new SemanticReassessmentManifestStore(path.join(root, 'manifest.json'));
    const record = {
      handle: 'cap-deferred',
      routingName: 'settled-artifact-delivery',
      guidanceHash: 'guidance-a',
      semanticObservations: [],
      revision: 1,
      evidenceRefs: [{ ref: 'episode-a#evidence' }],
    };
    const first = store.upsertForRecord(record);
    assert.ok(first);
    const deferred = store.load();
    deferred.entries[first!.taskId]!.status = 'deferred';
    deferred.entries[first!.taskId]!.lastError = 'bounded evidence unavailable';
    store.save(deferred);

    const repeated = store.upsertForRecord(record);
    assert.equal(repeated?.status, 'deferred');
    assert.equal(store.load().entries[first!.taskId]!.status, 'deferred');

    const newEvidence = store.upsertForRecord({ ...record, evidenceRefs: [{ ref: 'episode-b#evidence' }] });
    assert.equal(newEvidence?.status, 'pending');
    const newEvidenceState = store.load();
    newEvidenceState.entries[newEvidence!.taskId]!.status = 'deferred';
    store.save(newEvidenceState);
    const newReviewerState = store.upsertForRecord({ ...record, evidenceRefs: [{ ref: 'episode-b#evidence' }], revision: 2 });
    assert.equal(newReviewerState?.status, 'pending');

    const changedGuidance = store.upsertForRecord({ ...record, guidanceHash: 'guidance-b' });
    assert.ok(changedGuidance);
    assert.equal(changedGuidance!.status, 'pending');
    assert.equal(store.load().entries[first!.taskId]!.status, 'superseded');

    const explicit = store.upsertForRecord(record, new Date(), true);
    assert.ok(explicit);
    assert.equal(explicit!.status, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('operational reassessment retry persists the queue deadline in the manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reassessment-operational-'));
  try {
    const outputDir = path.join(root, 'skills', 'generated-distilled');
    const skillPath = path.join(outputDir, 'legacy', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: settled-artifact-delivery\ndescription: Legacy\n---\n\nLegacy guidance.\n', 'utf8');
    const registryPath = path.join(root, 'data', 'registry.json');
    const record = {
      handle: 'legacy', revision: 1, routingName: 'settled-artifact-delivery', description: 'Legacy',
      skillFilePath: skillPath, guidanceHash: cryptoHash(skillPath), evidenceRefs: [{ ref: 'episode#evidence' }],
      referencedSkills: [], semanticObservations: [{ kind: 'user-intent' as const, value: 'Deliver a report.', sourceRefs: ['episode#user'] }],
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    const registry = emptyCurrentSkillRegistryState();
    registry.capabilities.legacy = record;
    saveCurrentSkillRegistry(registryPath, registry);
    const queuePath = path.join(root, 'data', 'queue.json');
    const runtime = new SkillEvolutionRuntime({
      workingDirectory: root, outputDir, registryPath,
      auditPath: path.join(root, 'data', 'audit.jsonl'), journalPath: path.join(root, 'data', 'journal.json'),
      reviewQueuePath: queuePath, operationalRetryMs: 60_000, operationalRetryMaxMs: 60_000,
      authorFixture: () => ({
        body: 'Deliver the report.',
        envelope: { decision: 'migrate_skill_route', targetCapabilityHandle: 'legacy', routingName: 'report-delivery', description: 'Deliver a report.' },
      }),
      verifierFixture: () => { throw new Error('review service unavailable'); },
    });

    const manifestPath = path.join(root, 'data', 'manifest.json');
    const [result] = await bootstrapSemanticReassessmentOnce({ skillEvolution: runtime, manifestPath });
    assert.equal(result?.status, 'failed');
    const queued = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as { operational: Array<{ bundleId: string; nextRetryAt: string }> };
    const queuedEntry = queued.operational.find(entry => entry.bundleId === result!.taskId);
    assert.ok(queuedEntry, 'the reassessment should be present in the operational queue');
    const manifestEntry = Object.values(new SemanticReassessmentManifestStore(manifestPath).load().entries)[0]!;
    assert.equal(manifestEntry.status, 'failed');
    assert.equal(manifestEntry.nextRetryAt, queuedEntry!.nextRetryAt, 'manifest and queue must share one retry deadline');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('route-only dependent drift refreshes registry metadata without changing guidance content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reassessment-dependent-'));
  try {
    const outputDir = path.join(root, 'skills', 'generated-distilled');
    const registryPath = path.join(root, 'data', 'registry.json');
    const auditPath = path.join(root, 'data', 'audit.jsonl');
    const journalPath = path.join(root, 'data', 'journal.json');
    const sourcePath = path.join(root, 'data', 'source.jsonl');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '{"entry_type":"turn"}\n', 'utf8');
    const sourceSkillPath = path.join(outputDir, 'source', 'SKILL.md');
    const dependentSkillPath = path.join(outputDir, 'dependent', 'SKILL.md');
    fs.mkdirSync(path.dirname(sourceSkillPath), { recursive: true });
    fs.mkdirSync(path.dirname(dependentSkillPath), { recursive: true });
    fs.writeFileSync(sourceSkillPath, '---\nname: old-route\ndescription: Source\n---\n\nSource guidance.\n', 'utf8');
    fs.writeFileSync(dependentSkillPath, '---\nname: dependent-route\ndescription: Dependent\n---\n\nDependent guidance.\n', 'utf8');
    const observations = [{ kind: 'user-intent' as const, value: 'Use the source capability.', sourceRefs: ['source.jsonl#turn-1'] }];
    const sourceHash = cryptoHash(sourceSkillPath);
    const dependentHash = cryptoHash(dependentSkillPath);
    const registry = emptyCurrentSkillRegistryState();
    registry.capabilities.source = {
      handle: 'source', revision: 1, routingName: 'old-route', description: 'Source', skillFilePath: sourceSkillPath,
      guidanceHash: sourceHash, evidenceRefs: [], referencedSkills: [], semanticObservations: observations,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    registry.capabilities.dependent = {
      handle: 'dependent', revision: 1, routingName: 'dependent-route', description: 'Dependent', skillFilePath: dependentSkillPath,
      guidanceHash: dependentHash, evidenceRefs: [], referencedSkills: [{ name: 'old-route', capabilityHandle: 'source', guidanceHash: sourceHash, contentFingerprint: sourceHash }],
      semanticObservations: observations, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    saveCurrentSkillRegistry(registryPath, registry);
    const runtime = new SkillEvolutionRuntime({ workingDirectory: root, outputDir, registryPath, auditPath, journalPath, authorFixture: () => { throw new Error('route-only drift must not invoke review'); }, verifierFixture: () => { throw new Error('route-only drift must not invoke review'); } });

    // Produce the route drift through the real transition seam. The active
    // file hash changes because frontmatter/transition metadata changes, but
    // executable guidance remains byte-for-byte identical.
    applyCapabilityTransition({
      workingDirectory: root,
      outputDir,
      registryPath,
      auditPath,
      journalPath,
      bundle: {
        bundleId: 'route-only-migration',
        episode: { kind: 'route-migration' },
        completionEvidence: [{ ref: 'source#problem' }],
        settlementEvidence: [{ ref: 'source#verification' }],
        boundedContinuity: [],
        semanticObservations: observations,
        referencedSkills: [],
        relatedCurrentSkills: [{ handle: 'source', revision: 1, routingName: 'old-route', description: 'Source', guidanceHash: sourceHash }],
      },
      draft: { body: 'Source guidance.', envelope: { decision: 'migrate_skill_route', targetCapabilityHandle: 'source', routingName: 'new-route', description: 'Source' } },
      transition: 'migrate_skill_route',
      verifier: { decision: 'accept', transition: 'migrate_skill_route', issues: [], rationale: 'Route-only rename.' },
      branchTranscriptPaths: [], reviewerVersion: 'test', promptVersion: 'test',
    });

    const results = await bootstrapSemanticReassessmentOnce({ skillEvolution: runtime, manifestPath: path.join(root, 'data', 'manifest.json') });
    assert.equal(results.length, 1);
    assert.equal(runtime.getRegistry().capabilities.dependent!.revision, 2);
    assert.equal(runtime.getRegistry().capabilities.dependent!.guidanceHash, dependentHash);
    assert.equal(runtime.getRegistry().capabilities.dependent!.referencedSkills[0]!.name, 'new-route');
    assert.ok(runtime.getAudit().some(entry => entry.transition === 'append_evidence' && entry.involvedCapabilityHandles.includes('dependent')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changed referenced guidance reviews every stale dependent skill', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reassessment-multi-dependent-'));
  try {
    const outputDir = path.join(root, 'skills', 'generated-distilled');
    const registryPath = path.join(root, 'data', 'registry.json');
    const auditPath = path.join(root, 'data', 'audit.jsonl');
    const journalPath = path.join(root, 'data', 'journal.json');
    const sourcePath = path.join(outputDir, 'source', 'SKILL.md');
    const dependentPaths = ['dependent-a', 'dependent-b'].map(name => path.join(outputDir, name, 'SKILL.md'));
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '---\nname: source-route\ndescription: Source\n---\n\nNew source guidance.\n', 'utf8');
    for (const dependentPath of dependentPaths) {
      fs.mkdirSync(path.dirname(dependentPath), { recursive: true });
      fs.writeFileSync(dependentPath, `---\nname: ${path.basename(path.dirname(dependentPath))}\ndescription: Dependent\n---\n\nDependent guidance.\n`, 'utf8');
    }
    const sourceHash = cryptoHash(sourcePath);
    const oldSourceHash = 'old-source-guidance';
    const observations = [{ kind: 'user-intent' as const, value: 'Use the source capability.', sourceRefs: ['source.jsonl#turn-1'] }];
    const registry = emptyCurrentSkillRegistryState();
    registry.capabilities.source = {
      handle: 'source', revision: 2, routingName: 'source-route', description: 'Source', skillFilePath: sourcePath,
      guidanceHash: sourceHash, evidenceRefs: [], referencedSkills: [], semanticObservations: observations,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    for (const [index, dependentPath] of dependentPaths.entries()) {
      const handle = `dependent-${index === 0 ? 'a' : 'b'}`;
      registry.capabilities[handle] = {
        handle, revision: 1, routingName: handle, description: 'Dependent', skillFilePath: dependentPath,
        guidanceHash: cryptoHash(dependentPath), evidenceRefs: [{ ref: `${handle}.jsonl#evidence` }],
        referencedSkills: [{ name: 'source-route', capabilityHandle: 'source', guidanceHash: oldSourceHash, contentFingerprint: oldSourceHash }],
        semanticObservations: observations, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      };
    }
    saveCurrentSkillRegistry(registryPath, registry);
    const reviewedHandles: string[] = [];
    const runtime = new SkillEvolutionRuntime({
      workingDirectory: root, outputDir, registryPath, auditPath, journalPath,
      authorFixture: ({ bundle }) => {
        const handle = (bundle.episode as { capabilityHandle: string }).capabilityHandle;
        reviewedHandles.push(handle);
        return {
          body: 'Maintain the dependent workflow with the updated source guidance.',
          envelope: {
            decision: 'append_evidence', targetCapabilityHandle: handle,
            referencedSkills: bundle.referencedSkills.map(skill => skill.name),
            evidenceRefs: bundle.completionEvidence.map(item => item.ref),
          },
        };
      },
      verifierFixture: () => ({ decision: 'accept', transition: 'append_evidence', issues: [], rationale: 'Updated source guidance is bounded.' }),
    });

    const results = await bootstrapSemanticReassessmentOnce({
      skillEvolution: runtime,
      manifestPath: path.join(root, 'data', 'manifest.json'),
    });
    assert.deepEqual(reviewedHandles.sort(), ['dependent-a', 'dependent-b']);
    assert.equal(results.filter(result => result.status === 'succeeded').length, 2);
    const updated = runtime.getRegistry();
    for (const handle of ['dependent-a', 'dependent-b']) {
      assert.equal(updated.capabilities[handle]!.referencedSkills[0]!.guidanceHash, sourceHash);
      assert.equal(updated.capabilities[handle]!.revision, 2);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reassesses a legacy generic route from persisted episode observations and preserves its handle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reassessment-e2e-'));
  try {
    const outputDir = path.join(root, 'skills', 'generated-distilled');
    const handle = 'cap-legacy';
    const skillPath = path.join(outputDir, handle, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: settled-artifact-delivery\ndescription: Legacy\n---\n\nUse the old route.\n', 'utf8');
    const episodeStore = new LearningEpisodeStore(path.join(root, 'data', 'learning-episodes.json'));
    const [episode] = extractLearningEpisodes({
      filePath: path.join(root, 'logs', 'session.jsonl'),
      newTurns: [
        {
          entry_type: 'turn', turn: 1, timestamp: '2026-07-01T00:00:00.000Z', session_id: 's', session_type: 'chat',
          user: { text: 'Create a flashcard image.' },
          assistant: { text: '', tool_calls: [{ id: 'send', name: 'send_file', arguments: { file_path: 'card.jpg' }, result: 'sent' }] },
          tokens: { prompt: 1, completion: 1 },
        },
        {
          entry_type: 'turn', turn: 2, timestamp: '2026-07-01T00:01:00.000Z', session_id: 's', session_type: 'chat',
          user: { text: 'Looks good.' }, assistant: { text: 'Done.', tool_calls: [] }, tokens: { prompt: 1, completion: 1 },
        },
      ],
      continuityTurns: [], byteRange: { start: 10, end: 200 }, generatedAt: '2026-07-01T00:00:00.000Z',
    }).episodes;
    assert.ok(episode);
    episodeStore.upsert([episode!]);
    const registry = emptyCurrentSkillRegistryState();
    registry.catalogRevision = 1;
    registry.capabilities[handle] = {
      handle,
      revision: 1,
      routingName: 'settled-artifact-delivery',
      description: 'Legacy',
      skillFilePath: skillPath,
      guidanceHash: cryptoHash(skillPath),
      evidenceRefs: episode!.completionEvidence.map(item => ({ ref: item.ref })),
      referencedSkills: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const registryPath = path.join(root, 'data', 'current-skill-registry.json');
    saveCurrentSkillRegistry(registryPath, registry);
    const runtime = new SkillEvolutionRuntime({
      workingDirectory: root,
      outputDir,
      registryPath,
      auditPath: path.join(root, 'data', 'audit.jsonl'),
      journalPath: path.join(root, 'data', 'journal.json'),
      reviewQueuePath: path.join(root, 'data', 'queue.json'),
      authorFixture: ({ bundle }) => ({
        body: 'Use the semantic flashcard image delivery capability.',
        envelope: {
          decision: 'migrate_skill_route',
          targetCapabilityHandle: handle,
          routingName: 'flashcard-image-delivery',
          description: 'Create and deliver flashcard images.',
          evidenceRefs: [...bundle.completionEvidence, ...bundle.settlementEvidence].map(item => item.ref),
        },
      }),
      verifierFixture: () => ({ decision: 'accept', transition: 'migrate_skill_route', issues: [], rationale: 'Same capability, semantic route.' }),
    });

    const results = await bootstrapSemanticReassessmentOnce({
      skillEvolution: runtime,
      manifestPath: path.join(root, 'data', 'reassessment.json'),
      learningEpisodeStore: episodeStore,
    });
    assert.equal(results[0]?.status, 'succeeded');
    assert.equal(runtime.getRegistry().capabilities[handle]!.routingName, 'flashcard-image-delivery');
    assert.equal(runtime.getRegistry().capabilities[handle]!.handle, handle);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function cryptoHash(filePath: string): string {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
