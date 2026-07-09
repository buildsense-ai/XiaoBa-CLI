import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DistillationUnit,
  MAX_CONTINUITY_TURNS,
  extractDistillationUnit,
  processSessionLog,
  processSessionLogDirectory,
} from '../src/utils/distillation-unit';
import {
  loadLogCursorState,
  saveLogCursorState,
  getCursor,
} from '../src/utils/log-cursor-state';
import { SessionTurnLogEntry } from '../src/utils/session-log-schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(turn: number, session_id: string, session_type: string): SessionTurnLogEntry {
  return {
    entry_type: 'turn',
    turn,
    timestamp: new Date(2026, 0, 1, 0, 0, 0, turn * 1000).toISOString(),
    session_id,
    session_type,
    user: { text: `user input ${turn}` },
    assistant: { text: `assistant reply ${turn}`, tool_calls: [] },
    tokens: { prompt: 10, completion: 20 },
  };
}

function makeRuntimeEntry(session_id: string, session_type: string) {
  return {
    entry_type: 'runtime',
    timestamp: new Date().toISOString(),
    session_id,
    session_type,
    level: 'info',
    message: 'runtime event',
  };
}

function writeLog(filePath: string, entries: object[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function appendLog(filePath: string, entries: object[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filePath, content, 'utf-8');
}

function setup(): { root: string; logFile: string; stateFile: string; teardown: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-log-cursor-'));
  const logFile = path.join(root, 'logs', 'sessions', 'chat', '2026-07-08', 'chat_cli.jsonl');
  const stateFile = path.join(root, 'data', 'log-cursor-state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  return {
    root,
    logFile,
    stateFile,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Log Cursor based Distillation Unit extraction', () => {
  describe('initial extraction', () => {
    test('produces a Distillation Unit with all turns when cursor starts at zero', () => {
      const env = setup();
      try {
        const turns = [
          makeTurn(1, 'cli', 'chat'),
          makeTurn(2, 'cli', 'chat'),
          makeTurn(3, 'cli', 'chat'),
        ];
        writeLog(env.logFile, turns);

        const state = loadLogCursorState(env.stateFile);
        const cursor = getCursor(state, env.logFile);
        assert.equal(cursor.byteOffset, 0);
        assert.equal(cursor.status, 'pending');

        const result = extractDistillationUnit(env.logFile, cursor);

        assert.ok(result.distillationUnit);
        assert.equal(result.distillationUnit!.newTurns.length, 3);
        // No prior turns → empty continuity context
        assert.equal(result.distillationUnit!.continuityTurns.length, 0);
        assert.equal(result.advanced, true);
        assert.equal(result.newCursor.byteOffset, fs.statSync(env.logFile).size);
        assert.equal(result.newCursor.processedTurnCount, 3);
        assert.equal(result.newCursor.status, 'completed');
      } finally {
        env.teardown();
      }
    });

    test('includes non-turn entries in file but only advances past them without a DU when no turns exist', () => {
      const env = setup();
      try {
        writeLog(env.logFile, [
          makeRuntimeEntry('cli', 'chat'),
          makeRuntimeEntry('cli', 'chat'),
        ]);

        const state = loadLogCursorState(env.stateFile);
        const cursor = getCursor(state, env.logFile);
        const result = extractDistillationUnit(env.logFile, cursor);

        assert.equal(result.distillationUnit, null);
        assert.equal(result.advanced, true);
        assert.equal(result.newCursor.processedTurnCount, 0);
      } finally {
        env.teardown();
      }
    });
  });

  describe('append processing', () => {
    test('produces a DU with only newly appended turns and continuity context from prior turns', () => {
      const env = setup();
      try {
        const initialTurns = [
          makeTurn(1, 'cli', 'chat'),
          makeTurn(2, 'cli', 'chat'),
        ];
        writeLog(env.logFile, initialTurns);

        // First extraction
        const state1 = loadLogCursorState(env.stateFile);
        const cursor1 = getCursor(state1, env.logFile);
        const result1 = extractDistillationUnit(env.logFile, cursor1);
        assert.ok(result1.distillationUnit);
        assert.equal(result1.distillationUnit!.newTurns.length, 2);

        // Save cursor (simulates successful processing)
        state1.cursors[env.logFile] = result1.newCursor;
        saveLogCursorState(env.stateFile, state1);

        // Append new turns
        const appendedTurns = [
          makeTurn(3, 'cli', 'chat'),
          makeTurn(4, 'cli', 'chat'),
        ];
        appendLog(env.logFile, appendedTurns);

        // Second extraction
        const state2 = loadLogCursorState(env.stateFile);
        const cursor2 = getCursor(state2, env.logFile);
        const result2 = extractDistillationUnit(env.logFile, cursor2);

        assert.ok(result2.distillationUnit);
        // Only the newly appended turns
        assert.equal(result2.distillationUnit!.newTurns.length, 2);
        assert.equal(result2.distillationUnit!.newTurns[0].turn, 3);
        assert.equal(result2.distillationUnit!.newTurns[1].turn, 4);
        // Continuity context from prior turns (up to 10)
        assert.equal(result2.distillationUnit!.continuityTurns.length, 2);
        assert.equal(result2.distillationUnit!.continuityTurns[0].turn, 1);
        assert.equal(result2.distillationUnit!.continuityTurns[1].turn, 2);
        assert.equal(result2.newCursor.processedTurnCount, 4);
      } finally {
        env.teardown();
      }
    });
  });

  describe('idempotent re-run', () => {
    test('produces no duplicate Distillation Unit when no new turns are appended', () => {
      const env = setup();
      try {
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat'), makeTurn(2, 'cli', 'chat')]);

        // First extraction
        const state1 = loadLogCursorState(env.stateFile);
        const cursor1 = getCursor(state1, env.logFile);
        const result1 = extractDistillationUnit(env.logFile, cursor1);
        assert.ok(result1.distillationUnit);
        state1.cursors[env.logFile] = result1.newCursor;
        saveLogCursorState(env.stateFile, state1);

        // Re-run without changes
        const state2 = loadLogCursorState(env.stateFile);
        const cursor2 = getCursor(state2, env.logFile);
        const result2 = extractDistillationUnit(env.logFile, cursor2);

        assert.equal(result2.distillationUnit, null);
        assert.equal(result2.advanced, false);
        assert.equal(result2.newCursor.byteOffset, cursor2.byteOffset);
      } finally {
        env.teardown();
      }
    });

    test('processSessionLog does not invoke processor on re-run without new content', () => {
      const env = setup();
      try {
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat')]);

        let processorCalls = 0;
        processSessionLog(env.logFile, env.stateFile, () => {
          processorCalls++;
        });
        assert.equal(processorCalls, 1);

        // Re-run — no new content
        processSessionLog(env.logFile, env.stateFile, () => {
          processorCalls++;
        });
        assert.equal(processorCalls, 1); // still 1
      } finally {
        env.teardown();
      }
    });
  });

  describe('continuity context selection', () => {
    test('includes at most ten prior completed turns as continuity context', () => {
      const env = setup();
      try {
        // Write 15 turns initially
        const initialTurns = Array.from({ length: 15 }, (_, i) => makeTurn(i + 1, 'cli', 'chat'));
        writeLog(env.logFile, initialTurns);

        // First extraction processes all 15 turns
        const state1 = loadLogCursorState(env.stateFile);
        const cursor1 = getCursor(state1, env.logFile);
        const result1 = extractDistillationUnit(env.logFile, cursor1);
        assert.ok(result1.distillationUnit);
        assert.equal(result1.distillationUnit!.newTurns.length, 15);
        assert.equal(result1.distillationUnit!.continuityTurns.length, 0);
        state1.cursors[env.logFile] = result1.newCursor;
        saveLogCursorState(env.stateFile, state1);

        // Append 1 new turn
        appendLog(env.logFile, [makeTurn(16, 'cli', 'chat')]);

        // Second extraction — continuity should be last 10 of the 15 prior turns
        const state2 = loadLogCursorState(env.stateFile);
        const cursor2 = getCursor(state2, env.logFile);
        const result2 = extractDistillationUnit(env.logFile, cursor2);

        assert.ok(result2.distillationUnit);
        assert.equal(result2.distillationUnit!.newTurns.length, 1);
        assert.equal(result2.distillationUnit!.newTurns[0].turn, 16);
        assert.equal(result2.distillationUnit!.continuityTurns.length, MAX_CONTINUITY_TURNS);
        // The continuity turns should be turns 6–15 (last 10 of the first 15)
        assert.equal(result2.distillationUnit!.continuityTurns[0].turn, 6);
        assert.equal(result2.distillationUnit!.continuityTurns[9].turn, 15);
      } finally {
        env.teardown();
      }
    });

    test('continuity context includes fewer than ten when fewer prior turns exist', () => {
      const env = setup();
      try {
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat'), makeTurn(2, 'cli', 'chat')]);

        const state1 = loadLogCursorState(env.stateFile);
        const cursor1 = getCursor(state1, env.logFile);
        const result1 = extractDistillationUnit(env.logFile, cursor1);
        state1.cursors[env.logFile] = result1.newCursor;
        saveLogCursorState(env.stateFile, state1);

        appendLog(env.logFile, [makeTurn(3, 'cli', 'chat')]);

        const state2 = loadLogCursorState(env.stateFile);
        const cursor2 = getCursor(state2, env.logFile);
        const result2 = extractDistillationUnit(env.logFile, cursor2);

        assert.ok(result2.distillationUnit);
        assert.equal(result2.distillationUnit!.continuityTurns.length, 2);
        assert.equal(result2.distillationUnit!.continuityTurns[0].turn, 1);
        assert.equal(result2.distillationUnit!.continuityTurns[1].turn, 2);
      } finally {
        env.teardown();
      }
    });
  });

  describe('durable cursor advancement', () => {
    test('cursor byte offset persists across runs and does not depend on date alone', () => {
      const env = setup();
      try {
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat'), makeTurn(2, 'cli', 'chat')]);

        // First extraction
        processSessionLog(env.logFile, env.stateFile, () => {});

        // Verify persisted cursor
        const state = loadLogCursorState(env.stateFile);
        const cursor = getCursor(state, env.logFile);
        assert.equal(cursor.byteOffset, fs.statSync(env.logFile).size);
        assert.equal(cursor.processedTurnCount, 2);
        assert.equal(cursor.status, 'completed');
        assert.ok(cursor.updatedAt);

        // Re-run — no new content, cursor unchanged
        processSessionLog(env.logFile, env.stateFile, () => {});
        const state2 = loadLogCursorState(env.stateFile);
        const cursor2 = getCursor(state2, env.logFile);
        assert.equal(cursor2.byteOffset, cursor.byteOffset);
        assert.equal(cursor2.processedTurnCount, 2);
      } finally {
        env.teardown();
      }
    });
  });

  describe('failed processing retry', () => {
    test('leaves retryable state without losing original evidence', () => {
      const env = setup();
      try {
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat'), makeTurn(2, 'cli', 'chat')]);

        let callCount = 0;
        // First attempt — processor fails
        processSessionLog(env.logFile, env.stateFile, () => {
          callCount++;
          throw new Error('simulated processing failure');
        });

        assert.equal(callCount, 1);

        // Cursor should be marked failed but retain original byte offset (0)
        const state = loadLogCursorState(env.stateFile);
        const cursor = getCursor(state, env.logFile);
        assert.equal(cursor.status, 'failed');
        assert.equal(cursor.byteOffset, 0); // not advanced — retryable
        assert.ok(cursor.lastError?.includes('simulated processing failure'));

        // Original log file is untouched (evidence preserved)
        const fileContent = fs.readFileSync(env.logFile, 'utf-8');
        assert.ok(fileContent.includes('user input 1'));
        assert.ok(fileContent.includes('user input 2'));

        // Retry — processor succeeds this time
        processSessionLog(env.logFile, env.stateFile, () => {
          callCount++;
        });

        assert.equal(callCount, 2);

        // Cursor now advanced
        const state2 = loadLogCursorState(env.stateFile);
        const cursor2 = getCursor(state2, env.logFile);
        assert.equal(cursor2.status, 'completed');
        assert.equal(cursor2.byteOffset, fs.statSync(env.logFile).size);
        assert.equal(cursor2.processedTurnCount, 2);

        // Third run — no new content, no DU
        let callCount3 = 0;
        processSessionLog(env.logFile, env.stateFile, () => {
          callCount3++;
        });
        assert.equal(callCount3, 0);
      } finally {
        env.teardown();
      }
    });

    test('directory processing reports only successfully processed units', () => {
      const env = setup();
      try {
        const secondLogFile = path.join(path.dirname(env.logFile), 'chat_other.jsonl');
        writeLog(env.logFile, [makeTurn(1, 'cli', 'chat')]);
        writeLog(secondLogFile, [makeTurn(1, 'other', 'chat')]);

        const result = processSessionLogDirectory(
          path.join(env.root, 'logs'),
          env.stateFile,
          unit => {
            if (unit.filePath === env.logFile) {
              throw new Error('simulated directory failure');
            }
          },
        );

        assert.equal(result.units.length, 1);
        assert.equal(result.units[0].filePath, secondLogFile);
        assert.equal(result.advancedFiles, 1);

        const state = loadLogCursorState(env.stateFile);
        const failedCursor = getCursor(state, env.logFile);
        const completedCursor = getCursor(state, secondLogFile);
        assert.equal(failedCursor.status, 'failed');
        assert.equal(failedCursor.byteOffset, 0);
        assert.equal(completedCursor.status, 'completed');
        assert.equal(completedCursor.byteOffset, fs.statSync(secondLogFile).size);
      } finally {
        env.teardown();
      }
    });

    test('malformed complete lines leave retryable state without advancing the cursor', () => {
      const env = setup();
      try {
        fs.mkdirSync(path.dirname(env.logFile), { recursive: true });
        fs.writeFileSync(env.logFile, '{"entry_type":"turn"\n', 'utf-8');

        const result = processSessionLog(env.logFile, env.stateFile, () => {
          throw new Error('processor should not run');
        });

        assert.equal(result.distillationUnit, null);
        assert.equal(result.advanced, false);
        assert.equal(result.processed, false);

        const state = loadLogCursorState(env.stateFile);
        const cursor = getCursor(state, env.logFile);
        assert.equal(cursor.status, 'failed');
        assert.equal(cursor.byteOffset, 0);
        assert.ok(cursor.lastError?.includes('Expected'));
      } finally {
        env.teardown();
      }
    });
  });

  describe('partial line handling', () => {
    test('does not advance past an incomplete trailing line', () => {
      const env = setup();
      try {
        // Write file with a complete turn, then an incomplete line (no trailing \n)
        const completeLine = JSON.stringify(makeTurn(1, 'cli', 'chat')) + '\n';
        const incompleteLine = JSON.stringify(makeTurn(2, 'cli', 'chat')); // no \n
        fs.mkdirSync(path.dirname(env.logFile), { recursive: true });
        fs.writeFileSync(env.logFile, completeLine + incompleteLine, 'utf-8');

        const state = loadLogCursorState(env.stateFile);
        const cursor = getCursor(state, env.logFile);
        const result = extractDistillationUnit(env.logFile, cursor);

        // Should produce a DU with only the first turn (complete line)
        assert.ok(result.distillationUnit);
        assert.equal(result.distillationUnit!.newTurns.length, 1);
        assert.equal(result.distillationUnit!.newTurns[0].turn, 1);

        // Cursor should advance only past the complete line, not the incomplete one
        assert.equal(result.newCursor.byteOffset, completeLine.length);

        // Re-run — the incomplete line is still there, but now we treat it as
        // new content. Since it has no trailing \n, it's still incomplete.
        // No new complete line → no DU, cursor doesn't advance further.
        const state2 = loadLogCursorState(env.stateFile);
        state2.cursors[env.logFile] = result.newCursor;
        saveLogCursorState(env.stateFile, state2);

        const state3 = loadLogCursorState(env.stateFile);
        const cursor3 = getCursor(state3, env.logFile);
        const result3 = extractDistillationUnit(env.logFile, cursor3);
        assert.equal(result3.distillationUnit, null);
        assert.equal(result3.advanced, false);
      } finally {
        env.teardown();
      }
    });
  });

  describe('corrupt state recovery', () => {
    test('quarantines corrupt state file and starts fresh', () => {
      const env = setup();
      try {
        fs.writeFileSync(env.stateFile, '{not json', 'utf-8');

        const state = loadLogCursorState(env.stateFile);
        assert.equal(state.stateCorrupt, true);
        assert.equal(Object.keys(state.cursors).length, 0);
        // Original corrupt file moved aside
        assert.equal(fs.existsSync(env.stateFile), false);
        assert.ok(
          fs.readdirSync(path.dirname(env.stateFile)).some(name =>
            name.includes('.corrupt.'),
          ),
        );
      } finally {
        env.teardown();
      }
    });
  });

  describe('legacy turn entries', () => {
    test('handles legacy entries without entry_type field', () => {
      const env = setup();
      try {
        const legacyTurn = {
          // No entry_type field — legacy format
          turn: 1,
          timestamp: new Date().toISOString(),
          session_id: 'cli',
          session_type: 'chat',
          user: { text: 'legacy user' },
          assistant: { text: 'legacy assistant', tool_calls: [] },
          tokens: { prompt: 5, completion: 10 },
        };
        writeLog(env.logFile, [legacyTurn]);

        const state = loadLogCursorState(env.stateFile);
        const cursor = getCursor(state, env.logFile);
        const result = extractDistillationUnit(env.logFile, cursor);

        assert.ok(result.distillationUnit);
        assert.equal(result.distillationUnit!.newTurns.length, 1);
        assert.equal(result.newCursor.processedTurnCount, 1);
      } finally {
        env.teardown();
      }
    });
  });
});
