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
      'skillhub.localWorkspace.get',
      'skillhub.localSkill.share',
      'skillhub.localSkill.finalize',
      'skillhub.localSkill.delete',
      'skillhub.localBot.switch',
    ]);
    assert.deepEqual(
      capabilitiesForCatsCompanyRuntimeRole('desktop'),
      CATSCOMPANY_DESKTOP_RUNTIME_DEVICE_CAPABILITIES,
    );
  });

  test('server runtime advertises its own SkillHub workspace but cannot switch Bots', () => {
    assert.deepEqual(CATSCOMPANY_SERVER_RUNTIME_DEVICE_CAPABILITIES, [
      'read_file',
      'resolve_common_directory',
      'glob',
      'grep',
      'write_file',
      'edit_file',
      'send_file',
      'execute_shell',
      'skillhub.localWorkspace.get',
      'skillhub.localSkill.share',
      'skillhub.localSkill.finalize',
      'skillhub.localSkill.delete',
    ]);
    assert.equal(
      capabilitiesForCatsCompanyRuntimeRole('server').includes('skillhub.localBot.switch'),
      false,
    );
  });
});
