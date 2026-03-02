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
    config;
    emitter = new events_1.EventEmitter();
    uploader;
    pendingAcks = new Map();
    ws = null;
    msgId = 0;
    reconnectAttempt = 0;
    closed = false;
    pingTimer = null;
    constructor(config) {
        const httpBase = config.httpBaseUrl ?? deriveHttpBase(config.serverUrl);
        this.config = {
            serverUrl: config.serverUrl,
            apiKey: config.apiKey,
            httpBaseUrl: httpBase,
            reconnectDelay: config.reconnectDelay ?? 3000,
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
        if (this.ws) {
            this.ws.close(1000, 'bot disconnect');
            this.ws = null;
        }
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
            }, 10000);
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
            const url = this.config.serverUrl;
            let handshakeDone = false;
            try {
                this.ws = new ws_1.default(url, {
                    headers: { 'X-API-Key': this.config.apiKey },
                });
            }
            catch (err) {
                reject(new errors_1.ConnectionError(`Failed to create WebSocket: ${err.message}`));
                return;
            }
            const handshakeTimeout = setTimeout(() => {
                if (!handshakeDone) {
                    handshakeDone = true;
                    this.ws?.close();
                    reject(new errors_1.HandshakeError('Handshake timed out'));
                }
            }, 10000);
            this.ws.on('open', () => {
                // Send handshake
                const id = this.nextId();
                this.sendRaw({ hi: { id, ver: '0.1.0' } });
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
                        clearTimeout(handshakeTimeout);
                        this.uid = String(msg.ctrl.params?.uid ?? '');
                        this.reconnectAttempt = 0;
                        this.emit('ready', this.uid);
                        resolve();
                        return;
                    }
                    else {
                        handshakeDone = true;
                        clearTimeout(handshakeTimeout);
                        reject(new errors_1.HandshakeError(`Handshake failed: code ${msg.ctrl.code}`));
                        return;
                    }
                }
                this.dispatch(msg);
            });
            this.ws.on('close', (code, reason) => {
                clearTimeout(handshakeTimeout);
                this.clearPingTimer();
                this.rejectAllPending(new errors_1.ConnectionError('Connection closed'));
                this.emit('disconnect', code, reason.toString());
                if (!this.closed) {
                    this.scheduleReconnect();
                }
            });
            this.ws.on('error', (err) => {
                this.emit('error', err);
                if (!handshakeDone) {
                    handshakeDone = true;
                    clearTimeout(handshakeTimeout);
                    reject(new errors_1.ConnectionError(err.message));
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
