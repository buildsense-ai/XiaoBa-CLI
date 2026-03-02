import type { CatsBot } from './bot';
import type { MsgServerData, MessageContent } from './types';
import { type TopicInfo } from './topic';
export declare class MessageContext {
    readonly bot: CatsBot;
    readonly topic: string;
    readonly from: string;
    readonly seq: number;
    readonly content: unknown;
    readonly replyTo: number | undefined;
    constructor(bot: CatsBot, data: MsgServerData);
    /** Extract plain text from content (returns empty string for non-string content). */
    get text(): string;
    /** Whether this is a P2P (direct message) topic. */
    get isP2P(): boolean;
    /** Whether this is a group topic. */
    get isGroup(): boolean;
    /** Parsed topic info with peer/group identification. */
    get topicInfo(): TopicInfo;
    /** Reply with content to the same topic. */
    reply(content: MessageContent): Promise<number>;
    /** Send typing indicator, wait, then reply. */
    replyWithTyping(content: MessageContent, delay?: number): Promise<number>;
    /** Send a typing indicator to this topic. */
    sendTyping(): Promise<void>;
    /** Mark messages up to this seq as read. */
    markRead(): Promise<void>;
}
//# sourceMappingURL=context.d.ts.map
