import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CATSCOMPANY_LOCAL_DEVICE_CAPABILITIES } from '../src/catscompany';

describe('CatsCompany local device capabilities', () => {
  test('registers local CatsCo device with file artifact capabilities', () => {
    assert.deepEqual(CATSCOMPANY_LOCAL_DEVICE_CAPABILITIES, [
      'read_file',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'send_file',
    ]);
    assert.equal(CATSCOMPANY_LOCAL_DEVICE_CAPABILITIES.includes('execute_shell'), false);
  });
});
