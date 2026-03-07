#!/usr/bin/env node
import { chromium } from 'playwright';

async function debug() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto('http://118.145.116.152/');
  await page.waitForTimeout(1000);

  console.log('登录...');
  await page.fill('input.oc-auth-input[placeholder="用户名"]', 'zhy8882');
  await page.fill('input.oc-auth-input[type="password"]', '123321');
  await page.click('button.oc-auth-btn');
  await page.waitForTimeout(3000);

  console.log('保存登录后页面结构...');
  const html = await page.content();
  await page.screenshot({ path: 'login_page.png', fullPage: true });

  console.log('查找对话列表...');
  const chats = await page.$$eval('[class*="chat"], [class*="conversation"], [class*="contact"]', els =>
    els.map(el => ({ class: el.className, text: el.textContent?.slice(0, 50) }))
  );
  console.log('对话元素:', chats);

  console.log('\n等待60秒，请手动操作...');
  await page.waitForTimeout(60000);
  await browser.close();
}

debug().catch(console.error);
