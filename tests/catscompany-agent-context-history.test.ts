import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  isNativeFeishuGroupTrigger,
  selectNativeFeishuGroupContext,
} from '../src/catscompany/agent-context-history';
import { CatsCompanyBot } from '../src/catscompany';

function nativeMetadata(options: {
  triggered?: boolean;
  speaker?: string;
  source?: string;
  bindingId?: number;
} = {}) {
  return {
    source_channel: options.source ?? 'feishu',
    channel_native_group_binding_id: options.bindingId ?? 17,
    channel_native_group_triggered: options.triggered ?? false,
    catsco_identity: {
      actor: {
        display_name: options.speaker ?? '陈大为',
        user_id: 'usr7',
      },
    },
  };
}

describe('CatsCompany native Feishu group context', () => {
  test('recognizes only a triggered native Feishu group message', () => {
    assert.equal(isNativeFeishuGroupTrigger({
      chatType: 'group',
      seq: 12,
      metadata: nativeMetadata({ triggered: true }),
    }), true);
    assert.equal(isNativeFeishuGroupTrigger({
      chatType: 'group',
      seq: 12,
      metadata: nativeMetadata(),
    }), false);
    assert.equal(isNativeFeishuGroupTrigger({
      chatType: 'p2p',
      seq: 12,
      metadata: nativeMetadata({ triggered: true }),
    }), false);
  });

  test('replays eligible member messages after the persisted cursor', () => {
    const context = selectNativeFeishuGroupContext([
      {
        seq_id: 1,
        content: '更早的讨论',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
        metadata: { catsco_identity: nativeMetadata().catsco_identity },
      },
      {
        seq_id: 2,
        content: '@机器人 总结一下',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'group_message_targets_agent',
        metadata: { catsco_identity: nativeMetadata().catsco_identity },
      },
      {
        seq_id: 3,
        content: '上一轮回复',
        context_eligible: true,
        context_role: 'assistant',
        context_reason: 'current_agent_message',
        metadata: { catsco_identity: nativeMetadata().catsco_identity },
      },
      {
        seq_id: 4,
        content: '给我发一个 txt 文件',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
        metadata: { catsco_identity: nativeMetadata({ speaker: '陈大为' }).catsco_identity },
      },
      {
        seq_id: 5,
        content_blocks: [{ type: 'text', text: '里面写一句诗' }],
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
        metadata: { catsco_identity: nativeMetadata({ speaker: '林益' }).catsco_identity },
      },
      {
        seq_id: 6,
        content: 'working...',
        context_eligible: false,
        context_role: 'assistant',
        context_reason: 'current_agent_message',
        metadata: { catsco_identity: nativeMetadata().catsco_identity },
      },
      {
        seq_id: 3,
        content: '游标之前的消息',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
        metadata: { catsco_identity: nativeMetadata().catsco_identity },
      },
    ], 3);

    assert.deepEqual(context, [
      '[发言人: 陈大为]\n给我发一个 txt 文件',
      '[发言人: 林益]\n里面写一句诗',
    ]);
  });

  test('does not replay an earlier message that already triggered the agent', () => {
    const context = selectNativeFeishuGroupContext([{
      id: 7,
      seq_id: 7,
      content: '@机器人 总结上面的讨论',
      context_eligible: true,
      context_role: 'user',
      context_reason: 'group_message_targets_agent',
      agent_uid: 42,
      agent_id: 'usr42',
      metadata: nativeMetadata({ triggered: true }),
    }], 0);

    assert.deepEqual(context, []);
  });

  test('keeps only ordinary group messages after the latest clear boundary', () => {
    const context = selectNativeFeishuGroupContext([
      {
        id: 10,
        seq_id: 10,
        content: '清空前的普通讨论',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
        agent_uid: 42,
        agent_id: 'usr42',
      },
      {
        id: 11,
        seq_id: 11,
        content: '/clear',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'group_message_targets_agent',
        agent_uid: 42,
        agent_id: 'usr42',
      },
      {
        id: 12,
        seq_id: 12,
        content: '清空后的新讨论',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
        agent_uid: 42,
        agent_id: 'usr42',
        metadata: { catsco_identity: nativeMetadata({ speaker: '林益' }).catsco_identity },
      },
    ], 0);

    assert.deepEqual(context, ['[发言人: 林益]\n清空后的新讨论']);
  });

  test('injects restored ordinary messages before processing the trigger turn', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.botUid = 'usr42';
    const injected: string[] = [];
    const savedCursors: Array<[string, number]> = [];
    bot.bot = {
      getAgentContextHistory: async (topic: string, options: { beforeId?: number }) => {
        assert.equal(topic, 'grp_9');
        assert.equal(options.beforeId, 88);
        return {
          messages: [{
            id: 87,
            seq_id: 87,
            content: '回答我上面的问题',
            context_eligible: true,
            context_role: 'user',
            context_reason: 'participant_message',
            agent_uid: 42,
            agent_id: 'usr42',
            metadata: { catsco_identity: nativeMetadata({ speaker: '林益' }).catsco_identity },
          }],
          topic_id: 'grp_9',
          agent_uid: 42,
          has_more: false,
          next_before_id: 0,
        };
      },
    };

    await bot.hydrateNativeFeishuGroupContext({
      injectContext: (message: string) => injected.push(message),
      getRemoteContextCursor: () => 80,
      saveRemoteContextCursor: (source: string, cursor: number) => savedCursors.push([source, cursor]),
    }, {
      message: {
        topic: 'grp_9',
        chatType: 'group',
        seq: 88,
        metadata: nativeMetadata({ triggered: true }),
      },
      clearGeneration: 0,
    }, 'cc_group:grp_9');

    assert.deepEqual(injected, ['[发言人: 林益]\n回答我上面的问题']);
    assert.deepEqual(savedCursors, [['catscompany.agent_context', 88]]);
  });

  test('does not inject history twice after a complete cloud restore', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    let fetchCount = 0;
    const savedCursors: Array<[string, number]> = [];
    bot.bot = {
      getAgentContextHistory: async () => {
        fetchCount++;
        throw new Error('should not fetch after cloud restore');
      },
    };

    await bot.hydrateNativeFeishuGroupContext({
      injectContext: () => assert.fail('restored history must not be injected twice'),
      getRemoteContextCursor: () => 100,
      saveRemoteContextCursor: (source: string, cursor: number) => savedCursors.push([source, cursor]),
    }, {
      message: {
        topic: 'grp_9',
        chatType: 'group',
        seq: 88,
        metadata: nativeMetadata({ triggered: true }),
      },
      cloudRestoreStatus: 'restored',
      clearGeneration: 0,
    }, 'cc_group:grp_9');

    assert.equal(fetchCount, 0);
    assert.deepEqual(savedCursors, [['catscompany.agent_context', 100]]);
  });

  test('paginates native group history back to the previous cursor before advancing it', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.botUid = 'usr42';
    const injected: string[] = [];
    const beforeIds: number[] = [];
    let savedCursor = 5;
    const makeMessage = (seq: number) => ({
      id: seq,
      seq_id: seq,
      content: `message-${seq}`,
      context_eligible: true,
      context_role: 'user' as const,
      context_reason: 'participant_message',
      agent_uid: 42,
      agent_id: 'usr42',
      metadata: { catsco_identity: nativeMetadata({ speaker: '林益' }).catsco_identity },
    });
    bot.bot = {
      getAgentContextHistory: async (_topic: string, options: { beforeId: number }) => {
        beforeIds.push(options.beforeId);
        if (options.beforeId === 205) {
          return {
            messages: Array.from({ length: 100 }, (_, index) => makeMessage(105 + index)).reverse(),
            topic_id: 'grp_9',
            agent_uid: 42,
            has_more: true,
            next_before_id: 105,
          };
        }
        return {
          messages: Array.from({ length: 100 }, (_, index) => makeMessage(5 + index)).reverse(),
          topic_id: 'grp_9',
          agent_uid: 42,
          has_more: false,
          next_before_id: 5,
        };
      },
    };

    const valid = await bot.hydrateNativeFeishuGroupContext({
      injectContext: (message: string) => injected.push(message),
      getRemoteContextCursor: () => savedCursor,
      saveRemoteContextCursor: (_source: string, cursor: number) => { savedCursor = cursor; },
    }, {
      message: {
        topic: 'grp_9',
        chatType: 'group',
        seq: 205,
        metadata: nativeMetadata({ triggered: true }),
      },
      clearGeneration: 0,
    }, 'cc_group:grp_9');

    assert.equal(valid, true);
    assert.deepEqual(beforeIds, [205, 105]);
    assert.equal(injected.length, 199);
    assert.match(injected[0], /message-6$/);
    assert.match(injected.at(-1) || '', /message-204$/);
    assert.equal(savedCursor, 205);
  });

  test('uses a bounded recent-history fallback and advances the cursor for very large gaps', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.botUid = 'usr42';
    const injected: string[] = [];
    let fetches = 0;
    let savedCursor = 0;
    bot.bot = {
      getAgentContextHistory: async (_topic: string, options: { beforeId: number }) => {
        fetches++;
        const newest = options.beforeId - 1;
        const oldest = newest - 99;
        return {
          messages: Array.from({ length: 100 }, (_, index) => ({
            id: oldest + index,
            seq_id: oldest + index,
            content: `message-${oldest + index}`,
            context_eligible: true,
            context_role: 'user' as const,
            context_reason: 'participant_message',
            agent_uid: 42,
            agent_id: 'usr42',
          })),
          topic_id: 'grp_9',
          agent_uid: 42,
          has_more: true,
          next_before_id: oldest,
        };
      },
    };

    const valid = await bot.hydrateNativeFeishuGroupContext({
      injectContext: (message: string) => injected.push(message),
      getRemoteContextCursor: () => savedCursor,
      saveRemoteContextCursor: (_source: string, cursor: number) => { savedCursor = cursor; },
    }, {
      message: {
        topic: 'grp_9',
        chatType: 'group',
        seq: 1001,
        metadata: nativeMetadata({ triggered: true }),
      },
      clearGeneration: 0,
    }, 'cc_group:grp_9');

    assert.equal(valid, true);
    assert.equal(fetches, 10);
    assert.equal(injected.length, 1000);
    assert.equal(savedCursor, 1001);
  });

  test('rejects native history pages from another topic or agent without advancing the cursor', async () => {
    for (const pageScope of [
      { topic_id: 'grp_other', agent_uid: 42 },
      { topic_id: 'grp_9', agent_uid: 99 },
    ]) {
      const bot = Object.create(CatsCompanyBot.prototype) as any;
      bot.botUid = 'usr42';
      bot.bot = {
        getAgentContextHistory: async () => ({
          messages: [{
            id: 87,
            seq_id: 87,
            topic_id: pageScope.topic_id,
            content: 'wrong scope',
            context_eligible: true,
            context_role: 'user',
            context_reason: 'participant_message',
            agent_uid: pageScope.agent_uid,
            agent_id: `usr${pageScope.agent_uid}`,
          }],
          ...pageScope,
          has_more: false,
          next_before_id: 0,
        }),
      };
      const injected: string[] = [];
      const savedCursors: number[] = [];

      const valid = await bot.hydrateNativeFeishuGroupContext({
        injectContext: (message: string) => injected.push(message),
        getRemoteContextCursor: () => 80,
        saveRemoteContextCursor: (_source: string, cursor: number) => savedCursors.push(cursor),
      }, {
        message: {
          topic: 'grp_9',
          chatType: 'group',
          seq: 88,
          metadata: nativeMetadata({ triggered: true }),
        },
        clearGeneration: 0,
      }, 'cc_group:grp_9');

      assert.equal(valid, true);
      assert.deepEqual(injected, []);
      assert.deepEqual(savedCursors, []);
    }
  });
});
