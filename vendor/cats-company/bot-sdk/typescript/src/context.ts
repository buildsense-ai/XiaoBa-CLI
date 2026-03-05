// MessageContext — convenience wrapper around an incoming data message.

import type { CatsBot } from './bot';
import type { MsgServerData, MessageContent } from './types';
import { parseTopic, uidToNumber, type TopicInfo } from './topic';

export class MessageContext {
  public readonly bot: CatsBot;
  public readonly topic: string;
  public readonly from: string;
  public readonly seq: number;
  public readonly content: unknown;
  public readonly replyTo: number | undefined;

  constructor(bot: CatsBot, data: MsgServerData) {
    this.bot = bot;
    this.topic = data.topic;
    this.from = data.from ?? '';
    this.seq = data.seq;
    this.content = data.content;
    this.replyTo = data.reply_to;
  }

  /** Extract plain text from content (returns stringified JSON for rich content). */
  get text(): string {
    if (typeof this.content === 'string') return this.content;
    if (this.content == null) return '';
    return JSON.stringify(this.content);
  }

  /** Whether this is a P2P (direct message) topic. */
  get isP2P(): boolean {
    return this.topic.startsWith('p2p_');
  }

  /** Whether this is a group topic. */
  get isGroup(): boolean {
    return this.topic.startsWith('grp_');
  }

  /** Parsed topic info with peer/group identification. */
  get topicInfo(): TopicInfo {
    return parseTopic(this.topic, uidToNumber(this.bot.uid));
  }

  /** Reply with content to the same topic. */
  async reply(content: MessageContent): Promise<number> {
    return this.bot.sendMessage(this.topic, content);
  }

  /** Send typing indicator, wait, then reply. */
  async replyWithTyping(content: MessageContent, delay = 500): Promise<number> {
    await this.sendTyping();
    await new Promise((r) => setTimeout(r, delay));
    return this.reply(content);
  }

  /** Send a typing indicator to this topic. */
  async sendTyping(): Promise<void> {
    this.bot.sendTyping(this.topic);
  }

  /** Mark messages up to this seq as read. */
  async markRead(): Promise<void> {
    this.bot.sendReadReceipt(this.topic, this.seq);
  }
}
