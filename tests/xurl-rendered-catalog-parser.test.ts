import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import { XURL_TEST_HELPERS } from '../src/utils/xurl-session-log-source';

function pathCatalog(providers: readonly string[]): { uri: string; markdown: string } {
  const uri = 'agents:///Users/test/dev-env-transfer?providers=codex&limit=1';
  const providerLines = providers.map(provider => `  - '${provider}'`).join('\n');
  const markdown = [
    '---',
    `uri: '${uri}'`,
    "scope_path: '/Users/test/dev-env-transfer'",
    "mode: 'path_thread_query'",
    "limit: '1'",
    'providers:',
    providerLines,
    'threads:',
    "  provider: 'codex'",
    "  thread_id: 'thread-001'",
    "  uri: 'agents://codex/thread-001'",
    '---',
    '',
    '# Threads',
    '',
    '- Matched: `1`',
    '',
    '## 1. `agents://codex/thread-001`',
    '',
    '- Provider: `codex`',
    '- Thread ID: `thread-001`',
    '- Updated At: `1784353472`',
    '',
  ].join('\n');
  return { uri, markdown };
}

describe('rendered xurl catalog parser', () => {
  test('accepts official path-scope catalogs that declare a plural providers list', () => {
    const catalog = pathCatalog(['codex']);

    const parsed = XURL_TEST_HELPERS.parseRenderedCatalog(catalog.markdown, 'codex', catalog.uri);

    assert.equal(parsed.provider, 'codex');
    assert.deepEqual(parsed.threads.map(thread => thread.threadId), ['thread-001']);
  });

  test('rejects a path-scope catalog for a different provider', () => {
    const catalog = pathCatalog(['pi']);

    assert.throws(
      () => XURL_TEST_HELPERS.parseRenderedCatalog(catalog.markdown, 'codex', catalog.uri),
      /provider mismatch: expected codex, got pi/,
    );
  });

  test('rejects ambiguous multi-provider path catalogs', () => {
    const catalog = pathCatalog(['codex', 'pi']);

    assert.throws(
      () => XURL_TEST_HELPERS.parseRenderedCatalog(catalog.markdown, 'codex', catalog.uri),
      /providers must contain exactly one provider, got 2/,
    );
  });
});
