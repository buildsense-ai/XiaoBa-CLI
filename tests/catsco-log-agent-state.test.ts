import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearCatscoLogToken,
  ensureCatscoDeviceId,
  loadCatscoLogAgentState,
  saveCatscoLogAgentState,
} from '../src/utils/catsco-log-agent-state';

describe('catsco log agent state', () => {
  test('creates stable device id and atomically persists state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catslog-state-'));
    try {
      const statePath = path.join(root, 'data', 'catsco-log-agent-state.json');
      const state = loadCatscoLogAgentState(statePath);
      const deviceId = ensureCatscoDeviceId(state);
      assert.equal(ensureCatscoDeviceId(state), deviceId);

      state.token = 'secret-upload-token';
      state.tokenId = 'token-1';
      state.userId = 'catsco_123';
      state.uploaded['logs/sessions/chat/2026-05-14/chat_cli.jsonl'] = {
        size: 12,
        mtimeMs: 34,
        uploadedAt: '2026-05-14T00:00:00.000Z',
      };
      saveCatscoLogAgentState(statePath, state);

      const loaded = loadCatscoLogAgentState(statePath);
      assert.equal(loaded.deviceId, deviceId);
      assert.equal(loaded.token, 'secret-upload-token');
      assert.equal(Object.keys(loaded.uploaded).length, 1);

      clearCatscoLogToken(loaded);
      assert.equal(loaded.deviceId, deviceId);
      assert.equal(Object.keys(loaded.uploaded).length, 1);
      assert.equal(loaded.token, undefined);
      assert.equal(loaded.tokenId, undefined);
      assert.equal(loaded.userId, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('quarantines corrupt state and marks upload as paused', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catslog-state-'));
    try {
      const statePath = path.join(root, 'data', 'catsco-log-agent-state.json');
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, '{not json', 'utf-8');

      const state = loadCatscoLogAgentState(statePath);
      assert.equal(state.stateCorrupt, true);
      assert.equal(fs.existsSync(statePath), false);
      assert.ok(fs.readdirSync(path.dirname(statePath)).some(name => name.includes('.corrupt.')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
