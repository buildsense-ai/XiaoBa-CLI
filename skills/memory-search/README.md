# Memory Search - 完整参数说明

## 基本语法

```bash
python3 memory-search.py [选项]
```

## 搜索参数

### --date, -d
指定搜索的日期，格式：`YYYY-MM-DD`

- 默认：今天
- 示例：`--date 2026-04-11`

```bash
python3 memory-search.py --date 2026-04-11 --keyword "backlog"
```

### --session, -s
指定搜索的 session ID 或前缀

- 支持前缀匹配：`usr2` 会匹配 `cc_user_usr2`
- 支持完整匹配：`grp_35` 会匹配 `cc_group_grp_35`
- 示例：`--session grp_35`

```bash
# 搜索特定用户的对话
python3 memory-search.py --session usr2 --keyword "backlog"

# 搜索群组对话
python3 memory-search.py --session grp_35 --type user
```

### --type, -t
指定消息类型过滤

可选值：
- `user` - 只看用户消息
- `assistant` - 只看助手回复
- `tool` - 只看有工具调用的记录
- `error` - 看可能涉及错误的记录

```bash
# 只看用户消息
python3 memory-search.py --type user --limit 5

# 只看有工具调用的记录
python3 memory-search.py --type tool --limit 5

# 看可能涉及问题的记录
python3 memory-search.py --type error --limit 5
```

### --keyword, -k
关键词搜索（包含匹配，不区分大小写）

- 可以是单词或短语
- 示例：`--keyword "backlog"` 或 `--keyword 微服务`

```bash
# 搜索包含 "backlog" 的记录
python3 memory-search.py --keyword "backlog" --limit 5

# 搜索多个词
python3 memory-search.py --keyword "微服务" --limit 3
```

### --tool
按工具名过滤，只显示包含该工具调用的记录

常用工具名：
- `execute_shell` - shell 命令
- `edit_file` - 编辑文件
- `read_file` - 读取文件
- `write_file` - 写入文件
- `grep` - 搜索文件内容
- `glob` - 文件模式匹配
- `send_text` - 发送文本
- `send_file` - 发送文件

```bash
# 搜索所有 execute_shell 调用
python3 memory-search.py --tool execute_shell --limit 5

# 搜索文件编辑操作
python3 memory-search.py --tool edit_file --limit 5

# 搜索读文件操作
python3 memory-search.py --tool read_file --limit 5
```

### --turns
指定 turn 范围

格式：`start-end` 或单个数字

```bash
# Turn 5 到 10
python3 memory-search.py --session grp_35 --turns 5-10

# 单独 turn
python3 memory-search.py --session grp_35 --turns 5
```

## 显示参数

### --limit, -n
限制返回结果数量

- 默认：10
- 示例：`--limit 5`

```bash
python3 memory-search.py --keyword "backlog" --limit 5
```

### --truncate
截断文本显示长度

- 默认：150 字符
- 设置为 0 表示不截断

```bash
# 显示更多内容
python3 memory-search.py --keyword "backlog" --truncate 300

# 不截断
python3 memory-search.py --keyword "backlog" --truncate 0
```

### --full
显示完整结果（不截断）

```bash
python3 memory-search.py --inspect 0 --full
```

### --context, -c
显示周围上下文的记录数

用于获取某条记录前后的对话，帮助理解上下文。

```bash
# 显示搜索结果前后各2条记录
python3 memory-search.py --keyword "微服务" --context 2

# 显示前后各5条记录
python3 memory-search.py --keyword "微服务" --context 5
```

## 快速查看命令

### --inspect
查看指定索引的完整记录信息

需要先有搜索结果（通过缓存）。

```bash
# 查看第0条完整信息
python3 memory-search.py --inspect 0

# 完整显示（不截断）
python3 memory-search.py --inspect 0 --full

# 截断显示
python3 memory-search.py --inspect 0 --truncate 200
```

### --tools
查看指定索引的所有工具调用详情

显示该记录中每个工具的：
- 工具名
- 参数（Arguments）
- 结果（Result）

```bash
# 查看第0条的tool详情
python3 memory-search.py --tools 0

# 查看第1条
python3 memory-search.py --tools 1
```

### --stats
显示所有会话的统计信息

包括：
- 各 session 的时间范围
- 消息数量
- 工具使用统计

```bash
python3 memory-search.py --stats
```

## 交互模式

### -i, --interactive
进入交互式搜索模式

```bash
python3 memory-search.py -i
```

交互模式支持命令：
- `search <选项>` 或 `s` - 搜索
- `inspect <idx>` 或 `i` - 查看完整记录
- `tools <idx>` 或 `t` - 查看tool详情
- `last` 或 `l` - 显示上次结果
- `stats` - 会话统计
- `help` - 显示帮助
- `exit` - 退出

## 参数组合示例

### 组合1: 特定 session + 关键词 + 限制数量
```bash
python3 memory-search.py --session usr2 --keyword "backlog" --limit 3
```

### 组合2: 特定 session + 消息类型 + 上下文
```bash
python3 memory-search.py --session grp_35 --type user --context 2
```

### 组合3: 工具过滤 + 日期
```bash
python3 memory-search.py --date 2026-04-11 --tool execute_shell --limit 5
```

### 组合4: 错误记录 + 查看详情
```bash
# 搜索错误
python3 memory-search.py --type error --limit 3

# 查看第一条的完整信息
python3 memory-search.py --inspect 0 --full

# 查看tool详情
python3 memory-search.py --tools 0
```

## Session ID 说明

Session 文件命名格式：`cc_user_usr2.jsonl` 或 `cc_group_grp_35.jsonl`

可用前缀匹配：
- `usr2` → 匹配 `cc_user_usr2`
- `grp_35` → 匹配 `cc_group_grp_35`
- `usr` → 匹配所有用户 session
- `grp` → 匹配所有群组 session

## 缓存机制

搜索结果会缓存到 `/tmp/memory-search-last-results.jsonl`，支持跨命令访问：
- `--inspect` 和 `--tools` 会读取缓存
- 新的搜索会覆盖缓存

## 日志位置

默认搜索目录：`/Users/zhuhanyuan/Documents/xiaoba/logs/sessions/catscompany/YYYY-MM-DD/`

可根据需要修改 `memory-search.py` 中的 `DEFAULT_LOG_DIR`。
