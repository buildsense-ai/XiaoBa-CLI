import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'connector', 'index.ts'), 'utf8');
const buildScript = fs.readFileSync(path.join(process.cwd(), 'scripts', 'build-connector.mjs'), 'utf8');
const serviceManager = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'service-manager.ts'), 'utf8');
const electronMain = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.js'), 'utf8');

describe('standalone Connector Lite', () => {
  test('has a dedicated bundled entrypoint and does not import CatsCompanyBot', () => {
    assert.match(buildScript, /src.*connector.*index\.ts/);
    assert.match(serviceManager, /useConnectorLite = packaged/);
    assert.doesNotMatch(serviceManager, /XIAOBA_CONNECTOR_LITE/);
    assert.match(serviceManager, /path\.join\(appRoot, 'dist', 'index\.js'\)/);
    assert.match(electronMain, /connector-lite/);
    assert.match(electronMain, /connector-dashboard/);
    assert.match(buildScript, /bundle:\s*true/);
    assert.doesNotMatch(source, /CatsCompanyBot/);
    assert.doesNotMatch(source, /MessageSessionManager/);
    assert.doesNotMatch(source, /createAdapterRuntime/);
  });

  test('keeps the server-controlled local execution surface', () => {
    for (const tool of [
      'read_file',
      'resolve_common_directory',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'send_file',
      'execute_shell',
    ]) {
      assert.match(source, new RegExp(`['"]${tool}['"]`));
    }
    assert.match(source, /device_rpc_request/);
    assert.match(source, /thin_tool_rpc_request/);
    assert.match(source, /registerDevice/);
    assert.match(source, /acquireCatsCoConnectorLock/);
  });
});
