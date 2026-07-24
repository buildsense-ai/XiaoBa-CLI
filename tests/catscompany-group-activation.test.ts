import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { shouldActivateCatsCompanyMessage } from '../src/catscompany';

describe('CatsCompany group activation gate', () => {
  test('keeps p2p and two-member group behavior automatic', () => {
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: false }, 'usr43'), true);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: 2 }, 'usr43'), true);
  });

  test('requires the current AI in structured mentions for larger groups', () => {
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: 4 }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: 4, mentions: ['usr42'] }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: 4, mentions: ['usr43'] }, '43'), true);
  });

  test('fails closed when group size is missing or malformed unless the current AI is targeted', () => {
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: 1.5 }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: '2' } as any, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: Number.MAX_SAFE_INTEGER + 1 }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, mentions: ['usr43'] }, 'usr43'), true);
    assert.equal(shouldActivateCatsCompanyMessage({
      isGroup: true,
      memberCount: 1.5,
      mentions: ['usr43'],
    }, 'usr43'), true);
  });

  test('trusts only the structured channel trigger flag for externally managed groups', () => {
    assert.equal(shouldActivateCatsCompanyMessage({
      isGroup: true,
      metadata: { source_channel: 'feishu', channel_native_group_triggered: false },
    }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({
      isGroup: true,
      metadata: { source_channel: 'feishu', channel_native_group_triggered: true },
    }, 'usr43'), true);
  });
});
