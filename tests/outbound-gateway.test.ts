import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { resolveOutboundTarget } from '../src/tools/outbound-gateway';
import type { ExecutionScope } from '../src/types/session-identity';
import type { ToolExecutionContext, ToolSurface } from '../src/types/tool';

function scope(overrides: Partial<ExecutionScope> = {}): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'cc_user:usr7',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-main',
    channelSeq: 12,
    permissionsSource: 'server_canonical_message',
    identityTrust: 'server_canonical',
    isTrusted: true,
    ...overrides,
  };
}

function context(options: {
  chatId?: string;
  sessionId?: string;
  surface?: ToolSurface;
  executionScope?: ExecutionScope;
} = {}): ToolExecutionContext {
  return {
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    conversationHistory: [],
    sessionId: options.sessionId ?? 'cc_user:usr7',
    surface: options.surface ?? 'catscompany',
    executionScope: options.executionScope,
    channel: {
      chatId: options.chatId ?? 'p2p_7_43',
      reply: async () => undefined,
      sendFile: async () => undefined,
    },
  };
}

describe('resolveOutboundTarget', () => {
  test('allows trusted CatsCo text when channel, session, and scope match', () => {
    const result = resolveOutboundTarget(context({ executionScope: scope() }), {
      operation: 'send_text',
      missingChannelMessage: 'missing channel',
    });

    assert.deepEqual(result, { ok: true, chatId: 'p2p_7_43' });
  });

  test('rejects CatsCo outbound when channel chatId conflicts with scope topic', () => {
    const result = resolveOutboundTarget(context({ chatId: 'p2p_8_43', executionScope: scope() }), {
      operation: 'send_text',
      missingChannelMessage: 'missing channel',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /外发目标与当前执行身份不一致/);
    }
  });

  test('rejects CatsCo outbound when sessionId conflicts with scope sessionKey', () => {
    const result = resolveOutboundTarget(context({
      sessionId: 'cc_user:usr8',
      executionScope: scope(),
    }), {
      operation: 'send_text',
      missingChannelMessage: 'missing channel',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorCode, 'PERMISSION_DENIED');
      assert.match(result.message, /执行会话与当前执行身份不一致/);
    }
  });

  test('keeps legacy channel-only behavior when executionScope is missing', () => {
    const result = resolveOutboundTarget(context({
      chatId: 'legacy-chat',
      sessionId: undefined,
      surface: 'feishu',
    }), {
      operation: 'send_file',
      missingChannelMessage: 'missing channel',
    });

    assert.deepEqual(result, { ok: true, chatId: 'legacy-chat' });
  });

  test('allows legacy CatsCo file sends when topic still matches', () => {
    const result = resolveOutboundTarget(context({
      executionScope: scope({
        identityTrust: 'legacy_context',
        isTrusted: false,
        permissionsSource: undefined,
        agentBodyId: undefined,
      }),
    }), {
      operation: 'send_file',
      missingChannelMessage: 'missing channel',
    });

    assert.deepEqual(result, { ok: true, chatId: 'p2p_7_43' });
  });

  test('allows untrusted CatsCo text but blocks untrusted file sends', () => {
    const untrustedScope = scope({
      identityTrust: 'untrusted',
      isTrusted: false,
      permissionsSource: undefined,
      agentBodyId: undefined,
    });

    const textResult = resolveOutboundTarget(context({ executionScope: untrustedScope }), {
      operation: 'send_text',
      missingChannelMessage: 'missing channel',
    });
    assert.deepEqual(textResult, { ok: true, chatId: 'p2p_7_43' });

    const fileResult = resolveOutboundTarget(context({ executionScope: untrustedScope }), {
      operation: 'send_file',
      missingChannelMessage: 'missing channel',
    });
    assert.equal(fileResult.ok, false);
    if (!fileResult.ok) {
      assert.equal(fileResult.errorCode, 'PERMISSION_DENIED');
      assert.match(fileResult.message, /身份未通过服务端一致性校验/);
    }
  });
});
