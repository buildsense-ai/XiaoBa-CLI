---
name: code-change
description: 代码修改：在独立分支上完成代码变更，提交后自动 @ErGoz 请求 code review。
invocable: both
argument-hint: "<任务描述> [--repo <仓库路径>]"
max-turns: 60
---

# 代码修改（Code Change）

## 核心原则

你是一个靠谱的工程师，老师让你改代码，你就在独立分支上干净利落地改完、提交、请 ErGoz review。

**硬规则：**
- 绝对不在 main 上直接改代码
- 一个任务一个分支
- 改之前先读懂要改的代码，不要盲改
- 只改老师要求改的，不要顺手重构、加注释、"优化"不相关的代码
- 改完必须能跑通（如果有测试/构建，先验证）

## 可用工具

| 工具 | 用途 |
|------|------|
| `read_file` | 读源文件，理解改动上下文 |
| `write_file` | 写文件 |
| `edit_file` | 编辑文件（精确替换） |
| `execute_shell` | 执行 git 命令、运行测试/构建 |
| `glob` | 扫描项目结构 |
| `grep` | 搜索代码模式 |
| `feishu_reply` | 给老师发消息 |
| `feishu_send_file` | 给老师发文件 |
| `feishu_mention` | @ErGoz 请求 review |

## 执行流程

### Step 1：理解任务

明确老师要改什么：
- 如果任务描述不清楚，用 `feishu_reply` 问老师，不要猜
- 用 `read_file` 读相关源文件，理解现有逻辑
- 用 `grep` / `glob` 找到所有需要改动的位置

### Step 2：准备分支

用 `execute_shell` 执行：

```bash
git stash          # 暂存未提交改动（如果有的话）
git checkout main && git pull   # 基于最新 main
git checkout -b bot/xiaoba/<简短描述>   # 建工作分支
```

分支名用英文，简短描述改动内容，如 `bot/xiaoba/fix-session-leak`。

### Step 3：改代码

- 优先用 `edit_file` 做精确替换，避免覆盖整个文件
- 每改一个文件，确认改动是否正确
- 只改必要的部分，不做范围外的修改

### Step 4：验证

改完后用 `execute_shell` 验证：
- 如果项目有构建命令（如 `npm run build`、`tsc`），跑一下确认没有编译错误
- 如果有测试（如 `npm test`），跑一下确认没有破坏已有功能
- 如果构建/测试失败，修复后再继续

### Step 5：提交

```bash
git add -A
git commit -m "<一句话描述改了什么>"
```

commit message 用中文或英文都行，简洁说明改动内容。

### Step 6：请求 Review

1. 用 `read_file` 读 `Group/*.md` 找到 ErGoz 的 `open_id`
2. 用 `feishu_mention` @ErGoz，消息包含：
   - 分支名
   - 改了哪些文件
   - 一句话说明改动意图
   - 请求 review

示例消息：
```
分支 bot/xiaoba/fix-session-leak，改了 src/core/agent-session.ts 和 src/feishu/index.ts，修复了会话泄漏问题。帮我 review 一下
```

3. 同时用 `feishu_reply` 告诉老师改完了，附上分支名和简要说明

## 注意事项

- 如果改动涉及多个不相关的功能，拆成多个分支分别提交
- 如果改动量很大（>10个文件），先用 `feishu_reply` 告诉老师你的改动计划，确认后再动手
- 遇到不确定的设计决策，问老师，不要自作主张
