# Artifact 来源字段的服务端校验契约

`source_topic_id` 和 `source_message_id` 不能由 XiaoBa 客户端单独提供安全保证。
Bot 使用的是可被 Bot 进程读取的 bearer API key；模型可以复制 Skill、写 wrapper，或直接
调用 Artifact API。因此 XiaoBa 里的可信 Skill 直执行和环境变量清理只能作为纵深防御，
不能作为来源真实性或授权边界。

## 服务端必须保证

对新建 Artifact 的 `POST /api/artifacts/apps`：

1. `source_topic_id` 与 `source_message_id` 必须同时存在且格式有效；
2. 这对字段必须对应服务端保存的真实 CatsCo 会话/消息；
3. 消息必须属于当前认证 Bot 的可发布会话，并满足服务端规定的人类触发消息关系；
4. 不存在、越权、已撤销或不属于当前 Bot 的来源必须拒绝，建议返回明确的 4xx 错误；
5. 新建请求中的来源字段不能由客户端声明的其他身份字段覆盖；归属应从认证凭据服务端解析；
6. 对已存在 Artifact 的更新可以省略来源字段，但不能借更新接口为新记录绕过上述校验。

服务端还应覆盖直接 `curl`、复制后的 CLI、wrapper、`env VAR=...` 等调用路径；不能只依赖
XiaoBa 是否走了可信 Skill 入口。

## XiaoBa 客户端的职责

XiaoBa 在可信 `yii/artifact-publish` Skill 直执行路径注入当前 turn 的来源提示，并清理继承
环境中的旧值；不接受命令行手工来源字段。未通过可信入口的 Artifact Skill 命令会被拒绝，
以减少误用和普通路径下的伪造机会。这些措施不替代上述服务端校验。

## 当前状态

权威写入接口不在 XiaoBa 仓库，也不在 `catsco-artifact-gateway`（后者负责隧道和网关
控制面）。它位于 `buildsense-ai/cats-company` 的平台服务中：

- `server/artifact_apps.go` 接收并转发发布请求；
- `server/artifact_app_metadata.go` 的 `prepareMetadata` 对 Bot 新建请求执行来源校验；
- [cats-company PR #581](https://github.com/buildsense-ai/cats-company/pull/581) 已合并；
  来源校验首次引入于提交 `dc228f09`，后续提交 `427021df` 属于该 PR 的审阅修正。

因此本 PR 不需要再等待一个新的服务端实现 PR。仍需在发布前确认 `cats-company` main 的
这部分代码已经部署到实际承载 `/api/artifacts/apps` 的生产环境；代码合并本身不等于
生产已发布。
