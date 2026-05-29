import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href;

function runConfigProbe(homeDir: string, envFile: string, method: 'getConfig' | 'getConfigReadonly' = 'getConfig'): any {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      '--input-type=module',
      '-e',
      `
        import fs from 'node:fs';
        import path from 'node:path';
        const configModule = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'src/utils/config.ts')).href)});
        const { ConfigManager } = configModule.default ?? configModule;
        const config = ConfigManager.${method}();
        process.stdout.write(JSON.stringify({
          config,
          configDirExists: fs.existsSync(path.join(${JSON.stringify(homeDir)}, '.xiaoba')),
        }));
      `,
    ],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        XIAOBA_CONFIG_PATH: path.join(homeDir, '.xiaoba', 'config.json'),
        DOTENV_CONFIG_PATH: envFile,
      },
      encoding: 'utf8',
    },
  );

  return JSON.parse(output);
}

function runDashboardStatusProbe(homeDir: string, envFile: string): any {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      '--input-type=module',
      '-e',
      `
        import fs from 'node:fs';
        import path from 'node:path';
        import express from 'express';
        const apiModule = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'src/dashboard/routes/api.ts')).href)});
        const { createApiRouter } = apiModule.default ?? apiModule;

        const app = express();
        app.use('/api', createApiRouter({ getAll: () => [] }));
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const address = server.address();
        const response = await fetch('http://127.0.0.1:' + address.port + '/api/status');
        const data = await response.json();
        await new Promise(resolve => server.close(resolve));
        process.stdout.write(JSON.stringify({
          status: response.status,
          data,
          configDirExists: fs.existsSync(path.join(${JSON.stringify(homeDir)}, '.xiaoba')),
        }));
      `,
    ],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        XIAOBA_CONFIG_PATH: path.join(homeDir, '.xiaoba', 'config.json'),
        DOTENV_CONFIG_PATH: envFile,
      },
      encoding: 'utf8',
    },
  );

  return JSON.parse(output);
}

test('ConfigManager merges env-backed LLM config with partial user config file', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-config-merge-'));
  const homeDir = path.join(tempRoot, 'home');
  const configDir = path.join(homeDir, '.xiaoba');
  const envFile = path.join(tempRoot, '.env');

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    envFile,
    [
      'GAUZ_LLM_PROVIDER=openai',
      'GAUZ_LLM_API_BASE=https://api.deepseek.com/v1/chat/completions',
      'GAUZ_LLM_API_KEY=test-key',
      'GAUZ_LLM_MODEL=deepseek-chat',
      'GAUZ_LLM_MAX_OUTPUT_TOKENS=32768',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      catscompany: {
        serverUrl: 'ws://example.com/v0/channels',
        apiKey: 'cc_test_key',
      },
    }),
  );

  const { config } = runConfigProbe(homeDir, envFile);

  assert.equal(config.provider, 'openai');
  assert.equal(config.apiUrl, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(config.apiKey, 'test-key');
  assert.equal(config.model, 'deepseek-chat');
  assert.equal(config.maxTokens, 32768);
  assert.equal(config.catscompany.serverUrl, 'ws://example.com/v0/channels');
  assert.equal(config.catscompany.apiKey, 'cc_test_key');
});

test('ConfigManager lets explicit env LLM settings override legacy user config', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-config-env-priority-'));
  const homeDir = path.join(tempRoot, 'home');
  const configDir = path.join(homeDir, '.xiaoba');
  const envFile = path.join(tempRoot, '.env');

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    envFile,
    [
      'GAUZ_LLM_PROVIDER=openai',
      'GAUZ_LLM_API_BASE=https://api.deepseek.com',
      'GAUZ_LLM_MODEL=deepseek-v4-flash',
      'GAUZ_LLM_API_KEY=test-key',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      provider: 'anthropic',
      apiUrl: 'https://api.deepseek.com/anthropic',
      model: 'legacy-model',
      catscompany: {
        serverUrl: 'ws://example.com/v0/channels',
      },
    }),
  );

  const { config } = runConfigProbe(homeDir, envFile);

  assert.equal(config.provider, 'openai');
  assert.equal(config.apiUrl, 'https://api.deepseek.com');
  assert.equal(config.model, 'deepseek-v4-flash');
  assert.equal(config.apiKey, 'test-key');
  assert.equal(config.catscompany.serverUrl, 'ws://example.com/v0/channels');
});

test('ConfigManager readonly config does not create user config directory', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-config-readonly-'));
  const homeDir = path.join(tempRoot, 'home');
  const envFile = path.join(tempRoot, '.env');

  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(
    envFile,
    [
      'GAUZ_LLM_PROVIDER=openai',
      'GAUZ_LLM_MODEL=readonly-model',
    ].join('\n'),
  );

  const { config, configDirExists } = runConfigProbe(homeDir, envFile, 'getConfigReadonly');

  assert.equal(config.model, 'readonly-model');
  assert.equal(configDirExists, false);
});

test('dashboard status endpoint does not create user config directory', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-status-readonly-'));
  const homeDir = path.join(tempRoot, 'home');
  const envFile = path.join(tempRoot, '.env');

  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(
    envFile,
    [
      'GAUZ_LLM_PROVIDER=openai',
      'GAUZ_LLM_MODEL=dashboard-status-model',
    ].join('\n'),
  );

  const { status, data, configDirExists } = runDashboardStatusProbe(homeDir, envFile);

  assert.equal(status, 200);
  assert.equal(data.model, 'dashboard-status-model');
  assert.equal(configDirExists, false);
});
