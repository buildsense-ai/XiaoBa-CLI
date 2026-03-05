"use strict";
// CatsBot — main SDK class for connecting to Cats Company via WebSocket.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CatsBot = void 0;
const ws_1 = __importDefault(require("ws"));
const events_1 = require("events");
const errors_1 = require("./errors");
const context_1 = require("./context");
const uploader_1 = require("./uploader");
class CatsBot {
    uid = '';
    name = '';
    config;
    emitter = new events_1.EventEmitter();
    uploader;
    pendingAcks = new Map();
    topicLastSeq = new Map();
    ws = null;
    msgId = 0;
    reconnectAttempt = 0;
    closed = false;
    pingTimer = null;
    hasConversationBaseline = false;
    recoveryPromise = null;
    closeSocket(reason = 'bot disconnect') {
        if (!this.ws)
            return;
        const ws = this.ws;
        this.ws = null;
        if (ws.readyState === ws_1.default.CONNECTING) {
            ws.terminate();
            return;
        }
        if (ws.readyState === ws_1.default.OPEN || ws.readyState === ws_1.default.CLOSING) {
            ws.close(1000, reason);
        }
    }
    constructor(config) {
        const httpBase = config.httpBaseUrl ?? deriveHttpBase(config.serverUrl);
        this.config = {
            serverUrl: config.serverUrl,
            apiKey: config.apiKey,
            httpBaseUrl: httpBase,
            reconnectDelay: config.reconnectDelay ?? 3000,
            connectTimeout: config.connectTimeout ?? 15000,
            handshakeTimeout: config.handshakeTimeout ?? 10000,
            pingTimeout: config.pingTimeout ?? 70000,
        };
        this.uploader = new uploader_1.FileUploader(this.config.httpBaseUrl, this.config.apiKey);
    }
    // --- Typed event emitter ---
    on(event, listener) {
        this.emitter.on(event, listener);
        return this;
    }
    off(event, listener) {
        this.emitter.off(event, listener);
        return this;
    }
    once(event, listener) {
        this.emitter.once(event, listener);
        return this;
    }
    emit(event, ...args) {
        if (event === 'error' && this.emitter.listenerCount('error') === 0) {
            return;
        }
        this.emitter.emit(event, ...args);
    }
    // --- Connection lifecycle ---
    /**
     * Open the WebSocket connection and perform the handshake.
     * Resolves when the handshake ctrl 200 is received.
     */
    connect() {
        this.closed = false;
        return this.doConnect();
    }
    /**
     * Connect and block until the process is interrupted or disconnect() is called.
     */
    async run() {
        await this.connect();
        // Keep the process alive
        return new Promise((resolve) => {
            this.once('disconnect', () => {
                if (this.closed)
                    resolve();
            });
        });
    }
    /**
     * Gracefully close the connection. No automatic reconnect.
     */
    disconnect() {
        this.closed = true;
        this.clearPingTimer();
        this.rejectAllPending(new errors_1.ConnectionError('Disconnected'));
        this.closeSocket('bot disconnect');
    }
    // --- Sending messages ---
    /**
     * Publish a message to a topic. Returns the server-assigned seq number.
     */
    sendMessage(topic, content, replyTo) {
        const id = this.nextId();
        const pub = {
            pub: { id, topic, content, reply_to: replyTo },
        };
        return this.sendWithAck(id, pub);
    }
    /** Send an image message (from an UploadResult). */
    sendImage(topic, upload, opts) {
        const content = {
            type: 'image',
            payload: {
                url: upload.url,
                name: upload.name,
                size: upload.size,
                ...opts,
            },
        };
        return this.sendMessage(topic, content);
    }
    /** Send a file message (from an UploadResult). */
    sendFile(topic, upload, mimeType) {
        const content = {
            type: 'file',
            payload: {
                url: upload.url,
                name: upload.name,
                size: upload.size,
                mime_type: mimeType,
            },
        };
        return this.sendMessage(topic, content);
    }
    /** Send a link preview card. */
    sendLinkPreview(topic, payload) {
        const content = { type: 'link_preview', payload };
        return this.sendMessage(topic, content);
    }
    /** Send a rich card. */
    sendCard(topic, payload) {
        const content = { type: 'card', payload };
        return this.sendMessage(topic, content);
    }
    // --- Notifications ---
    /** Send a typing indicator. */
    sendTyping(topic) {
        this.sendRaw({ note: { topic, what: 'kp' } });
    }
    /** Send a read receipt for messages up to seq. */
    sendReadReceipt(topic, seq) {
        this.sendRaw({ note: { topic, what: 'read', seq } });
    }
    // --- History ---
    /** Fetch message history for a topic since a given seq. */
    getHistory(topic, sinceSeq = 0) {
        const id = this.nextId();
        const messages = [];
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new errors_1.ProtocolError(0, 'History request timed out'));
            }, 15000);
            const onData = (ctx) => {
                if (ctx.topic === topic) {
                    messages.push({
                        topic: ctx.topic,
                        from: ctx.from,
                        seq: ctx.seq,
                        content: ctx.content,
                        reply_to: ctx.replyTo,
                    });
                }
            };
            const onCtrl = (ctrl) => {
                if (ctrl.id === id && ctrl.code === 200) {
                    cleanup();
                    resolve(messages);
                }
                else if (ctrl.id === id) {
                    cleanup();
                    reject(new errors_1.ProtocolError(ctrl.code, ctrl.text));
                }
            };
            const cleanup = () => {
                clearTimeout(timeout);
                this.off('message', onData);
                this.off('ctrl', onCtrl);
            };
            // Temporarily listen for data messages that arrive as history
            this.on('message', onData);
            this.on('ctrl', onCtrl);
            this.sendRaw({ get: { id, topic, what: 'history', seq: sinceSeq } });
        });
    }
    // --- File upload ---
    /** Upload a file from disk path. */
    uploadFile(filePath, type = 'file') {
        return this.uploader.upload(filePath, type);
    }
    /** Upload a buffer. */
    uploadBuffer(buffer, filename, type = 'file') {
        return this.uploader.uploadBuffer(buffer, filename, type);
    }
    // --- Internal ---
    nextId() {
        return String(++this.msgId);
    }
    sendRaw(msg) {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
            throw new errors_1.ConnectionError('WebSocket is not connected');
        }
        this.ws.send(JSON.stringify(msg));
    }
    sendWithAck(id, msg) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingAcks.delete(id);
                reject(new errors_1.ProtocolError(0, 'Ack timeout'));
            }, 30000);
            this.pendingAcks.set(id, { resolve, reject, timer });
            try {
                this.sendRaw(msg);
            }
            catch (err) {
                clearTimeout(timer);
                this.pendingAcks.delete(id);
                reject(err);
            }
        });
    }
    resolveAck(ctrl) {
        if (!ctrl.id)
            return false;
        const pending = this.pendingAcks.get(ctrl.id);
        if (!pending)
            return false;
        clearTimeout(pending.timer);
        this.pendingAcks.delete(ctrl.id);
        if (ctrl.code === 200) {
            const seq = ctrl.params?.seq ?? 0;
            if (ctrl.topic && typeof seq === 'number' && seq > 0) {
                this.noteTopicSeq(ctrl.topic, seq);
            }
            pending.resolve(typeof seq === 'number' ? seq : 0);
        }
        else if (ctrl.code === 429) {
            pending.reject(new errors_1.RateLimitError(ctrl.text));
        }
        else {
            pending.reject(new errors_1.ProtocolError(ctrl.code, ctrl.text));
        }
        return true;
    }
    rejectAllPending(err) {
        for (const [id, pending] of this.pendingAcks) {
            clearTimeout(pending.timer);
            pending.reject(err);
        }
        this.pendingAcks.clear();
    }
    doConnect() {
        return new Promise((resolve, reject) => {
            let handshakeDone = false;
            let socketOpen = false;
            let connectTimer = null;
            let handshakeTimer = null;
            const clearConnectTimers = () => {
                if (connectTimer) {
                    clearTimeout(connectTimer);
                    connectTimer = null;
                }
                if (handshakeTimer) {
                    clearTimeout(handshakeTimer);
                    handshakeTimer = null;
                }
            };
            const failConnect = (err) => {
                if (handshakeDone)
                    return;
                handshakeDone = true;
                clearConnectTimers();
                reject(err);
            };
            try {
                this.ws = new ws_1.default(this.config.serverUrl, {
                    headers: { 'X-API-Key': this.config.apiKey },
                });
            }
            catch (err) {
                reject(new errors_1.ConnectionError(`Failed to create WebSocket: ${err.message}`));
                return;
            }
            connectTimer = setTimeout(() => {
                failConnect(new errors_1.ConnectionError('WebSocket connection timed out'));
                this.closeSocket('connect timeout');
            }, this.config.connectTimeout);
            this.ws.on('open', () => {
                socketOpen = true;
                if (connectTimer) {
                    clearTimeout(connectTimer);
                    connectTimer = null;
                }
                handshakeTimer = setTimeout(() => {
                    failConnect(new errors_1.HandshakeError('Handshake timed out'));
                    this.closeSocket('handshake timeout');
                }, this.config.handshakeTimeout);
                // Send handshake
                const id = this.nextId();
                try {
                    this.sendRaw({ hi: { id, ver: '0.1.0' } });
                }
                catch (err) {
                    failConnect(new errors_1.ConnectionError(err.message));
                }
            });
            this.ws.on('message', (raw) => {
                this.resetPingTimer();
                let msg;
                try {
                    msg = JSON.parse(raw.toString());
                }
                catch {
                    return;
                }
                // Handshake response
                if (!handshakeDone && msg.ctrl) {
                    if (msg.ctrl.code === 200 &&
                        msg.ctrl.params?.build === 'catscompany') {
                        handshakeDone = true;
                        clearConnectTimers();
                        this.uid = String(msg.ctrl.params?.uid ?? '');
                        this.name = String(msg.ctrl.params?.name ?? '');
                        this.reconnectAttempt = 0;
                        this.emit('ready', this.uid, this.name);
                        resolve();
                        void this.recoverMissedMessages();
                        return;
                    }
                    else {
                        failConnect(new errors_1.HandshakeError(`Handshake failed: code ${msg.ctrl.code}`));
                        return;
                    }
                }
                this.dispatch(msg);
            });
            this.ws.on('unexpected-response', (_req, res) => {
                const status = res.statusCode ?? 0;
                failConnect(new errors_1.HandshakeError(`WebSocket upgrade rejected with HTTP ${status}`, status));
                res.resume();
            });
            this.ws.on('close', (code, reason) => {
                clearConnectTimers();
                this.clearPingTimer();
                this.rejectAllPending(new errors_1.ConnectionError('Connection closed'));
                this.emit('disconnect', code, reason.toString());
                if (!handshakeDone) {
                    const message = socketOpen
                        ? 'Connection closed during handshake'
                        : 'WebSocket was closed before the connection was established';
                    failConnect(new errors_1.ConnectionError(message));
                }
                if (!this.closed) {
                    this.scheduleReconnect();
                }
            });
            this.ws.on('error', (err) => {
                if (this.closed && !handshakeDone) {
                    return;
                }
                if (this.emitter.listenerCount('error') > 0) {
                    this.emit('error', err);
                }
                if (!handshakeDone) {
                    failConnect(new errors_1.ConnectionError(err.message));
                }
            });
            this.ws.on('ping', () => {
                this.resetPingTimer();
            });
        });
    }
    dispatch(msg) {
        if (msg.ctrl) {
            // Try to resolve a pending ack first
            if (!this.resolveAck(msg.ctrl)) {
                this.emit('ctrl', msg.ctrl);
            }
        }
        if (msg.data) {
            this.noteTopicSeq(msg.data.topic, msg.data.seq);
            // Self-echo filter: skip messages from ourselves
            if (msg.data.from === this.uid)
                return;
            const ctx = new context_1.MessageContext(this, msg.data);
            this.emit('message', ctx);
        }
        if (msg.pres) {
            this.emit('presence', msg.pres);
        }
        if (msg.info) {
            if (msg.info.what === 'kp') {
                this.emit('typing', msg.info);
            }
            else if (msg.info.what === 'read') {
                this.emit('read', msg.info);
            }
        }
    }
    // --- Ping / heartbeat monitoring ---
    resetPingTimer() {
        this.clearPingTimer();
        this.pingTimer = setTimeout(() => {
            // No ping received within timeout — force reconnect
            if (this.ws) {
                this.ws.close(4000, 'ping timeout');
            }
        }, this.config.pingTimeout);
    }
    clearPingTimer() {
        if (this.pingTimer) {
            clearTimeout(this.pingTimer);
            this.pingTimer = null;
        }
    }
    noteTopicSeq(topic, seq) {
        if (!topic || typeof seq !== 'number' || seq <= 0) {
            return;
        }
        const prev = this.topicLastSeq.get(topic) ?? 0;
        if (seq > prev) {
            this.topicLastSeq.set(topic, seq);
        }
    }
    async recoverMissedMessages() {
        if (this.recoveryPromise) {
            return this.recoveryPromise;
        }
        this.recoveryPromise = (async () => {
            const conversations = await this.fetchConversationCursors();
            if (!this.hasConversationBaseline) {
                for (const convo of conversations) {
                    this.noteTopicSeq(convo.id, convo.latest_seq ?? 0);
                }
                this.hasConversationBaseline = true;
                return;
            }
            for (const convo of conversations) {
                const latestSeq = convo.latest_seq ?? 0;
                const lastSeen = this.topicLastSeq.get(convo.id);
                if (latestSeq <= 0) {
                    continue;
                }
                if (lastSeen == null) {
                    await this.getHistory(convo.id, 0);
                    this.noteTopicSeq(convo.id, latestSeq);
                    continue;
                }
                if (latestSeq > lastSeen) {
                    await this.getHistory(convo.id, lastSeen);
                    this.noteTopicSeq(convo.id, latestSeq);
                }
            }
        })()
            .catch((err) => {
            this.emit('error', new errors_1.ConnectionError(`Conversation recovery failed: ${err.message}`));
        })
            .finally(() => {
            this.recoveryPromise = null;
        });
        return this.recoveryPromise;
    }
    async fetchConversationCursors() {
        const url = `${this.config.httpBaseUrl}/api/conversations`;
        let res;
        try {
            res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `ApiKey ${this.config.apiKey}`,
                },
            });
        }
        catch (err) {
            throw new errors_1.ConnectionError(`Conversation sync request failed: ${err.message}`);
        }
        if (!res.ok) {
            if (res.status === 401) {
                return [];
            }
            const text = await res.text().catch(() => '');
            throw new errors_1.ConnectionError(`Conversation sync failed (${res.status}): ${text}`);
        }
        const data = (await res.json());
        return Array.isArray(data.conversations) ? data.conversations : [];
    }
    // --- Auto-reconnect ---
    scheduleReconnect() {
        this.reconnectAttempt++;
        this.emit('reconnecting', this.reconnectAttempt);
        setTimeout(async () => {
            if (this.closed)
                return;
            try {
                await this.doConnect();
            }
            catch {
                // doConnect failure will trigger ws close → scheduleReconnect again
            }
        }, this.config.reconnectDelay);
    }
}
exports.CatsBot = CatsBot;
// --- Helpers ---
/** Derive an HTTP base URL from a WebSocket URL. */
function deriveHttpBase(wsUrl) {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '';
    u.search = '';
    return u.origin;
}
//# sourceMappingURL=bot.js.map