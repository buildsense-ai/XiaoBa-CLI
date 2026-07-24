import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  detectDuplicateCapabilityCreation,
} from '../src/utils/capability-update-guidance';
import type {
  EvidenceBundle,
  RelatedCurrentSkill,
  SkillDraft,
} from '../src/utils/skill-evolution';

/**
 * Progressive Trust regression (root cause: relatedCurrentSkills append/replace
 * guidance). When the fixed Evidence Bundle already includes a matching
 * Capability in `relatedCurrentSkills` and the evidence supports updating it,
 * the Author must be guided toward `append_evidence` / `replace_current_skill`
 * instead of creating a duplicate `create_current_skill`. The runtime must not
 * invent semantic names or silently override a genuinely different Author
 * proposal — it emits a bounded validation/revision signal only.
 */

function related(handle: string, routingName: string, description = 'Existing capability.'): RelatedCurrentSkill {
  return { handle, revision: 1, routingName, description, guidanceHash: 'g-' + handle };
}

function bundleWith(relatedCurrentSkills: RelatedCurrentSkill[]): EvidenceBundle {
  return {
    bundleId: 'episode-vscode-exclusion-001',
    episode: {},
    completionEvidence: [
      { ref: 'xurl://openai/thread-vscode-exclusion#5:problem-action', sourceFilePath: 'xurl://openai/thread-vscode-exclusion', turn: 5, byteRange: { start: 5, end: 6 } },
    ],
    settlementEvidence: [
      { ref: 'xurl://openai/thread-vscode-exclusion#6:verification', sourceFilePath: 'xurl://openai/thread-vscode-exclusion', turn: 6, byteRange: { start: 5, end: 6 } },
    ],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills,
    semanticObservations: [],
  } as unknown as EvidenceBundle;
}

function createDraft(routingName: string, evidenceRefs: string[] = ['xurl://openai/thread-vscode-exclusion#5:problem-action']): SkillDraft {
  return {
    body: 'Bounded guidance for the Mac dev environment VS Code exclusion.',
    envelope: {
      decision: 'create_current_skill',
      routingName,
      description: 'Exclude VS Code from a Mac developer environment transfer.',
      evidenceRefs,
    },
  };
}

describe('Capability update guidance — duplicate detection (RC #6b)', () => {
  test('create_current_skill with a routingName matching an existing relatedCurrentSkill is flagged', () => {
    const bundle = bundleWith([
      related('cap_11af8d6aa4ea448594d705e231455b5e', 'transfer-mac-developer-environment', 'Transfer a Mac developer environment.'),
    ]);
    const draft = createDraft('transfer-mac-developer-environment');

    const issue = detectDuplicateCapabilityCreation(draft, bundle);

    assert.ok(issue, 'a duplicate create_current_skill against an existing relatedCurrentSkill must be flagged');
    assert.equal(issue!.code, 'duplicate-capability-creation');
    assert.equal(issue!.severity, 'error');
    assert.match(issue!.message, /transfer-mac-developer-environment/);
    assert.match(issue!.message, /append_evidence|replace_current_skill/);
    assert.match(issue!.message, /cap_11af8d6aa4ea448594d705e231455b5e/);
  });

  test('create_current_skill with a genuinely different routingName is NOT flagged (no silent override)', () => {
    const bundle = bundleWith([
      related('cap_11af8d6aa4ea448594d705e231455b5e', 'transfer-mac-developer-environment'),
    ]);
    const draft = createDraft('mac-dev-env-vscode-exclusion');

    const issue = detectDuplicateCapabilityCreation(draft, bundle);

    assert.equal(issue, null, 'a genuinely different routingName must not be silently flagged');
  });

  test('append_evidence targeting the existing capability is NOT flagged as a duplicate', () => {
    const bundle = bundleWith([
      related('cap_11af8d6aa4ea448594d705e231455b5e', 'transfer-mac-developer-environment'),
    ]);
    const draft: SkillDraft = {
      body: 'Append the VS Code exclusion evidence to the existing transfer capability.',
      envelope: {
        decision: 'append_evidence',
        targetCapabilityHandle: 'cap_11af8d6aa4ea448594d705e231455b5e',
        evidenceRefs: ['xurl://openai/thread-vscode-exclusion#5:problem-action'],
      },
    };

    const issue = detectDuplicateCapabilityCreation(draft, bundle);

    assert.equal(issue, null, 'append_evidence is the bounded update path and must not be flagged');
  });

});