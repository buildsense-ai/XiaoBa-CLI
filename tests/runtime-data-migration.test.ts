import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyRuntimeDataMigration,
  findLegacyRuntimeArtifacts,
  planRuntimeDataMigration,
} from '../src/runtime/data-migration';

describe('runtime data migration', () => {
  test('copies known runtime artifacts without deleting the source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-data-migration-'));
    const source = path.join(root, 'legacy-worktree');
    const target = path.join(root, 'profiles', 'default');
    fs.mkdirSync(path.join(source, 'logs', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(source, 'data'), { recursive: true });
    fs.writeFileSync(path.join(source, '.env'), 'SECRET=test\n', 'utf8');
    fs.writeFileSync(path.join(source, 'logs', 'sessions', 'one.jsonl'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(source, 'data', 'state.json'), '{"ok":true}\n', 'utf8');

    const preview = planRuntimeDataMigration(source, target);
    assert.equal(preview.totals.copy, 3);
    assert.equal(fs.existsSync(target), false);

    const result = applyRuntimeDataMigration(preview);
    assert.equal(result.applied, true);
    assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'SECRET=test\n');
    assert.equal(fs.readFileSync(path.join(target, 'data', 'state.json'), 'utf8'), '{"ok":true}\n');
    assert.equal(fs.existsSync(path.join(source, '.env')), true);
    assert.equal(fs.existsSync(result.manifestPath!), true);
    assert.equal(fs.statSync(path.join(target, '.env')).mode & 0o777, 0o600);
  });

  test('leaves conflicting target files unchanged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-data-conflict-'));
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(path.join(source, 'data'), { recursive: true });
    fs.mkdirSync(path.join(target, 'data'), { recursive: true });
    fs.writeFileSync(path.join(source, 'data', 'state.json'), 'source', 'utf8');
    fs.writeFileSync(path.join(target, 'data', 'state.json'), 'target', 'utf8');

    const plan = planRuntimeDataMigration(source, target);
    assert.equal(plan.totals.conflict, 1);
    const result = applyRuntimeDataMigration(plan);

    assert.equal(result.totals.conflict, 1);
    assert.equal(fs.readFileSync(path.join(target, 'data', 'state.json'), 'utf8'), 'target');
  });

  test('rejects nested migration roots', () => {
    assert.throws(
      () => planRuntimeDataMigration('/tmp/xiaoba-source', '/tmp/xiaoba-source/profile'),
      /must be separate, non-nested directories/,
    );
  });

  test('does not mistake bundled data and skills directories for legacy user data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-data-markers-'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    assert.deepEqual(findLegacyRuntimeArtifacts(root), []);

    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data', 'sessions'), { recursive: true });
    assert.deepEqual(findLegacyRuntimeArtifacts(root), ['logs', 'data/sessions']);
  });
});
