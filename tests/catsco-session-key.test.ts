import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { buildCatsSessionKey } from '../src/catscompany/session-key';
import { resolveSessionSurface } from '../src/core/session-surface';

describe('CatsCo session key isolation', () => {
  test('isolates private chats by bot identity and p2p topic', () => {
    const input = { chatType: 'p2p' as const, topic: 'p2p_1_2', senderId: 'usr2' };

    assert.equal(buildCatsSessionKey(input, 'bot_a'), 'cc_user:bot_a:p2p_1_2');
    assert.equal(buildCatsSessionKey(input, 'bot_b'), 'cc_user:bot_b:p2p_1_2');
    assert.notEqual(
      buildCatsSessionKey(input, 'bot_a'),
      buildCatsSessionKey(input, 'bot_b'),
    );
  });

  test('does not merge different p2p topics from the same sender', () => {
    assert.notEqual(
      buildCatsSessionKey({ chatType: 'p2p', topic: 'p2p_1_2', senderId: 'usr2' }, 'bot_a'),
      buildCatsSessionKey({ chatType: 'p2p', topic: 'p2p_3_2', senderId: 'usr2' }, 'bot_a'),
    );
  });

  test('isolates group chats by bot identity and group topic', () => {
    assert.notEqual(
      buildCatsSessionKey({ chatType: 'group', topic: 'grp_1', senderId: 'usr2' }, 'bot_a'),
      buildCatsSessionKey({ chatType: 'group', topic: 'grp_1', senderId: 'usr2' }, 'bot_b'),
    );
  });

  test('keeps current CatsCo session prefixes for surface detection', () => {
    assert.equal(
      resolveSessionSurface(buildCatsSessionKey({ chatType: 'p2p', topic: 'p2p_1_2' }, 'bot_a')),
      'catscompany',
    );
    assert.equal(
      resolveSessionSurface(buildCatsSessionKey({ chatType: 'group', topic: 'grp_1' }, 'bot_a')),
      'catscompany',
    );
  });

  test('falls back to sender id when private topic is unavailable', () => {
    assert.equal(
      buildCatsSessionKey({ chatType: 'p2p', senderId: 'usr2' }, 'bot_a'),
      'cc_user:bot_a:usr2',
    );
  });
});
