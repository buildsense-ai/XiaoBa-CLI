import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  buildPromotionPacket,
  FaithfulRewrite,
  PromotionDecision,
  PromotionPacket,
  PromotionReviewResult,
  reviewPromotionPacket,
} from '../src/utils/promotion-reviewer';
import {
  CapabilityProvenanceRef,
  DistilledKnowledgeCandidate,
  SolvedLoopEvidence,
} from '../src/utils/capability-distiller';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Promotion Reviewer', () => {
  // -------------------------------------------------------------------------
  // Promotion Packet construction
  // -------------------------------------------------------------------------

  describe('buildPromotionPacket', () => {
    test('builds a packet from a capability candidate with all required fields', () => {
      const candidate = makeCandidate();
      const packet = buildPromotionPacket(candidate);

      assert.equal(packet.schemaVersion, 1);
      assert.strictEqual(packet.candidate, candidate);
      assert.deepEqual(packet.solvedLoopEvidence, candidate.solvedLoop);
      assert.deepEqual(packet.provenance, candidate.provenance);
      assert.ok(Array.isArray(packet.reviewRisks));
      assert.ok(['promote', 'needs_review', 'reject'].includes(packet.recommendation));
    });

    test('builds a packet with supplied evidence, provenance, and reviewer risks', () => {
      const candidate = makeCandidate();
      const solvedLoopEvidence = {
        ...candidate.solvedLoop,
        verification: 'Verified by a later acceptance turn.',
      };
      const provenance = [
        {
          filePath: '/logs/sessions/chat/alternate.jsonl',
          turn: 10,
          role: 'problem-action' as const,
          unitByteRange: { start: 25, end: 400 },
        },
        {
          filePath: '/logs/sessions/chat/alternate.jsonl',
          turn: 11,
          role: 'verification' as const,
          unitByteRange: { start: 401, end: 600 },
        },
      ];
      const reviewRisks = [
        {
          label: 'reviewer-note',
          detail: 'Needs attention if reused outside JSONL parsing.',
        },
      ];

      const packet = buildPromotionPacket(candidate, {
        solvedLoopEvidence,
        provenance,
        reviewRisks,
      });

      assert.deepEqual(packet.solvedLoopEvidence, solvedLoopEvidence);
      assert.deepEqual(packet.provenance, provenance);
      assert.deepEqual(packet.reviewRisks, reviewRisks);
      assert.equal(packet.recommendation, 'promote');
    });

    test('packet recommendation is reject when candidate has no provenance', () => {
      const candidate = makeCandidate({ provenance: [] });
      const packet = buildPromotionPacket(candidate);
      assert.equal(packet.recommendation, 'reject');
    });

    test('packet recommendation is reject when solved-loop evidence is incomplete', () => {
      const candidate = makeCandidate({
        solvedLoop: {
          problem: '',
          action: 'Used tools [read_file].',
          verification: 'Thanks!',
          noCorrection: 'No correction.',
        },
      });
      const packet = buildPromotionPacket(candidate);
      assert.equal(packet.recommendation, 'reject');
    });

    test('packet recommendation is promote when candidate is well-formed', () => {
      const candidate = makeCandidate();
      const packet = buildPromotionPacket(candidate);
      assert.equal(packet.recommendation, 'promote');
    });
  });

  // -------------------------------------------------------------------------
  // Promote decision
  // -------------------------------------------------------------------------

  describe('promote decision', () => {
    test('returns promote when all checks pass', () => {
      const candidate = makeCandidate();
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.schemaVersion, 1);
      assert.equal(result.decision, 'promote');
      assert.equal(result.capabilityId, candidate.capabilityId);
      assert.ok(result.rationale);
      assert.ok(result.rationale.length > 0);
      assert.ok(result.reviewedAt);
    });

    test('promote result does not write SKILL.md (structured output only)', () => {
      const candidate = makeCandidate();
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      const json = JSON.stringify(result);
      assert.equal(json.includes('SKILL.md'), false);
      assert.equal(json.includes('---'), false); // no YAML front matter
      assert.equal(json.includes('```'), false); // no code fences
    });

    test('promote result has no unsupported claims', () => {
      const candidate = makeCandidate();
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'promote');
      const unsupportedRisks = result.reviewRisks.filter(r =>
        r.label.startsWith('unsupported-'),
      );
      assert.equal(unsupportedRisks.length, 0);
    });

    test('promote result may include faithful rewrite for whitespace normalization', () => {
      const candidate = makeCandidate({
        title: 'Capability: How do I parse  a  JSONL file',
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'promote');
      assert.ok(result.rewrite);
      assert.ok(result.rewrite!.title);
      assert.equal(result.rewrite!.title, 'Capability: How do I parse a JSONL file');
    });
  });

  // -------------------------------------------------------------------------
  // Reject decision
  // -------------------------------------------------------------------------

  describe('reject decision', () => {
    test('rejects when solved-loop evidence is incomplete (empty problem)', () => {
      const candidate = makeCandidate({
        solvedLoop: {
          problem: '',
          action: 'Used tools [read_file].',
          verification: 'Thanks!',
          noCorrection: 'No correction.',
        },
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'reject');
      assert.ok(result.rationale.includes('incomplete'));
    });

    test('rejects when solved-loop evidence is incomplete (empty verification)', () => {
      const candidate = makeCandidate({
        solvedLoop: {
          problem: 'How do I parse JSONL?',
          action: 'Used tools [read_file].',
          verification: '',
          noCorrection: 'No correction.',
        },
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'reject');
    });

    test('rejects when solved-loop evidence is incomplete (empty noCorrection)', () => {
      const candidate = makeCandidate({
        solvedLoop: {
          problem: 'How do I parse JSONL?',
          action: 'Used tools [read_file].',
          verification: 'Thanks!',
          noCorrection: '',
        },
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'reject');
    });

    test('rejects when provenance is empty', () => {
      const candidate = makeCandidate({ provenance: [] });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'reject');
      assert.ok(result.rationale.includes('empty') || result.rationale.includes('Provenance'));
    });
  });

  // -------------------------------------------------------------------------
  // Needs-review decision
  // -------------------------------------------------------------------------

  describe('needs_review decision', () => {
    test('downgrades to needs_review when action pattern claims a tool not in evidence', () => {
      const candidate = makeCandidate({
        actionPattern: 'Use tool(s) [read_file, grep, edit_file] then respond.',
        solvedLoop: makeSolvedLoop(),
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'needs_review');
      const toolRisks = result.reviewRisks.filter(r => r.label === 'unsupported-tool-claim');
      assert.ok(toolRisks.length >= 2);
      assert.ok(toolRisks.some(r => r.detail.includes('edit_file')));
    });

    test('downgrades to needs_review when later bracketed tool claims are unsupported', () => {
      const candidate = makeCandidate({
        actionPattern: 'Use [read_file] to inspect context, then use [edit_file] to patch.',
        solvedLoop: makeSolvedLoop(),
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'needs_review');
      const toolRisk = result.reviewRisks.find(r =>
        r.label === 'unsupported-tool-claim' && r.detail.includes('edit_file'),
      );
      assert.ok(toolRisk);
    });

    test('downgrades to needs_review when provenance has only one ref', () => {
      const candidate = makeCandidate({
        provenance: [
          {
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
            turn: 1,
            role: 'problem-action',
            unitByteRange: { start: 0, end: 1000 },
          },
        ],
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'needs_review');
      const provRisk = result.reviewRisks.find(r => r.label === 'insufficient-provenance');
      assert.ok(provRisk);
    });

    test('downgrades to needs_review when provenance is missing verification role', () => {
      const candidate = makeCandidate({
        provenance: [
          {
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
            turn: 1,
            role: 'problem-action',
            unitByteRange: { start: 0, end: 1000 },
          },
          {
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
            turn: 2,
            role: 'problem-action',
            unitByteRange: { start: 1001, end: 2000 },
          },
        ],
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'needs_review');
      assert.ok(result.reviewRisks.find(r => r.label === 'missing-verification-ref'));
    });

    test('rejects malformed provenance instead of promoting with a risk', () => {
      const candidate = makeCandidate({
        provenance: [
          {
            filePath: '',
            turn: 1,
            role: 'problem-action',
            unitByteRange: { start: 0, end: 1000 },
          },
          {
            filePath: '/logs/sessions/chat/chat_cli.jsonl',
            turn: 2,
            role: 'verification',
            unitByteRange: { start: 1000, end: 900 },
          },
        ],
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'reject');
      assert.ok(result.reviewRisks.find(r => r.label === 'missing-file-path'));
      assert.ok(result.reviewRisks.find(r => r.label === 'invalid-byte-range'));
    });

    test('downgrades to needs_review when applicability has no overlap with problem', () => {
      const candidate = makeCandidate({
        applicability: 'Applies when the user raises a similar problem to: database migration',
        solvedLoop: makeSolvedLoop(),
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.decision, 'needs_review');
      const applicRisk = result.reviewRisks.find(r => r.label === 'unsupported-applicability');
      assert.ok(applicRisk);
    });
  });

  // -------------------------------------------------------------------------
  // Faithful Rewrite
  // -------------------------------------------------------------------------

  describe('faithful rewrite', () => {
    test('rewrites title by normalizing whitespace without adding claims', () => {
      const candidate = makeCandidate({
        title: 'Capability: How do I   parse  a JSONL file',
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.ok(result.rewrite);
      assert.equal(result.rewrite!.title, 'Capability: How do I parse a JSONL file');
    });

    test('rewrites boundaries by removing empty entries', () => {
      const candidate = makeCandidate({
        boundaries: [
          'Only applies when the new situation matches.',
          '',
          'Do not apply when the user is still correcting.',
        ],
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.ok(result.rewrite);
      assert.ok(result.rewrite!.boundaries);
      assert.equal(result.rewrite!.boundaries!.length, 2);
      assert.equal(result.rewrite!.boundaries!.includes(''), false);
    });

    test('rewrites risks by normalizing whitespace in each entry', () => {
      const candidate = makeCandidate({
        risks: [
          'Distilled  from  a single solved loop; the pattern may not generalize.',
          'Apply the Promotion Reviewer before installing.',
        ],
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.ok(result.rewrite);
      assert.ok(result.rewrite!.risks);
      assert.equal(result.rewrite!.risks![0], 'Distilled from a single solved loop; the pattern may not generalize.');
    });

    test('trims overlong title to max length with ellipsis', () => {
      const longTitle = 'Capability: ' + 'A'.repeat(150);
      const candidate = makeCandidate({ title: longTitle });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.ok(result.rewrite);
      assert.ok(result.rewrite!.title);
      assert.ok(result.rewrite!.title!.endsWith('...'));
      assert.ok(result.rewrite!.title!.length <= 103); // 100 + '...'
    });

    test('returns null rewrite when no fields need improvement', () => {
      const candidate = makeCandidate({
        title: 'Capability: Parse JSONL in Node',
        applicability: 'Applies when the user raises a similar problem to: Parse JSONL in Node',
        actionPattern: 'Use tool(s) [read_file] then respond.',
        boundaries: ['Boundary one.', 'Boundary two.'],
        risks: ['Risk one.', 'Risk two.'],
      });
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.rewrite, null);
    });

    test('faithful rewrite does not add new capability claims', () => {
      const candidate = makeCandidate();
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      if (result.rewrite?.actionPattern) {
        // The rewritten action pattern should not contain tools that weren't
        // in the original.
        const originalTools = extractBracketItems(candidate.actionPattern);
        const rewrittenTools = extractBracketItems(result.rewrite.actionPattern);
        for (const tool of rewrittenTools) {
          assert.ok(
            originalTools.includes(tool),
            `Rewrite introduced a new tool not in the original: ${tool}`,
          );
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Structured output (no SKILL.md)
  // -------------------------------------------------------------------------

  describe('structured output', () => {
    test('review result is JSON-serializable structured data', () => {
      const candidate = makeCandidate();
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      const json = JSON.stringify(result);
      const reparsed = JSON.parse(json) as PromotionReviewResult;
      assert.equal(reparsed.schemaVersion, 1);
      assert.ok(['promote', 'needs_review', 'reject'].includes(reparsed.decision));
      assert.ok(reparsed.capabilityId);
      assert.ok(reparsed.rationale);
      assert.ok(reparsed.reviewedAt);
    });

    test('review result includes capabilityId for traceability', () => {
      const candidate = makeCandidate();
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.equal(result.capabilityId, candidate.capabilityId);
    });
  });

  // -------------------------------------------------------------------------
  // Reviewer is separate from distiller
  // -------------------------------------------------------------------------

  describe('reviewer separation from distiller', () => {
    test('reviewer consumes a candidate produced by the distiller without calling the distiller', () => {
      // The reviewer only needs the candidate; it does not import or call
      // distillCapabilityCandidates.
      const candidate = makeCandidate();
      const packet = buildPromotionPacket(candidate);
      const result = reviewPromotionPacket(packet);

      assert.ok(result);
      assert.ok(result.decision);
    });
  });
});

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function extractBracketItems(text: string): string[] {
  const match = text.match(/\[([^\]]+)\]/);
  if (!match) return [];
  return match[1].split(',').map(s => s.trim()).filter(Boolean);
}
