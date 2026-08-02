import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES,
  CATSCOMPANY_THIN_TOOL_RPC_AUTHORITY_CAPABILITY,
} from '../src/catscompany';

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

  test('advertises the authority-v1 protocol separately from grant operations', () => {
    assert.equal(CATSCOMPANY_THIN_TOOL_RPC_AUTHORITY_CAPABILITY, 'thin_tool_rpc_authority_v1');
    assert.equal(CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES.includes(
      CATSCOMPANY_THIN_TOOL_RPC_AUTHORITY_CAPABILITY as any,
    ), false);
  });
});
