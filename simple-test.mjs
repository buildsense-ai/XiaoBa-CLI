#!/usr/bin/env node
// 简单测试：通过 SDK 直接发送消息到已知 topic
import { CatsBot } from '@catscompany/bot-sdk';

const bot = new CatsBot({
  serverUrl: process.env.CATSCOMPANY_SERVER_URL,
  apiKey: process.env.CATSCOMPANY_API_KEY,
  httpBaseUrl: process.env.CATSCOMPANY_HTTP_BASE_URL,
});

// 尝试几个可能的 topic ID
const possibleTopics = [
  'tpc_67d9a0a0c0a84e0c8c0a0a0a0a0a0a0a',
  'tpc_test',
];

const tests = [
  '你好',
  '123 * 456',
  '读取 README.md 前5行',
];

async function sendTests() {
  console.log('发送测试消息...\n');

  for (const topic of possibleTopics) {
    console.log(`尝试 topic: ${topic}`);

    for (const msg of tests) {
      try {
        await bot.sendMessage(topic, msg);
        console.log(`  ✓ ${msg}`);
        await new Promise(r => setTimeout(r, 12000));
      } catch (err) {
        console.log(`  ✗ ${err.message}`);
        break;
      }
    }
  }

  process.exit(0);
}

setTimeout(sendTests, 2000);
