# 群聊设备共享协议

本改动配合 CatsCompany 的群聊设备共享后端使用，不增加新的网络服务。Bot 与 Connector 继续通过 CatsCo WebSocket 连接。

## Bot 与 Connector 的职责

- Bot 注册 `request_device_access` 工具。它只发送 owner 名字/UID、说明和可信消息序号；实际申请人由后端从原消息推导。成功后暂停当前轮，等待用户在所有者批准后发送下一条任务。
- 后端生成授权卡片，只有真人设备所有者可以批准或拒绝。模型、Bot 和 Connector 都不能代替所有者批准。
- Bot 收到的执行上下文可包含共享设备，但 actor 仍是发起人，owner 仍是物理设备所有者。默认和显式目标都按 owner+device 解析；显式使用共享电脑不会改写默认选择。
- Connector 执行后端转发的授权请求。Thin Tool RPC 上下文保留实际 actor，避免把共享使用者变成所有者。

## 协议约束

Bot 和 Connector 的握手均新增 `group-device-share.v1`。后端在两端都支持时才开放共享执行；旧接收端仍可处理本人的既有调用。

可信群授权来源为 `group_device_share`，必须有 `shareId`、正整数 `shareRevision`、`topicType=group` 和 `identityTrust=server_canonical`。原有 `channel_identity_link` 委托继续独立验证。不能只去掉 owner==actor 的限制。

元数据中的 camelCase 字段由 `catscompany/device-grants.ts` 解析。Device RPC / Thin Tool RPC 转发使用 `share_id`、`share_revision`、`identity_source` 等字段，后端负责从有效 grant 填入。接收端拒绝缺少共享许可版本的请求。

设备选择增加 `selectedOwnerUserId`，候选设备增加 owner 和共享来源。缺省 owner 的旧记录仍属于 actor。同一 device ID 对应两个 owner 时必须明确 owner，不能取第一条授权。

执行授权继续绑定原会话、群、actor、owner、Bot/运行体、设备和操作。PostgreSQL 的许可版本、群成员关系和设备绑定 epoch 由后端在每次执行/续期重新验证；客户端声明或模型文字不能延长许可。

目标不可用时保持原目标并报错，不改用其他电脑或 Cloud。撤销阻止后续调用，不保证终止已经启动的系统命令；多人共享不会获得设备级排队锁。结果可能出现在群聊中。

## 开发及发布

沿用 `npm run build` 编译 TypeScript，现有桌面/Worker 发布流程打入新 dist。后端迁移和能力协商先就绪，再逐步升级 Bot 与 Connector；无需新增 runtime surface 或独立共享服务。

本地测试用独立的 Cloud A/B、pcA/B 身份和数据卷。旧版本兼容应使用独立固定 checkout 构建接收端；把旧镜像与新 src 混用不能验证兼容性。

本次已实测 userA 经 botB 使用 pcB 的默认/显式读取，随机文件仅存在于 pcB。独立旧版 pcB（`c3facde9`）被共享选择能力门禁拦截，userB 对自己的 pcB 仍可经真实模型读取文件。后端重启、批准/撤销和双浏览器同步也已验证。

类型检查通过；共享、设备授权、执行路由、上下文及 RPC 等扩展测试共 69 项通过。旧 ToolGateway 文件另有 23 项失败，在未修改 `af1494c9` main 上同样失败，未在本功能中改写旧测试。

真实 macOS/Windows 系统操作仍需在对应 Connector 发布前验证。服务端 API、迁移和回滚步骤见 CatsCompany 的 `docs/group-device-sharing.md`。
