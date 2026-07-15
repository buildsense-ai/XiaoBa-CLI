import assert from 'node:assert/strict';
import test from 'node:test';

const {
  MAX_PUBLIC_UPDATE_ERROR_LENGTH,
  MISSING_MACOS_ZIP_MESSAGE,
  normalizeUpdateError,
} = require('../electron/update-errors');

test('macOS missing ZIP errors are not misclassified as checksum failures', () => {
  const error = Object.assign(
    new Error('ZIP file not provided: [{"url":"CatsCo.dmg","sha512":"abc"}]'),
    { code: 'ERR_UPDATER_ZIP_FILE_NOT_FOUND' },
  );

  assert.deepEqual(normalizeUpdateError(error, 'UPDATE_DOWNLOAD_FAILED'), {
    reason: 'MACOS_UPDATE_ZIP_MISSING',
    message: MISSING_MACOS_ZIP_MESSAGE,
  });
});

test('actual checksum failures retain package validation classification', () => {
  assert.deepEqual(
    normalizeUpdateError(new Error('sha512 checksum mismatch'), 'UPDATE_DOWNLOAD_FAILED'),
    {
      reason: 'PACKAGE_VALIDATION_FAILED',
      message: 'sha512 checksum mismatch',
    },
  );
});

test('public updater errors are capped to a readable size', () => {
  const result = normalizeUpdateError(new Error('x'.repeat(2000)), 'UPDATE_DOWNLOAD_FAILED');
  assert.equal(result.reason, 'UPDATE_DOWNLOAD_FAILED');
  assert.equal(result.message.length, MAX_PUBLIC_UPDATE_ERROR_LENGTH + 3);
  assert.match(result.message, /\.\.\.$/);
});
