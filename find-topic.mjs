#!/usr/bin/env node
import { CatsBot } from '@catscompany/bot-sdk';

const bot = new CatsBot({
  serverUrl: process.env.CATSCOMPANY_SERVER_URL,
  apiKey: process.env.CATSCOMPANY_API_KEY,
  httpBaseUrl: process.env.CATSCOMPANY_HTTP_BASE_URL,
});

bot.on('ready', (info) => {
  console.log('Bot 已连接:', info);
});

bot.on('message', (msg) => {
  console.log('\n收到消息:');
  console.log('  Topic:', msg.topic);
  console.log('  Sender:', msg.senderId);
  console.log('  Text:', msg.text);

  if (msg.senderId === 'zhy8882' || msg.text.includes('test')) {
    console.log('\n✅ 找到 zhy8882 的 topic:', msg.topic);
    process.exit(0);
  }
});

console.log('等待 zhy8882 发送消息...');
console.log('请在 CatsCompany 发送任意消息\n');
