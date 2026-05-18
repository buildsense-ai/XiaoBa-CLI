import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCatscoLogAgentConfig } from '../src/utils/catsco-log-agent-config';

describe('catsco log agent config', () => {
  test('uses production upload defaults and validates API base URL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catslog-config-'));
    try {
      const defaults = getCatscoLogAgentConfig(root, {});
      assert.equal(defaults.enabled, true);
      assert.equal(defaults.apiBaseUrl, 'https://logs.catsco.fun:8000');

      assert.equal(getCatscoLogAgentConfig(root, {
        CATSCO_LOG_UPLOAD_ENABLED: 'false',
      }).enabled, false);

      const enabled = getCatscoLogAgentConfig(root, {
        CATSCO_LOG_API_BASE_URL: 'https://logs.example.test:8000/path',
      });
      assert.equal(enabled.enabled, true);
      assert.equal(enabled.apiBaseUrl, 'https://logs.example.test:8000');

      const insecure = getCatscoLogAgentConfig(root, {
        CATSCO_LOG_UPLOAD_ENABLED: 'true',
        CATSCO_LOG_API_BASE_URL: 'http://logs.example.test',
      });
      assert.equal(insecure.apiBaseUrl, '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reads local dotenv login token and contains state/log paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catslog-config-'));
    try {
      fs.writeFileSync(
        path.join(root, '.env'),
        [
          'CATSCO_USER_TOKEN=dotenv-token',
          'CATSCO_LOG_UPLOAD_ENABLED=true',
          'CATSCO_LOG_API_BASE_URL=http://127.0.0.1:18080',
          '',
        ].join('\n'),
        'utf-8',
      );

      const config = getCatscoLogAgentConfig(root, {
        CATSCO_LOG_STATE_FILE: '../outside-state.json',
        CATSCO_LOG_ROOT: '../outside-logs',
        CATSCO_LOG_UPLOAD_INTERVAL_MINUTES: '-1',
        CATSCO_LOG_MAX_FILES_PER_CYCLE: '0',
      });

      assert.equal(config.catscoUserToken, 'dotenv-token');
      assert.equal(config.enabled, true);
      assert.equal(config.apiBaseUrl, 'http://127.0.0.1:18080');
      assert.equal(config.stateFilePath, path.join(root, 'data', 'catsco-log-agent-state.json'));
      assert.equal(config.logsRoot, path.join(root, 'logs'));
      assert.equal(config.uploadIntervalMinutes, 30);
      assert.equal(config.maxFilesPerCycle, 12);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
