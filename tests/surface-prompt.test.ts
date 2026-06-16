import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  composeSurfacePrompt,
  resolveSessionSurface,
} from '../src/core/session-surface';

describe('surface prompt', () => {
  test('resolves session surface from current session key conventions', () => {
    assert.equal(resolveSessionSurface('user:feishu-user'), 'feishu');
    assert.equal(resolveSessionSurface('group:feishu-group'), 'feishu');
    assert.equal(resolveSessionSurface('cc_user:cats-user'), 'catscompany');
    assert.equal(resolveSessionSurface('cc_group:cats-group'), 'catscompany');
    assert.equal(resolveSessionSurface('user:weixin-user', 'weixin'), 'weixin');
    assert.equal(resolveSessionSurface('cli'), 'cli');
  });

  test('sessionType overrides ambiguous session key prefixes', () => {
    assert.equal(resolveSessionSurface('user:shared-prefix', 'weixin'), 'weixin');
    assert.equal(resolveSessionSurface('user:shared-prefix', 'feishu'), 'feishu');
    assert.equal(resolveSessionSurface('cc_user:shared-prefix', 'catscompany'), 'catscompany');
  });

  test('resolves V2 session keys without relying on sessionType overrides', () => {
    assert.equal(resolveSessionSurface('session:v2:feishu:p2p:ou_1'), 'feishu');
    assert.equal(resolveSessionSurface('session:v2:weixin:p2p:ou_1'), 'weixin');
    assert.equal(resolveSessionSurface('session:v2:catscompany:group:grp_1:agent:usr43'), 'catscompany');
  });

  test('does not inject platform-specific system prompt text', () => {
    assert.equal(composeSurfacePrompt('user:feishu-user'), undefined);
    assert.equal(composeSurfacePrompt('group:feishu-group'), undefined);
    assert.equal(composeSurfacePrompt('cc_user:demo'), undefined);
    assert.equal(composeSurfacePrompt('cc_group:demo'), undefined);
    assert.equal(composeSurfacePrompt('user:weixin-user', 'weixin'), undefined);
    assert.equal(composeSurfacePrompt('cli'), undefined);
  });
});
