import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('Logger', () => {
  let testRoot: string;
  let originalCwd: string;
  let Logger: any;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-logger-'));
    process.chdir(testRoot);
  });

  afterEach(async () => {
    Logger?.closeLogFile();
    await waitForFlush();
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('runtime log lines include session_id from async context', async () => {
    delete require.cache[require.resolve('../src/utils/logger')];
    delete require.cache[require.resolve('../src/utils/session-turn-logger')];
    Logger = require('../src/utils/logger').Logger;
    const { SessionTurnLogger } = require('../src/utils/session-turn-logger');

    Logger.openLogFile('test', undefined, true);
    const sessionLogger = new SessionTurnLogger('feishu', 'user:ou_demo');

    Logger.info('outside context');
    await Logger.withSessionContext('user:ou_demo', sessionLogger, async () => {
      Logger.info('inside context');
      await Promise.resolve();
      Logger.info('still inside context');
    });

    const globalLogPath = Logger.getLogFilePath();
    const sessionLogPath = sessionLogger.getLogFilePath();
    assert.ok(globalLogPath);
    assert.ok(sessionLogPath);

    Logger.closeLogFile();
    await waitForFlush();

    const globalContent = fs.readFileSync(globalLogPath, 'utf-8');
    assert.match(globalContent, /\[INFO\] outside context/);
    assert.doesNotMatch(globalContent, /inside context/);
    assert.doesNotMatch(globalContent, /still inside context/);

    const sessionEntries = fs.readFileSync(sessionLogPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.deepStrictEqual(
      sessionEntries.map(entry => ({
        entry_type: entry.entry_type,
        level: entry.level,
        message: entry.message,
        session_id: entry.session_id,
      })),
      [
        {
          entry_type: 'runtime',
          level: 'INFO',
          message: 'inside context',
          session_id: 'user:ou_demo',
        },
        {
          entry_type: 'runtime',
          level: 'INFO',
          message: 'still inside context',
          session_id: 'user:ou_demo',
        },
      ],
    );
  });
  test('writes route-derived agent identity on every session-log entry', () => {
    delete require.cache[require.resolve('../src/utils/session-turn-logger')];
    const { SessionTurnLogger } = require('../src/utils/session-turn-logger');
    const sessionLogger = new SessionTurnLogger(
      'catscompany',
      'cc_group:grp_80',
      {
        agent_id: 'usr407',
        agent_body_id: 'body-main',
        trust: 'server_canonical',
        source: 'metadata.catsco_identity',
      },
    );

    sessionLogger.logTurn('hello', 'world', [], { prompt: 1, completion: 1 });
    sessionLogger.logRuntime('INFO', 'runtime event');
    const entries = fs.readFileSync(sessionLogger.getLogFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.deepEqual(entry.agent_identity, {
        agent_id: 'usr407',
        agent_body_id: 'body-main',
        trust: 'server_canonical',
        source: 'metadata.catsco_identity',
      });
    }
  });

  test('omits malformed agent identity rather than adding unbounded log metadata', () => {
    delete require.cache[require.resolve('../src/utils/session-turn-logger')];
    const { SessionTurnLogger } = require('../src/utils/session-turn-logger');
    const sessionLogger = new SessionTurnLogger('catscompany', 'cc_group:grp_80', {
      agent_id: `usr407\n${'x'.repeat(300)}`,
      trust: 'server_canonical',
    });
    sessionLogger.logRuntime('INFO', 'runtime event');

    const entry = JSON.parse(fs.readFileSync(sessionLogger.getLogFilePath(), 'utf8').trim());
    assert.equal('agent_identity' in entry, false);
  });

  test('late route identity enriches a legacy logger without allowing a relabel', () => {
    delete require.cache[require.resolve('../src/utils/session-turn-logger')];
    const { SessionTurnLogger } = require('../src/utils/session-turn-logger');
    const sessionLogger = new SessionTurnLogger('catscompany', 'cc_group:grp_81');
    assert.equal(sessionLogger.setAgentIdentity({
      agent_id: 'bot-bot-3332', trust: 'legacy_context', source: 'legacy.route',
    }), true);
    assert.equal(sessionLogger.setAgentIdentity({
      agent_id: 'bot-bot-3332', trust: 'server_canonical', agent_body_id: 'body-1', source: 'metadata.catsco_identity',
    }), true);
    assert.equal(sessionLogger.setAgentIdentity({
      agent_id: 'other-agent', trust: 'server_canonical',
    }), false);
    sessionLogger.logRuntime('INFO', 'late identity');
    const entry = JSON.parse(fs.readFileSync(sessionLogger.getLogFilePath(), 'utf8').trim());
    assert.deepEqual(entry.agent_identity, {
      agent_id: 'bot-bot-3332',
      agent_body_id: 'body-1',
      trust: 'server_canonical',
      source: 'metadata.catsco_identity',
    });
  });

  test('write stream errors are contained and file logging degrades', async () => {
    delete require.cache[require.resolve('../src/utils/logger')];
    delete require.cache[require.resolve('../src/utils/session-turn-logger')];
    Logger = require('../src/utils/logger').Logger;

    Logger.openLogFile('test', undefined, true);
    const stream: any = (Logger as any).logStream;
    assert.ok(stream, 'log stream should be open');

    // Simulate the real-world failure we observed on a full disk: the stream
    // emits an asynchronous 'error' (e.g. EDQUOT/ENOSPC/EBADF). Without a
    // listener this becomes an unhandled 'error' event and kills the process.
    stream.destroy(Object.assign(new Error('EDQUOT: Disk quota exceeded'), { code: 'EDQUOT' }));
    await waitForFlush();

    assert.strictEqual((Logger as any).logStream, null, 'broken stream must be dropped');
    assert.doesNotThrow(() => Logger.info('after degradation'));
    assert.doesNotThrow(() => Logger.error('after degradation error'));
  });

  test('openLogFile survives an unusable log directory', async () => {
    delete require.cache[require.resolve('../src/utils/logger')];
    Logger = require('../src/utils/logger').Logger;
    const { PathResolver } = require('../src/utils/path-resolver');

    // Occupy the logs directory path with a regular file so mkdirSync fails.
    const logsPath = PathResolver.getLogsPath();
    fs.mkdirSync(path.dirname(logsPath), { recursive: true });
    fs.writeFileSync(logsPath, 'not-a-directory');

    assert.doesNotThrow(() => Logger.openLogFile('test', undefined, true));
    assert.doesNotThrow(() => Logger.info('file logging unavailable'));
    assert.strictEqual(Logger.getLogFilePath(), null);
  });

  test('SessionTurnLogger degrades when its log directory cannot be created', () => {
    delete require.cache[require.resolve('../src/utils/session-turn-logger')];
    const { SessionTurnLogger } = require('../src/utils/session-turn-logger');
    const { PathResolver } = require('../src/utils/path-resolver');

    const logsPath = PathResolver.getLogsPath('sessions');
    fs.mkdirSync(path.dirname(logsPath), { recursive: true });
    fs.writeFileSync(logsPath, 'not-a-directory');

    let sessionLogger: any;
    assert.doesNotThrow(() => { sessionLogger = new SessionTurnLogger('catscompany', 'agent:usr1619'); });
    assert.strictEqual(sessionLogger.getLogFilePath(), '');
    assert.doesNotThrow(() => sessionLogger.logTurn('hi', 'hello', [], { prompt: 1, completion: 1 }));
  });

});

function waitForFlush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 20));
}
