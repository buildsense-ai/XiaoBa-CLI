# BotDefinition 本地模拟与模型配置解耦

这是 BotDefinition 的第一块落地实现，刻意保持很小：它当前只定义一个 CatsCo bot 选择了什么模型。Prompt 与 skill 快照仍待后续确定各自的版本契约后再加入。

## 定义范围

`botId` 是唯一锚点。一份 Definition 只保存一个模型选择：

- 目录模型：只保存 `modelId`。
- 自定义模型：保存协议、API 地址、模型名、API key、上下文窗口和可选的 reasoning effort。

目录模型的 endpoint 与 relay key 不属于可迁移的 BotDefinition。它们是当前设备取得的运行时材料，单独保存；新设备激活同一 bot 时会重新从 CatsCo relay 获取。

第一版不纳入显示名、设备身份、session、额度、工作目录、prompt 或 skill 数据。

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

1. 老安装第一次创建 Definition 或缺少目录模型运行时材料时，作为一次性迁移来源。
2. 未绑定 bot 的旧启动方式继续可用。

迁移成功后，即使 `.env` 里的旧模型值改变，已绑定 bot 仍使用本地 Definition 缓存和目录模型运行时材料。

## 同步方向

- 本机在 Dashboard 修改模型：本机发布 Definition 到 canonical，并更新当前设备缓存。
- 绑定或切换 bot：先从 canonical 拉取 Definition 到当前设备缓存；若是目录模型，再为当前设备获取 relay 运行时材料。
- 未存在 Definition 的老 bot：从当前旧模型配置创建一次 Definition，确保历史安装可继续使用。

当前运行实例的数据根沿用既有规则：Electron 使用 userData；CLI 或云端使用显式数据根或启动目录。因此 Definition、`.env`、`.xiaoba/catsco.json`、日志和 session 不会因本次改动额外产生新的数据根。
