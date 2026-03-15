---
name: report
description: 生成 XiaoBa 的每日工作报告、日报、工作总结。当用户要求生成报告、查看今天的工作、总结工作内容时使用
version: 1.0.0
author: XiaoBa Team
user_invocable: true
---

# Report Skill

生成 XiaoBa 的每日工作报告，汇总所有会话的工作内容。

## 使用方式

```
/report                    # 生成今天的日报
/report 2026-03-13        # 生成指定日期的日报
```

## 报告内容

- 统计概览（会话数、轮次、tokens）
- 个人工作总结（chat 会话）
- 团队工作总结（catscompany/feishu 会话）
- 主要使用的工具

## 输出

报告保存到 `logs/reports/YYYY-MM-DD.md`
