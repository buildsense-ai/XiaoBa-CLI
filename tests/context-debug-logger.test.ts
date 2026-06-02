import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContextDebugLogger } from '../src/utils/context-debug-logger';

test('SDK debug dumps redact provider hidden thinking blocks', () => {
  const previous = process.env.CONTEXT_DEBUG;
  process.env.CONTEXT_DEBUG = 'true';
  const requestId = `redact42-${Date.now()}`;
  const debugDir = path.resolve('logs/context-debug');

  try {
    ContextDebugLogger.dumpSdkBoundary('before', requestId, {
      params: {
        messages: [{
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden chain text', signature: 'sig_secret' },
            { type: 'redacted_thinking', data: 'opaque_secret' },
          ],
        }],
      },
    });

    const file = fs.readdirSync(debugDir).find(name =>
      name.includes('_sdk_before_redact42')
    );
    assert.ok(file, 'expected SDK debug dump file');
    const content = fs.readFileSync(path.join(debugDir, file), 'utf-8');

    assert.match(content, /redacted hidden thinking/);
    assert.match(content, /redacted thinking signature/);
    assert.match(content, /redacted thinking data/);
    assert.doesNotMatch(content, /hidden chain text/);
    assert.doesNotMatch(content, /sig_secret/);
    assert.doesNotMatch(content, /opaque_secret/);

    fs.unlinkSync(path.join(debugDir, file));
  } finally {
    if (previous === undefined) {
      delete process.env.CONTEXT_DEBUG;
    } else {
      process.env.CONTEXT_DEBUG = previous;
    }
  }
});
