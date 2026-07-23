# BotDefinition 本地模拟与模型配置解耦

这是 BotDefinition 的第一块落地实现。它定义一个 CatsCo bot 选择了什么模型，以及这个 Bot 应恢复哪些确定版本的 Skill。Skill 文件本身仍由 SkillHub 保存，Definition 只保存 `skillId + version` 引用。

## 定义范围

`botId` 是唯一锚点。一份 Definition 只保存一个模型选择：

- 目录模型：只保存 `modelId`。
- 自定义模型：保存协议、API 地址、模型名、API key、上下文窗口、最大输出、温度和可选的 reasoning effort。

目录模型的 endpoint 与 relay key 不属于可迁移的 BotDefinition。它们是当前设备取得的运行时材料，单独保存；未来接入 CatsCompany Definition API 后，新设备会按 `modelId` 重新获取这份设备运行时材料。

第一版不纳入显示名、设备身份、session、额度、工作目录、prompt 或 Skill 文件内容。

`skills` 字段缺失表示老 Definition 尚未完成 Skill 迁移，空数组表示已经迁移且当前 Bot 明确没有 Skill。模型和 Skill 使用字段保留更新：修改模型不能清空 `skills`，修改 Skill 引用也不能覆盖 `model`。

## 本地文件接口

当前仓库用文件模拟未来 CatsCompany 的 BotDefinition API：

- canonical Definition：`<runtimeDataRoot>/data/bot-definition-simulated-cloud/bots/<botId>.json`
- 当前设备 Definition 缓存：`<runtimeDataRoot>/data/bot-definition-cache/bots/<botId>.json`
- 当前设备目录模型运行时材料：`<runtimeDataRoot>/data/bot-catalog-model-runtime/bots/<botId>.json`

可以设置 `XIAOBA_BOT_DEFINITION_SIMULATED_CLOUD_DIR`，让多个本地测试实例共用一个模拟 canonical 存储。

## 最终模型读取链路

已绑定 bot 的实际模型配置只走这一条链：

```text
current botId
  -> BotDefinition 本地缓存
  -> 自定义模型定义 / 目录模型设备运行时材料
  -> LLMConfigResolver
  -> ConfigManager
  -> AIService
```

因此 `.env` 不再是已绑定 bot 的实际模型决定来源。它只保留两项兼容职责：

1. 老安装第一次创建 Definition，或目录模型缺少设备运行时材料且模型 id 精确匹配时，作为一次性迁移来源。
2. 未绑定 bot 的旧启动方式继续可用。

迁移或本机模型保存成功后，会删除 `.env` 与旧 `config.json` 中的模型字段，但不会动 CatsCo 登录、绑定和设备字段。之后已绑定 bot 只使用本地 Definition 缓存和目录模型运行时材料。

## 同步方向

- 本机在 Dashboard 修改模型：本机发布 Definition 到 canonical，并更新当前设备缓存。
- 每次 connector 启动、绑定或切换 bot：先从 canonical 拉取 Definition 到当前设备缓存。目录模型缺少当前设备运行时材料时，会向 CatsCo Relay 获取并写入本机材料，不修改 Definition 的模型选择。
- 未存在 Definition 的老 bot：从当前旧模型配置创建一次 Definition，确保历史安装可继续使用。
- 未存在 Definition 且没有旧模型配置的已绑定 bot：自动选用 `minimax-m3`（`MiniMax-M3`），先获取本机 Relay endpoint/key，再创建 Definition，避免留下无法执行的空配置。

当前运行实例的数据根沿用既有规则：Electron 使用 userData；CLI 或云端使用显式数据根或启动目录。因此 Definition、`.env`、`.xiaoba/catsco.json`、日志和 session 不会因本次改动额外产生新的数据根。
