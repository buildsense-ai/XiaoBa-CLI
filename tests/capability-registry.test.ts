import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendEvidence,
  AppendEvidenceInput,
  CapabilityRegistryEntry,
  CapabilityRegistryState,
  computeEvidenceId,
  emptyCapabilityRegistryState,
  getCapability,
  loadCapabilityRegistry,
  makeEvidenceRef,
  NewCapabilityInput,
  newCapability,
  saveCapabilityRegistry,
  supersedeSnapshot,
  SupersedeSnapshotInput,
} from '../src/utils/capability-registry';

// ---------------------------------------------------------------------------
// Test environment helpers
// ---------------------------------------------------------------------------

/**
 * Create a controlled runtime data root with a registry state file path,
 * mirroring the log-cursor / distillation-pipeline test setup pattern.
 */
function setup(): {
  root: string;
  stateFile: string;
  teardown: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-capability-registry-'));
  const stateFile = path.join(root, 'data', 'capability-registry-state.json');
  return {
    root,
    stateFile,
    teardown: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function makeEvidenceRefs(
  sourceFilePath: string,
  turns: number[],
  appendedAt: string,
) {
  return turns.map(turn =>
    makeEvidenceRef(sourceFilePath, turn, { start: 0, end: 1000 }, appendedAt),
  );
}

function makeNewCapabilityInput(
  overrides: Partial<NewCapabilityInput> = {},
): NewCapabilityInput {
  return {
    capabilityId: 'cap-parse-jsonl',
    activeSnapshotId: 'snap-aaaa1111bbbb2222',
    routingDescription:
      'Distilled capability. When: parse a JSONL file. Do: use readline and process line by line.',
    evidenceRefs: makeEvidenceRefs(
      '/logs/sessions/chat/chat_cli.jsonl',
      [1, 2],
      '2026-07-10T00:00:00.000Z',
    ),
    relatedSnapshotIds: ['snap-aaaa1111bbbb2222'],
    createdAt: '2026-07-10T01:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Capability Registry (issue #16)', () => {
  // -------------------------------------------------------------------------
  // Create and load an independent state file
  // -------------------------------------------------------------------------

  describe('create and load an independent state file', () => {
    test('loading a non-existent state file returns an empty registry', () => {
      const env = setup();
      try {
        const state = loadCapabilityRegistry(env.stateFile);
        assert.deepEqual(state.capabilities, {});
        assert.equal(state.schemaVersion, 1);
        assert.equal(state.stateCorrupt, undefined);
      } finally {
        env.teardown();
      }
    });

    test('a runtime data root can create and reload a registry state file', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        saveCapabilityRegistry(env.stateFile, state);

        assert.ok(fs.existsSync(env.stateFile));

        const reloaded = loadCapabilityRegistry(env.stateFile);
        assert.equal(Object.keys(reloaded.capabilities).length, 1);
        const entry = getCapability(reloaded, 'cap-parse-jsonl');
        assert.ok(entry);
        assert.equal(entry!.activeSnapshotId, 'snap-aaaa1111bbbb2222');
        assert.equal(entry!.status, 'active');
      } finally {
        env.teardown();
      }
    });

    test('loading a parseable state sanitizes malformed entry fields', () => {
      const env = setup();
      try {
        const goodRef = makeEvidenceRef(
          '/logs/sessions/chat/chat_cli.jsonl',
          1,
          { start: 0, end: 1000 },
          '2026-07-10T00:00:00.000Z',
        );
        fs.mkdirSync(path.dirname(env.stateFile), { recursive: true });
        fs.writeFileSync(
          env.stateFile,
          JSON.stringify({
            schemaVersion: 1,
            capabilities: {
              'cap-parse-jsonl': {
                capabilityId: 'cap-parse-jsonl',
                activeSnapshotId: 'snap-aaaa1111bbbb2222',
                status: 'not-a-real-status',
                routingDescription: 42,
                evidenceRefs: [
                  goodRef,
                  goodRef,
                  { evidenceId: 'broken-ref' },
                ],
                relatedSnapshotIds: [
                  'snap-aaaa1111bbbb2222',
                  'snap-aaaa1111bbbb2222',
                  99,
                ],
                createdAt: false,
                updatedAt: '2026-07-10T01:00:00.000Z',
                sourceReview: { decision: 'promote' },
              },
            },
          }),
          'utf-8',
        );

        const reloaded = loadCapabilityRegistry(env.stateFile);
        const entry = getCapability(reloaded, 'cap-parse-jsonl')!;
        assert.equal(entry.status, 'active');
        assert.equal(entry.routingDescription, '');
        assert.deepEqual(entry.evidenceRefs, [goodRef]);
        assert.deepEqual(entry.relatedSnapshotIds, ['snap-aaaa1111bbbb2222']);
        assert.equal(entry.createdAt, '');
        assert.equal(entry.updatedAt, '2026-07-10T01:00:00.000Z');
        assert.equal(entry.sourceReview, undefined);
      } finally {
        env.teardown();
      }
    });

    test('the registry state file lives under the runtime data root and is independent from skills', () => {
      const env = setup();
      try {
        // Simulate an installed snapshot directory existing alongside the registry.
        const skillsDir = path.join(env.root, 'skills', 'generated-distilled');
        const snapshotFile = path.join(skillsDir, 'cap-x', 'snap-y', 'SKILL.md');
        fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
        fs.writeFileSync(snapshotFile, '# fake snapshot');

        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        saveCapabilityRegistry(env.stateFile, state);

        // The registry state file must not have touched the skills tree.
        assert.ok(fs.existsSync(env.stateFile));
        assert.ok(fs.existsSync(path.join(skillsDir, 'cap-x', 'snap-y', 'SKILL.md')));
      } finally {
        env.teardown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Atomic writes
  // -------------------------------------------------------------------------

  describe('atomic writes do not leave partial JSON state', () => {
    test('a saved state file is valid JSON after a normal write', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        saveCapabilityRegistry(env.stateFile, state);

        const raw = fs.readFileSync(env.stateFile, 'utf-8');
        const parsed = JSON.parse(raw);
        assert.equal(parsed.schemaVersion, 1);
        assert.ok(parsed.capabilities['cap-parse-jsonl']);
      } finally {
        env.teardown();
      }
    });

    test('no stale temp files remain after a successful write', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        saveCapabilityRegistry(env.stateFile, state);

        const dir = path.dirname(env.stateFile);
        const entries = fs.readdirSync(dir);
        const tmpFiles = entries.filter(f => f.endsWith('.tmp'));
        assert.equal(tmpFiles.length, 0);
      } finally {
        env.teardown();
      }
    });

    test('repeated saves replace the state file atomically without corruption', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());

        // Save, then append evidence and save again.
        saveCapabilityRegistry(env.stateFile, state);
        appendEvidence(state, {
          capabilityId: 'cap-parse-jsonl',
          evidenceRefs: makeEvidenceRefs(
            '/logs/sessions/chat/chat_cli.jsonl',
            [5],
            '2026-07-11T00:00:00.000Z',
          ),
          appendedAt: '2026-07-11T00:00:00.000Z',
        });
        saveCapabilityRegistry(env.stateFile, state);

        const reloaded = loadCapabilityRegistry(env.stateFile);
        const entry = getCapability(reloaded, 'cap-parse-jsonl');
        assert.equal(entry!.evidenceRefs.length, 3);
      } finally {
        env.teardown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Corrupt state quarantine
  // -------------------------------------------------------------------------

  describe('corrupt state is quarantined without destroying snapshots or audit logs', () => {
    test('a corrupt state file is quarantined and an empty registry is returned', () => {
      const env = setup();
      try {
        fs.mkdirSync(path.dirname(env.stateFile), { recursive: true });
        fs.writeFileSync(env.stateFile, '{ this is not valid json ', 'utf-8');

        const state = loadCapabilityRegistry(env.stateFile);
        assert.equal(state.stateCorrupt, true);
        assert.deepEqual(state.capabilities, {});

        // The corrupt file was quarantined, not deleted.
        const dir = path.dirname(env.stateFile);
        const quarantined = fs
          .readdirSync(dir)
          .filter(f => f.startsWith('capability-registry-state.json.corrupt.'));
        assert.equal(quarantined.length, 1);

        // The original state file path no longer holds the corrupt content.
        assert.equal(fs.existsSync(env.stateFile), false);
      } finally {
        env.teardown();
      }
    });

    test('quarantine does not destroy installed snapshots or audit logs', () => {
      const env = setup();
      try {
        // Place installed snapshots and an audit log alongside the registry.
        const snapshotsDir = path.join(env.root, 'skills', 'generated-distilled');
        const snapshotFile = path.join(
          snapshotsDir,
          'cap-parse-jsonl',
          'snap-aaaa1111bbbb2222',
          'SKILL.md',
        );
        fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
        fs.writeFileSync(snapshotFile, '# immutable snapshot', 'utf-8');

        const auditLog = path.join(env.root, 'data', 'distillation-review-outcomes.json');
        fs.mkdirSync(path.dirname(auditLog), { recursive: true });
        fs.writeFileSync(auditLog, '{"schemaVersion":1,"outcomes":[]}');

        // Corrupt the registry state file.
        fs.writeFileSync(env.stateFile, '{ corrupt ', 'utf-8');
        loadCapabilityRegistry(env.stateFile);

        // Installed snapshots and audit logs are untouched.
        assert.ok(fs.existsSync(snapshotFile));
        assert.equal(fs.readFileSync(snapshotFile, 'utf-8'), '# immutable snapshot');
        assert.ok(fs.existsSync(auditLog));
        assert.equal(
          fs.readFileSync(auditLog, 'utf-8'),
          '{"schemaVersion":1,"outcomes":[]}',
        );
      } finally {
        env.teardown();
      }
    });

    test('loading after quarantine returns a clean empty registry that can be written to', () => {
      const env = setup();
      try {
        fs.mkdirSync(path.dirname(env.stateFile), { recursive: true });
        fs.writeFileSync(env.stateFile, '{ corrupt ', 'utf-8');

        // First load quarantines the corrupt file.
        const state = loadCapabilityRegistry(env.stateFile);
        assert.equal(state.stateCorrupt, true);

        // The returned state can be written to and reloaded cleanly.
        newCapability(state, makeNewCapabilityInput());
        saveCapabilityRegistry(env.stateFile, state);

        const reloaded = loadCapabilityRegistry(env.stateFile);
        assert.equal(reloaded.stateCorrupt, undefined);
        assert.ok(getCapability(reloaded, 'cap-parse-jsonl'));
      } finally {
        env.teardown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // new_capability transition
  // -------------------------------------------------------------------------

  describe('new_capability creates a full registry entry', () => {
    test('creates an entry with identity, active snapshot, routing, evidence, snapshots, status, and timestamps', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        const input = makeNewCapabilityInput();
        const entry = newCapability(state, input);

        assert.equal(entry.capabilityId, 'cap-parse-jsonl');
        assert.equal(entry.activeSnapshotId, 'snap-aaaa1111bbbb2222');
        assert.equal(entry.status, 'active');
        assert.equal(
          entry.routingDescription,
          input.routingDescription,
        );
        assert.equal(entry.evidenceRefs.length, 2);
        assert.deepEqual(entry.relatedSnapshotIds, ['snap-aaaa1111bbbb2222']);
        assert.equal(entry.createdAt, '2026-07-10T01:00:00.000Z');
        assert.equal(entry.updatedAt, '2026-07-10T01:00:00.000Z');

        // The entry is durable after save + reload.
        saveCapabilityRegistry(env.stateFile, state);
        const reloaded = loadCapabilityRegistry(env.stateFile);
        const stored = getCapability(reloaded, 'cap-parse-jsonl');
        assert.equal(stored!.capabilityId, 'cap-parse-jsonl');
        assert.equal(stored!.activeSnapshotId, 'snap-aaaa1111bbbb2222');
        assert.equal(stored!.evidenceRefs.length, 2);
      } finally {
        env.teardown();
      }
    });

    test('preserves source/review metadata for later rebuild', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        const input = makeNewCapabilityInput({
          sourceReview: {
            decision: 'promote',
            reviewedAt: '2026-07-10T01:00:00.000Z',
            sourceUnit: {
              filePath: '/logs/sessions/chat/chat_cli.jsonl',
              byteRange: { start: 0, end: 1000 },
            },
          },
        });
        newCapability(state, input);
        saveCapabilityRegistry(env.stateFile, state);

        const reloaded = loadCapabilityRegistry(env.stateFile);
        const entry = getCapability(reloaded, 'cap-parse-jsonl');
        assert.equal(entry!.sourceReview!.decision, 'promote');
        assert.equal(
          entry!.sourceReview!.sourceUnit.filePath,
          '/logs/sessions/chat/chat_cli.jsonl',
        );
      } finally {
        env.teardown();
      }
    });

    test('throws when a capability with the same id already exists', () => {
      const state = emptyCapabilityRegistryState();
      newCapability(state, makeNewCapabilityInput());
      assert.throws(
        () => newCapability(state, makeNewCapabilityInput()),
        /already exists/,
      );
    });

    test('throws when capabilityId is empty', () => {
      const state = emptyCapabilityRegistryState();
      assert.throws(
        () => newCapability(state, makeNewCapabilityInput({ capabilityId: '' })),
        /capabilityId must be a non-empty string/,
      );
    });

    test('throws when activeSnapshotId is empty', () => {
      const state = emptyCapabilityRegistryState();
      assert.throws(
        () =>
          newCapability(
            state,
            makeNewCapabilityInput({ activeSnapshotId: '' }),
          ),
        /activeSnapshotId must be a non-empty string/,
      );
    });

    test('initial evidence refs are deduplicated', () => {
      const state = emptyCapabilityRegistryState();
      const ref = makeEvidenceRef(
        '/logs/sessions/chat/chat_cli.jsonl',
        1,
        { start: 0, end: 1000 },
        '2026-07-10T00:00:00.000Z',
      );
      const entry = newCapability(state, makeNewCapabilityInput({ evidenceRefs: [ref, ref] }));
      assert.equal(entry.evidenceRefs.length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // append_evidence transition
  // -------------------------------------------------------------------------

  describe('append_evidence appends refs without changing the active snapshot', () => {
    test('appends new evidence refs and updates updatedAt', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        const before = getCapability(state, 'cap-parse-jsonl')!;
        assert.equal(before.evidenceRefs.length, 2);
        assert.equal(before.updatedAt, '2026-07-10T01:00:00.000Z');

        appendEvidence(state, {
          capabilityId: 'cap-parse-jsonl',
          evidenceRefs: makeEvidenceRefs(
            '/logs/sessions/chat/chat_cli.jsonl',
            [5, 6],
            '2026-07-11T00:00:00.000Z',
          ),
          appendedAt: '2026-07-11T00:00:00.000Z',
        });

        const after = getCapability(state, 'cap-parse-jsonl')!;
        assert.equal(after.evidenceRefs.length, 4);
        assert.equal(after.updatedAt, '2026-07-11T00:00:00.000Z');
        // Active Snapshot must not change (ADR 0004).
        assert.equal(
          after.activeSnapshotId,
          before.activeSnapshotId,
        );
      } finally {
        env.teardown();
      }
    });

    test('does not change activeSnapshotId even after multiple appends', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        const originalSnapshot = getCapability(state, 'cap-parse-jsonl')!
          .activeSnapshotId;

        for (let i = 3; i <= 7; i++) {
          appendEvidence(state, {
            capabilityId: 'cap-parse-jsonl',
            evidenceRefs: makeEvidenceRefs(
              '/logs/sessions/chat/chat_cli.jsonl',
              [i],
              `2026-07-1${i}T00:00:00.000Z`,
            ),
            appendedAt: `2026-07-1${i}T00:00:00.000Z`,
          });
        }

        const entry = getCapability(state, 'cap-parse-jsonl')!;
        assert.equal(entry.evidenceRefs.length, 7);
        assert.equal(entry.activeSnapshotId, originalSnapshot);
        assert.equal(entry.status, 'active');
      } finally {
        env.teardown();
      }
    });

    test('duplicate evidence refs are handled idempotently', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        const before = getCapability(state, 'cap-parse-jsonl')!;

        // Append the exact same evidence refs that already exist.
        appendEvidence(state, {
          capabilityId: 'cap-parse-jsonl',
          evidenceRefs: before.evidenceRefs,
          appendedAt: '2026-07-12T00:00:00.000Z',
        });

        const after = getCapability(state, 'cap-parse-jsonl')!;
        assert.equal(after.evidenceRefs.length, before.evidenceRefs.length);
        // updatedAt must not change when no new evidence was added.
        assert.equal(after.updatedAt, before.updatedAt);
        assert.equal(after.activeSnapshotId, before.activeSnapshotId);
      } finally {
        env.teardown();
      }
    });

    test('appending a mix of new and duplicate refs only adds the new ones', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        const before = getCapability(state, 'cap-parse-jsonl')!;
        assert.equal(before.evidenceRefs.length, 2);

        // Re-append turn 1 (duplicate) plus turn 9 (new).
        appendEvidence(state, {
          capabilityId: 'cap-parse-jsonl',
          evidenceRefs: [
            ...makeEvidenceRefs(
              '/logs/sessions/chat/chat_cli.jsonl',
              [1],
              '2026-07-12T00:00:00.000Z',
            ),
            ...makeEvidenceRefs(
              '/logs/sessions/chat/chat_cli.jsonl',
              [9],
              '2026-07-12T00:00:00.000Z',
            ),
          ],
          appendedAt: '2026-07-12T00:00:00.000Z',
        });

        const after = getCapability(state, 'cap-parse-jsonl')!;
        assert.equal(after.evidenceRefs.length, 3);
        assert.equal(after.updatedAt, '2026-07-12T00:00:00.000Z');
      } finally {
        env.teardown();
      }
    });

    test('throws when the capability does not exist', () => {
      const state = emptyCapabilityRegistryState();
      assert.throws(
        () =>
          appendEvidence(state, {
            capabilityId: 'cap-missing',
            evidenceRefs: makeEvidenceRefs(
              '/logs/sessions/chat/chat_cli.jsonl',
              [1],
              '2026-07-12T00:00:00.000Z',
            ),
            appendedAt: '2026-07-12T00:00:00.000Z',
          }),
        /no such registry entry/,
      );
    });

    test('append is durable across save and reload', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        saveCapabilityRegistry(env.stateFile, state);

        const reloaded = loadCapabilityRegistry(env.stateFile);
        appendEvidence(reloaded, {
          capabilityId: 'cap-parse-jsonl',
          evidenceRefs: makeEvidenceRefs(
            '/logs/sessions/chat/chat_cli.jsonl',
            [10],
            '2026-07-13T00:00:00.000Z',
          ),
          appendedAt: '2026-07-13T00:00:00.000Z',
        });
        saveCapabilityRegistry(env.stateFile, reloaded);

        const final = loadCapabilityRegistry(env.stateFile);
        const entry = getCapability(final, 'cap-parse-jsonl')!;
        assert.equal(entry.evidenceRefs.length, 3);
        assert.equal(entry.updatedAt, '2026-07-13T00:00:00.000Z');
        assert.equal(entry.activeSnapshotId, 'snap-aaaa1111bbbb2222');
      } finally {
        env.teardown();
      }
    });
  });

  // -------------------------------------------------------------------------
  // supersede_snapshot transition (issue #17)
  // -------------------------------------------------------------------------

  describe('supersede_snapshot installs a new active snapshot and preserves history', () => {
    test('updates activeSnapshotId to the reviewed new snapshot', () => {
      const state = emptyCapabilityRegistryState();
      newCapability(state, makeNewCapabilityInput());
      const before = getCapability(state, 'cap-parse-jsonl')!;
      assert.equal(before.activeSnapshotId, 'snap-aaaa1111bbbb2222');

      supersedeSnapshot(state, {
        capabilityId: 'cap-parse-jsonl',
        newActiveSnapshotId: 'snap-eeee5555ffff6666',
        supersededAt: '2026-07-20T00:00:00.000Z',
      });

      const after = getCapability(state, 'cap-parse-jsonl')!;
      assert.equal(after.activeSnapshotId, 'snap-eeee5555ffff6666');
      assert.equal(after.updatedAt, '2026-07-20T00:00:00.000Z');
    });

    test('prior active snapshot remains connected through relatedSnapshotIds', () => {
      const state = emptyCapabilityRegistryState();
      newCapability(state, makeNewCapabilityInput());
      const before = getCapability(state, 'cap-parse-jsonl')!;
      assert.deepEqual(before.relatedSnapshotIds, ['snap-aaaa1111bbbb2222']);

      supersedeSnapshot(state, {
        capabilityId: 'cap-parse-jsonl',
        newActiveSnapshotId: 'snap-eeee5555ffff6666',
        supersededAt: '2026-07-20T00:00:00.000Z',
      });

      const after = getCapability(state, 'cap-parse-jsonl')!;
      assert.ok(
        after.relatedSnapshotIds.includes('snap-aaaa1111bbbb2222'),
        'prior active snapshot must remain in relatedSnapshotIds',
      );
      assert.ok(
        after.relatedSnapshotIds.includes('snap-eeee5555ffff6666'),
        'new active snapshot must be in relatedSnapshotIds',
      );
    });

    test('evidence refs are preserved across supersede transitions', () => {
      const state = emptyCapabilityRegistryState();
      newCapability(state, makeNewCapabilityInput());
      appendEvidence(state, {
        capabilityId: 'cap-parse-jsonl',
        evidenceRefs: makeEvidenceRefs(
          '/logs/sessions/chat/chat_cli.jsonl',
          [5, 6],
          '2026-07-11T00:00:00.000Z',
        ),
        appendedAt: '2026-07-11T00:00:00.000Z',
      });
      const before = getCapability(state, 'cap-parse-jsonl')!;
      assert.equal(before.evidenceRefs.length, 4);

      supersedeSnapshot(state, {
        capabilityId: 'cap-parse-jsonl',
        newActiveSnapshotId: 'snap-eeee5555ffff6666',
        supersededAt: '2026-07-20T00:00:00.000Z',
      });

      const after = getCapability(state, 'cap-parse-jsonl')!;
      assert.equal(after.evidenceRefs.length, 4);
      assert.deepEqual(after.evidenceRefs, before.evidenceRefs);
    });

    test('supersede does not delete or overwrite immutable SKILL.md snapshots', () => {
      const env = setup();
      try {
        // Place immutable snapshots for both the prior and the new active snapshot.
        const snapshotsDir = path.join(env.root, 'skills', 'generated-distilled');
        const priorSnapshotFile = path.join(
          snapshotsDir,
          'cap-parse-jsonl',
          'snap-aaaa1111bbbb2222',
          'SKILL.md',
        );
        const newSnapshotFile = path.join(
          snapshotsDir,
          'cap-parse-jsonl',
          'snap-eeee5555ffff6666',
          'SKILL.md',
        );
        fs.mkdirSync(path.dirname(priorSnapshotFile), { recursive: true });
        fs.mkdirSync(path.dirname(newSnapshotFile), { recursive: true });
        fs.writeFileSync(priorSnapshotFile, '# prior immutable snapshot', 'utf-8');
        fs.writeFileSync(newSnapshotFile, '# new immutable snapshot', 'utf-8');

        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        saveCapabilityRegistry(env.stateFile, state);

        const reloaded = loadCapabilityRegistry(env.stateFile);
        supersedeSnapshot(reloaded, {
          capabilityId: 'cap-parse-jsonl',
          newActiveSnapshotId: 'snap-eeee5555ffff6666',
          supersededAt: '2026-07-20T00:00:00.000Z',
        });
        saveCapabilityRegistry(env.stateFile, reloaded);

        // Immutable snapshots are untouched by the registry transition.
        assert.equal(
          fs.readFileSync(priorSnapshotFile, 'utf-8'),
          '# prior immutable snapshot',
        );
        assert.equal(
          fs.readFileSync(newSnapshotFile, 'utf-8'),
          '# new immutable snapshot',
        );
      } finally {
        env.teardown();
      }
    });

    test('supersede is testable against a controlled runtime data root after a capability exists', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        saveCapabilityRegistry(env.stateFile, state);

        const reloaded = loadCapabilityRegistry(env.stateFile);
        supersedeSnapshot(reloaded, {
          capabilityId: 'cap-parse-jsonl',
          newActiveSnapshotId: 'snap-eeee5555ffff6666',
          supersededAt: '2026-07-20T00:00:00.000Z',
        });
        saveCapabilityRegistry(env.stateFile, reloaded);

        const final = loadCapabilityRegistry(env.stateFile);
        const entry = getCapability(final, 'cap-parse-jsonl')!;
        assert.equal(entry.activeSnapshotId, 'snap-eeee5555ffff6666');
        assert.ok(entry.relatedSnapshotIds.includes('snap-aaaa1111bbbb2222'));
      } finally {
        env.teardown();
      }
    });

    test('append_evidence and supersede_snapshot have different effects on activeSnapshotId', () => {
      const env = setup();
      try {
        // Two parallel registries starting from the same new_capability state.
        const base = emptyCapabilityRegistryState();
        newCapability(base, makeNewCapabilityInput());

        const appendState = emptyCapabilityRegistryState();
        newCapability(appendState, makeNewCapabilityInput());
        const supersedeState = emptyCapabilityRegistryState();
        newCapability(supersedeState, makeNewCapabilityInput());

        // append_evidence adds evidence but must NOT change activeSnapshotId.
        appendEvidence(appendState, {
          capabilityId: 'cap-parse-jsonl',
          evidenceRefs: makeEvidenceRefs(
            '/logs/sessions/chat/chat_cli.jsonl',
            [20],
            '2026-07-21T00:00:00.000Z',
          ),
          appendedAt: '2026-07-21T00:00:00.000Z',
        });

        // supersede_snapshot changes activeSnapshotId while preserving evidence.
        supersedeSnapshot(supersedeState, {
          capabilityId: 'cap-parse-jsonl',
          newActiveSnapshotId: 'snap-eeee5555ffff6666',
          supersededAt: '2026-07-21T00:00:00.000Z',
        });

        const afterAppend = getCapability(appendState, 'cap-parse-jsonl')!;
        const afterSupersede = getCapability(supersedeState, 'cap-parse-jsonl')!;

        assert.equal(
          afterAppend.activeSnapshotId,
          'snap-aaaa1111bbbb2222',
          'append_evidence must not change activeSnapshotId',
        );
        assert.equal(
          afterSupersede.activeSnapshotId,
          'snap-eeee5555ffff6666',
          'supersede_snapshot must change activeSnapshotId',
        );
        assert.notEqual(
          afterAppend.activeSnapshotId,
          afterSupersede.activeSnapshotId,
        );
      } finally {
        env.teardown();
      }
    });

    test('optionally updates routingDescription when a new one is provided', () => {
      const state = emptyCapabilityRegistryState();
      newCapability(state, makeNewCapabilityInput());
      const original = getCapability(state, 'cap-parse-jsonl')!.routingDescription;

      supersedeSnapshot(state, {
        capabilityId: 'cap-parse-jsonl',
        newActiveSnapshotId: 'snap-eeee5555ffff6666',
        supersededAt: '2026-07-20T00:00:00.000Z',
        routingDescription:
          'Distilled capability. When: parse a JSONL file. Do: stream via readline and validate schema.',
      });

      const after = getCapability(state, 'cap-parse-jsonl')!;
      assert.notEqual(after.routingDescription, original);
      assert.match(after.routingDescription, /stream via readline/);
    });

    test('leaves routingDescription unchanged when none is provided', () => {
      const state = emptyCapabilityRegistryState();
      newCapability(state, makeNewCapabilityInput());
      const original = getCapability(state, 'cap-parse-jsonl')!.routingDescription;

      supersedeSnapshot(state, {
        capabilityId: 'cap-parse-jsonl',
        newActiveSnapshotId: 'snap-eeee5555ffff6666',
        supersededAt: '2026-07-20T00:00:00.000Z',
      });

      const after = getCapability(state, 'cap-parse-jsonl')!;
      assert.equal(after.routingDescription, original);
    });

    test('supersede is durable across save and reload', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        saveCapabilityRegistry(env.stateFile, state);

        const reloaded = loadCapabilityRegistry(env.stateFile);
        supersedeSnapshot(reloaded, {
          capabilityId: 'cap-parse-jsonl',
          newActiveSnapshotId: 'snap-eeee5555ffff6666',
          supersededAt: '2026-07-20T00:00:00.000Z',
        });
        saveCapabilityRegistry(env.stateFile, reloaded);

        const final = loadCapabilityRegistry(env.stateFile);
        const entry = getCapability(final, 'cap-parse-jsonl')!;
        assert.equal(entry.activeSnapshotId, 'snap-eeee5555ffff6666');
        assert.ok(entry.relatedSnapshotIds.includes('snap-aaaa1111bbbb2222'));
        assert.equal(entry.updatedAt, '2026-07-20T00:00:00.000Z');
        assert.equal(entry.evidenceRefs.length, 2);
      } finally {
        env.teardown();
      }
    });

    test('throws when the capability does not exist', () => {
      const state = emptyCapabilityRegistryState();
      assert.throws(
        () =>
          supersedeSnapshot(state, {
            capabilityId: 'cap-missing',
            newActiveSnapshotId: 'snap-eeee5555ffff6666',
            supersededAt: '2026-07-20T00:00:00.000Z',
          }),
        /no such registry entry/,
      );
    });

    test('throws when newActiveSnapshotId is empty', () => {
      const state = emptyCapabilityRegistryState();
      newCapability(state, makeNewCapabilityInput());
      assert.throws(
        () =>
          supersedeSnapshot(state, {
            capabilityId: 'cap-parse-jsonl',
            newActiveSnapshotId: '',
            supersededAt: '2026-07-20T00:00:00.000Z',
          }),
        /newActiveSnapshotId must be a non-empty string/,
      );
    });

    test('throws when capabilityId is empty', () => {
      const state = emptyCapabilityRegistryState();
      assert.throws(
        () =>
          supersedeSnapshot(state, {
            capabilityId: '',
            newActiveSnapshotId: 'snap-eeee5555ffff6666',
            supersededAt: '2026-07-20T00:00:00.000Z',
          }),
        /capabilityId must be a non-empty string/,
      );
    });

    test('throws when superseding to the same active snapshot', () => {
      const state = emptyCapabilityRegistryState();
      newCapability(state, makeNewCapabilityInput());
      assert.throws(
        () =>
          supersedeSnapshot(state, {
            capabilityId: 'cap-parse-jsonl',
            newActiveSnapshotId: 'snap-aaaa1111bbbb2222',
            supersededAt: '2026-07-20T00:00:00.000Z',
          }),
        /already the active snapshot/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Evidence ref identity and idempotency
  // -------------------------------------------------------------------------

  describe('evidence ref identity is stable and comparable', () => {
    test('computeEvidenceId is deterministic for the same source identity', () => {
      const a = computeEvidenceId('/logs/sessions/chat/chat_cli.jsonl', 1, {
        start: 0,
        end: 1000,
      });
      const b = computeEvidenceId('/logs/sessions/chat/chat_cli.jsonl', 1, {
        start: 0,
        end: 1000,
      });
      assert.equal(a, b);
    });

    test('computeEvidenceId differs for different turns', () => {
      const a = computeEvidenceId('/logs/sessions/chat/chat_cli.jsonl', 1, {
        start: 0,
        end: 1000,
      });
      const b = computeEvidenceId('/logs/sessions/chat/chat_cli.jsonl', 2, {
        start: 0,
        end: 1000,
      });
      assert.notEqual(a, b);
    });

    test('computeEvidenceId differs for different byte ranges', () => {
      const a = computeEvidenceId('/logs/sessions/chat/chat_cli.jsonl', 1, {
        start: 0,
        end: 1000,
      });
      const b = computeEvidenceId('/logs/sessions/chat/chat_cli.jsonl', 1, {
        start: 2000,
        end: 3000,
      });
      assert.notEqual(a, b);
    });

    test('makeEvidenceRef builds a ref with a computed evidenceId', () => {
      const ref = makeEvidenceRef(
        '/logs/sessions/chat/chat_cli.jsonl',
        1,
        { start: 0, end: 1000 },
        '2026-07-10T00:00:00.000Z',
      );
      assert.ok(ref.evidenceId);
      assert.equal(ref.turn, 1);
      assert.equal(ref.appendedAt, '2026-07-10T00:00:00.000Z');
    });

    test('computeEvidenceId uses a stable sha256 digest suffix', () => {
      const id = computeEvidenceId('/logs/sessions/chat/chat_cli.jsonl', 1, {
        start: 0,
        end: 1000,
      });
      assert.match(id, /:[0-9a-f]{16}$/);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple capabilities coexist
  // -------------------------------------------------------------------------

  describe('multiple capabilities coexist in one registry', () => {
    test('two distinct capabilities are stored and retrieved independently', () => {
      const env = setup();
      try {
        const state = emptyCapabilityRegistryState();
        newCapability(state, makeNewCapabilityInput());
        newCapability(state, makeNewCapabilityInput({
          capabilityId: 'cap-read-large-file',
          activeSnapshotId: 'snap-cccc3333dddd4444',
          routingDescription: 'Distilled capability. When: read a large file. Do: stream in chunks.',
          relatedSnapshotIds: ['snap-cccc3333dddd4444'],
        }));
        saveCapabilityRegistry(env.stateFile, state);

        const reloaded = loadCapabilityRegistry(env.stateFile);
        assert.equal(Object.keys(reloaded.capabilities).length, 2);
        assert.ok(getCapability(reloaded, 'cap-parse-jsonl'));
        assert.ok(getCapability(reloaded, 'cap-read-large-file'));
        assert.notEqual(
          getCapability(reloaded, 'cap-parse-jsonl')!.activeSnapshotId,
          getCapability(reloaded, 'cap-read-large-file')!.activeSnapshotId,
        );
      } finally {
        env.teardown();
      }
    });
  });
});
