import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  EvidenceBundle,
  SkillEvolutionRuntime,
  SkillEvolutionOptions,
  loadTransitionAudit,
} from '../src/utils/skill-evolution';
import type { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';
import type { ShardFindingSet } from '../src/utils/evidence-review-types';

/**
 * Low-risk structural reader: both lanes produce the same single `fact`
 * finding over a non-empty span of each shard, so no high-risk Review
 * Obligation is raised and the dual-lane Difference Index is empty. This
 * mirrors a settled, low-risk external atom where the model-backed readers
 * would not surface open risk/contradiction findings.
 */
function lowRiskReaderFixture({ shard, lane }: { shard: { shardId: string; contentHash: string; content: string }; lane: 'author' | 'verifier' }): { findingSet: ShardFindingSet } {
  const findingId = `${lane}:fact:${shard.shardId}`;
  const spanEnd = Math.min(Buffer.byteLength(shard.content, 'utf8'), 8);
  return {
    findingSet: {
      shardId: shard.shardId,
      contentHash: shard.contentHash,
      lane,
      coverage: 'covered' as const,
      findings: [{
        findingId,
        classification: 'fact' as const,
        summary: 'Cited external completion/settlement evidence for the settled low-risk atom.',
        spans: [{ start: 0, end: spanEnd }],
      }],
    },
  };
}

/**
 * Integration regression (root cause #5): the enforceable Progressive Trust
 * defer seam runs at the real `runSkillVerifierQuantum` seam. A Verifier
 * fixture that defers a settled, low-risk, narrow external atom solely for
 * sample scarcity must not block the atom from promotion at the final round
 * when the draft is valid and no high-risk obligation / structural difference
 * remains. Genuine deferral reasons must still defer.
 */

function externalCandidate(): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: 'candidate-vscode-exclusion',
    title: 'Exclude VS Code from Mac developer environment transfer',
    applicability: 'Applies when transferring a Mac dev environment and excluding VS Code.',
    actionPattern: 'Remove the VS Code cask and extensions from the Brewfile, re-run brew bundle, and verify.',
    boundaries: ['Only apply when the user asks to exclude VS Code from a Homebrew Bundle.'],
    risks: ['External evidence is redacted and bounded.'],
    solvedLoop: {
      problem: 'User asked to exclude VS Code from the Mac developer environment transfer.',
      action: 'Inspected the Brewfile, removed the VS Code cask and 19 extensions, ran brew bundle.',
      verification: 'brew bundle check passed after the exclusion; episode settled without contradiction.',
      noCorrection: 'No contradiction signal was present at admission.',
    },
    provenance: [
      { filePath: 'xurl://openai/thread-vscode-exclusion', turn: 5, role: 'problem-action', unitByteRange: { start: 5, end: 6 } },
      { filePath: 'xurl://openai/thread-vscode-exclusion', turn: 6, role: 'verification', unitByteRange: { start: 5, end: 6 } },
    ],
    generatedAt: '2026-07-15T12:00:00.000Z',
    sourceUnit: { filePath: 'xurl-source-codex', byteRange: { start: 5, end: 6 }, generatedAt: '2026-07-15T12:00:00.000Z' },
  };
}

function externalBundle(): EvidenceBundle {
  return {
    bundleId: 'episode-vscode-exclusion-001',
    episode: externalCandidate(),
    completionEvidence: [
      { ref: 'xurl://openai/thread-vscode-exclusion#5:problem-action', sourceFilePath: 'xurl://openai/thread-vscode-exclusion', turn: 5, byteRange: { start: 5, end: 6 } },
    ],
    settlementEvidence: [
      { ref: 'xurl://openai/thread-vscode-exclusion#6:verification', sourceFilePath: 'xurl://openai/thread-vscode-exclusion', turn: 6, byteRange: { start: 5, end: 6 } },
    ],
    semanticObservations: [
      { kind: 'user-intent', value: 'Exclude VS Code from the Mac developer environment transfer.', sourceRefs: ['xurl://openai/thread-vscode-exclusion#5:problem-action'] },
      { kind: 'verification', value: 'brew bundle check passed after removing the VS Code cask and extensions.', sourceRefs: ['xurl://openai/thread-vscode-exclusion#5:problem-action'] },
    ],
    sourceEvidence: [
      {
        ref: 'xurl://openai/thread-vscode-exclusion#5:problem-action',
        role: 'problem-action' as const,
        content: 'User asked to exclude VS Code from the Mac developer environment transfer.',
        sourceFilePath: 'xurl://openai/thread-vscode-exclusion',
        turn: 5,
      },
      {
        ref: 'xurl://openai/thread-vscode-exclusion#6:verification',
        role: 'verification' as const,
        content: 'Episode settled at 2026-07-16T00:00:00.000Z (status: eligible)',
        sourceFilePath: 'xurl://openai/thread-vscode-exclusion',
        turn: 6,
      },
    ],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [],
  } as unknown as EvidenceBundle;
}

function setup(): { root: string; options: SkillEvolutionOptions; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-progressive-trust-'));
  const skillsRoot = path.join(root, 'skills');
  const previousRuntimeRoot = process.env.XIAOBA_RUNTIME_ROOT;
  const previousSkillsRoot = process.env.XIAOBA_SKILLS_DIR;
  process.env.XIAOBA_RUNTIME_ROOT = root;
  process.env.XIAOBA_SKILLS_DIR = skillsRoot;
  const options: SkillEvolutionOptions = {
    workingDirectory: root,
    outputDir: path.join(skillsRoot, 'generated-distilled'),
    registryPath: path.join(root, 'data', 'current-skill-registry.json'),
    auditPath: path.join(root, 'data', 'transition-audit.jsonl'),
    journalPath: path.join(root, 'data', 'transition-journal.json'),
    manualSkillNames: ['manual-skill'],
    logEnabled: true,
    readerFixture: ({ shard, lane }) => lowRiskReaderFixture({ shard, lane }),
    authorFixture: () => ({
      body: 'Remove the VS Code cask and the listed extensions from the Brewfile and re-run `brew bundle` to verify the exclusion. Keep the change bounded to the Homebrew Bundle on the user\'s Mac.',
      envelope: {
        decision: 'create_current_skill',
        routingName: 'mac-dev-env-vscode-exclusion',
        description: 'Exclude VS Code from a Mac developer environment Homebrew Bundle transfer.',
        evidenceRefs: [
          'xurl://openai/thread-vscode-exclusion#5:problem-action',
          'xurl://openai/thread-vscode-exclusion#6:verification',
        ],
      },
    }),
    verifierFixture: () => ({
      decision: 'defer',
      issues: [],
      rationale: 'Only one source instance was observed for this pattern; there is no independent repetition of this external atom. Defer for more observations.',
    }),
  };
  return {
    root,
    options,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      if (previousRuntimeRoot === undefined) delete process.env.XIAOBA_RUNTIME_ROOT;
      else process.env.XIAOBA_RUNTIME_ROOT = previousRuntimeRoot;
      if (previousSkillsRoot === undefined) delete process.env.XIAOBA_SKILLS_DIR;
      else process.env.XIAOBA_SKILLS_DIR = previousSkillsRoot;
    },
  };
}

describe('Progressive Trust enforceable defer seam — integration (RC #5)', () => {
  test('a scarcity-only defer of a settled low-risk external atom is not allowed to block promotion', async () => {
    const env = setup();
    try {
      const result = await new SkillEvolutionRuntime(env.options).reviewAndApply(externalBundle());
      assert.equal(
        result.transition,
        'create_current_skill',
        `expected the Progressive Trust seam to let the settled low-risk external atom commit, got ${JSON.stringify({ transition: result.transition, verified: result.verified, queued: result.queued })}`,
      );
      assert.equal(result.verified, true);
      const audit = loadTransitionAudit(env.options.auditPath);
      const entry = audit.at(-1);
      assert.ok(entry, 'a transition audit entry should have been written');
      assert.equal(entry?.transition, 'create_current_skill');
    } finally {
      env.cleanup();
    }
  });

  test('a genuine truncation defer is not overridden (no blind accept)', async () => {
    const env = setup();
    try {
      env.options.verifierFixture = () => ({
        decision: 'defer',
        issues: [],
        rationale: 'The user intent is truncated and materially ambiguous; defer for more evidence before naming the capability.',
      });
      const result = await new SkillEvolutionRuntime(env.options).reviewAndApply(externalBundle());
      assert.equal(result.transition, 'defer', 'genuine truncation defer must not be overridden by the seam');
      assert.equal(result.verified, false);
    } finally {
      env.cleanup();
    }
  });
});