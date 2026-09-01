import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReleaseRetentionPlan,
  compareReleaseVersions,
} from '../scripts/plan-release-retention.mjs';

const now = Date.parse('2026-08-17T00:00:00Z');
const oldDate = '2026-06-01T00:00:00Z';

function object(Key: string, LastModified = oldDate, Size = 10) {
  return { Key, LastModified, Size };
}

function release(version: string, modified = oldDate) {
  return [
    object(`update/CatsCo-${version}-win.exe`, modified),
    object(`update/CatsCo-${version}-win.exe.blockmap`, modified),
    object(`update/CatsCo-${version}-linux.AppImage`, modified),
    object(`update/macos-x64/CatsCo-${version}-mac-x64.dmg`, modified),
    object(`update/macos-arm64/CatsCo-${version}-mac-arm64.zip`, modified),
  ];
}

test('semantic versions sort numerically', () => {
  assert.equal(compareReleaseVersions('1.10.0', '1.9.9') > 0, true);
  assert.equal(compareReleaseVersions('1.4.8', '1.4.8-beta.1') > 0, true);
});

test('protects current metadata and the newest two complete releases', () => {
  const plan = buildReleaseRetentionPlan({
    objects: [
      ...release('1.0.1'),
      ...release('1.1.0'),
      ...release('1.4.6'),
      ...release('1.4.7'),
      ...release('1.4.8'),
      object('update/latest.yml'),
      object('update/worker/1.4.8/manifest.json'),
    ],
    metadataDocuments: ['version: 1.4.8\npath: CatsCo-1.4.8-win.exe\n'],
    keepVersions: 2,
    minAgeDays: 30,
    maxDeleteObjects: 80,
    now,
  });

  assert.deepEqual(plan.protectedVersions, ['1.4.8', '1.4.7']);
  assert.deepEqual(plan.deleteVersions, ['1.0.1', '1.1.0', '1.4.6']);
  assert.equal(plan.deleteObjects.length, 15);
  assert.equal(plan.deleteObjects.some((row) => row.key.includes('1.4.8')), false);
  assert.deepEqual(plan.ignoredKeys.sort(), ['update/latest.yml', 'update/worker/1.4.8/manifest.json']);
});

test('does not delete a release with any recently republished artifact', () => {
  const rows = release('1.4.6');
  rows[2] = object(rows[2].Key, '2026-08-10T00:00:00Z');
  const plan = buildReleaseRetentionPlan({
    objects: [...rows, ...release('1.4.7'), ...release('1.4.8')],
    metadataDocuments: ['version: 1.4.8\n'],
    keepVersions: 2,
    minAgeDays: 30,
    maxDeleteObjects: 80,
    now,
  });
  assert.deepEqual(plan.deleteVersions, []);
});

test('deletion cap never splits a release group', () => {
  const plan = buildReleaseRetentionPlan({
    objects: [
      ...release('1.0.0'),
      ...release('1.0.1'),
      ...release('1.4.6'),
      ...release('1.4.7'),
      ...release('1.4.8'),
    ],
    metadataDocuments: ['version: 1.4.8\n'],
    keepVersions: 3,
    minAgeDays: 30,
    maxDeleteObjects: 5,
    now,
  });
  assert.deepEqual(plan.deleteVersions, ['1.0.0']);
  assert.deepEqual(plan.deferredVersions, ['1.0.1']);
  assert.equal(plan.deleteObjects.length, 5);
});
