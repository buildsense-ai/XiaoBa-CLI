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

  // botCount 是"多 bot 群"的真正判据：memberCount 判不出来。
  // 一个助手 + 三个人（memberCount 4）不需要协调，两个助手 + 一个人（memberCount 3）才需要。
  describe('bot count decides whether the room needs coordination', () => {
    test('a room with one agent always activates, however many people are in it', () => {
      // memberCount 4 但 botCount 1：旧判据会误判成多 bot 群，新判据不会。
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 4, botCount: 1,
      }, 'usr43'), true);
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 2, botCount: 1,
      }, 'usr43'), true);
      // 即使服务端说没激活，单助手群也照旧自动回复。
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 4, botCount: 1, activated: false,
      }, 'usr43'), true);
    });

    test('a multi-agent room reads the server verdict instead of re-deriving one', () => {
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 3, botCount: 2, activated: true,
      }, 'usr43'), true);
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 3, botCount: 2, activated: false,
      }, 'usr43'), false);
      // 多 bot 群不再看 mentions：服务端的结论就是结论。
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 5, botCount: 3, activated: false, mentions: ['usr43'],
      }, 'usr43'), false);
      // 缺 activated 时保守判否，不猜。
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 5, botCount: 3,
      }, 'usr43'), false);
    });

    test('a botCount of zero is treated as unusable, not as a single-agent room', () => {
      // 0 对一条投给助手的消息来说不可能是真的，说明服务端没算出来。
      // 当成"单助手群"会让这个助手在繁忙群里回每一条消息，所以回退旧判据。
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 5, botCount: 0, activated: false,
      }, 'usr43'), false);
      // 回退后仍尊重显式 @。
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 5, botCount: 0, activated: false, mentions: ['usr43'],
      }, 'usr43'), true);
    });
  });

  // 向后兼容：旧服务端不下发 botCount，客户端必须保持原有行为，不能崩也不能改判。
  describe('older server without botCount keeps the previous behaviour', () => {
    test('falls back to memberCount and mentions', () => {
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 2,
      }, 'usr43'), true);
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 4,
      }, 'usr43'), false);
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 4, mentions: ['usr43'],
      }, 'usr43'), true);
    });

    test('ignores a malformed botCount rather than trusting it', () => {
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 4, botCount: 1.5,
      }, 'usr43'), false);
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 4, botCount: '2',
      } as any, 'usr43'), false);
      assert.equal(shouldActivateCatsCompanyMessage({
        isGroup: true, memberCount: 4, botCount: Number.MAX_SAFE_INTEGER + 1,
      }, 'usr43'), false);
    });
  });
});
