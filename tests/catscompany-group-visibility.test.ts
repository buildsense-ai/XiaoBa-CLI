/**
 * 多 bot 群的消息可见性、附件地址与队列注入格式。
 *
 * 三条规则服务于同一件事：让一个助手在群里看到的每条消息，格式一致、身份清楚、
 * 附件可读，并且"该不该看见"与"该不该回"分开——后者由激活门控单独决定。
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { selectNativeFeishuGroupContextEntries } from '../src/catscompany/agent-context-history';
import { mergeQueuedMessageContents } from '../src/catscompany/queued-message-merge';

describe('人类 @别人 的消息进入长期上下文', () => {
  test('@别人 的消息收进来，但标记仍保留服务端原意', () => {
    const entries = selectNativeFeishuGroupContextEntries([
      {
        id: 10,
        seq_id: 10,
        topic_id: 'grp_1',
        from_uid: 7,
        content: '帮我看下这个',
        agent_uid: 9,
        agent_id: 'usr9',
        context_role: 'user',
        context_eligible: false,
        context_reason: 'group_message_targets_another_member',
        metadata: { catsco_identity: { actor: { display_name: '林', is_bot: false } } },
      },
    ]);

    assert.equal(entries.length, 1, '被 @ 的是别人，但这条消息仍然可见');
    assert.equal(entries[0].role, 'user');
    assert.ok(entries[0].content.includes('帮我看下这个'), entries[0].content);
    assert.ok(entries[0].content.includes('林（人）'), entries[0].content);
  });

  test('@我 与 @所有人 的消息照旧收进来', () => {
    const entries = selectNativeFeishuGroupContextEntries([
      {
        id: 11,
        seq_id: 11,
        topic_id: 'grp_1',
        from_uid: 7,
        content: '这个给你',
        agent_uid: 9,
        agent_id: 'usr9',
        context_role: 'user',
        context_eligible: true,
        context_reason: 'group_message_targets_agent',
      },
      {
        id: 12,
        seq_id: 12,
        topic_id: 'grp_1',
        from_uid: 7,
        content: '大家一起看',
        agent_uid: 9,
        agent_id: 'usr9',
        context_role: 'user',
        context_eligible: true,
        context_reason: 'group_message_targets_all_agents',
      },
    ]);

    assert.equal(entries.length, 2);
  });

  test('发送者分类失败的消息仍然不进来', () => {
    // 这条与 @别人 不同：服务端根本没认出是谁发的，身份都不可信。
    const entries = selectNativeFeishuGroupContextEntries([
      {
        id: 13,
        seq_id: 13,
        topic_id: 'grp_1',
        from_uid: 7,
        content: '???',
        agent_uid: 9,
        agent_id: 'usr9',
        context_role: 'user',
        context_eligible: false,
        context_reason: 'sender_classification_failed',
      },
    ]);

    assert.equal(entries.length, 0);
  });
});

describe('历史回填保留同伴发过的附件', () => {
  test('file 消息带出名字与服务端给的绝对地址', () => {
    const entries = selectNativeFeishuGroupContextEntries([
      {
        id: 20,
        seq_id: 20,
        topic_id: 'grp_1',
        from_uid: 42,
        content: {
          type: 'file',
          payload: {
            url: '/uploads/files/report.txt',
            name: 'report.txt',
            description: '[附件地址] https://app.catsco.cc/uploads/files/report.txt',
          },
        },
        agent_uid: 9,
        agent_id: 'usr9',
        context_role: 'other_agent',
        context_eligible: false,
        context_reason: 'other_agent_message',
        metadata: { catsco_identity: { actor: { display_name: '阿码', is_bot: true } } },
      },
    ]);

    assert.equal(entries.length, 1, '附件消息以前会被整条丢弃');
    assert.ok(entries[0].content.includes('report.txt'), entries[0].content);
    assert.ok(
      entries[0].content.includes('https://app.catsco.cc/uploads/files/report.txt'),
      entries[0].content,
    );
  });

  test('image 消息同样保留', () => {
    const entries = selectNativeFeishuGroupContextEntries([
      {
        id: 21,
        seq_id: 21,
        topic_id: 'grp_1',
        from_uid: 42,
        content: {
          type: 'image',
          payload: { url: '/uploads/images/shot.png', name: 'shot.png' },
        },
        agent_uid: 9,
        agent_id: 'usr9',
        context_role: 'other_agent',
        context_eligible: false,
        context_reason: 'other_agent_message',
      },
    ]);

    assert.equal(entries.length, 1);
    assert.ok(entries[0].content.includes('shot.png'), entries[0].content);
  });

  test('纯文本消息的渲染不受影响', () => {
    const entries = selectNativeFeishuGroupContextEntries([
      {
        id: 22,
        seq_id: 22,
        topic_id: 'grp_1',
        from_uid: 7,
        content: '就是一句话',
        agent_uid: 9,
        agent_id: 'usr9',
        context_role: 'user',
        context_eligible: true,
        context_reason: 'group_message_targets_agent',
      },
    ]);

    assert.equal(entries.length, 1);
    assert.ok(entries[0].content.endsWith('就是一句话'), entries[0].content);
  });
});

describe('排队消息的注入格式与当前回合一致', () => {
  test('多条消息只拼接，不再另加 usr42 编号', () => {
    const merged = mergeQueuedMessageContents([
      { userMessage: '[发言人: 林（人）]\n先做 A' },
      { userMessage: '[发言人: 阿码（bot）]\n顺便看下 B' },
    ]);

    assert.equal(typeof merged, 'string');
    const text = merged as string;
    assert.ok(text.includes('[发言人: 林（人）]'), text);
    assert.ok(text.includes('[发言人: 阿码（bot）]'), text);
    assert.ok(!text.includes('usr42'), '原始 uid 不再顶替可读身份');
    assert.ok(!/\n1\. /.test(text), '不再另加序号编号');
    assert.ok(text.includes('2 条消息'), text);
  });

  test('单条消息原样返回，不套头部', () => {
    const merged = mergeQueuedMessageContents([
      { userMessage: '[发言人: 林（人）]\n就一条' },
    ]);

    assert.equal(merged, '[发言人: 林（人）]\n就一条');
  });

  test('含附件的消息走 block 形态，文本部分仍保留前缀', () => {
    const merged = mergeQueuedMessageContents([
      { userMessage: '[发言人: 林（人）]\n看这个文件' },
      {
        userMessage: [
          { type: 'text', text: '[发言人: 阿码（bot）]\n[文件] a.txt' },
        ],
      },
    ]);

    assert.ok(Array.isArray(merged), '含富内容时返回 block 数组');
    const blocks = merged as Array<{ type: string; text?: string }>;
    const joined = blocks.map(b => b.text || '').join('\n');
    assert.ok(joined.includes('[发言人: 林（人）]'), joined);
    assert.ok(joined.includes('[发言人: 阿码（bot）]'), joined);
    assert.ok(!joined.includes('补充消息'), '旧的编号式头部已移除');
  });
});
