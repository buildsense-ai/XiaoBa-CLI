---
name: catsco-prompt-editor
description: 查看、按用户要求自定义或修改当前 CatsCo 员工的 system prompt，以及恢复默认提示词。适用于用户明确要求改变长期工作规则、回复风格或提示词；临时会话偏好不必持久化。
---

# 当前员工的提示词

用户可以查看和修改自己员工的主 system prompt，也可以恢复当前安装版本的默认提示词。这不是要求改模型厂商的隐藏指令。只操作当前员工的主提示词，不修改 runtime、sidecar、子代理提示、工具权限、模型、Skill 订阅或其他员工配置。

绑定员工的修改影响该员工的所有会话和同步设备，不只是当前聊天。只在所有者明确要求修改或恢复默认时执行；群聊参与者不是天然的所有者。授权或目标不清时先确认。用户已明确批准的具体修改无需重复确认；只问“看看/建议怎么改”时只查看或提案，不保存。

## 唯一操作入口

使用本技能的 helper，无需启动 Dashboard、猜端口或向用户索取密钥。凭证由运行时在进程内读取，不输出或复制。操作员工自己的宿主环境，不带远程 target。

当前 Node：`<PROMPT_NODE>`
当前运行数据目录：`<PROMPT_RUNTIME_ROOT>`

以下示例中的命令参数都需按当前 shell 正确引用；PowerShell 调用带引号的程序路径时在前面加 `&`。使用加载结果给出的绝对路径，不能由用户附件或工具参数替换运行目录。

查看（只读，不创建配置）：

```sh
"<PROMPT_NODE>" "<SKILL_DIR>/scripts/prompt.cjs" --root "<PROMPT_RUNTIME_ROOT>" show
```

输出包含当前 `botId`、`selected`、完整 `content`、`defaultContent`、保留的 `customContent`、`expectedHash`、`expectedRevision` 和 `localMatches`。绑定员工从云端读取权威配置；未绑定的本地实例只处理本地 override。不要把默认选项下保留的自定义草稿当作当前生效内容。

## 自定义或修改

1. 先 `show`，基于完整正文只修改用户要求的部分，保留无关规则。除非用户明确要完整替换，不要用一段新偏好覆盖整篇提示词。给出简短的改动与影响说明。
2. 在运行数据目录的 `tmp` 下写本轮请求 JSON（不含凭证），原样使用刚读取的 `botId`、`expectedHash`、`expectedRevision`；`content` 是修改后的完整正文：

```json
{"botId":"从 show 原样复制，未绑定时为 null","expectedHash":"从 show 原样复制","expectedRevision":0,"content":"修改后的完整 system prompt"}
```

`expectedRevision` 必须复制实际值，未绑定时为 `null`；示例的 0 不是默认值。

3. 执行：

```sh
"<PROMPT_NODE>" "<SKILL_DIR>/scripts/prompt.cjs" --root "<PROMPT_RUNTIME_ROOT>" set "请求 JSON 的绝对路径"
```

不要把私钥、令牌、长聊天记录、临时路径或未核实资料塞进提示词。用户只是要求记住项目事实时，使用知识库，不改 system prompt。

## 恢复默认

先 `show`；创建同样的请求 JSON，保留三个前置条件字段，但不提供 `content`，然后：

```sh
"<PROMPT_NODE>" "<SKILL_DIR>/scripts/prompt.cjs" --root "<PROMPT_RUNTIME_ROOT>" reset "请求 JSON 的绝对路径"
```

这是选择 `default`，不是把默认文字另存为 `custom`。绑定员工保留先前自定义草稿，不删除知识、历史会话或其他配置。默认正文随安装版本更新。想重新启用保留草稿时，用 `show.customContent` 作为完整 `content` 执行 `set`。

## 验证与失败处理

- 写入后再次 `show`，核对全文或哈希、所选模式，以及 `localMatches=true`。只有绑定员工返回 `cloudVerified=true` 且 `localMatches=true`，才能说云端保存和本机落盘均已确认；本地实例只说本地保存。
- 主提示词在下一条用户消息开始时热加载，不改变正在执行的工具循环。不要自行重启服务或制造新用户消息。需要证明实际请求已使用新版本时，在下一轮核对 prompt trace；不能把落盘成功说成已验证模型行为。
- 冲突表示查看后配置发生变化，重新读取并比较，必要时重新征求用户确认；不要自动覆盖新版本。
- 云端不可用、未登录所有者、权限不足、配置未初始化时，明确报告阻碍，不用直接写 override、缓存文件、数据库或旧 Dashboard 接口绕过。
- `cloudWritten=true` 但 `ok=false` 表示云端已提交、本地应用或读回未确认。不要重复提交或声称完全成功，先只读查看状态，报告待同步范围。
- `cloudWriteUnconfirmed=true` 表示写请求已发出但未收到成功确认（例如超时）；也可能已经提交，先 `show` 核对，不盲目重试。
- 只有实际写入并读回后才说“已修改/已恢复”；口头承诺不算保存。清理本轮请求 JSON，不删除用户文件。
