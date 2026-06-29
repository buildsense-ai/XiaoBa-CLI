import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES } from '../src/catscompany';
import {
  DEVICE_RPC_TOOL_REGISTRY,
  getDeviceRpcToolRegistration,
  normalizeDeviceRpcOperation,
} from '../src/tools/device-rpc-registry';
import { isRemoteDeviceRpcTool } from '../src/tools/device-rpc-tool';

describe('CatsCompany runtime device capabilities', () => {
  test('full runtime advertises local owner self capabilities', () => {
    assert.deepEqual(CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES, [
      'read_file',
      'resolve_common_directory',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'send_file',
      'execute_shell',
    ]);
  });

  test('Device RPC registry drives advertised capabilities and remote allowlist', () => {
    assert.deepEqual(
      CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES,
      DEVICE_RPC_TOOL_REGISTRY.map(registration => registration.operation),
    );

    for (const registration of DEVICE_RPC_TOOL_REGISTRY) {
      assert.equal(
        getDeviceRpcToolRegistration(registration.toolName, registration.operation),
        registration,
      );
      assert.equal(
        normalizeDeviceRpcOperation(registration.operation),
        registration.operation,
      );
      assert.equal(
        isRemoteDeviceRpcTool(registration.toolName, registration.operation),
        true,
      );
    }
  });
});
