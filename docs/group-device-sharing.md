# 群聊设备共享协议

本改动配合 CatsCompany 的群聊设备共享后端使用，不增加新的网络服务。Bot 与 Connector 继续通过 CatsCo WebSocket 连接。

## Bot 与 Connector 的职责

- 设备所有者在 CatsCompany 群聊的「设备与授权」面板直接授权。Bot 负责使用已授权设备。
- Bot 收到的执行上下文可包含共享设备，但 actor 仍是发起人，owner 仍是物理设备所有者。默认和显式目标都按 owner+device 解析；显式使用共享电脑不会改写默认选择。
- Connector 执行后端以设备所有者身份转发的普通请求；实际使用者仍保留在后端 pending / 审计，以及 Bot 的原始上下文中。

## 协议约束

`group-device-share.v1` 仅用于识别 Bot 是否支持共享目标。Connector 不再需要共享能力声明，可复用旧所有者 RPC。

可信群授权来源为 `group_device_share`，必须有 `shareId`、正整数 `shareRevision`、`topicType=group` 和 `identityTrust=server_canonical`。原有 `channel_identity_link` 委托继续独立验证。不能只去掉 owner==actor 的限制。

元数据中的 camelCase 字段由 `catscompany/device-grants.ts` 解析。Bot 到后端的请求仍使用可信共享范围；后端校验后，以所有者 actor/owner、所有者会话和既有来源转发到设备，不发送 share 字段。响应恢复实际发起人。接收端对直接共享字段的防御校验继续保留。

设备选择增加 `selectedOwnerUserId`，候选设备增加 owner 和共享来源。缺省 owner 的旧记录仍属于 actor。同一 device ID 对应两个 owner 时必须明确 owner，不能取第一条授权。

执行授权继续绑定原会话、群、actor、owner、Bot/运行体、设备和操作。PostgreSQL 的许可版本、群成员关系和设备绑定 epoch 由后端在每次执行/续期重新验证；客户端声明或模型文字不能延长许可。

目标不可用时保持原目标并报错，不改用其他电脑或 Cloud。撤销阻止后续调用，不保证终止已经启动的系统命令；多人共享不会获得设备级排队锁。结果可能出现在群聊中。

## 开发及发布

沿用 `npm run build` 编译 TypeScript，现有桌面/Worker 发布流程打入新 dist。后端迁移和能力协商先就绪，再逐步升级 Bot 与 Connector；无需新增 runtime surface 或独立共享服务。

本地测试用独立的 Cloud A/B、pcA/B 身份和数据卷。旧版本兼容应使用独立固定 checkout 构建接收端；把旧镜像与新 src 混用不能验证兼容性。

本次已实测 userA 经 botB 使用 pcB 的默认/显式读取，随机文件仅存在于 pcB。独立旧版 pcB（`c3facde9`）被共享选择能力门禁拦截，userB 对自己的 pcB 仍可经真实模型读取文件。此前还验证了后端重启、撤销和双浏览器设备状态同步。

类型检查通过；共享、设备授权、执行路由、上下文及 RPC 等扩展测试共 69 项通过。旧 ToolGateway 文件另有 23 项失败，在未修改 `af1494c9` main 上同样失败，未在本功能中改写旧测试。

真实 macOS/Windows 系统操作仍需在对应 Connector 发布前验证。服务端 API、迁移和回滚步骤见 CatsCompany 的 `docs/group-device-sharing.md`。


## 外部审查加固（2026-11-23）

- 旧无 grant 的普通 Thin Tool RPC 仅允许 Bot 访问数据库确认的 Bot 所有者设备；目标属于其他用户、归属未知或读取失败均要求 grant。新 Bot 仍须携带完整 grant。该限制主动收紧旧版跨用户兼容旁路；旧 Bot 服务其他用户需升级。
- 缺少可信 deviceSelection 时，不从 deviceGrants 第一项推断 speaker_default，运行时快照也不把它显示为就绪。默认 grant 与当前选择 revision 不符时在客户端派发前拒绝；服务端原有的选择版本及许可实时复核继续保留。
- 群聊和私聊均可选择「云端」。未确认默认时，普通任务在 Bot 自身运行环境执行；本人唯一在线设备也不会自动成为默认。明确要求使用用户设备时，Bot 仍可使用该设备的独立授权。既有可信身份委托保留单设备回退。
- 两种 RPC 接收端对 group_device_share 要求完整 owner、actor、grant、session、群、Bot、许可版本及未过期截止时间，owner 必须匹配本机绑定，目标必须匹配本机设备；共享 owner 不能回退为 actor。旧的非共享 RPC 兼容不变。
- 客户端保留旧 grant 不等于撤销后还能执行：服务端查询、续期和派发仍按当前许可及选择版本拒绝。撤销不终止已启动命令的边界不变。

当前服务端代执行方案不要求 Connector 升级；此前直接共享字段的防御校验仍保留。


## 无固定期限与旧 Connector（2026-11-23）

共享许可没有固定期限，新权限引用使用与本人设备相同的无期限表示，不依赖续期心跳。旧版短期记录的续期兼容仍保留。共享撤销、成员或绑定变化由后端每次派发重新检查，不能仅凭缓存字段执行。每条 RPC 的传输/命令超时保持独立。

设备所有者 A 授权 B 后，Bot 仍知道 actor=B、owner=A；Connector 只看到后端转换后的 A 身份。后端恢复返回上下文并保留 B 的执行审计。因此设备端不需要 group-device-share.v1，也不需要为本次服务端调整重新打包。


## 当前完整授权列表更新（2026-11-23）

实时用户消息为 Bot 携带当前会话的完整设备授权列表：没有可执行权限时，device_grants 明确发送 []；V2 显式设备列表也发送 []。历史回放继续省略这些字段，不能重新签发或覆盖正在执行的授权上下文。

XiaoBa 保留「未提供更新」与「明确为空」的区别：undefined 不更新，[] 清空；非空列表经过可信来源和会话范围校验后替换旧列表。一次消费多条排队消息时只取最新提供的完整列表，不将历史授权做并集。runner 同样替换列表，并重建设备运行时上下文；重新授权后不会被旧目标失败状态卡住。附件和 Skill connector 授权仍沿用各自原合并规则。

这是收到服务端新上下文时的数据更新，不是数据库对象与 Bot 内存自动绑定；本轮没有新增数据库变更推送或轮询服务。新上下文到达前，后续 RPC 仍由服务器实时复核和拒绝已撤销权限。通用 permission_denied、网络超时和存储故障不能被客户端直接解释成「所有者已经撤销」，因此本轮不据此篡改本地授权状态。

本轮需要更新 server 和 Bot 运行时代码；Connector 不使用此 pending React loop，不需要因此重装。Bot 侧 group-device-share.v1 兼容门控仍保留，删除它未包含在本次列表同步改动中。
