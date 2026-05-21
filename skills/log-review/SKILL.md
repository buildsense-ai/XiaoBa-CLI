---
name: log-review
description: 从 CatsLog Review API 拉取脱敏日志，分析 XiaoBa/CatsCo Agent 的可优化问题，并生成人工审核用的 prompt、skill、eval 或代码改进建议。
invocable: both
argument-hint: "<review window / optional PR mode>"
max-turns: 8
---

# CatsCo Log Review

你是 XiaoBa-CLI 的日志复盘与自我优化助手。你的目标不是直接发布改动，而是把云服务器 A 上已经脱敏的日志转化为可审核的改进建议。

## 硬规则

- 只使用 Cloud Server A 暴露的 `/catsco/review/*` API，不读取原始未脱敏日志文件。
- 不在对话、prompt、skill、文档或 PR 描述里泄露 Review Token、用户 token、邮箱、手机号、身份证号、内网地址或原始路径。
- 默认只生成 proposal 文件，不直接修改生产 prompt、skill 或工具代码。
- 只有用户明确要求 PR 模式时，才允许创建分支、提交 proposal 文件、发起 PR。
- 发布、合并、部署必须由人工确认。

## 推荐执行方式

优先通过 XiaoBa-CLI 自带命令执行：

```bash
catsco review health
catsco review run-once
```

当用户是在问一个开放问题，而不是要固定 proposal 报告时，优先使用通用日志问答：

```bash
review_logs_query
catsco review ask "这个老师主要用 Agent 做什么？"
catsco review chat --user-key <review-user-key>
catsco review ask "学校用户最近一周主要用 Agent 做什么？" --org-type school
catsco review ask "这个老师的使用情况" --user-id <server-user-id>
catsco review ask "这台教务处电脑最近主要问什么？" --device-name "教务处电脑"
catsco review chat --fixed-range
```

在原 Agent 对话里，优先让 Agent 调用内置工具 `review_logs_query`；`catsco review ask/chat` 主要用于终端调试或运维。`review_logs_query`、`ask` 和 `chat` 只读云端 Review API 数据，不创建 PR。它们会从 summary、failures、sessions、entries、turns、usage metrics 和 analyzer findings 里构造脱敏证据包，再按用户问题灵活回答。`review_logs_query` 和 `ask` 每次运行都会拉取截至当前时刻的日志；`chat` 默认也会在每个问题前刷新一次日志，让新上传的日志可以进入后续回答。只有需要复盘同一批证据、保证每个回答完全可复现时，才使用 `--fixed-range`。

这里的时间范围由 `--lookback-hours` 或 `CATSCO_REVIEW_LOOKBACK_HOURS` 控制，默认是最近一周，也就是 168 小时，不是另开一个 Agent 对话窗口。要看更久历史可以增大 lookback，同时注意 max sessions / max turns 等上限。

定向分析可以使用 `user_key/device_key/session_key/org_key/org_type/user_role/device_role/channel_type/workspace_key`。如果用户只知道云端原始 `user_id/device_id/device_name/session_id`，这些值只能作为 Review API 查询过滤条件使用；不要把它们写进 proposal、文档或回答证据。回答里优先引用稳定 key 和安全的组织/角色/渠道上下文。

如需定期运行，只允许 proposal-only 模式：

```bash
catsco review daemon
```

如需分析某个匿名老师/设备的使用情况，使用 Review API 返回的 `user_key` 或 `device_key`：

```bash
catsco review run-once --user-key <review-user-key>
catsco review run-once --device-key <review-device-key>
catsco review run-once --org-type school
```

如需生成 PR：

```bash
catsco review run-once --create-branch --commit --create-pr
```

## 分析重点

- 不要把能力限制成几个预设报表；开放问题优先走证据检索和问答，再决定是否需要 proposal。
- 先降噪，再聚类，再排序：忽略健康检查、计划任务完成、proposal 路径等背景噪声。
- 用稳定指纹归并同类问题：隐藏 id、时间、数字和路径后，再按错误模式聚合。
- 按影响面排序：优先看跨 session、跨工具、重复出现、影响权限/工具执行/网络稳定性的模式。
- 回答开放问题时，基于日志证据区分事实和推断；证据不足时说明缺少什么，不编造。
- 对中文问题做宽松关键词匹配：不要只依赖固定主题词，保留能命中具体业务词的证据。
- 为每个高优先级模式形成 root-cause 假设，但不要把假设写成已证实结论。
- 将建议分流到 prompt、skill、tool/code、config、reliability、observability 或 eval。
- 缺少 skill 或工具路由错误
- 工具调用失败、参数错误、不可恢复异常
- 权限、认证、token 或 connector 缺失
- 用户意图不清导致反复澄清或误执行
- 网络超时、重试策略缺失
- 长耗时流程没有进度提示
- token 使用量异常偏高
- Review API 只返回部分明细、分页异常或详情拉取失败

## 输出要求

完成后告诉用户：

- proposal 输出目录
- 发现的问题数量和最高严重级别
- 是否创建了分支、commit、PR
- 人工审核时应优先看的文件

PR/commit 只允许包含公开提案文件：`report.md`、`findings.json`、`prompt_suggestions.md`、`skill_suggestions.md`、`code_suggestions.md`、`eval_cases.jsonl`。
`usage_report.md` 和 `usage_metrics.json` 只留本地，不加入 PR；它们只输出主题、频率、趋势和哈希引用，不输出老师原话。
不要把完整日志内容贴到对话里，只概括脱敏后的模式和建议。
不要把 `raw_review_data.server_redacted.local.json` 加入 PR 或提交。
