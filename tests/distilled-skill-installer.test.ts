import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import matter from 'gray-matter';
import { SkillParser } from '../src/skills/skill-parser';
import {
  CapabilityProvenanceRef,
  DistilledKnowledgeCandidate,
  SolvedLoopEvidence,
} from '../src/utils/capability-distiller';
import {
  buildPromotionPacket,
  PromotionReviewResult,
  reviewPromotionPacket,
} from '../src/utils/promotion-reviewer';
import {
  computeSnapshotId,
  installPromotedCandidate,
  InstalledSkillSnapshot,
  renderDistilledSkillMarkdown,
  resolveEffectiveFields,
} from '../src/utils/distilled-skill-installer';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProvenance(
  filePath = '/logs/sessions/chat/chat_cli.jsonl',
): CapabilityProvenanceRef[] {
  return [
    {
      filePath,
      turn: 1,
      role: 'problem-action',
      unitByteRange: { start: 0, end: 1000 },
    },
    {
      filePath,
      turn: 2,
      role: 'verification',
      unitByteRange: { start: 0, end: 1000 },
    },
  ];
}

function makeSolvedLoop(): SolvedLoopEvidence {
  return {
    problem: 'How do I parse a JSONL file in Node without loading everything into memory?',
    action: 'Used tools [read_file] and said: You can use readline and process line by line.',
    verification: 'Thanks, that works perfectly!',
    noCorrection: 'Verification turn contained positive acceptance and no immediate-correction markers.',
  };
}

function makeCandidate(
  overrides: Partial<DistilledKnowledgeCandidate> = {},
): DistilledKnowledgeCandidate {
  const solvedLoop = overrides.solvedLoop ?? makeSolvedLoop();
  return {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: 'cap-abc123def456',
    title: 'Capability: How do I parse a JSONL file in Node',
    applicability: 'Applies when the user raises a similar problem to: How do I parse a JSONL file in Node',
    actionPattern: 'Use tool(s) [read_file] then respond with: You can use readline and process line by line.',
    boundaries: [
      'Only applies when the new situation matches the original problem shape; verify applicability before reuse.',
      'Do not apply when the user is still correcting or iterating on the request.',
    ],
    risks: [
      'Distilled from a single solved loop; the pattern may not generalize.',
      'Apply the Promotion Reviewer before installing as an active skill.',
    ],
    solvedLoop,
    provenance: overrides.provenance ?? makeProvenance(),
    generatedAt: '2026-07-10T00:00:00.000Z',
    sourceUnit: {
      filePath: '/logs/sessions/chat/chat_cli.jsonl',
      byteRange: { start: 0, end: 1000 },
      generatedAt: '2026-07-10T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makePromoteReview(
  overrides: Partial<PromotionReviewResult> = {},
): PromotionReviewResult {
  return {
    schemaVersion: 1,
    capabilityId: 'cap-abc123def456',
    decision: 'promote',
    rationale: 'All checks passed: solved-loop evidence is complete, provenance is sufficient, and no unsupported claims were detected.',
    reviewRisks: [],
    rewrite: null,
    reviewedAt: '2026-07-10T01:00:00.000Z',
    ...overrides,
  };
}

function makePromoteReviewFor(
  candidate: DistilledKnowledgeCandidate,
  overrides: Partial<PromotionReviewResult> = {},
): PromotionReviewResult {
  return makePromoteReview({
    capabilityId: candidate.capabilityId,
    ...overrides,
  });
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'distilled-installer-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Distilled Skill Installer', () => {
  // -------------------------------------------------------------------------
  // Deterministic Markdown rendering
  // -------------------------------------------------------------------------

  describe('deterministic Markdown rendering', () => {
    test('rendering the same candidate and review produces identical Markdown', () => {
      const candidate = makeCandidate();
      const review = makePromoteReview();

      const a = renderDistilledSkillMarkdown(candidate, review);
      const b = renderDistilledSkillMarkdown(candidate, review);

      assert.equal(a, b);
    });

    test('rendering does not call new Date() — generation time comes from the review', () => {
      const candidate = makeCandidate();
      const review = makePromoteReview({ reviewedAt: '2026-01-01T00:00:00.000Z' });

      const markdown = renderDistilledSkillMarkdown(candidate, review);
      const parsed = matter(markdown);

      assert.equal(parsed.data.generated_at, '2026-01-01T00:00:00.000Z');
    });

    test('rendered Markdown starts with YAML frontmatter delimiters', () => {
      const markdown = renderDistilledSkillMarkdown(makeCandidate(), makePromoteReview());
      assert.ok(markdown.startsWith('---\n'));
    });

    test('rendered Markdown includes the Traceability Contract section', () => {
      const markdown = renderDistilledSkillMarkdown(makeCandidate(), makePromoteReview());
      assert.match(markdown, /## Traceability Contract/);
    });

    test('rendered Markdown includes the Provenance Refs section', () => {
      const markdown = renderDistilledSkillMarkdown(makeCandidate(), makePromoteReview());
      assert.match(markdown, /## Provenance Refs/);
    });

    test('rendered Markdown includes the Capability Guidance section', () => {
      const markdown = renderDistilledSkillMarkdown(makeCandidate(), makePromoteReview());
      assert.match(markdown, /## Capability Guidance/);
    });

    test('rendered Markdown includes the Boundaries section with boundary entries', () => {
      const candidate = makeCandidate({
        boundaries: ['Boundary one.', 'Boundary two.'],
      });
      const markdown = renderDistilledSkillMarkdown(candidate, makePromoteReview());
      assert.match(markdown, /## Boundaries/);
      assert.match(markdown, /- Boundary one\./);
      assert.match(markdown, /- Boundary two\./);
    });

    test('rendered Markdown does not embed raw log content', () => {
      const candidate = makeCandidate();
      const markdown = renderDistilledSkillMarkdown(candidate, makePromoteReview());
      // The raw solved-loop evidence fields should not appear verbatim in the
      // body (only structured refs are included).
      assert.doesNotMatch(markdown, /Thanks, that works perfectly!/);
    });

    test('frontmatter description is a routable when/do summary', () => {
      const markdown = renderDistilledSkillMarkdown(makeCandidate(), makePromoteReview());
      const parsed = matter(markdown);
      assert.match(parsed.data.description, /^Distilled capability\. When:/);
      assert.match(parsed.data.description, /Do:/);
      assert.match(parsed.data.description, /parse a JSONL file/);
      assert.match(parsed.data.description, /readline and process line by line/);
      assert.doesNotMatch(parsed.data.description, /Capability: Capability:/);
    });

    test('frontmatter description marks truncated metadata instead of ending with bare ellipsis', () => {
      const candidate = makeCandidate({
        applicability: `Applies when the user raises a similar problem to: ${'Long problem detail '.repeat(30)}`,
        actionPattern: `Apply this response pattern: ${'Long action detail '.repeat(40)}`,
      });

      const markdown = renderDistilledSkillMarkdown(candidate, makePromoteReview());
      const parsed = matter(markdown);

      assert.match(parsed.data.description, /\[source has more\]/);
      assert.doesNotMatch(parsed.data.description, /\.\.\.$/);
    });

    test('frontmatter includes stable capability_id and immutable snapshot_id', () => {
      const candidate = makeCandidate();
      const review = makePromoteReview();
      const markdown = renderDistilledSkillMarkdown(candidate, review);
      const parsed = matter(markdown);

      assert.equal(parsed.data.capability_id, candidate.capabilityId);
      assert.ok(parsed.data.snapshot_id);
      assert.equal(parsed.data.snapshot_id.length, 16);
    });

    test('frontmatter includes source runtime metadata', () => {
      const candidate = makeCandidate();
      const markdown = renderDistilledSkillMarkdown(candidate, makePromoteReview());
      const parsed = matter(markdown);

      assert.equal(parsed.data.source_file_path, candidate.sourceUnit.filePath);
      assert.equal(parsed.data.source_byte_range_start, candidate.sourceUnit.byteRange.start);
      assert.equal(parsed.data.source_byte_range_end, candidate.sourceUnit.byteRange.end);
      assert.equal(parsed.data.source_unit_generated_at, candidate.sourceUnit.generatedAt);
    });

    test('frontmatter includes generation time', () => {
      const review = makePromoteReview({ reviewedAt: '2026-03-01T12:00:00.000Z' });
      const markdown = renderDistilledSkillMarkdown(makeCandidate(), review);
      const parsed = matter(markdown);

      assert.equal(parsed.data.generated_at, '2026-03-01T12:00:00.000Z');
    });

    test('frontmatter includes review metadata', () => {
      const review = makePromoteReview({
        rationale: 'Custom rationale text.',
      });
      const markdown = renderDistilledSkillMarkdown(makeCandidate(), review);
      const parsed = matter(markdown);

      assert.equal(parsed.data.review_decision, 'promote');
      assert.equal(parsed.data.review_reviewed_at, review.reviewedAt);
      assert.equal(parsed.data.review_rationale, 'Custom rationale text.');
    });

    test('frontmatter marks the skill as distilled', () => {
      const markdown = renderDistilledSkillMarkdown(makeCandidate(), makePromoteReview());
      const parsed = matter(markdown);
      assert.equal(parsed.data.distilled, true);
      assert.equal(parsed.data.kind, 'capability');
    });

    test('frontmatter user-invocable is true for skill discovery compatibility', () => {
      const markdown = renderDistilledSkillMarkdown(makeCandidate(), makePromoteReview());
      const parsed = matter(markdown);
      assert.equal(parsed.data['user-invocable'], true);
    });

    test('different candidates produce different snapshot_ids', () => {
      const candidateA = makeCandidate({ capabilityId: 'cap-aaa' });
      const candidateB = makeCandidate({ capabilityId: 'cap-bbb' });

      const effectiveA = resolveEffectiveFields(candidateA, null);
      const effectiveB = resolveEffectiveFields(candidateB, null);
      const idA = computeSnapshotId(candidateA, effectiveA, makePromoteReviewFor(candidateA));
      const idB = computeSnapshotId(candidateB, effectiveB, makePromoteReviewFor(candidateB));

      assert.notEqual(idA, idB);
    });

    test('different source metadata produces different snapshot_ids', () => {
      const candidateA = makeCandidate({
        sourceUnit: {
          filePath: '/logs/sessions/chat/session_a.jsonl',
          byteRange: { start: 0, end: 1000 },
          generatedAt: '2026-07-10T00:00:00.000Z',
        },
      });
      const candidateB = makeCandidate({
        sourceUnit: {
          filePath: '/logs/sessions/chat/session_b.jsonl',
          byteRange: { start: 0, end: 1000 },
          generatedAt: '2026-07-10T00:00:00.000Z',
        },
      });

      const idA = computeSnapshotId(candidateA, resolveEffectiveFields(candidateA, null), makePromoteReview());
      const idB = computeSnapshotId(candidateB, resolveEffectiveFields(candidateB, null), makePromoteReview());

      assert.notEqual(idA, idB);
    });

    test('different review metadata produces different snapshot_ids', () => {
      const candidate = makeCandidate();
      const effective = resolveEffectiveFields(candidate, null);
      const idA = computeSnapshotId(
        candidate,
        effective,
        makePromoteReview({ reviewedAt: '2026-07-10T01:00:00.000Z' }),
      );
      const idB = computeSnapshotId(
        candidate,
        effective,
        makePromoteReview({ reviewedAt: '2026-07-10T02:00:00.000Z' }),
      );

      assert.notEqual(idA, idB);
    });

    test('snapshot_id is stable when nested object key insertion order differs', () => {
      const candidateA = makeCandidate();
      const candidateB = makeCandidate({
        sourceUnit: {
          generatedAt: candidateA.sourceUnit.generatedAt,
          byteRange: {
            end: candidateA.sourceUnit.byteRange.end,
            start: candidateA.sourceUnit.byteRange.start,
          },
          filePath: candidateA.sourceUnit.filePath,
        } as DistilledKnowledgeCandidate['sourceUnit'],
        provenance: [
          {
            unitByteRange: { end: 1000, start: 0 },
            role: 'problem-action',
            turn: 1,
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
          } as CapabilityProvenanceRef,
          {
            unitByteRange: { end: 1000, start: 0 },
            role: 'verification',
            turn: 2,
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
          } as CapabilityProvenanceRef,
        ],
      });
      const reviewA = makePromoteReviewFor(candidateA);
      const reviewB = makePromoteReviewFor(candidateB);

      const idA = computeSnapshotId(candidateA, resolveEffectiveFields(candidateA, null), reviewA);
      const idB = computeSnapshotId(candidateB, resolveEffectiveFields(candidateB, null), reviewB);

      assert.equal(idA, idB);
    });

    test('a Faithful Rewrite changes the rendered content and snapshot_id', () => {
      const candidate = makeCandidate({ title: 'Capability: Parse  JSONL' });
      const reviewNoRewrite = makePromoteReview({ rewrite: null });
      const reviewWithRewrite = makePromoteReview({
        rewrite: { title: 'Capability: Parse JSONL' },
      });

      const mdNoRewrite = renderDistilledSkillMarkdown(candidate, reviewNoRewrite);
      const mdWithRewrite = renderDistilledSkillMarkdown(candidate, reviewWithRewrite);

      assert.notEqual(mdNoRewrite, mdWithRewrite);
      assert.match(mdWithRewrite, /Capability: Parse JSONL/);
    });

    test('frontmatter safely escapes YAML control characters', () => {
      const candidate = makeCandidate({
        title: 'Capability: Parse\nJSONL\tlogs',
        sourceUnit: {
          filePath: '/logs/sessions/chat/session\nwith-tab\t.jsonl',
          byteRange: { start: 0, end: 1000 },
          generatedAt: '2026-07-10T00:00:00.000Z',
        },
      });
      const review = makePromoteReviewFor(candidate, {
        rationale: 'Line one\r\nLine two\tTabbed',
      });
      const markdown = renderDistilledSkillMarkdown(candidate, review);
      const parsed = matter(markdown);

      assert.equal(parsed.data.source_file_path, '/logs/sessions/chat/session\nwith-tab\t.jsonl');
      assert.equal(parsed.data.review_rationale, 'Line one\r\nLine two\tTabbed');
      assert.match(parsed.data.description, /^Distilled capability\. When:/);
      assert.match(parsed.data.description, /Do:/);
    });
  });

  // -------------------------------------------------------------------------
  // Skill parser compatibility
  // -------------------------------------------------------------------------

  describe('skill parser compatibility', () => {
    test('generated SKILL.md is parseable by SkillParser', () => {
      const dir = makeTempDir();
      try {
        const result = installPromotedCandidate(
          makeCandidate(),
          makePromoteReview(),
          dir,
        );
        assert.ok(result.newlyCreated);

        const skill = SkillParser.parse(result.filePath);
        assert.ok(skill.metadata.name);
        assert.ok(skill.metadata.description);
        assert.equal(skill.metadata.userInvocable, true);
        assert.equal(skill.filePath, result.filePath);
        assert.ok(skill.content.length > 0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('parsed skill name matches the generated frontmatter name', () => {
      const dir = makeTempDir();
      try {
        const result = installPromotedCandidate(
          makeCandidate(),
          makePromoteReview(),
          dir,
        );
        const skill = SkillParser.parse(result.filePath);
        assert.equal(skill.metadata.name, result.skillName);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('parsed skill description is a routable distilled capability summary', () => {
      const dir = makeTempDir();
      try {
        const result = installPromotedCandidate(
          makeCandidate(),
          makePromoteReview(),
          dir,
        );
        const skill = SkillParser.parse(result.filePath);
        assert.match(skill.metadata.description, /^Distilled capability\. When:/);
        assert.match(skill.metadata.description, /Do:/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('parsed skill content includes the Traceability Contract and Provenance Refs', () => {
      const dir = makeTempDir();
      try {
        const result = installPromotedCandidate(
          makeCandidate(),
          makePromoteReview(),
          dir,
        );
        const skill = SkillParser.parse(result.filePath);
        assert.match(skill.content, /## Traceability Contract/);
        assert.match(skill.content, /## Provenance Refs/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // Provenance preservation
  // -------------------------------------------------------------------------

  describe('provenance preservation', () => {
    test('provenance refs appear in the rendered Markdown', () => {
      const candidate = makeCandidate({
        provenance: [
          {
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
            turn: 5,
            role: 'problem-action',
            unitByteRange: { start: 100, end: 500 },
          },
          {
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
            turn: 6,
            role: 'verification',
            unitByteRange: { start: 100, end: 500 },
          },
        ],
      });
      const markdown = renderDistilledSkillMarkdown(candidate, makePromoteReview());

      assert.match(markdown, /turn 5 \(problem-action\)/);
      assert.match(markdown, /turn 6 \(verification\)/);
      assert.match(markdown, /100\u2013500/);
    });

    test('provenance refs are preserved after install and parse', () => {
      const dir = makeTempDir();
      try {
        const candidate = makeCandidate({
          provenance: [
            {
              filePath: '/logs/sessions/chat/chat_cli.jsonl',
              turn: 10,
              role: 'problem-action',
              unitByteRange: { start: 2048, end: 4096 },
            },
            {
              filePath: '/logs/sessions/chat/chat_cli.jsonl',
              turn: 11,
              role: 'verification',
              unitByteRange: { start: 2048, end: 4096 },
            },
          ],
        });
        const result = installPromotedCandidate(candidate, makePromoteReview(), dir);
        const skill = SkillParser.parse(result.filePath);

        assert.match(skill.content, /turn 10/);
        assert.match(skill.content, /turn 11/);
        assert.match(skill.content, /2048\u20134096/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('source runtime metadata is preserved in the frontmatter', () => {
      const candidate = makeCandidate({
        sourceUnit: {
          filePath: '/logs/sessions/chat/session_xyz.jsonl',
          byteRange: { start: 512, end: 1024 },
          generatedAt: '2026-05-01T08:00:00.000Z',
        },
      });
      const markdown = renderDistilledSkillMarkdown(candidate, makePromoteReview());
      const parsed = matter(markdown);

      assert.equal(parsed.data.source_file_path, '/logs/sessions/chat/session_xyz.jsonl');
      assert.equal(parsed.data.source_byte_range_start, 512);
      assert.equal(parsed.data.source_byte_range_end, 1024);
      assert.equal(parsed.data.source_unit_generated_at, '2026-05-01T08:00:00.000Z');
    });

    test('raw solved-loop evidence text is not embedded in the skill body', () => {
      const candidate = makeCandidate({
        solvedLoop: {
          problem: 'A very specific problem text that should not appear in the body.',
          action: 'A very specific action text that should not appear in the body.',
          verification: 'A very specific verification that should not appear in the body.',
          noCorrection: 'A noCorrection note that should not appear in the body.',
        },
      });
      const markdown = renderDistilledSkillMarkdown(candidate, makePromoteReview());

      // The structured evidence fields should not appear verbatim in the body.
      // Only structured refs and the applicability/actionPattern (which are
      // distilled summaries, not raw evidence) should appear.
      assert.doesNotMatch(markdown, /A very specific verification that should not appear in the body\./);
      assert.doesNotMatch(markdown, /A noCorrection note that should not appear in the body\./);
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot immutability
  // -------------------------------------------------------------------------

  describe('snapshot immutability', () => {
    test('installing the same promoted candidate twice does not overwrite the first snapshot', () => {
      const dir = makeTempDir();
      try {
        const candidate = makeCandidate();
        const review = makePromoteReview();

        const first = installPromotedCandidate(candidate, review, dir);
        assert.equal(first.newlyCreated, true);

        // Capture the original file content.
        const originalContent = fs.readFileSync(first.filePath, 'utf-8');

        const second = installPromotedCandidate(candidate, review, dir);
        assert.equal(second.newlyCreated, false);
        assert.equal(second.snapshotId, first.snapshotId);
        assert.equal(second.filePath, first.filePath);

        // The file was not overwritten.
        const currentContent = fs.readFileSync(second.filePath, 'utf-8');
        assert.equal(currentContent, originalContent);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('different snapshots coexist without overwriting each other', () => {
      const dir = makeTempDir();
      try {
        const candidateA = makeCandidate({ capabilityId: 'cap-aaa' });
        const candidateB = makeCandidate({ capabilityId: 'cap-bbb' });

        const resultA = installPromotedCandidate(candidateA, makePromoteReviewFor(candidateA), dir);
        const resultB = installPromotedCandidate(candidateB, makePromoteReviewFor(candidateB), dir);

        assert.notEqual(resultA.snapshotId, resultB.snapshotId);
        assert.notEqual(resultA.filePath, resultB.filePath);
        assert.ok(fs.existsSync(resultA.filePath));
        assert.ok(fs.existsSync(resultB.filePath));

        // Both files contain their own capability_id.
        const contentA = fs.readFileSync(resultA.filePath, 'utf-8');
        const contentB = fs.readFileSync(resultB.filePath, 'utf-8');
        assert.match(contentA, /cap-aaa/);
        assert.match(contentB, /cap-bbb/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('a candidate with a different title produces a different snapshot and both are preserved', () => {
      const dir = makeTempDir();
      try {
        const candidateA = makeCandidate({ title: 'Capability: Original title' });
        const reviewA = makePromoteReview();
        const resultA = installPromotedCandidate(candidateA, reviewA, dir);

        // Same capabilityId but different content → different snapshot.
        const candidateB = makeCandidate({ title: 'Capability: Revised title' });
        const reviewB = makePromoteReview();
        const resultB = installPromotedCandidate(candidateB, reviewB, dir);

        assert.equal(resultA.capabilityId, resultB.capabilityId);
        assert.notEqual(resultA.snapshotId, resultB.snapshotId);
        assert.ok(fs.existsSync(resultA.filePath));
        assert.ok(fs.existsSync(resultB.filePath));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('the snapshot file path follows the generated-distilled/<capabilityId>/<snapshotId>/SKILL.md layout', () => {
      const dir = makeTempDir();
      try {
        const candidate = makeCandidate({ capabilityId: 'cap-test123' });
        const result = installPromotedCandidate(candidate, makePromoteReviewFor(candidate), dir);

        assert.ok(result.filePath.includes('cap-test123'));
        assert.ok(result.filePath.includes(result.snapshotId));
        assert.ok(result.filePath.endsWith('SKILL.md'));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // Non-promote rejection
  // -------------------------------------------------------------------------

  describe('non-promote rejection', () => {
    test('throws when the review decision is needs_review', () => {
      const dir = makeTempDir();
      try {
        const candidate = makeCandidate();
        const review = makePromoteReview({ decision: 'needs_review' });
        assert.throws(
          () => installPromotedCandidate(candidate, review, dir),
          /expected one of promote, new_capability, supersede_snapshot/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('throws when the review decision is reject', () => {
      const dir = makeTempDir();
      try {
        const candidate = makeCandidate();
        const review = makePromoteReview({ decision: 'reject' });
        assert.throws(
          () => installPromotedCandidate(candidate, review, dir),
          /expected one of promote, new_capability, supersede_snapshot/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('renderDistilledSkillMarkdown throws for non-promote decisions', () => {
      assert.throws(
        () => renderDistilledSkillMarkdown(makeCandidate(), makePromoteReview({ decision: 'reject' })),
        /expected one of promote, new_capability, supersede_snapshot/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  describe('input validation', () => {
    test('throws when review capabilityId does not match the candidate', () => {
      const dir = makeTempDir();
      try {
        const candidate = makeCandidate({ capabilityId: 'cap-candidate' });
        const review = makePromoteReview({ capabilityId: 'cap-review' });

        assert.throws(
          () => installPromotedCandidate(candidate, review, dir),
          /does not match candidate capabilityId/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('rejects unsafe capability_id values before writing files', () => {
      const dir = makeTempDir();
      const outsidePath = path.join(dir, 'outside');
      try {
        const candidate = makeCandidate({ capabilityId: '../outside' });
        const review = makePromoteReviewFor(candidate);

        assert.throws(
          () => installPromotedCandidate(candidate, review, dir),
          /safe path segment/,
        );
        assert.equal(fs.existsSync(outsidePath), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end with the real reviewer
  // -------------------------------------------------------------------------

  describe('end-to-end with buildPromotionPacket and reviewPromotionPacket', () => {
    test('a distiller candidate reviewed as promote installs successfully', () => {
      const dir = makeTempDir();
      try {
        const candidate = makeCandidate();
        const packet = buildPromotionPacket(candidate);
        const review = reviewPromotionPacket(packet);

        assert.equal(review.decision, 'promote');

        const result = installPromotedCandidate(candidate, review, dir);
        assert.equal(result.newlyCreated, true);
        assert.ok(fs.existsSync(result.filePath));

        const skill = SkillParser.parse(result.filePath);
        assert.ok(skill.metadata.name);
        assert.match(skill.metadata.description, /^Distilled capability\. When:/);
        assert.match(skill.metadata.description, /Do:/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('re-running the full pipeline for the same candidate is idempotent', () => {
      const dir = makeTempDir();
      try {
        const candidate = makeCandidate();
        const packet = buildPromotionPacket(candidate);
        const review = reviewPromotionPacket(packet);

        const first = installPromotedCandidate(candidate, review, dir);
        assert.equal(first.newlyCreated, true);

        const second = installPromotedCandidate(candidate, review, dir);
        assert.equal(second.newlyCreated, false);
        assert.equal(second.filePath, first.filePath);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
