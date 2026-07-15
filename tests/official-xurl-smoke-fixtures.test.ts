import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  listOfficialXurlSmokeFixtures,
  materializeOfficialXurlSmokeFixtures,
  validateOfficialXurlSmokeFixtures,
} from './helpers/official-xurl-smoke-fixtures';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('official xurl smoke fixtures', () => {
  test('fixture roots exist and contain parseable raw provider files', () => {
    assert.doesNotThrow(() => validateOfficialXurlSmokeFixtures());
    const fixtures = listOfficialXurlSmokeFixtures();
    assert.deepEqual(fixtures.map(fixture => fixture.provider), ['codex', 'claude', 'pi']);
  });

  test('materialized fixture roots expose isolated provider env vars and appendable files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-official-xurl-fixtures-'));
    tempRoots.push(root);

    const materialized = materializeOfficialXurlSmokeFixtures(root);
    assert.ok(materialized.env.CODEX_HOME);
    assert.ok(materialized.env.CLAUDE_CONFIG_DIR);
    assert.ok(materialized.env.PI_CODING_AGENT_DIR);

    const codexFile = path.join(
      materialized.env.CODEX_HOME,
      'sessions',
      '2026',
      '02',
      '23',
      'rollout-2026-02-23T06-55-38-codex-smoke-session.jsonl',
    );
    const before = fs.readFileSync(codexFile, 'utf8').trim().split('\n').length;
    materialized.appendStableCompletedTurn('codex');
    const after = fs.readFileSync(codexFile, 'utf8').trim().split('\n').length;
    assert.equal(after, before + 2);
  });
});
