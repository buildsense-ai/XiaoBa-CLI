import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { shouldDisableHardwareAcceleration } = require('../electron/gpu-compat.js');

const env = (extra = {}) => ({ ...extra });

test('software rendering defaults to Intel Macs only', () => {
  assert.equal(shouldDisableHardwareAcceleration({ platform: 'darwin', arch: 'x64', env: env() }), true);
  assert.equal(shouldDisableHardwareAcceleration({ platform: 'darwin', arch: 'arm64', env: env() }), false);
  assert.equal(shouldDisableHardwareAcceleration({ platform: 'win32', arch: 'x64', env: env() }), false);
  assert.equal(shouldDisableHardwareAcceleration({ platform: 'linux', arch: 'x64', env: env() }), false);
  assert.equal(shouldDisableHardwareAcceleration({ platform: 'win32', arch: 'arm64', env: env() }), false);
});

test('XIAOBA_DISABLE_GPU override forces software rendering on any platform', () => {
  for (const value of ['1', 'true']) {
    assert.equal(
      shouldDisableHardwareAcceleration({ platform: 'win32', arch: 'x64', env: env({ XIAOBA_DISABLE_GPU: value }) }),
      true,
    );
    assert.equal(
      shouldDisableHardwareAcceleration({ platform: 'darwin', arch: 'arm64', env: env({ XIAOBA_DISABLE_GPU: value }) }),
      true,
    );
  }
  assert.equal(
    shouldDisableHardwareAcceleration({ platform: 'win32', arch: 'x64', env: env({ XIAOBA_DISABLE_GPU: '0' }) }),
    false,
  );
});
