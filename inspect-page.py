#!/usr/bin/env python3
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto("http://118.145.116.152/")

    # 保存页面 HTML
    html = page.content()
    with open("page_structure.html", "w") as f:
        f.write(html)

    # 截图
    page.screenshot(path="login_page.png")

    print("✅ 页面结构已保存到 page_structure.html")
    print("✅ 截图已保存到 login_page.png")

    browser.close()
