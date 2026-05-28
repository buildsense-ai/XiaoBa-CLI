---
name: memory-search
description: 记忆搜索工具。当用户要求"回忆"、"查找"、"搜索"过去的对话、工具调用、错误记录时使用。AI 在解决问题时如果发现需要参考过往信息，也应主动使用此工具搜索。也用于回顾某个话题的演变过程、排查之前遇到的问题。
category: 工具
invocable: both
argument-hint: "<搜索需求描述>"
---

# Memory Search - 记忆搜索

用于搜索和回溯过去的对话记录、工具调用、错误信息。

**何时使用：**
- 用户要求"回忆"、"查找"、"搜索"过去的对话
- 用户问"之前怎么做的"、"那时候讨论了什么"
- 用户问"某天/某个 session 做了什么"
- **AI 解决问题时需要参考过往信息（如之前的错误、决策、代码改动）**
- 需要排查之前遇到的问题

## 快速开始

### 基本调用

```bash
python3 memory-search.py <选项>
```

### 查看帮助

```bash
python3 memory-search.py --help
```

## 常用搜索模式

### 1. 按话题搜索
```bash
# 搜索包含关键词的记录
python3 memory-search.py --keyword "backlog" --limit 5
python3 memory-search.py --keyword "微服务" --limit 3
python3 memory-search.py --keyword "编译" --limit 5
```

### 2. 按工具名搜索
```bash
# 搜索特定工具的调用记录
python3 memory-search.py --tool execute_shell --limit 5
python3 memory-search.py --tool edit_file --limit 3
python3 memory-search.py --tool read_file --limit 3
```

### 3. 按消息类型搜索
```bash
# 只看用户消息
python3 memory-search.py --type user --limit 5

# 只看有工具调用的记录
python3 memory-search.py --type tool --limit 5

# 看可能涉及问题的记录
python3 memory-search.py --type error --limit 5
```

### 4. 特定Session搜索
```bash
# 当前用户的对话
python3 memory-search.py --session usr2 --limit 5

# 某个群组对话
python3 memory-search.py --session grp_35 --limit 5

# 组合：特定session + 关键词
python3 memory-search.py --session usr2 --keyword "backlog"
```

### 5. 会话统计
```bash
# 查看今天所有会话概况
python3 memory-search.py --stats
```

## 嵌套搜索（分步回溯）

当一次搜索结果不足以回答时，可以继续深入：

### Step 1: 初步搜索
```bash
python3 memory-search.py --keyword "某个关键词" --limit 5
```

### Step 2: 查看完整记录
```bash
# 完整显示
python3 memory-search.py --inspect 0 --full

# 截断显示
python3 memory-search.py --inspect 0
```

### Step 3: 查看工具调用详情
```bash
python3 memory-search.py --tools 0
```

### Step 4: 基于发现继续搜索
```bash
# 发现某个session很有价值，继续看该session的更多记录
python3 memory-search.py --session grp_35 --type user --limit 5

# 或搜索同一session的某个关键词
python3 memory-search.py --session grp_35 --keyword "微服务"
```

## 使用场景示例

| 用户需求 | 使用的命令 |
|---------|-----------|
| "我记得之前讨论过backlog" | `--keyword backlog` |
| "查一下编译时报了什么错" | `--keyword "error\|编译"` |
| "看看今天用了哪些工具" | `--stats` 然后 `--tool xxx` |
| "那个微服务的问题后来怎么解决的" | `--keyword 微服务` → `inspect` → 继续搜 |
| "找回上周五的讨论" | `--date 2026-04-11 --keyword xxx` |
| "我今天主要做了什么" | `--stats` 看所有session概览 |
| "看看 grp_35 聊了什么" | `--session grp_35 --type user` |
| "之前修改了哪些文件" | `--tool edit_file` |

## 输出说明

搜索结果会显示：
- `[index] session_id | Turn N | HH:MM` - 记录位置和基本信息
- `User:` - 用户消息摘要
- `🔧 N tools` - 该记录的工具调用数量

用 `inspect index` 查看完整内容，包括：
- 完整的用户消息
- 完整的助手回复
- 所有工具调用的参数和结果

用 `tools index` 查看该记录所有工具的完整详情。

## 完整参数说明

详见：[README.md](README.md)

## 限制

- 默认只搜索今天的会话（日期格式：YYYY-MM-DD）
- `--limit` 默认10条
- Tool result 默认截断显示，可用 `--full` 查看完整
