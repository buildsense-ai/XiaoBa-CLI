import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  isNativeFeishuGroupTrigger,
  selectNativeFeishuGroupContext,
  selectNativeFeishuGroupContextEntries,
} from '../src/catscompany/agent-context-history';
import { CatsCompanyBot } from '../src/catscompany';

function nativeMetadata(options: {
  triggered?: boolean;
  speaker?: string;
  userId?: string;
  topicId?: string;
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
        user_id: options.userId ?? 'usr7',
      },
      agent: { agent_id: 'usr42' },
      topic: { topic_id: options.topicId ?? 'grp_9', type: 'group' },
      permissions: { source: 'server_canonical_message' },
    },
  };
}

function scopedHistory(messages: any[]): any[] {
  return messages.map(message => ({
    id: message.seq_id,
    topic_id: 'grp_9',
    from_uid: 7,
    agent_uid: 42,
    agent_id: 'usr42',
    ...message,
  }));
}

function nativeExecutionScope(): any {
  return { identityTrust: 'server_canonical', topicId: 'grp_9' };
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
    const context = selectNativeFeishuGroupContext(scopedHistory([
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
    ]), 3, 0, 'grp_9', 'usr42');

    assert.deepEqual(context, [
      '[发言人: 陈大为; id=usr7]\n给我发一个 txt 文件',
      '[发言人: 林益; id=usr7]\n里面写一句诗',
    ]);
  });

  test('keeps a missed current-Agent message as assistant during incremental hydration', () => {
    const context = selectNativeFeishuGroupContextEntries(scopedHistory([
      {
        seq_id: 11,
        from_uid: 42,
        content: '上一轮由当前 Agent 发出的回复',
        context_eligible: true,
        context_role: 'assistant',
        context_reason: 'current_agent_message',
      },
      {
        seq_id: 12,
        content: '@当前Agent 继续',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'group_message_targets_agent',
        metadata: { catsco_identity: nativeMetadata({ speaker: '陈大为' }).catsco_identity },
      },
    ]), 10, 12, 'grp_9', 'usr42');

    assert.deepEqual(context, [{
      source: 'catscompany.agent_context',
      id: 11,
      role: 'assistant',
      content: '上一轮由当前 Agent 发出的回复',
    }]);
  });

  test('drops cross-scope records and never promotes a participant to assistant history', () => {
    const context = selectNativeFeishuGroupContextEntries(scopedHistory([
      {
        seq_id: 21,
        content: 'valid human',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
      },
      {
        seq_id: 22,
        topic_id: 'grp_other',
        content: 'cross-topic injection',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
      },
      {
        seq_id: 23,
        agent_id: 'usr99',
        agent_uid: 99,
        content: 'cross-agent injection',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
      },
      {
        seq_id: 24,
        agent_id: 'usr42',
        agent_uid: 99,
        content: 'conflicting numeric agent scope',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
      },
      {
        seq_id: 25,
        agent_id: 'usr99',
        agent_uid: 42,
        content: 'conflicting string agent scope',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'participant_message',
      },
      {
        seq_id: 26,
        content: 'participant assistant spoof',
        context_eligible: true,
        context_role: 'assistant',
        context_reason: 'current_agent_message',
      },
      {
        seq_id: 27,
        from_uid: 42,
        content: 'wrong assistant reason',
        context_eligible: true,
        context_role: 'assistant',
        context_reason: 'participant_message',
      },
      {
        seq_id: 28,
        from_uid: 0,
        content: 'missing other agent actor',
        context_eligible: false,
        context_role: 'other_agent',
        context_reason: 'other_agent_message',
      },
      {
        seq_id: 29,
        from_uid: 42,
        content: 'valid current agent',
        context_eligible: true,
        context_role: 'assistant',
        context_reason: 'current_agent_message',
      },
    ]), 0, 0, 'grp_9', 'usr42');

    assert.deepEqual(context.map(entry => [entry.role, entry.content]), [
      ['user', '[发言人: usr7; id=usr7]\nvalid human'],
      ['assistant', 'valid current agent'],
    ]);
  });

  test('excludes only the exact current trigger and keeps earlier targeted turns', () => {
    const context = selectNativeFeishuGroupContext(scopedHistory([
      {
        id: 7,
        seq_id: 7,
        content: '@机器人 上一轮已经问过的问题',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'group_message_targets_agent',
        agent_uid: 42,
        agent_id: 'usr42',
        metadata: nativeMetadata({ triggered: true, speaker: '布鲁斯' }),
      },
      {
        id: 8,
        seq_id: 8,
        content: '@机器人 当前触发',
        context_eligible: true,
        context_role: 'user',
        context_reason: 'group_message_targets_agent',
        agent_uid: 42,
        agent_id: 'usr42',
        metadata: nativeMetadata({ triggered: true, speaker: '布鲁斯' }),
      },
    ]), 0, 8, 'grp_9', 'usr42');

    assert.deepEqual(context, ['[发言人: 布鲁斯; id=usr7]\n@机器人 上一轮已经问过的问题']);
  });

  test('replays legacy other_agent context as a labeled participant', () => {
    const context = selectNativeFeishuGroupContext(scopedHistory([
      {
        id: 21,
        seq_id: 21,
        content: '旧版其他 Agent 的结论',
        context_eligible: false,
        context_role: 'other_agent',
        context_reason: 'other_agent_message',
        agent_uid: 42,
        agent_id: 'usr42',
        from_uid: 43,
        metadata: { catsco_identity: nativeMetadata({ speaker: 'Saturday', userId: 'usr43' }).catsco_identity },
      },
    ]), 0, 0, 'grp_9', 'usr42');

    assert.deepEqual(context, ['[其他 Agent: Saturday; id=usr43]\n旧版其他 Agent 的结论']);
  });

  test('keeps only ordinary group messages after the latest clear boundary', () => {
    const context = selectNativeFeishuGroupContext(scopedHistory([
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
    ]), 0, 0, 'grp_9', 'usr42');

    assert.deepEqual(context, ['[发言人: 林益; id=usr7]\n清空后的新讨论']);
  });

  test('hydrates complete missed group history before processing the current trigger', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.botUid = 'usr42';
    const injected: string[] = [];
    const savedCursors: Array<[string, number]> = [];
    bot.bot = {
      getAgentContextHistory: async (topic: string, options: { beforeId?: number }) => {
        assert.equal(topic, 'grp_9');
        assert.equal(options.beforeId, 88);
        return {
          messages: [
            {
              id: 84,
              seq_id: 84,
              content: '公网能访问么',
              context_eligible: true,
              context_role: 'user',
              context_reason: 'participant_message',
              topic_id: 'grp_9',
              from_uid: 7,
              agent_uid: 42,
              agent_id: 'usr42',
              metadata: { catsco_identity: nativeMetadata({ speaker: '布鲁斯' }).catsco_identity },
            },
            {
              id: 85,
              seq_id: 85,
              content: '@另一个Agent 先检查部署',
              context_eligible: true,
              context_role: 'user',
              context_reason: 'group_message_targets_another_member',
              topic_id: 'grp_9',
              from_uid: 7,
              agent_uid: 42,
              agent_id: 'usr42',
              metadata: { catsco_identity: nativeMetadata({ speaker: '布鲁斯' }).catsco_identity },
            },
            {
              id: 86,
              seq_id: 86,
              content: '部署正常，公网入口未开放',
              context_eligible: true,
              context_role: 'other_agent',
              context_reason: 'other_agent_message',
              topic_id: 'grp_9',
              from_uid: 43,
              agent_uid: 42,
              agent_id: 'usr42',
              metadata: { catsco_identity: nativeMetadata({ speaker: 'Saturday', userId: 'usr43' }).catsco_identity },
            },
            {
              id: 87,
              seq_id: 87,
              content: '@所有人 汇总',
              context_eligible: true,
              context_role: 'user',
              context_reason: 'group_message_targets_all_agents',
              topic_id: 'grp_9',
              from_uid: 7,
              agent_uid: 42,
              agent_id: 'usr42',
              metadata: { catsco_identity: nativeMetadata({ speaker: '布鲁斯' }).catsco_identity },
            },
            {
              id: 88,
              seq_id: 88,
              content: '@当前Agent',
              context_eligible: true,
              context_role: 'user',
              context_reason: 'group_message_targets_agent',
              topic_id: 'grp_9',
              from_uid: 7,
              agent_uid: 42,
              agent_id: 'usr42',
              metadata: { catsco_identity: nativeMetadata({ speaker: '布鲁斯' }).catsco_identity },
            },
          ],
          topic_id: 'grp_9',
          agent_uid: 42,
          has_more: false,
          next_before_id: 0,
        };
      },
    };

    await bot.hydrateNativeFeishuGroupContext({
      appendDurableContext: async (messages: Array<string | { content: string }>, cursorUpdate?: { source: string; cursor: number }) => { injected.push(...messages.map(message => typeof message === 'string' ? message : message.content)); if (cursorUpdate) savedCursors.push([cursorUpdate.source, cursorUpdate.cursor]); return true; },
      getRemoteContextCursor: () => 80,
      saveRemoteContextCursor: (source: string, cursor: number) => { savedCursors.push([source, cursor]); return true; },
    }, {
      message: {
        topic: 'grp_9',
        chatType: 'group',
        seq: 88,
        metadata: nativeMetadata({ triggered: true }),
        executionScope: nativeExecutionScope(),
      },
      clearGeneration: 0,
    }, 'cc_group:grp_9');

    assert.deepEqual(injected, [
      '[发言人: 布鲁斯; id=usr7]\n公网能访问么',
      '[发言人: 布鲁斯; id=usr7]\n@另一个Agent 先检查部署',
      '[其他 Agent: Saturday; id=usr43]\n部署正常，公网入口未开放',
      '[发言人: 布鲁斯; id=usr7]\n@所有人 汇总',
    ]);
    assert.deepEqual(savedCursors, [['catscompany.agent_context', 88]]);
  });

  test('does not advance the remote cursor when durable context persistence fails', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.botUid = 'usr42';
    bot.bot = {
      getAgentContextHistory: async () => ({
        messages: [{
          id: 81,
          seq_id: 81,
          content: '需要保留的补历史消息',
          context_eligible: true,
          context_role: 'user',
          context_reason: 'participant_message',
          topic_id: 'grp_9',
          from_uid: 7,
          agent_uid: 42,
          agent_id: 'usr42',
          metadata: { catsco_identity: nativeMetadata({ speaker: '布鲁斯' }).catsco_identity },
        }],
        topic_id: 'grp_9',
        agent_uid: 42,
        has_more: false,
        next_before_id: 0,
      }),
    };
    const savedCursors: number[] = [];

    const valid = await bot.hydrateNativeFeishuGroupContext({
      appendDurableContext: async () => false,
      getRemoteContextCursor: () => 80,
      saveRemoteContextCursor: (_source: string, cursor: number) => { savedCursors.push(cursor); return true; },
    }, {
      message: {
        topic: 'grp_9',
        chatType: 'group',
        seq: 82,
        metadata: nativeMetadata({ triggered: true }),
        executionScope: nativeExecutionScope(),
      },
      clearGeneration: 0,
    }, 'cc_group:grp_9');

    assert.equal(valid, false);
    assert.deepEqual(savedCursors, []);
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
      appendDurableContext: async () => assert.fail('restored history must not be appended twice'),
      getRemoteContextCursor: () => 100,
      saveRemoteContextCursor: (source: string, cursor: number) => { savedCursors.push([source, cursor]); return true; },
    }, {
      message: {
        topic: 'grp_9',
        chatType: 'group',
        seq: 88,
        metadata: nativeMetadata({ triggered: true }),
        executionScope: nativeExecutionScope(),
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
      topic_id: 'grp_9',
      from_uid: 7,
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
      appendDurableContext: async (messages: Array<string | { content: string }>, cursorUpdate?: { cursor: number }) => { injected.push(...messages.map(message => typeof message === 'string' ? message : message.content)); if (cursorUpdate) savedCursor = cursorUpdate.cursor; return true; },
      getRemoteContextCursor: () => savedCursor,
      saveRemoteContextCursor: (_source: string, cursor: number) => { savedCursor = cursor; return true; },
    }, {
      message: {
        topic: 'grp_9',
        chatType: 'group',
        seq: 205,
        metadata: nativeMetadata({ triggered: true }),
        executionScope: nativeExecutionScope(),
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

  test('cross-scope low or duplicate sequences cannot truncate incremental pagination', async () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    bot.botUid = 'usr42';
    const beforeIds: number[] = [];
    const injected: string[] = [];
    bot.bot = {
      getAgentContextHistory: async (_topic: string, options: { beforeId: number }) => {
        beforeIds.push(options.beforeId);
        if (options.beforeId === 200) {
          return {
            messages: [
              {
                id: 5,
                seq_id: 5,
                topic_id: 'grp_other',
                from_uid: 99,
                content: 'must not stop pagination',
                context_eligible: true,
                context_role: 'user',
                context_reason: 'participant_message',
                agent_uid: 42,
                agent_id: 'usr42',
              },
              {
                id: 150,
                seq_id: 150,
                topic_id: 'grp_other',
                from_uid: 99,
                content: 'must not occupy the sequence',
                context_eligible: true,
                context_role: 'user',
                context_reason: 'participant_message',
                agent_uid: 42,
                agent_id: 'usr42',
              },
              {
                id: 150,
                seq_id: 150,
                topic_id: 'grp_9',
                from_uid: 7,
                content: 'newer valid history',
                context_eligible: true,
                context_role: 'user',
                context_reason: 'participant_message',
                agent_uid: 42,
                agent_id: 'usr42',
              },
            ],
            topic_id: 'grp_9',
            agent_uid: 42,
            has_more: true,
            next_before_id: 100,
          };
        }
        return {
          messages: [
            {
              id: 80,
              seq_id: 80,
              topic_id: 'grp_9',
              from_uid: 7,
              content: 'cursor boundary',
              context_eligible: true,
              context_role: 'user',
              context_reason: 'participant_message',
              agent_uid: 42,
              agent_id: 'usr42',
            },
            {
              id: 90,
              seq_id: 90,
              topic_id: 'grp_9',
              from_uid: 7,
              content: 'older valid history',
              context_eligible: true,
              context_role: 'user',
              context_reason: 'participant_message',
              agent_uid: 42,
              agent_id: 'usr42',
            },
          ],
          topic_id: 'grp_9',
          agent_uid: 42,
          has_more: false,
          next_before_id: 80,
        };
      },
    };

    const valid = await bot.hydrateNativeFeishuGroupContext({
      appendDurableContext: async (messages: Array<{ content: string }>) => {
        injected.push(...messages.map(message => message.content));
        return true;
      },
      getRemoteContextCursor: () => 80,
      saveRemoteContextCursor: () => true,
    }, {
      message: {
        topic: 'grp_9',
        chatType: 'group',
        seq: 200,
        metadata: nativeMetadata({ triggered: true }),
        executionScope: nativeExecutionScope(),
      },
      clearGeneration: 0,
    }, 'cc_group:grp_9');

    assert.equal(valid, true);
    assert.deepEqual(beforeIds, [200, 100]);
    assert.deepEqual(injected, [
      '[发言人: usr7; id=usr7]\nolder valid history',
      '[发言人: usr7; id=usr7]\nnewer valid history',
    ]);
  });

  test('paginates beyond ten pages without losing older durable history', async () => {
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
            topic_id: 'grp_9',
            from_uid: 7,
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
      appendDurableContext: async (messages: Array<string | { content: string }>, cursorUpdate?: { cursor: number }) => { injected.push(...messages.map(message => typeof message === 'string' ? message : message.content)); if (cursorUpdate) savedCursor = cursorUpdate.cursor; return true; },
      getRemoteContextCursor: () => savedCursor,
      saveRemoteContextCursor: (_source: string, cursor: number) => { savedCursor = cursor; return true; },
    }, {
      message: {
        topic: 'grp_9',
        chatType: 'group',
        seq: 1001,
        metadata: nativeMetadata({ triggered: true }),
        executionScope: nativeExecutionScope(),
      },
      clearGeneration: 0,
    }, 'cc_group:grp_9');

    assert.equal(valid, true);
    assert.equal(fetches, 11);
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
        appendDurableContext: async (messages: Array<string | { content: string }>) => { injected.push(...messages.map(message => typeof message === 'string' ? message : message.content)); return true; },
        getRemoteContextCursor: () => 80,
        saveRemoteContextCursor: (_source: string, cursor: number) => { savedCursors.push(cursor); return true; },
      }, {
        message: {
          topic: 'grp_9',
          chatType: 'group',
          seq: 88,
          metadata: nativeMetadata({ triggered: true }),
          executionScope: nativeExecutionScope(),
        },
        clearGeneration: 0,
      }, 'cc_group:grp_9');

      assert.equal(valid, false);
      assert.deepEqual(injected, []);
      assert.deepEqual(savedCursors, []);
    }
  });
});
