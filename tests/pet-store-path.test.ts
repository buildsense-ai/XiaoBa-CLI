import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvePetDataDir } from '../src/pet/pet-store';

test('pet state follows the shared runtime data root instead of the worktree', () => {
  const cwd = path.resolve('/tmp/xiaoba-worktree');
  const dataRoot = path.resolve('/tmp/xiaoba-runtime-data');
  assert.equal(
    resolvePetDataDir({ XIAOBA_USER_DATA_DIR: dataRoot }, cwd),
    path.join(dataRoot, 'data', 'pet'),
  );
});

test('an explicit pet directory remains available as a compatibility override', () => {
  const cwd = path.resolve('/tmp/xiaoba-worktree');
  assert.equal(
    resolvePetDataDir({ XIAOBA_PET_DATA_DIR: 'pet-experiment' }, cwd),
    path.join(cwd, 'pet-experiment'),
  );
});

test('the packaged app keeps its existing pet state location', () => {
  const cwd = path.resolve('/tmp/xiaoba-worktree');
  const electronData = path.resolve('/tmp/xiaoba-electron-data');
  assert.equal(
    resolvePetDataDir({ XIAOBA_ELECTRON_USER_DATA_DIR: electronData }, cwd),
    path.join(electronData, 'pet'),
  );
});
