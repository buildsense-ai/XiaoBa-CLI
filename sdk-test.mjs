#!/usr/bin/env node
import { CatsBot } from '@catscompany/bot-sdk';

const bot = new CatsBot({
  serverUrl: process.env.CATSCOMPANY_SERVER_URL,
  apiKey: process.env.CATSCOMPANY_API_KEY,
  httpBaseUrl: process.env.CATSCOMPANY_HTTP_BASE_URL,
});

const tests = [
  '你好',
  '现在几点？',
  '123 * 456 等于多少？',
  '读取 README.md 的前 10 行',
  '找到所有包含 Message 的 .ts 文件',
  '分析这个项目的架构',
  '我叫张三',
  '我叫什么名字？',
];

let topicId = null;

bot.on('ready', async (info) => {
  console.log('✅ Bot 已连接:', info.name);
  console.log('等待找到 zhy8882 的 topic...\n');
});

bot.on('message', async (msg) => {
  if (!topicId && msg.senderId.includes('zhy8882')) {
    topicId = msg.topic;
    console.log(`✅ 找到 topic: ${topicId}\n`);
    await runTests();
  }
});

async function runTests() {
  console.log('📝 开始发送测试消息\n');

  for (let i = 0; i < tests.length; i++) {
    const msg = tests[i];
    console.log(`[${i + 1}/${tests.length}] 发送: ${msg}`);

    try {
      await bot.sendMessage(topicId, msg);
      console.log('  ✓ 已发送\n');
      await new Promise(r => setTimeout(r, 10000));
    } catch (err) {
      console.log(`  ✗ 失败: ${err.message}\n`);
    }
  }

  console.log('✅ 测试完成！等待 20 秒收集数据...');
  await new Promise(r => setTimeout(r, 20000));
  process.exit(0);
}

console.log('🔍 等待 zhy8882 发送任意消息来获取 topic ID...');
console.log('请在 CatsCompany 发送一条消息\n');
