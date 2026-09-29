import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Interrupted-turn bookkeeping.
 *
 * When the worker process is killed (OOM killer, provider host restart) the
 * session keeps running inside systemd, but nobody knows that a turn never
 * reached a terminal state — the user sees a conversation that looks dead
 * until they type "继续" by hand. These tests pin the durable marker that
 * makes the interruption recoverable, and the scan that turns it back into a
 * model turn on the next start().
 */
describe('interrupted turn recovery', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-interrupted-turn-'));
    process.chdir(testRoot);
  });

  afterEach(async () => {
    // The Windows teardown races the open log handle; closing it first keeps
    // the temp-dir cleanup from failing with EBUSY.
    require('../src/utils/logger').Logger.closeLogFile();
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      await fs.promises.rm(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('records an interrupted turn with the data recovery needs', async () => {
    const { markInterruptedTurn, SessionStore } = loadModules();

    markInterruptedTurn('cc_group:grp_2613', {
      topic: 'grp_2613',
      reason: 'oom-kill',
      senderId: 'usr38',
    });

    const state = SessionStore.getInstance().loadRuntimeState('cc_group:grp_2613');
    assert.ok(state.interruptedTurn, 'interrupted turn marker must be persisted');
    assert.equal(state.interruptedTurn.topic, 'grp_2613');
    assert.equal(state.interruptedTurn.reason, 'oom-kill');
    assert.equal(state.interruptedTurn.senderId, 'usr38');
    assert.equal(state.interruptedTurn.attempts, 0, 'a fresh interruption starts at zero resumptions');
    assert.ok(typeof state.interruptedTurn.startedAt === 'string');
    assert.ok(Date.parse(state.interruptedTurn.startedAt) > 0, 'startedAt must be an ISO timestamp');
  });

  test('clears the marker once the turn reaches a terminal state', async () => {
    const { markInterruptedTurn, clearInterruptedTurn, SessionStore } = loadModules();
    const store = SessionStore.getInstance();
    const key = 'cc_group:grp_clear';

    markInterruptedTurn(key, { topic: 'grp_clear', reason: 'oom-kill' });
    assert.ok(store.loadRuntimeState(key).interruptedTurn);

    clearInterruptedTurn(key);

    assert.equal(store.loadRuntimeState(key).interruptedTurn, undefined);
  });

  test('counts resumption attempts so an OOM loop cannot run forever', async () => {
    const { markInterruptedTurn, noteResumeAttempt, SessionStore } = loadModules();
    const store = SessionStore.getInstance();
    const key = 'cc_group:grp_attempts';

    markInterruptedTurn(key, { topic: 'grp_attempts', reason: 'oom-kill' });
    assert.equal(noteResumeAttempt(key), 1, 'first resumption is attempt 1');
    assert.equal(store.loadRuntimeState(key).interruptedTurn.attempts, 1);

    markInterruptedTurn(key, { topic: 'grp_attempts', reason: 'oom-kill' });
    assert.equal(noteResumeAttempt(key), 2, 'second resumption is attempt 2');
    assert.equal(store.loadRuntimeState(key).interruptedTurn.attempts, 2);
  });

  test('markInterruptedTurn preserves the existing attempt count', async () => {
    const { markInterruptedTurn, noteResumeAttempt, SessionStore } = loadModules();
    const store = SessionStore.getInstance();
    const key = 'cc_group:grp_preserve';

    markInterruptedTurn(key, { topic: 'grp_preserve', reason: 'oom-kill' });
    noteResumeAttempt(key);
    noteResumeAttempt(key);
    // A second kill while the automatic resume was running must not reset the
    // budget, otherwise a crash loop would resume forever.
    markInterruptedTurn(key, { topic: 'grp_preserve', reason: 'oom-kill' });

    const state = store.loadRuntimeState(key);
    assert.equal(state.interruptedTurn.attempts, 2, 'attempt budget survives a re-interruption');
  });

  test('scans session state files and returns only resumable interruptions', async () => {
    const { SessionStore, collectInterruptedTurns } = loadModules();
    const store = SessionStore.getInstance();
    const now = Date.now();

    store.saveRuntimeState('cc_group:grp_recent', {
      interruptedTurn: {
        topic: 'grp_recent',
        reason: 'oom-kill',
        startedAt: new Date(now - 5 * 60_000).toISOString(),
        attempts: 0,
      },
    });
    store.saveRuntimeState('cc_group:grp_old', {
      interruptedTurn: {
        topic: 'grp_old',
        reason: 'oom-kill',
        startedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
        attempts: 0,
      },
    });
    store.saveRuntimeState('cc_group:grp_exhausted', {
      interruptedTurn: {
        topic: 'grp_exhausted',
        reason: 'oom-kill',
        startedAt: new Date(now - 60_000).toISOString(),
        attempts: 2,
      },
    });
    store.saveRuntimeState('cc_group:grp_clean', { currentDirectory: '/tmp' });

    const resumable = collectInterruptedTurns({
      stateDir: path.join(testRoot, 'data', 'session-state'),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
      now,
    });

    assert.deepStrictEqual(
      resumable.map((item: any) => item.sessionKey),
      ['cc_group:grp_recent'],
      'only a recent, un-exhausted interruption may resume',
    );
    assert.equal(resumable[0].topic, 'grp_recent');
  });

  test('skips interruptions whose attempt budget is exhausted', async () => {
    const { SessionStore, collectInterruptedTurns } = loadModules();
    const store = SessionStore.getInstance();
    const now = Date.now();

    store.saveRuntimeState('cc_group:grp_budget', {
      interruptedTurn: {
        topic: 'grp_budget',
        reason: 'oom-kill',
        startedAt: new Date(now - 60_000).toISOString(),
        attempts: 2,
      },
    });

    assert.deepStrictEqual(
      collectInterruptedTurns({
        stateDir: path.join(testRoot, 'data', 'session-state'),
        maxAgeMs: 30 * 60_000,
        maxAttempts: 2,
        now,
      }),
      [],
    );
  });

  test('tolerates missing and corrupt state files', async () => {
    const { collectInterruptedTurns } = loadModules();
    const stateDir = path.join(testRoot, 'data', 'session-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'broken.json'), '{not json', 'utf-8');

    assert.deepStrictEqual(
      collectInterruptedTurns({ stateDir, maxAgeMs: 30 * 60_000, maxAttempts: 2 }),
      [],
      'a corrupt state file must never break startup',
    );
    assert.deepStrictEqual(
      collectInterruptedTurns({ stateDir: path.join(testRoot, 'missing'), maxAgeMs: 30 * 60_000, maxAttempts: 2 }),
      [],
    );
  });

  test('a shutdown marker survives the terminal-state sweep', async () => {
    // Regression guard for the ordering trap: the shutdown path retires each
    // task first (which clears any marker) and only then writes the marker for
    // this shutdown. Writing them the other way round silently erased the
    // recovery record and no turn was ever resumed.
    const { markInterruptedTurn, clearInterruptedTurn, collectInterruptedTurns, SessionStore } = loadModules();
    const store = SessionStore.getInstance();
    const key = 'cc_group:grp_ordering';

    // Retiring the task wipes stale markers...
    clearInterruptedTurn(key);
    // ...and the shutdown marker written afterwards must still be there.
    markInterruptedTurn(key, { topic: 'grp_ordering', reason: 'connector-shutdown' });

    const resumable = collectInterruptedTurns({
      stateDir: path.join(testRoot, 'data', 'session-state'),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
    });
    assert.deepStrictEqual(
      resumable.map((item: any) => item.sessionKey),
      ['cc_group:grp_ordering'],
      'the marker written after the sweep must remain resumable',
    );
    assert.equal(store.loadRuntimeState(key).interruptedTurn.reason, 'connector-shutdown');
  });

  test('a user reply supersedes a pending interruption', async () => {
    // The startup scan must not replay a turn the user has visibly taken over;
    // processParsedMessage drops the marker for any real user message.
    const { markInterruptedTurn, clearInterruptedTurn, collectInterruptedTurns } = loadModules();
    const key = 'cc_group:grp_user_took_over';

    markInterruptedTurn(key, { topic: 'grp_user_took_over', reason: 'oom-kill' });
    assert.equal(
      collectInterruptedTurns({
        stateDir: path.join(testRoot, 'data', 'session-state'),
        maxAgeMs: 30 * 60_000,
        maxAttempts: 2,
      }).length,
      1,
    );

    clearInterruptedTurn(key);

    assert.deepStrictEqual(
      collectInterruptedTurns({
        stateDir: path.join(testRoot, 'data', 'session-state'),
        maxAgeMs: 30 * 60_000,
        maxAttempts: 2,
      }),
      [],
      'once the user replies there is nothing left to resume',
    );
  });

  test('a disbanded or blocked group stops being resumable', async () => {
    // handleGroupDisbandedNotice / handleMemberKickedNotice / send-blocked all
    // funnel into stopSessionExecution(). If the marker survived, a restart
    // would keep posting the resume turn into a topic the bot no longer owns.
    const { markInterruptedTurn, stopResumingInterruptedTurn, collectInterruptedTurns } = loadModules();
    const key = 'cc_group:grp_disbanded';

    markInterruptedTurn(key, { topic: 'grp_disbanded', reason: 'connector-shutdown' });
    assert.equal(
      collectInterruptedTurns({
        stateDir: path.join(testRoot, 'data', 'session-state'),
        maxAgeMs: 30 * 60_000,
        maxAttempts: 2,
      }).length,
      1,
    );

    // Mirrors what stopSessionExecution() does on kick / disband / send-blocked.
    stopResumingInterruptedTurn(key);

    assert.deepStrictEqual(
      collectInterruptedTurns({
        stateDir: path.join(testRoot, 'data', 'session-state'),
        maxAgeMs: 30 * 60_000,
        maxAttempts: 2,
      }),
      [],
      'a dead topic must never be auto-resumed',
    );
  });

  test('a wiped conversation stops being resumable', async () => {
    // /clear leaves the session file in place, so the marker is the only thing
    // that would drag a resume turn into the history the user just erased.
    const { markInterruptedTurn, clearInterruptedTurn, collectInterruptedTurns } = loadModules();
    const key = 'cc_group:grp_cleared';

    markInterruptedTurn(key, { topic: 'grp_cleared', reason: 'oom-kill' });
    clearInterruptedTurn(key);

    assert.deepStrictEqual(
      collectInterruptedTurns({
        stateDir: path.join(testRoot, 'data', 'session-state'),
        maxAgeMs: 30 * 60_000,
        maxAttempts: 2,
      }),
      [],
    );
  });

  test('the attempt budget bounds a kill-resume-kill loop', async () => {
    // The real OOM loop: the resume turn itself exhausts memory, the process
    // dies again, and a fresh marker is written. Without a persistent counter
    // the worker would keep restarting into the same crash forever.
    const { markInterruptedTurn, noteResumeAttempt, collectInterruptedTurns } = loadModules();
    const key = 'cc_group:grp_oom_loop';
    const scan = () => collectInterruptedTurns({
      stateDir: path.join(testRoot, 'data', 'session-state'),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
    });

    // The process died mid-turn; the shutdown path wrote the first marker.
    markInterruptedTurn(key, { topic: 'grp_oom_loop', reason: 'oom-kill' });

    let resumes = 0;
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      if (scan().length === 0) break;
      resumes += 1;
      noteResumeAttempt(key);
      // The resume turn dies again and the shutdown path rewrites the marker.
      markInterruptedTurn(key, { topic: 'grp_oom_loop', reason: 'oom-kill' });
    }

    assert.equal(resumes, 2, 'exactly the budget may be spent, then the loop must stop');
    assert.deepStrictEqual(scan(), [], 'an exhausted marker is no longer resumable');
  });
});

function loadModules(): any {
  for (const modulePath of [
    '../src/core/interrupted-turn-recovery',
    '../src/utils/session-store',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const recovery = require('../src/core/interrupted-turn-recovery');
  return {
    markInterruptedTurn: recovery.markInterruptedTurn,
    clearInterruptedTurn: recovery.clearInterruptedTurn,
    stopResumingInterruptedTurn: recovery.stopResumingInterruptedTurn,
    noteResumeAttempt: recovery.noteResumeAttempt,
    collectInterruptedTurns: recovery.collectInterruptedTurns,
    SessionStore: require('../src/utils/session-store').SessionStore,
  };
}

function buildInbox(): any {
  return {
    reset() {},
    consume() { return []; },
  };
}
