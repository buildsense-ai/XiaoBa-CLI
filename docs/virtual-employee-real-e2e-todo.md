# 虚拟员工真实端到端验证 TODO

这份清单记录“本地自动测试覆盖不了，但上线前必须用真实场景跑一遍”的事情。

当前代码已经能用自动测试证明：两个 CatsCo 用户打开同一个在线 agent 时，会得到不同的 p2p 会话；平台转发给 agent 的消息里会带 canonical `catsco_identity`，包含 actor、agent、body、topic 等信息。

但真实体验还需要在 CatsCo WebApp、CatsCompany 后端、XiaoBa/CatsCo Agent runtime、Dashboard 之间完整跑通。

## 验证目标

用普通人的话说，要确认这件事：

> 一个部署在某台机器或云 VM 上的 agent，只运行一个 body；两个真实用户都能找到它、同时和它说话；它能知道“现在是谁在说话”，并且不会把两个人的 session 混在一起。

## 前置条件

- CatsCompany 测试环境已经部署 `codex/catsco-body-safety` 分支对应的平台代码。
- XiaoBa/CatsCo Agent 测试机器已经使用 `codex/xiaoba-body-safety-dashboard` 分支对应的 Dashboard/runtime 代码。
- 准备两个真实 CatsCo 测试账号：`User A` 和 `User B`。
- 准备一个测试 agent/bot，建议名字明显一点，比如 `School Test Agent`。
- agent body 只在一台机器上启动，记录它的 `bodyId`。
- 模型可以用便宜模型、mock 模型或测试额度；本清单重点不是模型质量，而是身份、会话和连接。
- 不使用生产敏感资料，不让测试 agent 操作真实客户文件。

## 需要收集的证据

- CatsCompany 后端日志：WebSocket 连接、`/api/agents`、`/api/agents/open`、`/api/messages/send`。
- XiaoBa/CatsCo Agent runtime 日志：收到消息、session identity、实际 session key 或 session id。
- Dashboard 截图：CatsCo 账号、Agent 绑定、Agent Body 状态、connector 状态。
- CatsCo WebApp 截图：两个用户能看到同一个 agent，并进入各自聊天。
- 如果失败，保留请求时间、用户、topic id、agent uid、body id、错误提示和日志片段。

## 测试用例

### 1. 部署者启动 agent body

步骤：

1. 部署者在 agent body 所在机器打开 Dashboard。
2. 登录 CatsCo。
3. 选择或创建测试 agent。
4. 启动 CatsCompany connector。

预期：

- Dashboard 显示 CatsCo 账号正常。
- Dashboard 显示 Agent 已绑定。
- Dashboard 显示 Agent Body 是当前机器，状态为 online/active。
- CatsCompany 后端 `bot_config.body_id` 已绑定这个 body。

### 2. 第二台机器不能继承同一个 bot body

步骤：

1. 在另一台机器或另一个 runtime，用同一个 bot API key 但不同 `bodyId` 尝试连接。

预期：

- 平台拒绝第二个 body 连接。
- WebApp 里同一条消息不会出现两个 agent 回复。
- Dashboard 或日志能看到用户可理解的 conflict/auth_error 信息。

### 3. 两个用户都能找到同一个 agent

步骤：

1. `User A` 登录 CatsCo WebApp。
2. `User B` 登录 CatsCo WebApp。
3. 两人都打开 Virtual Employees/agent 列表。

预期：

- 两人都能看到 `School Test Agent`。
- 如果当前 beta 入口依赖 owner/friend 关系，需要先把 bot 加到两人的可访问关系里。
- 看不到时要记录：用户 id、bot uid、是否 friend/owner、`/api/agents` 返回内容。

### 4. 两个用户分别打开 agent 会话

步骤：

1. `User A` 点击 `School Test Agent`。
2. `User B` 点击 `School Test Agent`。

预期：

- `User A` 得到自己的 p2p topic，例如 `p2p_A_agent`。
- `User B` 得到另一个 p2p topic，例如 `p2p_B_agent`。
- 两个人的 topic 不相同。
- 后端 `/api/agents/open` 有清晰日志。

### 5. 两个用户同时发不同任务

步骤：

1. `User A` 发送：`我是 User A，请只回复 A-测试-001`。
2. `User B` 几乎同时发送：`我是 User B，请只回复 B-测试-002`。

预期：

- `User A` 只收到跟 `A-测试-001` 有关的回复。
- `User B` 只收到跟 `B-测试-002` 有关的回复。
- 没有串话、漏回、重复回复。
- XiaoBa/CatsCo Agent 日志里能看到两条消息的 actor 不同、agent/body 相同、topic 不同。

### 6. 不能绕过 agent 入口直接构造 topic

步骤：

1. 准备一个 `User C`，不要把 `School Test Agent` 加到它的 owner/friend 可访问关系里。
2. 用 WebApp 或调试请求尝试直接向 `p2p_UserC_agent` 发消息。

预期：

- 平台返回 403 或等价的“agent 不可访问”错误。
- agent body 不应该收到这条消息。
- 数据库不应该保存这条消息。

### 7. 检查 agent 看到的 session identity

步骤：

1. 查看 runtime 日志或 session debug 输出。
2. 对比 `User A` 和 `User B` 的两轮消息。

预期：

- actor 信息不同：user id、display name、channel actor。
- agent 信息相同：agent uid、agent display name。
- body 信息相同：当前运行机器的 body id。
- topic/session 信息不同：两个人不共享同一个 session。
- 插入给模型看的 identity note 只出现在当前 turn，不污染 durable chat history。

### 8. 刷新后能找回会话

步骤：

1. `User A` 和 `User B` 刷新 CatsCo WebApp。
2. 重新进入 Conversations 或 Virtual Employees。

预期：

- owner 自己的 agent 会话能在 Conversations 找回。
- 成员至少能通过 Virtual Employees 再次进入同一个 agent。
- 如果当前 beta 尚未把所有成员 agent 会话沉淀进 Conversations，需要记录为已知限制，而不是误判为身份失败。

### 9. agent 离线时提示合理

步骤：

1. 停止 agent body。
2. 用户在 WebApp 或 Dashboard 尝试继续聊天。

预期：

- 用户能看到 agent 不在线或连接不可用。
- 不应该静默吞消息。
- 不应该错误地显示另一个 body 在线。

### 10. agent body 重启后历史消息身份不丢

步骤：

1. 停止 agent body。
2. `User A` 和 `User B` 分别发送一条测试消息。
3. 重新启动同一个 agent body。
4. 观察 runtime 是否通过历史补消息或未处理消息拉取看到这两条消息。

预期：

- 重启后的 agent body 仍然是同一个 `bodyId`。
- 拉回来的历史消息仍然带正确 `catsco_identity`。
- `User A` 和 `User B` 的 actor/topic 仍然不同。
- 如果当前产品策略是不允许离线期间继续发给 agent，也要记录实际 UX，而不是把它当成 session identity 失败。

### 11. 微信扫码绑定到当前 agent

这一步验证的是“微信通道属于哪个 agent”，不是完整的“微信 openid 绑定 CatsCo actor”。

步骤：

1. 在 Dashboard 登录 CatsCo。
2. 选择或创建测试 agent，并确认当前 body 已绑定。
3. 打开设置里的微信高级配置。
4. 点击“为当前 Agent 扫码绑定”。
5. 用微信完成扫码授权。
6. 启动 Weixin connector。

预期：

- 没有当前 CatsCo agent/body 时，Dashboard 不允许获取微信二维码。
- 扫码弹窗明确显示“绑定到哪个 agent”。
- 授权成功后，本地 `.env` 有 `WEIXIN_TOKEN` 和 `WEIXIN_BOUND_AGENT_*`。
- 本地 `.xiaoba/channel-bindings.json` 记录了 agent uid、bodyId、绑定人和 token 摘要，但不保存明文 token。
- Weixin connector 启动时拿到当前 agent/body/channel 上下文。
- 如果扫码过程中切换了 agent，授权确认会失败并要求重新扫码。

### 12. CatsCo WebApp 绑定 agent 的微信通道

这一步验证的是“在平台 UI 里选择某个 agent 再扫码”，不是“本地 connector 已经自动同步平台 token”。

步骤：

1. 部署包含 `agent_channel_bindings` 和 `/api/agents/channels/*` 的 CatsCompany。
2. 用 agent owner 的 CatsCo 账号登录 WebApp。
3. 在 Virtual Employees 列表里找到自己 owned 的 agent。
4. 点击 agent 行上的二维码按钮。
5. 确认弹窗显示当前 agent 名称，并展示微信二维码。
6. 用微信完成扫码授权。
7. 刷新或重新打开弹窗查看绑定状态。

预期：

- 只有 owner agent 行展示微信绑定按钮；friend agent 不能配置该 agent 的微信通道。
- 弹窗明确显示“当前 agent”。
- 授权成功后，平台 `agent_channel_bindings` 有 `agent_uid=该 agent`、`channel=weixin`、token 摘要和绑定人。
- API 返回不包含明文 `bot_token` 或 token hash；浏览器只显示状态和 token 尾号。
- 当前阶段不要求本地 Weixin connector 自动使用平台 token，这一项留给 body secret sync。

## 通过标准

| 检查项 | 通过标准 |
|---|---|
| 单 body 绑定 | 同一个 bot 只能被绑定 body 正常接管，不同 body 不能偷偷继承 |
| 多用户入口 | 两个真实 CatsCo 用户都能找到同一个 agent |
| 入口边界 | 不可访问用户不能直接构造 p2p topic 绕过 agent 入口 |
| 独立会话 | 两个用户打开 agent 后 topic/session 不相同 |
| 并发消息 | 两个用户同时发消息不会串话、重复回复或漏回 |
| 身份快照 | agent runtime 能看到正确 actor/agent/body/topic |
| 历史补消息 | agent body 重启后拉回的历史消息仍然带正确身份 |
| 刷新恢复 | 刷新后仍能找到 agent 或对应会话 |
| 离线体验 | agent 离线时错误可理解，不误导用户 |
| 微信 agent 绑定 | 微信扫码只能绑定到当前 agent；启动 Weixin connector 时不会丢失 agent/body 上下文 |
| WebApp 微信通道绑定 | owner 能在 WebApp 给指定 agent 扫码登记微信通道；friend 不能配置；API 不泄露 token |

## 当前暂不验证

- 微信/飞书 openid/user id 绑定回 CatsCo actor。当前只验证“微信 token 或 channel binding 属于哪个 agent”。
- agent body 从平台自动同步 Weixin channel secret 并启动 legacy connector。
- 完整组织权限：owner/member/viewer、邀请、审计。
- GauzMem 图记忆的跨用户检索策略。
- 群聊 Reply Policy、agent-to-agent 防循环。
- 用户本地电脑作为“云盘”的长期连接和 grant 工具。
- 多 CatsCompany server 实例之间的 Redis/DB 在线 lease。

## 失败时怎么记录

每个失败都至少记录：

- 时间。
- 操作用户。
- agent uid / bot uid。
- body id。
- topic id。
- WebApp 截图。
- Dashboard 截图。
- CatsCompany 后端日志。
- XiaoBa/CatsCo Agent runtime 日志。
- 预期是什么，实际发生了什么。

这样 peer review 时不用靠印象判断，可以直接定位是平台身份、Dashboard 绑定、connector 转发、还是 agent session 管理的问题。
