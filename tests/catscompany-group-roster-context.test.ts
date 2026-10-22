/**
 * 群成员名单与发言人身份标记。
 *
 * 这两件事服务于同一个目的：让一个助手能区分"人在问我"和"同伴在汇报"。
 * 名单回答"群里是谁"，发言人标记回答"这条是谁说的"。两者都来自服务端已经
 * 下发的数据，客户端此前只是没有渲染出来。
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { buildRuntimeContextText, TRANSIENT_RUNTIME_CONTEXT_PREFIX } from '../src/core/runtime-context-builder';
import { formatSpeakerLabel } from '../src/catscompany/speaker-label';

describe('群成员名单注入', () => {
  test('名单渲染成人/助手标记，并落在临时上下文块里', () => {
    const text = buildRuntimeContextText(undefined, undefined, [
      { uid: 'usr7', name: '林', isBot: false },
      { uid: 'usr42', name: '阿码', isBot: true },
    ]);

    assert.ok(text.startsWith(TRANSIENT_RUNTIME_CONTEXT_PREFIX));
    assert.ok(text.includes('群成员：'), text);
    assert.ok(text.includes('林（人）'), text);
    assert.ok(text.includes('阿码（bot）'), text);
  });

  test('被禁言的成员保留在名单里并标出来', () => {
    // 禁言者无法被指名，打算交接的同伴需要知道点名它会无人应答，
    // 而不是把它误认为不在群里的成员。
    const text = buildRuntimeContextText(undefined, undefined, [
      { uid: 'usr42', name: '阿码', isBot: true },
      { uid: 'usr43', name: '小文', isBot: true, muted: true },
    ]);

    assert.ok(text.includes('小文（bot，已禁言）'), text);
  });

  test('身份缺失时不猜，只写名字', () => {
    // 旧服务端不下发 is_bot，硬猜一个身份比不标更糟。
    const text = buildRuntimeContextText(undefined, undefined, [
      { uid: 'usr7', name: '林' },
    ]);

    assert.ok(text.includes('- 林'), text);
    assert.ok(!text.includes('林（人）'), text);
    assert.ok(!text.includes('林（bot）'), text);
  });

  test('没有名字时退回 uid，不渲染空条目', () => {
    const text = buildRuntimeContextText(undefined, undefined, [
      { uid: 'usr99', isBot: true },
    ]);

    assert.ok(text.includes('usr99（bot）'), text);
  });

  test('名单为空时不产生空的"群成员"段', () => {
    const text = buildRuntimeContextText(undefined, undefined, []);
    assert.ok(!text.includes('群成员：'), text);
  });

  test('不传名单时行为与改动前一致', () => {
    const withRoster = buildRuntimeContextText(undefined, undefined, undefined);
    assert.ok(withRoster.startsWith(TRANSIENT_RUNTIME_CONTEXT_PREFIX));
    assert.ok(!withRoster.includes('群成员：'), withRoster);
  });
});

describe('发言人身份标记', () => {
  test('助手标（bot），人标（人）', () => {
    assert.equal(formatSpeakerLabel({ actor: { display_name: '阿码', is_bot: true } }), '阿码（bot）');
    assert.equal(formatSpeakerLabel({ actor: { display_name: '林', is_bot: false } }), '林（人）');
  });

  test('身份缺失时不加后缀', () => {
    assert.equal(formatSpeakerLabel({ actor: { display_name: '林' } }), '林');
  });

  test('没有显示名时依次退回 username、user_id、传入的 uid', () => {
    assert.equal(formatSpeakerLabel({ actor: { username: 'lin', is_bot: false } }), 'lin（人）');
    assert.equal(formatSpeakerLabel({ actor: { user_id: 'usr7', is_bot: true } }), 'usr7（bot）');
    assert.equal(formatSpeakerLabel({ actor: {}, fallbackUid: 'usr42' }), 'usr42');
    assert.equal(formatSpeakerLabel({ fallbackUid: 42 }), '42');
  });

  test('actor 完全缺失时用兜底 uid，不崩', () => {
    assert.equal(formatSpeakerLabel({ actor: undefined, fallbackUid: 'usr7' }), 'usr7');
    assert.equal(formatSpeakerLabel({ actor: null }), 'User');
  });

  test('is_bot 不是布尔时视为未知，不加标记', () => {
    // 服务端只应下发 true/false；其它值说明数据不对，不猜。
    assert.equal(formatSpeakerLabel({ actor: { display_name: '林', is_bot: 'true' } }), '林');
    assert.equal(formatSpeakerLabel({ actor: { display_name: '林', is_bot: 1 } }), '林');
  });
});
