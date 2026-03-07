#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto("http://118.145.116.152/")
    page.fill('input[placeholder="用户名"]', 'zhy8882')
    page.fill('input[type="password"]', '123321')
    page.click('button[type="submit"]')
    time.sleep(2)

    page.click('text=盖尔曼')
    time.sleep(1)

    # 快速发送3条消息测试队列
    for msg in ["测试1", "测试2", "测试3"]:
        page.fill('textarea, input[type="text"]:visible', msg)
        page.keyboard.press('Enter')
        time.sleep(0.5)  # 快速发送

    time.sleep(15)
    browser.close()
    print("✅ 快速测试完成")
