---
name: session-analytics
description: 会话数据分析工具。统计对话轮数、Token 消耗、工具调用频率、活跃时段等指标。用于了解使用模式、成本分析、生成日报摘要。
invocable: both
argument-hint: "<'today' | 'week' | '--date YYYY-MM-DD' | '--range N'>"
---

# Session Analytics - 会话数据分析

分析对话记录，生成统计报告。

**何时使用：**
- 用户问"今天用了多少 token"、"这周花了多少钱"
- 用户问"我最常用什么工具"、"哪个时段最活跃"
- 用户要求生成日报、周报
- 用户问"最近有什么错误"、"哪些命令经常失败"
- AI 需要了解自身使用模式以优化行为

## 快速开始

```bash
# 分析今天的数据
python3 session_analytics.py

# 分析指定日期
python3 session_analytics.py --date 2026-05-12

# 分析最近 7 天
python3 session_analytics.py --range 7

# 只看某个会话
python3 session_analytics.py --session usr2

# Markdown 格式输出（适合直接展示）
python3 session_analytics.py --format markdown
```

## 常用场景

| 用户需求 | 命令 |
|---------|------|
| "今天用了多少 token" | `python3 session_analytics.py` |
| "这周的使用情况" | `python3 session_analytics.py --range 7` |
| "哪个工具用得最多" | `python3 session_analytics.py --top-tools 5` |
| "最近有什么错误" | `python3 session_analytics.py --errors` |
| "生成今天的日报" | `python3 session_analytics.py --format markdown` |
| "某个会话的详情" | `python3 session_analytics.py --session <id>` |

## 输出说明

默认输出 JSON 格式，包含：
- `summary` - 总览（会话数、轮数、token、活跃时段）
- `tool_usage` - 工具调用统计（频率、成功率）
- `hourly_distribution` - 按小时分布
- `sessions` - 各会话概览
- `errors` - 错误统计

使用 `--format markdown` 输出可读性更好的 Markdown 格式。
