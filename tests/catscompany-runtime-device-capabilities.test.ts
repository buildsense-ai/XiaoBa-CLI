import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES } from '../src/catscompany';

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
});
