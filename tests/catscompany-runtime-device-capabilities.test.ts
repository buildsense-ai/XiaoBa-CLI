import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES } from '../src/catscompany';

describe('CatsCompany runtime device capabilities', () => {
  test('full runtime advertises local file write capabilities', () => {
    assert.deepEqual(CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES, [
      'read_file',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'send_file',
    ]);
    assert.equal(CATSCOMPANY_FULL_RUNTIME_DEVICE_CAPABILITIES.includes('execute_shell'), false);
  });
});
