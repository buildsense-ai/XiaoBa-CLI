import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  composeSurfacePrompt,
  resolveSessionSurface,
} from '../src/core/session-surface';

describe('surface prompt', () => {
  const autoSendModeInstruction = [
    '【消息模式】你的每次文本输出都会立即自动发送给用户。',
    '',
    '工作流程：',
    '1. 简单问答：直接输出文本回答',
    '2. 需要工具：调用工具（read/write/grep 等）后再回答',
    '',
    '重要规则：',
    '- 如果还需要调用工具，不要输出任何文本',
    '- 只在最终准备回答用户时才输出文本',
  ].join('\n');

  const catscoFileSelectionInstruction = [
    '[CatsCo file selection rules]',
    '- tmp/downloads/... is the local cache for files/images received from chat. It is not the user\'s general local file library.',
    '- If the user asks for a new/local file or says they have not sent it before, do not reuse files from tmp/downloads/... or old conversation paths.',
    '- If the user did not provide an exact path, first ask for the location or search likely local folders such as Desktop, Downloads, Documents, Pictures, or an explicit path the user mentioned.',
    '- Use current catsco_attachment:<id> references for received attachments; local tmp/downloads paths are backend-only and should not be guessed or reused.',
  ].join('\n');

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
    assert.match(composeSurfacePrompt('session:v2:feishu:group:oc_1') || '', /\[surface:feishu:group\]/);
    assert.match(composeSurfacePrompt('session:v2:feishu:p2p:ou_1') || '', /\[surface:feishu:private\]/);
  });

  test('composes current Feishu private and group surface prompts', () => {
    const privatePrompt = composeSurfacePrompt('user:feishu-user');
    const groupPrompt = composeSurfacePrompt('group:feishu-group');

    assert.equal(
      privatePrompt,
      `[surface:feishu:private]\n当前是飞书私聊会话。\n${autoSendModeInstruction}`,
    );
    assert.equal(
      groupPrompt,
      `[surface:feishu:group]\n当前是飞书群聊会话。\n${autoSendModeInstruction}`,
    );
  });

  test('composes current CatsCo surface prompt and omits CLI prompt', () => {
    const catsUserPrompt = composeSurfacePrompt('cc_user:demo');
    const catsGroupPrompt = composeSurfacePrompt('cc_group:demo');

    assert.equal(
      catsUserPrompt,
      `[surface:catscompany]\n当前是 CatsCo 聊天会话。\n${autoSendModeInstruction}\n\n${catscoFileSelectionInstruction}`,
    );
    assert.equal(catsGroupPrompt, catsUserPrompt);
    assert.equal(composeSurfacePrompt('cli'), undefined);
  });

  test('composes Weixin surface prompt when sessionType is explicit', () => {
    const weixinPrompt = composeSurfacePrompt('user:weixin-user', 'weixin');

    assert.equal(
      weixinPrompt,
      `[surface:weixin]\n当前是微信聊天会话。\n${autoSendModeInstruction}`,
    );
  });
});
