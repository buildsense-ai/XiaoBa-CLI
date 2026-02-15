---
name: agent-browser
description: "浏览器自动化工具。用于需要与网页交互的场景：导航页面、填写表单、点击按钮、截图、提取动态加载的数据、测试 Web 应用等。当 web_fetch 无法获取完整内容时，使用此 skill。"
invocable: user
autoInvocable: true
argument-hint: "<url>"
max-turns: 80
---

# Agent Browser

通过 `execute_shell` 运行 `npx agent-browser <command>` 来控制浏览器。

## 核心工作流

```
open <url> → snapshot -i → interact → re-snapshot → ...
```

每次页面变化后必须重新 snapshot，因为 ref 编号会改变。

## 命令参考

### 导航

```bash
npx agent-browser open <url>           # 打开页面
npx agent-browser back                 # 后退
npx agent-browser forward              # 前进
npx agent-browser refresh              # 刷新
npx agent-browser open <url> --new-tab # 新标签页打开
npx agent-browser tabs                 # 列出所有标签页
npx agent-browser switch-tab <index>   # 切换标签页
npx agent-browser close-tab            # 关闭当前标签页
```

### 快照（Snapshot）

```bash
npx agent-browser snapshot             # 获取页面快照（纯文本）
npx agent-browser snapshot -i          # 获取带 ref 编号的交互式快照
npx agent-browser snapshot --html      # 获取 HTML 快照
```

`-i` 模式下，每个可交互元素会标注 `[ref=N]`，后续命令用 ref 编号定位元素。

### 交互

```bash
npx agent-browser click <ref>                    # 点击元素
npx agent-browser type <ref> --text "内容"        # 输入文本
npx agent-browser type <ref> --text "内容" --submit  # 输入并提交
npx agent-browser select <ref> --value "选项值"   # 选择下拉选项
npx agent-browser hover <ref>                    # 悬停
npx agent-browser scroll-down                    # 向下滚动
npx agent-browser scroll-up                      # 向上滚动
npx agent-browser scroll-down <ref>              # 在元素内向下滚动
```

### 键盘

```bash
npx agent-browser key Enter
npx agent-browser key Tab
npx agent-browser key Escape
npx agent-browser key "Control+a"
```

### 等待

```bash
npx agent-browser wait <seconds>                 # 等待指定秒数
npx agent-browser wait-for-text "文本内容"        # 等待文本出现
```

### 截图与文件

```bash
npx agent-browser screenshot                     # 截图（输出路径）
npx agent-browser screenshot --path ./shot.png   # 截图到指定路径
npx agent-browser pdf --path ./page.pdf          # 保存为 PDF
```

### JavaScript 执行

使用 `--stdin` heredoc 避免 shell 转义问题：

```bash
npx agent-browser eval --stdin <<'JS'
document.querySelectorAll('table tr').forEach(row => {
  console.log(Array.from(row.cells).map(c => c.textContent.trim()).join(' | '));
});
JS
```

### 语义定位器（find）

当 ref 编号不可靠时，使用语义定位：

```bash
npx agent-browser find text "登录"               # 按文本查找
npx agent-browser find label "用户名"             # 按 label 查找
npx agent-browser find role "button"             # 按 ARIA role 查找
npx agent-browser find placeholder "请输入..."    # 按 placeholder 查找
```

find 返回 ref 编号，可直接用于后续交互命令。

### Session 持久化

```bash
npx agent-browser open <url> --session my-session   # 使用命名 session
```

同一 session 名会复用浏览器上下文（cookies、登录状态等）。

## 常用模式

### 表单填写

```bash
npx agent-browser open "https://example.com/form"
npx agent-browser snapshot -i
npx agent-browser type 3 --text "张三"
npx agent-browser type 5 --text "zhangsan@example.com"
npx agent-browser select 7 --value "option2"
npx agent-browser click 10
npx agent-browser snapshot -i    # 确认提交结果
```

### 数据提取

```bash
npx agent-browser open "https://example.com/data"
npx agent-browser wait-for-text "加载完成"
npx agent-browser eval --stdin <<'JS'
JSON.stringify(
  Array.from(document.querySelectorAll('.item')).map(el => ({
    title: el.querySelector('h3')?.textContent?.trim(),
    price: el.querySelector('.price')?.textContent?.trim(),
  }))
);
JS
```

### 需要登录的页面

```bash
npx agent-browser open "https://example.com/login" --session my-app
npx agent-browser snapshot -i
npx agent-browser type 2 --text "username"
npx agent-browser type 4 --text "password"
npx agent-browser click 6
npx agent-browser wait-for-text "欢迎"
# 后续请求继续使用 --session my-app 保持登录状态
npx agent-browser open "https://example.com/dashboard" --session my-app
```

## 重要提示

- 每次页面导航或交互后，必须重新 `snapshot -i` 获取新的 ref 编号
- ref 编号在页面变化后会失效，不要缓存或复用旧的 ref
- 对于简单的静态页面抓取，优先使用 `web_fetch` 工具，更快更轻量
- 如果页面需要 JavaScript 渲染才能显示内容，才需要使用此 skill
