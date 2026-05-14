import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as path from 'path';
import * as os from 'os';

const SCRIPT = path.resolve(__dirname, '../skills/session-analytics/session_analytics.py');
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/sessions/catscompany');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

const execOpts: ExecSyncOptionsWithStringEncoding = { encoding: 'utf-8', timeout: 10000 };

function run(args: string): string {
  return execSync(`${PYTHON} "${SCRIPT}" --log-dir "${FIXTURE_DIR}" ${args}`, execOpts);
}

describe('session-analytics', () => {
  test('returns non-zero tokens for fixture date', () => {
    const output = run('--date 2026-05-12');
    const report = JSON.parse(output);
    assert.ok(report.summary.total_tokens.total > 0, 'total tokens should be > 0');
  });

  test('counts tokens from production schema (tokens.prompt/completion)', () => {
    const output = run('--date 2026-05-12');
    const report = JSON.parse(output);
    assert.ok(report.summary.total_tokens.input > 0, 'input tokens > 0');
    assert.ok(report.summary.total_tokens.output > 0, 'output tokens > 0');
    // If only legacy was counted, total would be 18600; with production schema it's 20850
    assert.ok(report.summary.total_tokens.total > 18600, 'production schema tokens should be included');
  });

  test('markdown format outputs valid headers', () => {
    const output = run('--date 2026-05-12 --format markdown');
    assert.ok(output.includes('# Session Analytics Report'), 'should have main header');
    assert.ok(output.includes('## Overview'), 'should have Overview section');
    assert.ok(output.includes('## Tool Usage'), 'should have Tool Usage section');
  });

  test('--errors flag returns error report', () => {
    const output = run('--date 2026-05-12 --errors');
    const report = JSON.parse(output);
    assert.ok('total_errors' in report, 'should have total_errors field');
    assert.ok(report.total_errors > 0, 'fixture has at least one error');
  });

  test('non-existent log dir exits with error JSON', () => {
    const fakePath = path.join(os.tmpdir(), 'nonexistent_session_dir_xyz_' + Date.now());
    try {
      execSync(`${PYTHON} "${SCRIPT}" --log-dir "${fakePath}"`, execOpts);
      assert.fail('should have thrown');
    } catch (err: any) {
      const result = JSON.parse(err.stdout || err.stderr);
      assert.ok(result.error, 'should return error message');
    }
  });
});
