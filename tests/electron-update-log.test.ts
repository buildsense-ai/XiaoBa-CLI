import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { createUpdateLogger, sanitizeUpdateLogMessage } = require('../electron/update-log');

test('updater logs redact credentials and URL secrets', () => {
  const message = sanitizeUpdateLogMessage(
    'GET https://example.test/file?token=secret&api_key=hidden Authorization: Bearer abc.def',
  );
  assert.doesNotMatch(message, /secret|hidden|abc\.def/);
  assert.match(message, /\[REDACTED\]/);
});

test('updater logs are persisted and rotated within a bounded size', () => {
  const root = mkdtempSync(join(tmpdir(), 'catsco-updater-log-'));
  const logPath = join(root, 'logs', 'updater.log');
  const silentConsole = { log() {}, warn() {}, error() {} };
  try {
    const logger = createUpdateLogger({ logPath, maxBytes: 40, consoleImpl: silentConsole });
    logger.info('first update message long enough to rotate');
    logger.info('second update message');
    assert.match(readFileSync(logPath, 'utf8'), /second update message/);
    assert.match(readFileSync(`${logPath}.previous`, 'utf8'), /first update message/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
