import { chromium } from 'playwright';

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

async function runTests() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('🔐 登录 CatsCompany...');
  await page.goto('https://catscompany.ai/login');
  await page.fill('input[type="text"]', 'zhy8882');
  await page.fill('input[type="password"]', '123321');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  console.log('✅ 登录成功\n');

  // 找到与盖尔曼的对话
  console.log('🔍 查找盖尔曼对话...');
  await page.click('text=盖尔曼');
  await page.waitForTimeout(2000);

  console.log('📝 开始发送测试消息\n');

  for (let i = 0; i < tests.length; i++) {
    const msg = tests[i];
    console.log(`[${i + 1}/${tests.length}] 发送: ${msg}`);

    await page.fill('textarea', msg);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000); // 等待回复

    console.log(`  ✓ 已发送，等待回复...\n`);
  }

  console.log('✅ 所有测试消息已发送');
  console.log('等待 30 秒收集性能数据...');
  await page.waitForTimeout(30000);

  await browser.close();
  console.log('\n测试完成！');
}

runTests().catch(console.error);
