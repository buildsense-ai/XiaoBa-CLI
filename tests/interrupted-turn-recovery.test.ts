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

  test('a restart after a historical OOM is not reported as an OOM kill', async () => {
    // The cgroup counter is cumulative for the unit's lifetime. Reading it
    // without a startup baseline made every later restart claim "内存不足被系统
    // 终止", which is both wrong and alarming to the user.
    const { classifyShutdownReason } = loadModules();

    assert.equal(
      classifyShutdownReason(3, 3),
      'connector-shutdown',
      'an unchanged counter means nothing was killed under this process',
    );
    assert.equal(
      classifyShutdownReason(4, 3),
      'oom-kill',
      'a counter that grew since startup belongs to this process',
    );
    assert.equal(
      classifyShutdownReason(0, undefined),
      'connector-shutdown',
      'without a baseline the reason stays generic rather than guessing',
    );
    assert.equal(
      classifyShutdownReason(undefined, 0),
      'connector-shutdown',
      'an unreadable counter must not fabricate an OOM kill',
    );
    assert.equal(
      classifyShutdownReason(1, 5),
      'connector-shutdown',
      'a counter that went backwards (cgroup recreated) is not a kill',
    );
  });

  test('a resume cut short by shutdown stays resumable across a restart', async () => {
    // The resume turn creates no ActiveConversationTask, so the shutdown sweep
    // never sees it and cannot re-write a marker on its behalf. If the resume
    // is cut short by destroy(), the marker must survive so the next start()
    // still knows the work was interrupted -- otherwise the turn is lost in
    // silence, which is exactly the bug this feature exists to fix.
    //
    // The production guard is "clear only when !shuttingDown"; what this test
    // pins is the observable consequence of getting it wrong: clearing after a
    // shutdown leaves nothing for the next start() to find.
    const { markInterruptedTurn, clearInterruptedTurn, noteResumeAttempt, collectInterruptedTurns } = loadModules();
    const key = 'cc_group:grp_shutdown_mid_resume';
    const scan = () => collectInterruptedTurns({
      stateDir: path.join(testRoot, 'data', 'session-state'),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
    });

    markInterruptedTurn(key, { topic: 'grp_shutdown_mid_resume', reason: 'oom-kill' });
    noteResumeAttempt(key);

    // Resuming without clearing (the shutdown case) keeps the work recoverable.
    const survived = scan();
    assert.equal(survived.length, 1, 'an uncleared marker stays resumable across a restart');
    assert.equal(survived[0].attempts, 1, 'the spent attempt is still accounted for');

    // A resume that runs to completion does retire the marker.
    clearInterruptedTurn(key);
    assert.deepStrictEqual(scan(), [], 'a completed resume retires the marker');
  });

  test('recovers the session key for a private chat, not just a group', async () => {
    // keyToFilename() replaces every character outside [a-zA-Z0-9_-] with '_',
    // so 'cc_user:usr38' is stored as 'cc_user_usr38.json' and the colon is
    // gone. Reconstructing the key from the file name produced 'cc_user_usr38'
    // -- a different, non-existent session -- so a private chat could never be
    // resumed. The marker carries its own key instead.
    const { markInterruptedTurn, collectInterruptedTurns } = loadModules();
    const key = 'cc_user:usr38';

    markInterruptedTurn(key, { topic: 'p2p_1_38', reason: 'oom-kill' });

    const scanned = collectInterruptedTurns({
      stateDir: path.join(testRoot, 'data', 'session-state'),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
    });
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].sessionKey, key, 'a private chat must resume its real session key');
  });

  test('recovers a modern session:v2 key that cannot be reconstructed', async () => {
    // 'session:v2:catscompany:p2p:p2p_1_2:agent:usr43' loses six separators to
    // the file-name sanitizer. No prefix rule can bring it back, so the stored
    // key is the only source of truth.
    const { markInterruptedTurn, collectInterruptedTurns } = loadModules();
    const key = 'session:v2:catscompany:p2p:p2p_1_2:agent:usr43';

    markInterruptedTurn(key, { topic: 'p2p_1_2', reason: 'connector-shutdown' });

    const scanned = collectInterruptedTurns({
      stateDir: path.join(testRoot, 'data', 'session-state'),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
    });
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].sessionKey, key, 'the exact v2 key must survive a restart');
  });

  test('reads the OOM counter from a real /proc/vmstat sample', async () => {
    // Captured verbatim from worker-bot-bot-bot-9308 after three real kills.
    // The cgroup's own oom_kill read 0 at the same moment because the unit runs
    // with MemoryMax=infinity, so reading it there always reported "服务重启"
    // and the user was never told their task died of memory exhaustion.
    const { parseOomKillCount } = loadModules();
    const sample = [
      'nr_free_pages 415929',
      'oom_kill 3',
      'numa_hit 1050350',
    ].join('\n');

    assert.equal(parseOomKillCount(sample), 3, 'the host-wide counter must be read');
    assert.equal(
      parseOomKillCount('oom_kill_disable 0\noom_kill 12\n'),
      12,
      'only the exact oom_kill field counts, not oom_kill_disable',
    );
    assert.equal(parseOomKillCount('nr_free_pages 415929'), undefined);
    assert.equal(parseOomKillCount(''), undefined);
    assert.equal(parseOomKillCount(undefined as any), undefined);
  });

  test('clearing uses the stored key so the right file is retired', async () => {
    // mark/clear/scan must agree on one key. Deriving a different key in the
    // scanner than the one written by mark() would leave tombstones that never
    // clear, and a cleared conversation could still look resumable.
    const { markInterruptedTurn, clearInterruptedTurn, collectInterruptedTurns } = loadModules();
    const key = 'cc_user:usr99';
    const scan = () => collectInterruptedTurns({
      stateDir: path.join(testRoot, 'data', 'session-state'),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
    });

    markInterruptedTurn(key, { topic: 'p2p_1_99', reason: 'oom-kill' });
    assert.equal(scan().length, 1);
    assert.equal(clearInterruptedTurn(key), true, 'clear must find the file mark() wrote');
    assert.deepStrictEqual(scan(), [], 'a cleared private chat is not resumable');
  });

  test('a torn state file never replaces a good one', async () => {
    // The marker is written on the shutdown path of a process the kernel is
    // already killing, and the same file carries the remote context cursors.
    // Overwriting in place means a kill mid-write leaves an unparseable file
    // and loses BOTH the marker and the cursors; the next start() then finds
    // nothing to resume and has to re-pull history. The write must be atomic,
    // so readers only ever see the old file or the complete new one.
    //
    // This asserts the contract directly rather than inferring it: the write is
    // interrupted part-way and the pre-existing file must still be intact. A
    // test that only checked the final content passed with an in-place
    // overwrite too (verified by mutation), which is exactly the bug.
    const { markInterruptedTurn, collectInterruptedTurns, SessionStore } = loadModules();
    const fsModule = require('fs');
    const store = SessionStore.getInstance();
    const key = 'cc_group:grp_torn';
    const stateFile = path.join(testRoot, 'data', 'session-state', 'cc_group_grp_torn.json');

    store.saveRuntimeState(key, {
      currentDirectory: '/srv/catsco-agent/tmp',
      remoteContextCursors: { 'catscompany.agent_context': 1158677 },
    });
    markInterruptedTurn(key, { topic: 'grp_torn', reason: 'oom-kill' });

    const before = fs.readFileSync(stateFile, 'utf-8');
    assert.ok(before.includes('1158677'), 'cursors and marker share one file');

    // Interrupt the payload write the way a kill would: some bytes reach the
    // file and then the process dies. Writing nothing would not distinguish an
    // atomic write from an in-place one -- both would leave the target intact
    // (verified by mutation), so the partial bytes are the whole point.
    const realWrite = fsModule.writeFileSync;
    let interrupted = false;
    fsModule.writeFileSync = (file: any, data: any, ...rest: any[]) => {
      if (String(file).includes('grp_torn')) {
        interrupted = true;
        // Land half the payload, then die: this is what a truncated file is.
        const text = String(data);
        realWrite(file, text.slice(0, Math.floor(text.length / 2)), ...rest);
        const error: any = new Error('simulated SIGKILL mid-write');
        error.code = 'EIO';
        throw error;
      }
      return realWrite(file, data, ...rest);
    };
    try {
      store.saveRuntimeState(key, {
        currentDirectory: '/somewhere/else',
        remoteContextCursors: { 'catscompany.agent_context': 999 },
      });
    } finally {
      fsModule.writeFileSync = realWrite;
    }

    assert.ok(interrupted, 'the test must actually have interrupted a write');

    // The old file survived intact: the marker and cursors are still readable.
    const after = fs.readFileSync(stateFile, 'utf-8');
    assert.equal(after, before, 'an interrupted write must not touch the live file');
    const state = store.loadRuntimeState(key);
    assert.equal(state.currentDirectory, '/srv/catsco-agent/tmp');
    assert.deepEqual(state.remoteContextCursors, { 'catscompany.agent_context': 1158677 });
    assert.equal(collectInterruptedTurns({
      stateDir: path.dirname(stateFile),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
    }).length, 1, 'the interruption marker must survive a torn write');

    // And no staging file is left lying around in the state directory.
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(stateFile)).filter((name) => name.endsWith('.tmp')),
      [],
      'a failed write must clean up its temp file',
    );
  });

  test('staging files left by a crash do not accumulate', async () => {
    // A kill between the staging write and the rename is exactly the event this
    // file exists for, so leftovers are expected rather than exceptional. They
    // are invisible to the scan (they do not end in .json), but without a sweep
    // they would pile up one per crash forever in a directory the scan walks.
    const { markInterruptedTurn, collectInterruptedTurns, SessionStore } = loadModules();
    const store = SessionStore.getInstance();
    const key = 'cc_group:grp_leftover';
    const stateDir = path.join(testRoot, 'data', 'session-state');
    const stateFile = path.join(stateDir, 'cc_group_grp_leftover.json');

    store.saveRuntimeState(key, { currentDirectory: '/tmp' });
    markInterruptedTurn(key, { topic: 'grp_leftover', reason: 'oom-kill' });

    // Three kills, each landing between write and rename.
    for (const pid of [1111, 2222, 3333]) {
      fs.writeFileSync(`${stateFile}.${pid}.tmp`, '{"partial":', 'utf-8');
    }
    assert.equal(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')).length,
      3,
      'the scenario must actually have leftovers',
    );

    // A later successful write sweeps them.
    store.saveRuntimeState(key, { ...store.loadRuntimeState(key), currentDirectory: '/tmp/next' });
    assert.deepStrictEqual(
      fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp')),
      [],
      'stale staging files must not accumulate',
    );

    // And the sweep must not have disturbed the live marker.
    assert.equal(collectInterruptedTurns({ stateDir, maxAgeMs: 30 * 60_000, maxAttempts: 2 }).length, 1);
    assert.equal(store.loadRuntimeState(key).currentDirectory, '/tmp/next');
  });

  test('a resumed turn keeps the device access the interrupted turn had', async () => {
    // A resume is a runtime observation, not a user message, so it carries no
    // metadata of its own. Without the captured context the resumed turn has no
    // execution scope, no device grants and no target routes: user-device tools
    // are denied and the model is told "No user computer targets are currently
    // available" -- which strands exactly the tasks this feature rescues.
    const { markInterruptedTurn, sanitizeDeviceContext, collectInterruptedTurns } = loadModules();
    const key = 'cc_group:grp_device';
    const scope = {
      source: 'catscompany',
      sessionKey: key,
      topicId: 'grp_device',
      topicType: 'group',
      actorUserId: 'usr38',
      agentId: 'usr982',
      identityTrust: 'server_canonical',
      isTrusted: true,
      permissionsSource: 'server_canonical_message',
    };
    const metadata = {
      catsco_identity: {
        permissions: { source: 'server_canonical_message' },
        device_grants: [{ kind: 'user_device_grant', deviceId: 'dev-1', ownerUserId: 'usr38' }],
      },
      xiaoba_runtime: {
        schema: 'xiaoba.runtime.v1',
        devices: [{ userId: 'usr38', deviceId: 'dev-1', userName: 'ck', os: 'windows' }],
      },
    };

    const captured = sanitizeDeviceContext(metadata, scope as any);
    assert.ok(captured, 'device metadata must be captured');
    assert.equal(captured.executionScope?.actorUserId, 'usr38');
    assert.ok(captured.catscoIdentity, 'identity metadata must be kept');
    assert.ok(captured.xiaobaRuntime, 'runtime routes must be kept');

    markInterruptedTurn(key, { topic: 'grp_device', reason: 'oom-kill', deviceContext: captured });

    const scanned = collectInterruptedTurns({
      stateDir: path.join(testRoot, 'data', 'session-state'),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
    });
    assert.equal(scanned.length, 1);
    const restored = scanned[0].deviceContext;
    assert.ok(restored, 'the scan must hand the context back to the resume');
    assert.equal(restored.executionScope?.actorUserId, 'usr38');
    assert.equal(restored.executionScope?.identityTrust, 'server_canonical');
    assert.equal(restored.executionScope?.isTrusted, true);
    assert.deepEqual(restored.xiaobaRuntime, metadata.xiaoba_runtime);
    assert.deepEqual(restored.catscoIdentity, metadata.catsco_identity);
  });

  test('connector credentials never reach the state file', async () => {
    // ParsedCatsMessage documents connector grants as "never copied into model
    // text or durable history", because they carry an actor_token. The device
    // context must therefore whitelist keys rather than copy metadata wholesale.
    const { markInterruptedTurn, sanitizeDeviceContext, SessionStore } = loadModules();
    const key = 'cc_group:grp_secret';
    const metadata = {
      catsco_identity: { permissions: { source: 'server_canonical_message' } },
      // The credential-bearing key:
      catsco_skill_connectors: {
        schema: 'catsco.skill_connectors.v1',
        grants: [{ provider: 'shimo', skill_id: 'a/b', actor_token: 'SECRET-TOKEN-VALUE' }],
      },
    };

    const captured = sanitizeDeviceContext(metadata, {
      source: 'catscompany',
      sessionKey: key,
      topicId: 'grp_secret',
      topicType: 'group',
      actorUserId: 'usr38',
      identityTrust: 'server_canonical',
      isTrusted: true,
    } as any);
    assert.ok(captured);
    assert.equal(
      (captured as any).catscoSkillConnectors,
      undefined,
      'the connector key must not be part of the stored shape',
    );

    markInterruptedTurn(key, { topic: 'grp_secret', reason: 'oom-kill', deviceContext: captured });

    const onDisk = fs.readFileSync(
      path.join(testRoot, 'data', 'session-state', 'cc_group_grp_secret.json'),
      'utf-8',
    );
    assert.ok(
      !onDisk.includes('SECRET-TOKEN-VALUE'),
      'an actor token must never be written to the state file',
    );
    assert.ok(!onDisk.includes('actor_token'), 'no connector grant fields may leak');
    assert.ok(onDisk.includes('usr38'), 'the device context itself must still be stored');
    assert.ok(SessionStore.getInstance().loadRuntimeState(key).interruptedTurn?.deviceContext);
  });

  test('a marker without device context still resumes', async () => {
    // Backward compatibility: markers written before this field existed must
    // keep working. An older marker simply resumes with no device access.
    const { markInterruptedTurn, collectInterruptedTurns } = loadModules();
    const key = 'cc_group:grp_legacy';

    markInterruptedTurn(key, { topic: 'grp_legacy', reason: 'oom-kill' });

    const scanned = collectInterruptedTurns({
      stateDir: path.join(testRoot, 'data', 'session-state'),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
    });
    assert.equal(scanned.length, 1, 'a legacy marker must remain resumable');
    assert.equal(scanned[0].deviceContext, undefined);
  });

  test('a crash-loop rewrite keeps the captured device context', async () => {
    // The resume itself can be killed. The shutdown rewrite must not silently
    // drop the device access, or a task that survives one restart would lose
    // user-device tools on the next.
    const { markInterruptedTurn, collectInterruptedTurns } = loadModules();
    const key = 'cc_group:grp_loop_ctx';
    const captured = {
      executionScope: {
        source: 'catscompany',
        sessionKey: key,
        topicId: 'grp_loop_ctx',
        topicType: 'group',
        actorUserId: 'usr38',
        identityTrust: 'server_canonical',
        isTrusted: true,
      },
      xiaobaRuntime: {
        schema: 'xiaoba.runtime.v1',
        devices: [{ userId: 'usr38', deviceId: 'dev-9' }],
      },
    };

    markInterruptedTurn(key, { topic: 'grp_loop_ctx', reason: 'oom-kill', deviceContext: captured });
    // Re-interrupted without context (the shutdown path always has the task, but
    // the fallback must still hold what the first marker knew).
    markInterruptedTurn(key, { topic: 'grp_loop_ctx', reason: 'oom-kill' });

    const scanned = collectInterruptedTurns({
      stateDir: path.join(testRoot, 'data', 'session-state'),
      maxAgeMs: 30 * 60_000,
      maxAttempts: 2,
    });
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].deviceContext?.executionScope?.actorUserId, 'usr38');
    assert.equal(scanned[0].deviceContext?.xiaobaRuntime?.schema, 'xiaoba.runtime.v1');
  });

  test('an oversized device context is refused rather than persisted', async () => {
    // The startup scan reads every state file on boot, so a pathological
    // payload must not be written into one.
    const { sanitizeDeviceContext } = loadModules();
    const huge = {
      xiaoba_runtime: {
        schema: 'xiaoba.runtime.v1',
        devices: Array.from({ length: 4000 }, (_, i) => ({
          userId: `usr${i}`,
          deviceId: `dev-${i}`,
          userName: 'x'.repeat(20),
        })),
      },
    };
    assert.equal(
      sanitizeDeviceContext(huge as any, undefined),
      undefined,
      'an oversized context must be dropped, not stored',
    );
  });

  test('the resume path actually forwards the rebuilt device access', async () => {
    // The module tests above prove the context survives storage, but they
    // cannot see whether the connector hands it to the resumed turn -- and a
    // mutation that deleted that wiring left every one of them green. This
    // pins the call site itself: capture at task start, mark at shutdown,
    // rebuild and forward at resume. Without all four links the user's own
    // computer becomes unreachable after a restart.
    const connector = fs.readFileSync(
      path.join(originalCwd, 'src', 'catscompany', 'index.ts'),
      'utf-8',
    );

    assert.match(
      connector,
      /sanitizeDeviceContext\(msg\.metadata,\s*msg\.executionScope\)/,
      'message handling must capture the device context',
    );
    // Every shutdown path must carry it. Asserting "at least one match" is not
    // enough: index.ts retires tasks in two places (the shutdown sweep and the
    // destroy orphan re-sweep), and mutating only one of them left this test
    // green until it counted all of them.
    const markCalls = connector.match(/this\.markInterruptedTurn\([^;]*?\);/gs) ?? [];
    assert.ok(markCalls.length >= 2, `expected both shutdown paths, found ${markCalls.length}`);
    for (const call of markCalls) {
      assert.match(
        call,
        /task\.deviceContext/,
        `every interruption marker must carry the device context: ${call.slice(0, 90)}`,
      );
    }
    assert.match(
      connector,
      /this\.runInterruptedTurnResume\(sessionKey,\s*topic,\s*notice,\s*candidate\.deviceContext\)/,
      'the scan result must be handed to the resume',
    );
    assert.match(
      connector,
      /const resumedContext = this\.rebuildDeviceContext\(deviceContext\)/,
      'the resume must rebuild the context it was given',
    );
    for (const field of ['executionScope', 'deviceGrants', 'deviceSelection', 'targetRoutes']) {
      assert.match(
        connector,
        new RegExp(`${field}: resumedContext\\.${field}`),
        `the resumed turn must receive ${field}`,
      );
    }
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
    classifyShutdownReason: recovery.classifyShutdownReason,
    parseOomKillCount: recovery.parseOomKillCount,
    sanitizeDeviceContext: recovery.sanitizeDeviceContext,
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
