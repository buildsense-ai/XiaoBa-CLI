import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  DistilledKnowledgeCandidate,
  distillCapabilityCandidates,
} from '../src/utils/capability-distiller';
import { DistillationUnit } from '../src/utils/distillation-unit';
import { SessionToolCallLog, SessionTurnLogEntry } from '../src/utils/session-log-schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCall(id: string, name: string, result = 'ok'): SessionToolCallLog {
  return { id, name, arguments: {}, result, duration_ms: 10 };
}

function makeTurn(
  turn: number,
  userText: string,
  assistantText: string,
  toolCalls: SessionToolCallLog[] = [],
): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(2026, 0, 1, 0, 0, 0, turn * 1000).toISOString(),
    session_id: 'cli',
    session_type: 'chat',
    user: { text: userText },
    assistant: { text: assistantText, tool_calls: toolCalls },
    tokens: { prompt: 10, completion: 20 },
  };
}

function makeUnit(
  newTurns: SessionTurnLogEntry[],
  opts: { filePath?: string; start?: number; end?: number; continuityTurns?: SessionTurnLogEntry[] } = {},
): DistillationUnit {
  return {
    filePath: opts.filePath ?? '/logs/sessions/chat/chat_cli.jsonl',
    newTurns,
    continuityTurns: opts.continuityTurns ?? [],
    byteRange: { start: opts.start ?? 0, end: opts.end ?? 1000 },
    generatedAt: '2026-07-10T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Capability Candidate Distiller', () => {
  describe('candidate emission from a solved loop', () => {
    test('emits a kind=capability candidate when a problem turn is followed by positive acceptance', () => {
      const unit = makeUnit([
        makeTurn(
          1,
          'How do I parse a JSONL file in Node without loading everything into memory?',
          'You can use readline and process line by line.',
          [makeToolCall('t1', 'read_file')],
        ),
        makeTurn(2, 'Thanks, that works perfectly!', 'Glad it helped.'),
      ]);

      const candidates = distillCapabilityCandidates(unit);

      assert.equal(candidates.length, 1);
      const candidate = candidates[0];
      assert.equal(candidate.schemaVersion, 1);
      assert.equal(candidate.kind, 'capability');
      assert.ok(candidate.capabilityId.startsWith('cap-'));
      assert.ok(candidate.capabilityId.length > 'cap-'.length);
      assert.ok(candidate.title);
      assert.ok(candidate.applicability);
      assert.ok(candidate.actionPattern);
      assert.ok(candidate.boundaries.length >= 1);
      assert.ok(candidate.risks.length >= 1);
      assert.ok(candidate.solvedLoop.problem);
      assert.ok(candidate.solvedLoop.action);
      assert.ok(candidate.solvedLoop.verification);
      assert.ok(candidate.solvedLoop.noCorrection);
      assert.ok(candidate.generatedAt);
      assert.equal(candidate.sourceUnit.filePath, unit.filePath);
      assert.deepEqual(candidate.sourceUnit.byteRange, unit.byteRange);
    });

    test('candidate action pattern references the tools used in the problem turn', () => {
      const unit = makeUnit([
        makeTurn(
          1,
          'How do I read the tail of a growing log file?',
          'Stream it from the last offset.',
          [makeToolCall('t1', 'read_file'), makeToolCall('t2', 'grep')],
        ),
        makeTurn(2, 'Great, that solved it for me.', 'Happy to help.'),
      ]);

      const candidates = distillCapabilityCandidates(unit);
      assert.equal(candidates.length, 1);
      assert.ok(candidates[0].actionPattern.includes('read_file'));
      assert.ok(candidates[0].actionPattern.includes('grep'));
    });

    test('candidate capabilityId is stable for the same source unit and problem turn', () => {
      const unit = makeUnit([
        makeTurn(1, 'How do I fix the flaky test in suite A?', 'Run with --retry.', [
          makeToolCall('t1', 'run_tests'),
        ]),
        makeTurn(2, 'Thanks, works now.', 'Good.'),
      ]);

      const a = distillCapabilityCandidates(unit);
      const b = distillCapabilityCandidates(unit);
      assert.equal(a[0].capabilityId, b[0].capabilityId);
    });

    test('emits one candidate per solved loop when multiple new loops exist in a unit', () => {
      const unit = makeUnit([
        makeTurn(1, 'How do I parse JSONL in Node?', 'Use readline.', [makeToolCall('t1', 'read_file')]),
        makeTurn(2, 'Thanks, that works!', 'Great.'),
        makeTurn(3, 'Now how do I dedupe the parsed rows?', 'Use a Set.', [makeToolCall('t2', 'run_script')]),
        makeTurn(4, 'Perfect, that fixed it.', 'Good.'),
      ]);

      const candidates = distillCapabilityCandidates(unit);
      assert.equal(candidates.length, 2);
      assert.notEqual(candidates[0].capabilityId, candidates[1].capabilityId);
    });

    test('emits when a continuity problem turn is closed by newly appended acceptance', () => {
      const continuityTurns = [
        makeTurn(
          1,
          'How do I extract only appended session log turns?',
          'Track a durable cursor and read from the previous byte offset.',
          [makeToolCall('t1', 'read_file')],
        ),
      ];
      const unit = makeUnit(
        [
          makeTurn(2, 'Thanks, that works for the append-only log path.', 'Good.'),
        ],
        { continuityTurns },
      );

      const candidates = distillCapabilityCandidates(unit);

      assert.equal(candidates.length, 1);
      assert.deepEqual(
        candidates[0].provenance.map(r => r.turn),
        [1, 2],
      );
    });
  });

  describe('no-candidate cases', () => {
    test('does not emit for ambiguous unfinished work (single new turn with no follow-up)', () => {
      const unit = makeUnit([
        makeTurn(1, 'How do I debug this hanging process?', 'Try strace.', [makeToolCall('t1', 'run_shell')]),
      ]);

      assert.deepEqual(distillCapabilityCandidates(unit), []);
    });

    test('does not emit when the verification turn contains an immediate correction', () => {
      const unit = makeUnit([
        makeTurn(1, 'How do I fix the failing build?', 'Run npm rebuild.', [makeToolCall('t1', 'run_shell')]),
        makeTurn(2, "No, that didn't work, still failing.", 'Sorry, let me try again.'),
      ]);

      assert.deepEqual(distillCapabilityCandidates(unit), []);
    });

    test('does not emit when the verification turn has no positive acceptance', () => {
      const unit = makeUnit([
        makeTurn(1, 'How do I fix the failing build?', 'Run npm rebuild.', [makeToolCall('t1', 'run_shell')]),
        makeTurn(2, 'What about the linker error then?', 'Let me check.'),
      ]);

      assert.deepEqual(distillCapabilityCandidates(unit), []);
    });

    test('does not treat marker substrings as positive acceptance', () => {
      const unit = makeUnit([
        makeTurn(1, 'How do I configure the network adapter?', 'Open the adapter settings.', [
          makeToolCall('t1', 'read_file'),
        ]),
        makeTurn(2, 'The networking stack changed after that.', 'Let me inspect it.'),
      ]);

      assert.deepEqual(distillCapabilityCandidates(unit), []);
    });

    test('does not emit for unsupported raw summaries (trivial user text, no action)', () => {
      const unit = makeUnit([
        makeTurn(1, 'hi', ''), // trivial problem, no assistant action
        makeTurn(2, 'thanks', 'ok'),
      ]);

      assert.deepEqual(distillCapabilityCandidates(unit), []);
    });

    test('does not emit when the problem turn has a problem but the assistant took no action', () => {
      const unit = makeUnit([
        makeTurn(1, 'How do I fix the failing build?', ''), // no tool calls, no text
        makeTurn(2, 'Thanks, that works!', 'Good.'),
      ]);

      assert.deepEqual(distillCapabilityCandidates(unit), []);
    });

    test('does not re-emit candidates for solved loops entirely within continuity turns', () => {
      const continuity = [
        makeTurn(1, 'How do I parse JSONL?', 'Use readline.', [makeToolCall('t1', 'read_file')]),
        makeTurn(2, 'Thanks, works!', 'Good.'),
      ];
      // New turn is unrelated chatter; the solved loop lives only in continuity.
      const unit = makeUnit([makeTurn(3, 'ok', 'ok')], { continuityTurns: continuity });

      assert.deepEqual(distillCapabilityCandidates(unit), []);
    });
  });

  describe('provenance preservation', () => {
    test('provenance refs point back to source turns and the source unit byte range', () => {
      const unit = makeUnit(
        [
          makeTurn(5, 'How do I tail a growing log?', 'Stream from offset.', [makeToolCall('t1', 'read_file')]),
          makeTurn(6, 'Thanks, that works!', 'Great.'),
        ],
        { start: 4096, end: 8192 },
      );

      const candidates = distillCapabilityCandidates(unit);
      assert.equal(candidates.length, 1);
      const refs = candidates[0].provenance;
      assert.equal(refs.length, 2);

      const problemRef = refs.find(r => r.role === 'problem-action');
      const verificationRef = refs.find(r => r.role === 'verification');
      assert.ok(problemRef);
      assert.ok(verificationRef);
      assert.equal(problemRef!.filePath, unit.filePath);
      assert.equal(problemRef!.turn, 5);
      assert.equal(verificationRef!.turn, 6);
      assert.deepEqual(problemRef!.unitByteRange, unit.byteRange);
      assert.deepEqual(verificationRef!.unitByteRange, unit.byteRange);
    });

    test('provenance refs are preserved across multiple candidates in the same unit', () => {
      const unit = makeUnit([
        makeTurn(10, 'How do I parse JSONL?', 'Use readline.', [makeToolCall('t1', 'read_file')]),
        makeTurn(11, 'Thanks, that works!', 'Great.'),
        makeTurn(12, 'How do I dedupe rows?', 'Use a Set.', [makeToolCall('t2', 'run_script')]),
        makeTurn(13, 'Perfect, fixed it.', 'Good.'),
      ]);

      const candidates = distillCapabilityCandidates(unit);
      assert.equal(candidates.length, 2);
      assert.deepEqual(
        candidates[0].provenance.map(r => r.turn),
        [10, 11],
      );
      assert.deepEqual(
        candidates[1].provenance.map(r => r.turn),
        [12, 13],
      );
    });
  });

  describe('structured output (no Markdown)', () => {
    test('candidate fields are plain structured data with no markdown formatting', () => {
      const unit = makeUnit([
        makeTurn(1, 'How do I parse JSONL in Node?', 'Use readline.', [makeToolCall('t1', 'read_file')]),
        makeTurn(2, 'Thanks, that works!', 'Great.'),
      ]);

      const candidates = distillCapabilityCandidates(unit);
      assert.equal(candidates.length, 1);
      const candidate = candidates[0];

      const json = JSON.stringify(candidate);
      // No markdown emphasis, headers, lists, or code fences.
      assert.equal(json.includes('**'), false);
      assert.equal(json.includes('##'), false);
      assert.equal(json.includes('```'), false);
      assert.equal(json.includes('- '), false);
      assert.equal(json.includes('# '), false);

      // Round-trips through JSON as structured data.
      const reparsed = JSON.parse(json) as DistilledKnowledgeCandidate;
      assert.equal(reparsed.kind, 'capability');
      assert.equal(reparsed.schemaVersion, 1);
      assert.ok(Array.isArray(reparsed.boundaries));
      assert.ok(Array.isArray(reparsed.risks));
      assert.ok(Array.isArray(reparsed.provenance));
    });

    test('candidate is JSON-serializable and suitable for Promotion Reviewer input', () => {
      const unit = makeUnit([
        makeTurn(1, 'How do I parse JSONL in Node?', 'Use readline.', [makeToolCall('t1', 'read_file')]),
        makeTurn(2, 'Thanks, that works!', 'Great.'),
      ]);

      const candidates = distillCapabilityCandidates(unit);
      // No throw means every field is plain JSON-compatible data.
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(candidates)));
    });
  });

  describe('schema extensibility', () => {
    test('the kind field is typed to capability only in the first version', () => {
      const unit = makeUnit([
        makeTurn(1, 'How do I parse JSONL in Node?', 'Use readline.', [makeToolCall('t1', 'read_file')]),
        makeTurn(2, 'Thanks, that works!', 'Great.'),
      ]);

      const candidates = distillCapabilityCandidates(unit);
      for (const candidate of candidates) {
        assert.equal(candidate.kind, 'capability');
      }
    });

    test('emits zero candidates for an empty Distillation Unit', () => {
      const unit = makeUnit([]);
      assert.deepEqual(distillCapabilityCandidates(unit), []);
    });
  });
});
