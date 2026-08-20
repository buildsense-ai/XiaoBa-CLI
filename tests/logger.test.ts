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

});

function waitForFlush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 20));
}
