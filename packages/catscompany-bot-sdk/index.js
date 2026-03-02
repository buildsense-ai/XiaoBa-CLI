'use strict';

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class CatsBot extends EventEmitter {
  constructor(options) {
    super();
    this.config = {
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      httpBaseUrl: options.httpBaseUrl || this._deriveHttpBase(options.serverUrl),
    };
    this._ws = null;
    this._msgId = 0;
    this._uid = null;
    this.name = '';
    this._connected = false;
    this._shouldReconnect = true;
    this._reconnectAttempt = 0;
    this._maxReconnectDelay = 30000;
    this._pendingCtrl = new Map();
  }

  _deriveHttpBase(wsUrl) {
    try {
      const u = new URL(wsUrl);
      const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
      return `${proto}//${u.host}`;
    } catch { return ''; }
  }

  _nextId() { return String(++this._msgId); }

  async connect() {
    return new Promise((resolve, reject) => {
      const url = `${this.config.serverUrl}?api_key=${this.config.apiKey}`;
      this._ws = new WebSocket(url);
      this._ws.on('open', async () => {
        try {
          await this._handshake();
          this._connected = true;
          this._reconnectAttempt = 0;
          resolve();
        } catch (err) { reject(err); }
      });
      this._ws.on('message', (raw) => this._onRawMessage(raw));
      this._ws.on('close', () => this._onClose());
      this._ws.on('error', (err) => {
        this.emit('error', err);
        if (!this._connected) reject(err);
      });
    });
  }

  disconnect() {
    this._shouldReconnect = false;
    this._connected = false;
    if (this._ws) { this._ws.close(); this._ws = null; }
  }

  async _handshake() {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      const timeout = setTimeout(() => {
        this._pendingCtrl.delete(id);
        reject(new Error('Handshake timeout'));
      }, 10000);
      this._pendingCtrl.set(id, (ctrl) => {
        clearTimeout(timeout);
        this._pendingCtrl.delete(id);
        if (ctrl.code === 200) {
          this._uid = ctrl.params?.uid;
          this.name = String(ctrl.params?.name || '');
          this.emit('ready', this._uid, this.name);
          resolve();
        } else {
          reject(new Error(`Handshake failed: ${ctrl.text || ctrl.code}`));
        }
      });
      this._send({ hi: { id, ver: '0.1.0' } });
    });
  }

  _onRawMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.ctrl) {
      const handler = this._pendingCtrl.get(msg.ctrl.id);
      if (handler) handler(msg.ctrl);
      return;
    }
    if (msg.data) {
      const d = msg.data;
      this.emit('message', {
        topic: d.topic,
        from: String(d.from),
        seq: d.seq || 0,
        text: typeof d.content === 'string' ? d.content : '',
        isGroup: d.topic?.startsWith('grp_') || false,
        content: d.content,
      });
    }
  }

  _onClose() {
    this._connected = false;
    if (!this._shouldReconnect) return;
    this._reconnectAttempt++;
    const delay = Math.min(1000 * 2 ** (this._reconnectAttempt - 1), this._maxReconnectDelay);
    this.emit('reconnecting', this._reconnectAttempt);
    setTimeout(async () => {
      try { await this.connect(); } catch { /* retry on next close */ }
    }, delay);
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  _waitCtrl(id) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingCtrl.delete(id);
        resolve();
      }, 5000);
      this._pendingCtrl.set(id, (ctrl) => {
        clearTimeout(timeout);
        this._pendingCtrl.delete(id);
        if (ctrl.code === 200) resolve(ctrl.params);
        else reject(new Error(`Server error ${ctrl.code}: ${ctrl.text || ''}`));
      });
    });
  }

  async sendMessage(topic, text) {
    const id = this._nextId();
    this._send({ pub: { id, topic, content: text } });
    return this._waitCtrl(id);
  }

  sendTyping(topic) {
    this._send({ note: { topic, what: 'kp' } });
  }

  async uploadFile(filePath, type) {
    const url = `${this.config.httpBaseUrl}/api/upload?type=${type}`;
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const boundary = '----BotSDK' + Date.now();
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `ApiKey ${this.config.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: Buffer.concat([head, fileBuffer, tail]),
    });
    if (!resp.ok) throw new Error(`Upload failed: HTTP ${resp.status}`);
    const data = await resp.json();
    return data.url || data.file_key;
  }

  async sendImage(topic, ref) {
    const id = this._nextId();
    this._send({ pub: { id, topic, content: { type: 'image', payload: { url: ref } } } });
    return this._waitCtrl(id);
  }

  async sendFile(topic, ref) {
    const id = this._nextId();
    this._send({ pub: { id, topic, content: { type: 'file', payload: { url: ref } } } });
    return this._waitCtrl(id);
  }
}

module.exports = { CatsBot };
