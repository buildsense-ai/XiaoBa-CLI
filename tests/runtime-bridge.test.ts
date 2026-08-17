import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  configureRuntimeBridgeEnvironment,
  describeRuntimeBridge,
  parseRuntimeBridgeCommand,
  RUNTIME_BRIDGE_PROTOCOL_VERSION,
  summarizeRuntimeBridgeWake,
} from '../src/runtime-bridge';

describe('runtime bridge', () => {
  test('pins every runtime data alias to the selected tenant root', () => {
    const environment: NodeJS.ProcessEnv = {
      CATSLOG_RUNTIME_ROOT: '/stale/catslog-root',
      XIAOBA_RUNTIME_ROOT: '/stale/runtime-root',
      XIAOBA_USER_DATA_DIR: '/stale/user-data',
      CATSCO_USER_DATA_DIR: '/stale/catsco-data',
      XIAOBA_ELECTRON_USER_DATA_DIR: '/stale/electron-data',
      XIAOBA_SKILLS_DIR: '/stale/skills',
      CATSCO_LOG_UPLOAD_ENABLED: 'true',
      XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: 'true',
      DISTILLATION_HEARTBEAT_LOG_ROOT: '/stale/logs',
    };

    configureRuntimeBridgeEnvironment('/srv/runtime/tenant-a', environment);

    assert.deepEqual(environment, {
      CATSLOG_RUNTIME_ROOT: '/srv/runtime/tenant-a',
      XIAOBA_RUNTIME_ROOT: '/srv/runtime/tenant-a',
      XIAOBA_USER_DATA_DIR: '/srv/runtime/tenant-a',
      CATSCO_USER_DATA_DIR: '/srv/runtime/tenant-a',
      XIAOBA_ELECTRON_USER_DATA_DIR: '/srv/runtime/tenant-a',
      XIAOBA_SKILLS_DIR: '/srv/runtime/tenant-a/skills',
      CATSCO_LOG_UPLOAD_ENABLED: 'false',
      XIAOBA_EXTERNAL_SESSION_LOG_SOURCES_ENABLED: 'false',
      DISTILLATION_HEARTBEAT_LOG_ROOT: 'logs',
    });
  });

  test('ships the bridge as an explicit public executable', () => {
    const manifest = require('../package.json') as { bin?: Record<string, string> };
    assert.equal(manifest.bin?.['xiaoba-runtime-bridge'], 'dist/runtime-bridge.js');
  });

  test('publishes a small versioned host contract', () => {
    assert.deepEqual(describeRuntimeBridge(), {
      protocol_version: RUNTIME_BRIDGE_PROTOCOL_VERSION,
      xiaoba_version: require('../src/version').APP_VERSION,
      commands: ['describe', 'wake'],
    });
  });

  test('accepts only explicit bridge commands', () => {
    assert.equal(parseRuntimeBridgeCommand(['describe']), 'describe');
    assert.equal(parseRuntimeBridgeCommand(['wake']), 'wake');
    assert.throws(() => parseRuntimeBridgeCommand([]), /usage/);
    assert.throws(() => parseRuntimeBridgeCommand(['wake', '--unsafe']), /usage/);
  });

  test('turns a durable Runtime Learning failure into a bridge failure', () => {
    assert.throws(
      () => summarizeRuntimeBridgeWake({ ran: true, unitsProcessed: 2, advancedFiles: 1 }, 'failed'),
      /failed heartbeat/,
    );
    assert.deepEqual(
      summarizeRuntimeBridgeWake({ ran: false, unitsProcessed: 0, advancedFiles: 0 }, 'memory_suspended'),
      {
        protocol_version: RUNTIME_BRIDGE_PROTOCOL_VERSION,
        status: 'deferred',
        ran: false,
        units_processed: 0,
        advanced_files: 0,
      },
    );
  });
});
