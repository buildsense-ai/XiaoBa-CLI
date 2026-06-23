import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';

describe('memory sidecar branch', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-memory-sidecar-'));
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('searches local session logs and publishes a memory observation', async () => {
    const sessionDir = path.join(testRoot, 'logs', 'sessions', 'chat');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'demo.jsonl'),
      JSON.stringify({
        entry_type: 'turn',
        turn: 4,
        timestamp: '2026-06-09T10:00:00.000Z',
        session_id: 'chat:demo',
        user: { text: 'dashboard filters compact preference' },
        assistant: { text: 'Decision: keep dashboard filters compact and avoid a large hero panel.' },
      }) + '\n',
      'utf-8',
    );

    const queue = new InMemorySyntheticObservationQueue();
    const handle = startMemorySidecarBranch({
      sessionKey: 'test-session',
      input: 'what did we decide about dashboard filters?',
      recentMessages: [],
      workingDirectory: testRoot,
      queue,
    });

    await handle.done;
    const observations = queue.drain();

    assert.equal(observations.length, 1);
    assert.equal(observations[0].source, 'memory');
    assert.equal(observations[0].status, 'completed');
    assert.match(observations[0].summary, /Memory sidecar found/);
    assert.match(observations[0].evidence?.[0].snippet || '', /dashboard filters compact/);
  });
});
