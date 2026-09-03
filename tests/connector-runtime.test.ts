import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'connector', 'index.ts'), 'utf8');
const buildScript = fs.readFileSync(path.join(process.cwd(), 'scripts', 'build-connector.mjs'), 'utf8');
const serviceManager = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'service-manager.ts'), 'utf8');
const connectorElectronMain = fs.readFileSync(path.join(process.cwd(), 'electron', 'connector-main.js'), 'utf8');
const liteDashboard = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'connector-lite-server.ts'), 'utf8');
const liteFrontend = fs.readFileSync(path.join(process.cwd(), 'dashboard', 'connector.js'), 'utf8');
const liteHtml = fs.readFileSync(path.join(process.cwd(), 'dashboard', 'connector.html'), 'utf8');

describe('standalone Connector Lite', () => {
  test('has a dedicated bundled entrypoint and does not import CatsCompanyBot', () => {
    assert.match(buildScript, /src.*connector.*index\.ts/);
    assert.match(serviceManager, /useConnectorLite = process\.env\.XIAOBA_CONNECTOR_PACKAGE/);
    assert.doesNotMatch(serviceManager, /XIAOBA_CONNECTOR_LITE/);
    assert.match(serviceManager, /path\.join\(appRoot, 'dist', 'index\.js'\)/);
    assert.match(connectorElectronMain, /connector-lite/);
    assert.match(connectorElectronMain, /connector-dashboard/);
    assert.match(liteDashboard, /connectorOnly: true/);
    assert.match(liteDashboard, /status\(404\)\.json\(\{ error: 'api_not_found' \}\)/);
    assert.doesNotMatch(liteDashboard, /registerCacheTraceRoutes|registerTurnErrorRoutes|cache-trace|turn-errors/);
    assert.doesNotMatch(liteDashboard, /weixin\/qrcode|weixin\/channel-binding/);
    assert.doesNotMatch(liteFrontend, /feishu|weixin|微信|飞书/);
    assert.doesNotMatch(liteHtml, /feishu|weixin|微信|飞书/);
    assert.doesNotMatch(liteHtml, /Cache Trace|Turn Errors|cache-trace|turn-errors/);
    assert.doesNotMatch(liteFrontend, /cache-trace|turn-errors/);
    assert.match(liteHtml, /获取 Connector 凭证并绑定这台电脑/);
    assert.match(buildScript, /bundle:\s*true/);
    assert.match(serviceManager, /ELECTRON_RUN_AS_NODE/);
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
