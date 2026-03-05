"use strict";
// MessageContext — convenience wrapper around an incoming data message.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageContext = void 0;
const topic_1 = require("./topic");
class MessageContext {
    bot;
    topic;
    from;
    seq;
    content;
    replyTo;
    constructor(bot, data) {
        this.bot = bot;
        this.topic = data.topic;
        this.from = data.from ?? '';
        this.seq = data.seq;
        this.content = data.content;
        this.replyTo = data.reply_to;
    }
    /** Extract plain text from content (returns stringified JSON for rich content). */
    get text() {
        if (typeof this.content === 'string')
            return this.content;
        if (this.content == null)
            return '';
        return JSON.stringify(this.content);
    }
    /** Whether this is a P2P (direct message) topic. */
    get isP2P() {
        return this.topic.startsWith('p2p_');
    }
    /** Whether this is a group topic. */
    get isGroup() {
        return this.topic.startsWith('grp_');
    }
    /** Parsed topic info with peer/group identification. */
    get topicInfo() {
        return (0, topic_1.parseTopic)(this.topic, (0, topic_1.uidToNumber)(this.bot.uid));
    }
    /** Reply with content to the same topic. */
    async reply(content) {
        return this.bot.sendMessage(this.topic, content);
    }
    /** Send typing indicator, wait, then reply. */
    async replyWithTyping(content, delay = 500) {
        await this.sendTyping();
        await new Promise((r) => setTimeout(r, delay));
        return this.reply(content);
    }
    /** Send a typing indicator to this topic. */
    async sendTyping() {
        this.bot.sendTyping(this.topic);
    }
    /** Mark messages up to this seq as read. */
    async markRead() {
        this.bot.sendReadReceipt(this.topic, this.seq);
    }
}
exports.MessageContext = MessageContext;
//# sourceMappingURL=context.js.map