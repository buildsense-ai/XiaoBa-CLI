#!/usr/bin/env python3
from playwright.sync_api import sync_playwright
import time
import json

tests = [
    "你好",
    "现在几点？",
    "123 * 456 等于多少？",
    "读取 README.md 的前 10 行",
    "找到所有包含 Message 的 .ts 文件",
    "分析这个项目的架构",
    "我叫张三",
    "我叫什么名字？",
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    print("🔐 登录...")
    page.goto("http://118.145.116.152/")
    page.fill('input[placeholder="用户名"]', 'zhy8882')
    page.fill('input[type="password"]', '123321')
    page.click('button[type="submit"]')
    time.sleep(3)

    print("✅ 登录成功\n")

    # 查找盖尔曼
    print("🔍 查找盖尔曼...")
    page.click('text=盖尔曼')
    time.sleep(2)

    print("📝 开始测试\n")
    results = []

    for i, msg in enumerate(tests):
        print(f"[{i+1}/{len(tests)}] {msg}")
        start = time.time()

        # 查找输入框并发送
        page.fill('textarea, input[type="text"]:visible', msg)
        page.keyboard.press('Enter')
        time.sleep(12)

        duration = time.time() - start
        results.append({"msg": msg, "duration": duration})
        print(f"  ✓ {duration:.1f}s\n")

    print("✅ 测试完成，等待20秒...")
    time.sleep(20)

    with open("/Users/zhuhanyuan/Desktop/test-results.json", "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    browser.close()
    print("📄 结果已保存")
