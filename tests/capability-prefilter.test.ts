import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  emptyCapabilityRegistryState,
  makeEvidenceRef,
  newCapability,
  CapabilityRegistryState,
} from '../src/utils/capability-registry';
import {
  prefilterCapabilities,
  CapabilityPrefilterResult,
  tokenizeText,
} from '../src/utils/capability-prefilter';
import { DistilledKnowledgeCandidate } from '../src/utils/capability-distiller';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_PROVENANCE = [
  {
    filePath: '/logs/sessions/chat/chat_cli.jsonl',
    turn: 1,
    role: 'problem-action' as const,
    unitByteRange: { start: 0, end: 1000 },
  },
  {
    filePath: '/logs/sessions/chat/chat_cli.jsonl',
    turn: 2,
    role: 'verification' as const,
    unitByteRange: { start: 0, end: 1000 },
  },
];

function makeCandidate(overrides: Partial<DistilledKnowledgeCandidate> = {}): DistilledKnowledgeCandidate {
  return {
    schemaVersion: 1 as const,
    kind: 'capability' as const,
    capabilityId: 'cap-jsonl-readline',
    title: 'Capability: parse JSONL in Node',
    applicability: 'Applies when the user raises a similar problem to: parse a JSONL file',
    actionPattern: 'Use tools [read_file] then apply this pattern: process line by line with readline',
    boundaries: ['Only applies when the file is JSONL.', 'Do not apply to binary files.'],
    risks: ['Distilled from a single solved loop.'],
    solvedLoop: {
      problem: 'How do I parse a JSONL file in Node without loading everything into memory?',
      action: 'Use readline and process line by line.',
      verification: 'Thanks, that works perfectly!',
      noCorrection: 'Verification turn contained positive acceptance.',
    },
    provenance: BASE_PROVENANCE,
    generatedAt: '2026-07-10T00:00:00.000Z',
    sourceUnit: {
      filePath: '/logs/sessions/chat/chat_cli.jsonl',
      byteRange: { start: 0, end: 1000 },
      generatedAt: '2026-07-10T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makeRegistryEntry(
  state: CapabilityRegistryState,
  overrides: {
    capabilityId: string;
    activeSnapshotId: string;
    routingDescription: string;
    createdAt?: string;
    evidenceSourcePath?: string;
  },
): void {
  newCapability(state, {
    capabilityId: overrides.capabilityId,
    activeSnapshotId: overrides.activeSnapshotId,
    routingDescription: overrides.routingDescription,
    evidenceRefs: [
      makeEvidenceRef(
        overrides.evidenceSourcePath ?? '/logs/sessions/chat/chat_cli.jsonl',
        1,
        { start: 0, end: 1000 },
        '2026-07-10T00:00:00.000Z',
      ),
    ],
    relatedSnapshotIds: [overrides.activeSnapshotId],
    createdAt: overrides.createdAt ?? '2026-07-10T01:00:00.000Z',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Capability Prefilter (issue #18)', () => {
  describe('tokenization', () => {
    test('tokenizeText produces lowercase alphanumeric tokens', () => {
      const tokens = tokenizeText('Parse JSONL with readline, process parse JSONL.');
      assert.ok(tokens.has('parse'));
      assert.ok(tokens.has('jsonl'));
      assert.ok(tokens.has('readline'));
      assert.ok(tokens.has('process'));
      assert.equal(tokens.has('JSONL'), false);
    });

    test('tokenizeText ignores single-character tokens', () => {
      const tokens = tokenizeText('a b c jsonl');
      assert.equal(tokens.has('a'), false);
      assert.equal(tokens.has('b'), false);
      assert.equal(tokens.has('c'), false);
      assert.ok(tokens.has('jsonl'));
    });
  });

  describe('obvious match', () => {
    test('exact capabilityId match returns score 100 and is ranked first', () => {
      const registry = emptyCapabilityRegistryState();
      makeRegistryEntry(registry, {
        capabilityId: 'cap-jsonl-readline',
        activeSnapshotId: 'snap-aaaa1111bbbb2222',
        routingDescription:
          'Distilled capability. When: parse a JSONL file. Do: use readline and process line by line.',
      });
      makeRegistryEntry(registry, {
        capabilityId: 'cap-read-large-file',
        activeSnapshotId: 'snap-cccc3333dddd4444',
        routingDescription:
          'Distilled capability. When: read a large file. Do: stream in chunks.',
      });

      const candidate = makeCandidate();
      const result = prefilterCapabilities(candidate, registry, { limit: 5 });

      assert.equal(result.candidateCapabilityId, candidate.capabilityId);
      assert.equal(result.totalRegistryCapabilities, 2);
      assert.equal(result.matches.length, 2);
      assert.equal(result.matches[0].capabilityId, 'cap-jsonl-readline');
      assert.equal(result.matches[0].score, 100);
      assert.equal(result.matches[1].capabilityId, 'cap-read-large-file');
      assert.ok(result.matches[1].score < 100);
    });
  });

  describe('near duplicate', () => {
    test('similar routing and action text returns a high score below 100', () => {
      const registry = emptyCapabilityRegistryState();
      makeRegistryEntry(registry, {
        capabilityId: 'cap-process-jsonl-stream',
        activeSnapshotId: 'snap-1111222233334444',
        routingDescription:
          'Distilled capability. When: process a JSONL stream. Do: read each line and parse JSON.',
      });
      makeRegistryEntry(registry, {
        capabilityId: 'cap-tail-log-file',
        activeSnapshotId: 'snap-5555666677778888',
        routingDescription:
          'Distilled capability. When: tail a growing log file. Do: stream from the last offset.',
      });

      const candidate = makeCandidate({
        capabilityId: 'cap-new-jsonl-readline',
        title: 'Capability: read JSONL line by line',
      });
      const result = prefilterCapabilities(candidate, registry, { limit: 5 });

      assert.equal(result.matches.length, 2);
      assert.equal(result.matches[0].capabilityId, 'cap-process-jsonl-stream');
      assert.ok(
        result.matches[0].score >= 20 && result.matches[0].score < 100,
        `expected near-duplicate score in [20,100), got ${result.matches[0].score}`,
      );
      assert.equal(result.matches[1].capabilityId, 'cap-tail-log-file');
      assert.ok(
        result.matches[1].score > 0 && result.matches[1].score < result.matches[0].score,
        'expected log-tail entry to score lower than the JSONL near-duplicate',
      );
    });

    test('shared evidence source path adds a small bonus to the score', () => {
      const registry = emptyCapabilityRegistryState();
      makeRegistryEntry(registry, {
        capabilityId: 'cap-shared-source',
        activeSnapshotId: 'snap-shared-source',
        routingDescription:
          'Distilled capability. When: archive old log files. Do: compress and move to cold storage.',
        evidenceSourcePath: '/logs/sessions/chat/chat_cli.jsonl',
      });

      const candidate = makeCandidate({
        capabilityId: 'cap-unrelated-jsonl',
      });
      const result = prefilterCapabilities(candidate, registry, { limit: 5 });

      assert.equal(result.matches.length, 1);
      // Text overlap is low but shared evidence source adds +10.
      assert.ok(
        result.matches[0].score >= 10,
        `expected shared-source bonus to push score >= 10, got ${result.matches[0].score}`,
      );
    });
  });

  describe('unrelated candidate', () => {
    test('a candidate unrelated to every registry entry returns an empty match list', () => {
      const registry = emptyCapabilityRegistryState();
      makeRegistryEntry(registry, {
        capabilityId: 'cap-read-large-file',
        activeSnapshotId: 'snap-cccc3333dddd4444',
        routingDescription:
          'Distilled capability. When: read a large file. Do: stream in chunks.',
        evidenceSourcePath: '/logs/sessions/chat/file_cli.jsonl',
      });
      makeRegistryEntry(registry, {
        capabilityId: 'cap-tail-log-file',
        activeSnapshotId: 'snap-5555666677778888',
        routingDescription:
          'Distilled capability. When: tail a growing log file. Do: stream from the last offset.',
        evidenceSourcePath: '/logs/sessions/chat/tail_cli.jsonl',
      });

      const candidate = makeCandidate({
        capabilityId: 'cap-database-backup',
        title: 'Capability: backup a PostgreSQL database',
        applicability: 'Applies when the user asks to backup a PostgreSQL database',
        actionPattern: 'Apply this response pattern: use pg_dump and verify the dump',
        boundaries: ['Only applies to PostgreSQL databases.'],
        solvedLoop: {
          problem: 'How do I backup my PostgreSQL database?',
          action: 'Use pg_dump with custom format.',
          verification: 'Perfect, the backup worked.',
          noCorrection: 'Verification turn contained positive acceptance.',
        },
      });
      const result = prefilterCapabilities(candidate, registry, { limit: 5 });

      assert.equal(result.totalRegistryCapabilities, 2);
      assert.equal(result.matches.length, 0);
    });
  });

  describe('bounded top-N', () => {
    test('returns at most limit matches even when more capabilities overlap', () => {
      const registry = emptyCapabilityRegistryState();
      for (let i = 0; i < 10; i++) {
        makeRegistryEntry(registry, {
          capabilityId: `cap-jsonl-${i}`,
          activeSnapshotId: `snap-jsonl-${i}`,
          routingDescription:
            'Distilled capability. When: parse a JSONL file. Do: use readline and process line by line.',
        });
      }

      const candidate = makeCandidate();
      const result = prefilterCapabilities(candidate, registry, { limit: 3 });

      assert.equal(result.limit, 3);
      assert.equal(result.matches.length, 3);
      // All are tied on score, so stable ordering uses capabilityId ascending.
      const ids = result.matches.map(m => m.capabilityId);
      assert.deepEqual(ids, ids.slice().sort());
    });

    test('limit is normalized to a sensible default when invalid', () => {
      const registry = emptyCapabilityRegistryState();
      makeRegistryEntry(registry, {
        capabilityId: 'cap-jsonl-0',
        activeSnapshotId: 'snap-jsonl-0',
        routingDescription:
          'Distilled capability. When: parse a JSONL file. Do: use readline and process line by line.',
      });

      const candidate = makeCandidate();
      const result = prefilterCapabilities(candidate, registry, { limit: -1 });
      assert.equal(result.limit, 5);
    });
  });

  describe('stable tie-breaking', () => {
    test('ties are broken by capabilityId ascending regardless of insertion order', () => {
      const registry = emptyCapabilityRegistryState();
      const ids = ['cap-zebra', 'cap-apple', 'cap-mango'];
      for (const id of ids) {
        makeRegistryEntry(registry, {
          capabilityId: id,
          activeSnapshotId: `snap-${id}`,
          routingDescription:
            'Distilled capability. When: parse a JSONL file. Do: use readline.',
        });
      }

      const candidate = makeCandidate();
      const result = prefilterCapabilities(candidate, registry, { limit: 5 });

      assert.equal(result.matches.length, 3);
      const returnedIds = result.matches.map(m => m.capabilityId);
      assert.deepEqual(returnedIds, ['cap-apple', 'cap-mango', 'cap-zebra']);
    });

    test('higher scores always outrank lower scores before tie-breaking', () => {
      const registry = emptyCapabilityRegistryState();
      makeRegistryEntry(registry, {
        capabilityId: 'cap-apple-low',
        activeSnapshotId: 'snap-apple-low',
        routingDescription:
          'Distilled capability. When: parse a JSONL file. Do: use readline.',
      });
      makeRegistryEntry(registry, {
        capabilityId: 'cap-zebra-high',
        activeSnapshotId: 'snap-zebra-high',
        routingDescription:
          'Distilled capability. When: parse JSONL files with readline. Do: process line by line and validate.',
      });

      const candidate = makeCandidate();
      const result = prefilterCapabilities(candidate, registry, { limit: 5 });

      assert.equal(result.matches.length, 2);
      assert.equal(result.matches[0].capabilityId, 'cap-zebra-high');
      assert.equal(result.matches[1].capabilityId, 'cap-apple-low');
      assert.ok(result.matches[0].score > result.matches[1].score);
    });
  });

  describe('output summary data', () => {
    test('each match includes enough identity and summary data for a reviewer branch', () => {
      const registry = emptyCapabilityRegistryState();
      makeRegistryEntry(registry, {
        capabilityId: 'cap-jsonl-readline',
        activeSnapshotId: 'snap-aaaa1111bbbb2222',
        routingDescription:
          'Distilled capability. When: parse a JSONL file. Do: use readline and process line by line.',
      });

      const candidate = makeCandidate();
      const result = prefilterCapabilities(candidate, registry, { limit: 5 });

      assert.equal(result.matches.length, 1);
      const match = result.matches[0];
      assert.equal(match.capabilityId, 'cap-jsonl-readline');
      assert.equal(match.activeSnapshotId, 'snap-aaaa1111bbbb2222');
      assert.equal(match.status, 'active');
      assert.ok(match.routingDescription);
      assert.equal(match.evidenceCount, 1);
      assert.equal(match.relatedSnapshotCount, 1);
      assert.ok(match.createdAt);
      assert.ok(match.updatedAt);
      assert.equal(typeof match.score, 'number');
    });

    test('prefilter does not mutate the registry', () => {
      const registry = emptyCapabilityRegistryState();
      makeRegistryEntry(registry, {
        capabilityId: 'cap-jsonl-readline',
        activeSnapshotId: 'snap-aaaa1111bbbb2222',
        routingDescription:
          'Distilled capability. When: parse a JSONL file. Do: use readline and process line by line.',
      });

      const before = Object.keys(registry.capabilities);
      const candidate = makeCandidate();
      prefilterCapabilities(candidate, registry, { limit: 5 });

      const after = Object.keys(registry.capabilities);
      assert.deepEqual(after, before);
    });
  });

  describe('minScore filtering', () => {
    test('minScore can include zero-score entries when set to 0', () => {
      const registry = emptyCapabilityRegistryState();
      makeRegistryEntry(registry, {
        capabilityId: 'cap-unrelated',
        activeSnapshotId: 'snap-unrelated',
        routingDescription:
          'Distilled capability. When: configure a network adapter. Do: open adapter settings.',
        evidenceSourcePath: '/logs/sessions/chat/network_cli.jsonl',
      });

      const candidate = makeCandidate();
      const result = prefilterCapabilities(candidate, registry, {
        limit: 5,
        minScore: 0,
      });

      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].score, 0);
    });

    test('default minScore excludes zero-score entries', () => {
      const registry = emptyCapabilityRegistryState();
      makeRegistryEntry(registry, {
        capabilityId: 'cap-unrelated',
        activeSnapshotId: 'snap-unrelated',
        routingDescription:
          'Distilled capability. When: configure a network adapter. Do: open adapter settings.',
        evidenceSourcePath: '/logs/sessions/chat/network_cli.jsonl',
      });

      const candidate = makeCandidate();
      const result = prefilterCapabilities(candidate, registry, { limit: 5 });

      assert.equal(result.matches.length, 0);
    });
  });
});
