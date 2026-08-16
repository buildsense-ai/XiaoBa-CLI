import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  capabilitiesForCatsCompanyRuntimeRole,
  CATSCOMPANY_DESKTOP_RUNTIME_DEVICE_CAPABILITIES,
  CATSCOMPANY_SERVER_RUNTIME_DEVICE_CAPABILITIES,
} from '../src/catscompany';

describe('CatsCompany runtime device capabilities', () => {
  test('desktop runtime advertises local owner and SkillHub workspace capabilities', () => {
    assert.deepEqual(CATSCOMPANY_DESKTOP_RUNTIME_DEVICE_CAPABILITIES, [
      'read_file',
      'resolve_common_directory',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'send_file',
      'execute_shell',
      'external_history',
      'skillhub.localWorkspace.get',
      'skillhub.localSkill.share',
      'skillhub.localSkill.finalize',
      'skillhub.localBot.switch',
    ]);
    assert.deepEqual(
      capabilitiesForCatsCompanyRuntimeRole('desktop'),
      CATSCOMPANY_DESKTOP_RUNTIME_DEVICE_CAPABILITIES,
    );
  });

  test('server runtime never advertises desktop SkillHub workspace capabilities', () => {
    assert.deepEqual(CATSCOMPANY_SERVER_RUNTIME_DEVICE_CAPABILITIES, [
      'read_file',
      'resolve_common_directory',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'send_file',
      'execute_shell',
    ]);
    assert.equal(
      capabilitiesForCatsCompanyRuntimeRole('server').some(capability => capability.startsWith('skillhub.')),
      false,
    );
  });
});
