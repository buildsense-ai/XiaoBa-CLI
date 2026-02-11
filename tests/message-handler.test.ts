import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageHandler } from '../src/feishu/message-handler';

function buildTextEvent(options: {
  text: string;
  mentions?: any[];
  chatType?: 'group' | 'p2p';
}): any {
  return {
    message: {
      message_id: 'om_test_1',
      chat_id: 'oc_test_1',
      chat_type: options.chatType ?? 'group',
      message_type: 'text',
      content: JSON.stringify({ text: options.text }),
      mentions: options.mentions ?? [],
    },
    sender: {
      sender_id: {
        open_id: 'ou_sender',
      },
    },
  };
}

test('message handler only marks mentionBot when mentioned open_id matches bot', () => {
  const handler = new MessageHandler();
  handler.setBotOpenId('ou_bot');

  const byOther = handler.parse(buildTextEvent({
    text: '@张三 帮忙看一下',
    mentions: [
      { key: '@张三', id: { open_id: 'ou_other' } },
    ],
  }));
  assert.notEqual(byOther, null);
  assert.equal(byOther?.mentionBot, false);

  const byBot = handler.parse(buildTextEvent({
    text: '@小八 帮忙看一下',
    mentions: [
      { key: '@小八', id: { open_id: 'ou_bot' } },
    ],
  }));
  assert.notEqual(byBot, null);
  assert.equal(byBot?.mentionBot, true);
});

test('message handler falls back to alias match only when botOpenId is missing', () => {
  const handler = new MessageHandler();
  handler.setMentionAliases(['小八', 'xiaoba']);

  const byAlias = handler.parse(buildTextEvent({
    text: '@小八 帮忙看一下',
    mentions: [
      { key: '@小八', id: { open_id: 'ou_unknown' } },
    ],
  }));
  assert.notEqual(byAlias, null);
  assert.equal(byAlias?.mentionBot, true);

  const byOther = handler.parse(buildTextEvent({
    text: '@李四 帮忙看一下',
    mentions: [
      { key: '@李四', id: { open_id: 'ou_other' } },
    ],
  }));
  assert.notEqual(byOther, null);
  assert.equal(byOther?.mentionBot, false);
});
