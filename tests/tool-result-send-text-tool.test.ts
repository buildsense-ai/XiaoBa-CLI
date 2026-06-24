import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { SendTextTool } from '../src/tools/send-text-tool';
import type { ExecutionScope } from '../src/types/session-identity';
import type { ToolExecutionContext } from '../src/types/tool';

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

function contextWithChannel(chatId: string, executionScope?: ExecutionScope) {
  const sent: Array<{ chatId: string; text: string }> = [];
  const context: ToolExecutionContext = {
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    conversationHistory: [],
    surface: 'catscompany',
    executionScope,
    channel: {
      chatId,
      reply: async (targetChatId, text) => {
        sent.push({ chatId: targetChatId, text });
      },
      sendFile: async () => undefined,
    },
  };
  return { context, sent };
}

describe('SendTextTool outbound scope checks', () => {
  test('uses executionScope topic as the outbound target when scope is present', async () => {
    const tool = new SendTextTool();
    const { context, sent } = contextWithChannel('p2p_7_43', scope());

    const result = await tool.execute({ text: '  合同已查到  ' }, context);

    assert.equal(result.ok, true);
    assert.deepEqual(sent, [{ chatId: 'p2p_7_43', text: '合同已查到' }]);
  });

  test('keeps legacy channel-only behavior when executionScope is missing', async () => {
    const tool = new SendTextTool();
    const { context, sent } = contextWithChannel('legacy-chat');

    const result = await tool.execute({ text: 'hello' }, context);

    assert.equal(result.ok, true);
    assert.deepEqual(sent, [{ chatId: 'legacy-chat', text: 'hello' }]);
  });

  test('blocks text send when channel chatId conflicts with executionScope topic', async () => {
    const tool = new SendTextTool();
    const { context, sent } = contextWithChannel('p2p_8_43', scope());

    const result = await tool.execute({ text: 'should not send' }, context);

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.match(result.message, /外发目标与当前执行身份不一致/);
    assert.deepEqual(sent, []);
  });

  test('allows basic text replies for untrusted scope when topic still matches', async () => {
    const tool = new SendTextTool();
    const { context, sent } = contextWithChannel('p2p_7_43', scope({
      identityTrust: 'untrusted',
      isTrusted: false,
      agentBodyId: undefined,
      permissionsSource: undefined,
    }));

    const result = await tool.execute({ text: '请重新发送一下' }, context);

    assert.equal(result.ok, true);
    assert.deepEqual(sent, [{ chatId: 'p2p_7_43', text: '请重新发送一下' }]);
  });

  test('propagates channel send failures to the tool caller', async () => {
    const tool = new SendTextTool();
    const context: ToolExecutionContext = {
      workingDirectory: process.cwd(),
      workspaceRoot: process.cwd(),
      conversationHistory: [],
      surface: 'catscompany',
      executionScope: scope(),
      channel: {
        chatId: 'p2p_7_43',
        reply: async () => {
          throw new Error('ack timeout');
        },
        sendFile: async () => undefined,
      },
    };

    await assert.rejects(
      () => tool.execute({ text: '会发送失败' }, context),
      /ack timeout/,
    );
  });
});
