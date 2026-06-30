import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
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
});
