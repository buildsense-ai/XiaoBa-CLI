import assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { GauzMemClient } from '../src/utils/gauzmem-client';
import { shouldUseManagedGauzMem } from '../src/utils/gauzmem-managed-sidecar';
import { resolveGauzMemProjectPath } from '../src/utils/gauzmem-paths';

test('GauzMem managed mode is explicit and keeps roots resolved', () => {
  assert.equal(shouldUseManagedGauzMem({ GAUZMEM_MODE: 'managed' } as NodeJS.ProcessEnv), true);
  assert.equal(shouldUseManagedGauzMem({ GAUZMEM_TRANSPORT: 'auto' } as NodeJS.ProcessEnv), true);
  assert.equal(shouldUseManagedGauzMem({ GAUZMEM_MANAGED: 'true' } as NodeJS.ProcessEnv), true);
  assert.equal(shouldUseManagedGauzMem({ GAUZMEM_MODE: 'http' } as NodeJS.ProcessEnv), false);

  const client = new GauzMemClient({
    env: {
      GAUZMEM_ENABLED: 'true',
      GAUZMEM_MODE: 'managed',
      GAUZMEM_URL: 'http://127.0.0.1:8799',
      GAUZMEM_ROOTS: ['logs/sessions', '/tmp/gauzmem-fixture'].join(path.delimiter),
      GAUZMEM_TIMEOUT_MS: '45000',
    } as NodeJS.ProcessEnv,
  });

  assert.equal(client.enabled, true);
  assert.equal(client.managed, true);
  assert.equal(client.baseUrl, 'http://127.0.0.1:8799');
  assert.equal(client.timeoutMs, 45000);
  assert.deepEqual(client.rootPaths, [
    resolveGauzMemProjectPath('logs/sessions'),
    '/tmp/gauzmem-fixture',
  ]);
});
