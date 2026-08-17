import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  describeRuntimeBridge,
  parseRuntimeBridgeCommand,
  RUNTIME_BRIDGE_PROTOCOL_VERSION,
  summarizeRuntimeBridgeWake,
} from '../src/runtime-bridge';

describe('runtime bridge', () => {
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
