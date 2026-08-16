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
import { acceptReviewObligations } from './evidence-review-test-fixtures';

/**
 * Integration regression (root cause: relatedCurrentSkills duplicate avoidance).
 * The real Codex VS-Code-exclusion external atom's bundle included the existing
 * `transfer-mac-developer-environment` capability (cap_11af8d6aa4ea448594d705e231455b5e)
 * in relatedCurrentSkills. The runtime must guide the Author to
 * append_evidence / replace_current_skill against that capability rather than
 * silently installing a duplicate create_current_skill with the same route.
 *
 * Strong signal: when the Author fixture proposes a duplicate
 * create_current_skill with the matching routingName, the Verifier still
 * dispositions every review obligation, while the runtime draft gate tightens
 * the decision so the duplicate is never committed. When the Author switches
 * to append_evidence targeting the existing capability, the transition commits.
 */

const EXISTING_HANDLE = 'cap_11af8d6aa4ea448594d705e231455b5e';
const EXISTING_ROUTE = 'transfer-mac-developer-environment';

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
    ],
    generatedAt: '2026-07-15T12:00:00.000Z',
    sourceUnit: { filePath: 'xurl-source-codex', byteRange: { start: 5, end: 6 }, generatedAt: '2026-07-15T12:00:00.000Z' },
  };
}

function externalBundle(): EvidenceBundle {
  return {
    bundleId: 'episode-vscode-exclusion-001',
    authority: {
      kind: 'learning-episode',
      episodeId: 'episode-vscode-exclusion-001',
    },
    episode: externalCandidate(),
    completionEvidence: [
      { ref: 'xurl://openai/thread-vscode-exclusion#5:problem-action', sourceFilePath: 'xurl://openai/thread-vscode-exclusion', turn: 5, byteRange: { start: 5, end: 6 } },
    ],
    settlementEvidence: [
      { ref: 'xurl://openai/thread-vscode-exclusion#6:verification', sourceFilePath: 'xurl://openai/thread-vscode-exclusion', turn: 6, byteRange: { start: 5, end: 6 } },
    ],
    semanticObservations: [
      {
        kind: 'user-intent',
        value: `Append this exclusion evidence to ${EXISTING_ROUTE}.`,
        sourceRefs: ['xurl://openai/thread-vscode-exclusion#5:problem-action'],
      },
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
    relatedCurrentSkills: [
      { handle: EXISTING_HANDLE, revision: 1, routingName: EXISTING_ROUTE, description: 'Transfer a Mac developer environment.', guidanceHash: 'g-transfer' },
    ],
  } as unknown as EvidenceBundle;
}

function lowRiskReader({ shard, lane }: { shard: { shardId: string; contentHash: string; content: string }; lane: 'author' | 'verifier' }): { findingSet: ShardFindingSet } {
  const spanEnd = Math.min(Buffer.byteLength(shard.content, 'utf8'), 8);
  return {
    findingSet: {
      shardId: shard.shardId,
      contentHash: shard.contentHash,
      lane,
      coverage: 'covered' as const,
      findings: [{
        findingId: `${lane}:fact:${shard.shardId}`,
        classification: 'fact' as const,
        summary: 'Cited external completion/settlement evidence for the settled low-risk atom.',
        spans: [{ start: 0, end: spanEnd }],
      }],
    },
  };
}

function setup(): { root: string; options: SkillEvolutionOptions; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cap-update-guidance-'));
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
    readerFixture: ({ shard, lane }) => lowRiskReader({ shard, lane }),
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

describe('Capability update guidance — integration (RC #6b)', () => {
  test('a duplicate create_current_skill is verified for evidence but is not committed as a duplicate', async () => {
    const env = setup();
    try {
      // Seed the live registry with the existing capability so the Review
      // Commit Fence does not supersede on a stale read set; the bundle's
      // relatedCurrentSkills must match the live registry for the duplicate
      // draft gate to be the seam under test.
      fs.mkdirSync(path.dirname(env.options.registryPath), { recursive: true });
      const existingSkillPath = path.join(env.options.outputDir, EXISTING_HANDLE, 'SKILL.md');
      fs.mkdirSync(path.dirname(existingSkillPath), { recursive: true });
      fs.writeFileSync(existingSkillPath, '---\nskill: transfer-mac-developer-environment\n---\nTransfer a Mac developer environment.', 'utf8');
      fs.writeFileSync(env.options.registryPath, JSON.stringify({
        schemaVersion: 2,
        catalogRevision: 1,
        routeRedirects: {},
        capabilities: {
          [EXISTING_HANDLE]: {
            handle: EXISTING_HANDLE,
            revision: 1,
            routingName: EXISTING_ROUTE,
            description: 'Transfer a Mac developer environment.',
            skillFilePath: existingSkillPath,
            guidanceHash: 'g-transfer',
            evidenceRefs: [{ ref: 'prior://transfer-mac-dev-env#1' }],
            referencedSkills: [],
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        },
      }), 'utf8');

      let verifierReached = 0;
      env.options.authorFixture = () => ({
        body: 'Bounded guidance for the Mac dev environment transfer that excludes VS Code.',
        envelope: {
          decision: 'create_current_skill',
          routingName: EXISTING_ROUTE, // duplicates the existing capability route
          description: 'Exclude VS Code from a Mac developer environment transfer.',
          evidenceRefs: [
            'xurl://openai/thread-vscode-exclusion#5:problem-action',
            'xurl://openai/thread-vscode-exclusion#6:verification',
          ],
        },
      });
      env.options.verifierFixture = ({ bundle }) => {
        verifierReached += 1;
        return {
          decision: 'accept',
          transition: 'create_current_skill',
          issues: [],
          rationale: 'The cited evidence supports the draft, subject to runtime capability constraints.',
          obligationDispositions: acceptReviewObligations(bundle),
        };
      };

      const result = await new SkillEvolutionRuntime(env.options).reviewAndApply(externalBundle());

      assert.ok(verifierReached >= 1, 'the Verifier must disposition obligations before the runtime gate tightens the decision');
      assert.notEqual(
        result.transition,
        'create_current_skill',
        `a duplicate create_current_skill against an existing relatedCurrentSkill must not commit; got ${JSON.stringify({ transition: result.transition, verified: result.verified })}`,
      );
      assert.equal(result.verified, false, 'the duplicate draft must not be verified');
      // The runtime draft gate's defer rationale must name the duplicate issue.
      const audit = loadTransitionAudit(env.options.auditPath);
      const rationale = (audit.at(-1)?.rationale ?? result.verifier?.rationale ?? '');
      assert.match(rationale, /duplicate-capability-creation|already exists|append_evidence|replace_current_skill/i, `rationale should name the duplicate issue, got: ${rationale}`);
    } finally {
      env.cleanup();
    }
  });

  test('an append_evidence draft targeting the existing capability is allowed to commit', async () => {
    const env = setup();
    try {
      fs.mkdirSync(path.dirname(env.options.registryPath), { recursive: true });
      const skillFilePath = path.join(env.options.outputDir, EXISTING_HANDLE, 'SKILL.md');
      fs.mkdirSync(path.dirname(skillFilePath), { recursive: true });
      fs.writeFileSync(skillFilePath, '---\nskill: transfer-mac-developer-environment\n---\nTransfer a Mac developer environment.', 'utf8');
      fs.writeFileSync(env.options.registryPath, JSON.stringify({
        schemaVersion: 2,
        catalogRevision: 1,
        routeRedirects: {},
        capabilities: {
          [EXISTING_HANDLE]: {
            handle: EXISTING_HANDLE,
            revision: 1,
            routingName: EXISTING_ROUTE,
            description: 'Transfer a Mac developer environment.',
            skillFilePath,
            guidanceHash: 'g-transfer',
            evidenceRefs: [{ ref: 'prior://transfer-mac-dev-env#1' }],
            referencedSkills: [],
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        },
      }), 'utf8');

      let verifierReached = 0;
      env.options.authorFixture = () => ({
        body: 'Append the bounded VS Code exclusion evidence to the existing Mac developer environment transfer capability.',
        envelope: {
          decision: 'append_evidence',
          targetCapabilityHandle: EXISTING_HANDLE,
          evidenceRefs: [
            'xurl://openai/thread-vscode-exclusion#5:problem-action',
            'xurl://openai/thread-vscode-exclusion#6:verification',
          ],
        },
      });
      env.options.verifierFixture = () => {
        verifierReached += 1;
        return { decision: 'accept', transition: 'append_evidence', issues: [], rationale: 'Verifier accepts the bounded append to the existing capability.' };
      };

      const result = await new SkillEvolutionRuntime(env.options).reviewAndApply(externalBundle());

      assert.ok(verifierReached >= 1, 'append_evidence draft should reach the Verifier');
      assert.equal(
        result.transition,
        'append_evidence',
        `append_evidence targeting the existing capability should commit; got ${JSON.stringify({ transition: result.transition, verified: result.verified })}`,
      );
      assert.equal(result.verified, true);
    } finally {
      env.cleanup();
    }
  });

  test('round-1 duplicate create → bounded Author correction in round-2 → exactly one append to cap_, zero new capability', async () => {
    const env = setup();
    try {
      env.options.reviewQueuePath = path.join(env.root, 'data', 'review-queue.json');
      fs.mkdirSync(path.dirname(env.options.registryPath), { recursive: true });
      const skillFilePath = path.join(env.options.outputDir, EXISTING_HANDLE, 'SKILL.md');
      fs.mkdirSync(path.dirname(skillFilePath), { recursive: true });
      fs.writeFileSync(skillFilePath, '---\nskill: transfer-mac-developer-environment\n---\nTransfer a Mac developer environment.', 'utf8');
      fs.writeFileSync(env.options.registryPath, JSON.stringify({
        schemaVersion: 2,
        catalogRevision: 1,
        routeRedirects: {},
        capabilities: {
          [EXISTING_HANDLE]: {
            handle: EXISTING_HANDLE,
            revision: 1,
            routingName: EXISTING_ROUTE,
            description: 'Transfer a Mac developer environment.',
            skillFilePath,
            guidanceHash: 'g-transfer',
            evidenceRefs: [{ ref: 'prior://transfer-mac-dev-env#1' }],
            referencedSkills: [],
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        },
      }), 'utf8');

      const authorRounds: unknown[] = [];
      let verifierReached = 0;

      env.options.authorFixture = (input: unknown) => {
        const ctx = input as { round?: number; verifierIssues?: unknown[] };
        authorRounds.push({ round: ctx.round, hasIssues: Array.isArray(ctx.verifierIssues) && ctx.verifierIssues.length > 0 });
        // Round 1: propose duplicate create (triggers the draft gate).
        // Round 2: after guidance, switch to append_evidence.
        if (ctx.round === 2) {
          return {
            body: 'Append bounded VS Code exclusion evidence to the existing Mac dev env transfer capability.',
            envelope: {
              decision: 'append_evidence',
              targetCapabilityHandle: EXISTING_HANDLE,
              evidenceRefs: [
                'xurl://openai/thread-vscode-exclusion#5:problem-action',
                'xurl://openai/thread-vscode-exclusion#6:verification',
              ],
            },
          };
        }
        // Round 1: duplicate create.
        return {
          body: 'Bounded guidance for the Mac dev environment transfer that excludes VS Code.',
          envelope: {
            decision: 'create_current_skill',
            routingName: EXISTING_ROUTE,
            description: 'Exclude VS Code from a Mac dev env transfer.',
            evidenceRefs: [
              'xurl://openai/thread-vscode-exclusion#5:problem-action',
              'xurl://openai/thread-vscode-exclusion#6:verification',
            ],
          },
        };
      };
      env.options.verifierFixture = () => {
        verifierReached += 1;
        return { decision: 'accept', transition: 'append_evidence', issues: [], rationale: 'Verifier accepts the corrected append to the existing capability.' };
      };

      const result = await new SkillEvolutionRuntime(env.options).reviewAndApply(externalBundle());

      assert.ok(
        authorRounds.length >= 2,
        `round-1 duplicate should grant Author a bounded revision (round 2); got ${authorRounds.length} Author rounds`,
      );
      assert.ok(verifierReached >= 1, 'corrected append draft should reach the Verifier (round 2)');
      assert.equal(
        result.transition,
        'append_evidence',
        `round-2 correction should commit append_evidence, got ${JSON.stringify({ transition: result.transition, verified: result.verified, queued: result.queued })}`,
      );
      assert.equal(result.verified, true);

      // Assert exactly one append to EXISTING_HANDLE, zero new capability.
      const audit = loadTransitionAudit(env.options.auditPath);
      const lastEntry = audit.at(-1);
      assert.ok(lastEntry, 'a transition audit entry should have been written');
      assert.equal(lastEntry?.transition, 'append_evidence');
      assert.ok(
        lastEntry?.involvedCapabilityHandles?.includes(EXISTING_HANDLE),
        `should target existing handle ${EXISTING_HANDLE}, got ${JSON.stringify(lastEntry?.involvedCapabilityHandles)}`,
      );
    } finally {
      env.cleanup();
    }
  });
});
