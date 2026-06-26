import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MessageSender } from '../src/weixin/message-sender';

describe('weixin message sender', () => {
  test('treats HTTP 200 with successful business response as sent', async () => {
    const originalPost = axios.post;
    const calls: unknown[] = [];
    (axios.post as any) = async (...args: unknown[]) => {
      calls.push(args);
      return { data: { errcode: 0, errmsg: 'ok' } };
    };

    try {
      const sender = new MessageSender('token', 'https://weixin.example.test', 'https://cdn.example.test');
      await sender.sendText('user-1', 'hello', 'ctx-1', 'bot-1');
      assert.equal(calls.length, 1);
      assert.equal((calls[0] as any[])[1].msg.from_user_id, 'bot-1');
    } finally {
      (axios.post as any) = originalPost;
    }
  });

  test('rejects HTTP 200 when sendmessage business response fails', async () => {
    const originalPost = axios.post;
    (axios.post as any) = async () => ({
      data: { errcode: 40003, errmsg: 'invalid context token' },
    });

    try {
      const sender = new MessageSender('token', 'https://weixin.example.test', 'https://cdn.example.test');
      await assert.rejects(
        () => sender.sendText('user-1', 'hello', 'ctx-1'),
        /微信 sendmessage:text 业务失败: errcode=40003/
      );
    } finally {
      (axios.post as any) = originalPost;
    }
  });

  test('allows HTTP 200 when sendmessage response has no acknowledgement fields', async () => {
    const originalPost = axios.post;
    (axios.post as any) = async () => ({ data: {} });

    try {
      const sender = new MessageSender('token', 'https://weixin.example.test', 'https://cdn.example.test');
      await sender.sendText('user-1', 'hello', 'ctx-1', 'bot-1');
    } finally {
      (axios.post as any) = originalPost;
    }
  });

  test('rejects HTTP 200 when success flag is false', async () => {
    const originalPost = axios.post;
    (axios.post as any) = async () => ({
      data: { success: false, message: 'send denied' },
    });

    try {
      const sender = new MessageSender('token', 'https://weixin.example.test', 'https://cdn.example.test');
      await assert.rejects(
        () => sender.sendText('user-1', 'hello', 'ctx-1'),
        /微信 sendmessage:text 业务失败: success=false/
      );
    } finally {
      (axios.post as any) = originalPost;
    }
  });

  test('sends jpg files as Weixin image messages', async () => {
    const originalPost = axios.post;
    const originalFetch = globalThis.fetch;
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-image-send-'));
    const imagePath = path.join(testRoot, 'graded.jpg');
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const calls: Array<{ url: string; body: any }> = [];

    (axios.post as any) = async (url: string, body: any) => {
      calls.push({ url, body });
      if (url.endsWith('/ilink/bot/getuploadurl')) {
        return { data: { errcode: 0, upload_param: 'upload-param' } };
      }
      return { data: { errcode: 0, msgid: 'wx-msg-1' } };
    };
    (globalThis.fetch as any) = async () => ({
      status: 200,
      headers: {
        get: (name: string) => name.toLowerCase() === 'x-encrypted-param' ? 'download-param' : null,
      },
      text: async () => '',
    });

    try {
      const sender = new MessageSender('token', 'https://weixin.example.test', 'https://cdn.example.test');
      await sender.sendFile('user-1', imagePath, 'graded.jpg', 'ctx-1', 'bot-1');

      assert.equal(calls.length, 2);
      assert.equal(calls[0].body.media_type, 1);
      const item = calls[1].body.msg.item_list[0];
      assert.equal(item.type, 2);
      assert.ok(item.image_item);
      assert.equal(item.file_item, undefined);
    } finally {
      (axios.post as any) = originalPost;
      globalThis.fetch = originalFetch;
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });
});
