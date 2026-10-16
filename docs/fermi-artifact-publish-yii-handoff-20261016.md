# Fermi Artifact 发布故障与 Yii Skill 修复交接

日期：2026-10-16

交接对象：Yii / Artifact Skill 维护同事

目标：继续使用 `yii/artifact-publish`，修复正常对话中的新应用发布，不换成 David_owner 版，不依赖用户每次追加特殊提示词。

运行时修复与补丁 PR：[XiaoBa-CLI #536](https://github.com/buildsense-ai/XiaoBa-CLI/pull/536)（交付时待审阅合并）。

在线补丁：[artifact-publish-yii-followup.patch](https://github.com/buildsense-ai/XiaoBa-CLI/blob/codex/artifact-publish-command-plan/docs/artifact-publish-yii-followup.patch)。

## 1. 当前结论与交付边界

这次是三个问题先后暴露，不是一个报错反复出现：

1. Fermi 的云端 Skill 定义与本地实际加载状态不一致，且旧 Skill 备份仍被扫描，导致发布进入“应用旧”。这部分已经在服务器做了定点修复。
2. 改用新 Skill 后，XiaoBa 对组合命令的可信调用识别不完整，`初始化 && 发布` 被拒绝。这部分本次准备正式运行时修复。
3. 拆开命令后，Yii 1.0.7 的发布请求缺少来源字段，服务端返回 `HTTP 400 / artifact_source_message_required`。这部分需要 Yii 更新并发布自己的 Skill。

本次交付的是运行时修复代码、Yii Skill 补丁与测试，不是“生产发布已恢复”的验收报告。本轮没有覆盖 Fermi 的生产运行时，没有改写已签名的 Yii 1.0.7，也没有代 Yii 发布版本。Linux 验证只在独立目录运行，未重启生产服务、未向生产平台创建应用。

**仍需完成：代码审阅与合并 → 运行时部署 → Yii 正式发布新 Skill → Fermi 安装 → 真实对话验收。**

## 2. 现场背景及证据

### 2.1 为什么旧 Skill 已删除，却仍然走“应用旧”

Fermi 是 Bot `836`，连接握手使用 `usr836`。云端定义已经记录 `yii/artifact-publish@1.0.7`，但当时服务器持续报：

```text
Bot Skill workspace ownership is changing (836 -> usr836); retry the write.
```

同步中止后保留旧工作区。运行时扫描还会递归读取隐藏子目录中的 `SKILL.md`，于是以下备份被当成有效 Skill：

```text
/opt/xiaoba-cli/skills/.cloud-html-artifact-1.0.12-old-20260731T035832Z/
```

“灵感素材库”对应会话 `grp_5214` 的工具记录证明：Bot 实际加载了该目录中的 `cloud-html-artifact`，并执行其 `publish-html-directory.mjs`，发布到旧的 `19991` 托管地址。

“应用旧”与“应用”是不同的发布记录入口，不是根据 Skill 版本号排序。`cloud-html-artifact@1.0.12` 与 `artifact-publish@1.0.7` 是不同包，版本号不能横向比较。

前一轮服务器修复已完成：

- 在 Skill 同步入口把同一 Bot 的 UID 别名映射回已绑定工作区 ID，保留不同 Bot 的归属检查。
- 将旧 Skill 备份移出扫描目录，保留可恢复副本。
- 移出阻止安全快照的失效 `node_modules` 软链接；将本地 `CLAUDE.md` 别名按原内容物化，保留原链接备份。
- 同步云端 revision 74，并确认实际加载 Yii 的新版 Skill。
- 保留旧应用托管与页面预览进程，未迁移、下架或删除旧应用。

这些服务器定点修复与本次“命令计划”修复是不同层次的工作；后续升级必须保留或以正式修复替代本地定点修改，不能盲目覆盖。

### 2.2 第一次新渠道测试：运行时拦截

会话：`grp_5426`；截图时间：13:23。

用户要求创建“Fermi 发布测试”，明确不要使用旧渠道。Bot 读取了实际安装的 Yii Skill，但把初始化和发布组合成：

```sh
node init-connector.mjs ... && node artifact-cli.mjs publish ...
```

运行时返回：

```text
The artifact-publish connector command was not accepted as a trusted Skill invocation.
```

这次发布请求没有到达平台。解析检查另外发现：

| 输入 | 修复前行为 |
|---|---|
| 单条 `artifact-cli.mjs` 调用 | 可通过可信执行 |
| `init-connector && artifact-cli` | 被拒绝 |
| `artifact-cli whoami && artifact-cli list` | 后半段被当成前一条命令的参数 |
| `node --version` 后换行调用 Artifact CLI | 可能退回普通 Shell |
| 将相同换行改成分号 | 又被拒绝 |

所以不能简单归因于模型“不按要求调用”，更不能只在提示词中要求用户拆命令。

### 2.3 第二次测试：服务端拒绝缺少来源的请求

同一会话；截图时间：13:33。用户按照临时建议拆开调用后，初始化成功，发布脚本确实执行，但返回：

```text
发布失败 HTTP 400: {"error":"artifact_source_message_required"}
```

Yii 当前包的 `connector/artifact-cli.mjs` 构造请求如下：

```js
const payload = { id, title, publicKey, localPort };
```

其中没有 `source_topic_id`、`source_message_id`，也没有读取运行时来源环境变量的逻辑。该问题已由生产错误与代码共同确认，不再只是推测。

当前安装包的身份：

- Publisher：Yii，UID 363。
- Skill ID：`yii/artifact-publish`。
- 版本：1.0.7。
- 发布元数据：2026-10-12T13:57:06.716Z（截图显示北京时间 21:57）。
- package SHA-256：`6c2c409cc623a4192d7e4584cc9bfd43bad039ced96b8f692ee551bdbc5794b6`。

## 3. 与此前 guga / David 修复的关系

之前处理 guga 时，XiaoBa PR #527 加入了 Artifact 来源传递，PR #529 加入了 `david/artifact-publish` 的可信发布者兼容。David_owner 发布的 1.0.7 带有来源读取逻辑，并在 guga 上做过真实对话验收。

**Yii 的 1.0.7 与 David_owner 的 1.0.7 是不同包，不能因为版本号相同就假定代码一致。** 本次用户明确要求继续使用 Yii，不能用换成 David 的方式代替对 Yii 版本的修复。

来源字段只是客户端提供的归属线索，真正的授权校验仍由 CatsCompany 平台按认证 Bot、会话和真实人类消息完成。不能关闭服务端校验，也不能改用人类账号令牌或从历史日志拼一个消息 ID 让请求通过。

## 4. 本次 XiaoBa 运行时修复

代码基于 main `09066b4`，分支 `codex/artifact-publish-command-plan`。

主要文件：

- `src/bot-skills/artifact-command-plan.ts`：有限命令语法解析。
- `src/bot-skills/trusted-script-execution.ts`：Artifact 专用计划、包校验与来源隔离。
- `src/tools/bash-tool.ts`：受控逐步执行、共享超时和输出汇总。
- `src/tools/execution-router.ts`：提供具体拒绝原因，并说明整组命令尚未执行。

修复行为：

1. 先校验整组命令，再产生副作用；每个脚本执行前还会重新检查包完整性与撤销状态。
2. 支持同一可信 Artifact 包的 `init-connector.mjs`、`artifact-cli.mjs`，以及 `node --version/-v` 检查；支持开头的 `cd`。
3. 支持 `&&`、分号和换行，正确处理引号、CRLF、续行；`&&` 保持成功才继续，分号/换行保持普通顺序命令语义，不偷偷改成 `&&`。
4. 使用确定的 Node 可执行文件和 argv 逐步启动，不把接受的计划交给 Shell 解释。
5. 管道、重定向、变量/命令展开、额外 Shell 命令等不属于支持语法，明确拒绝；不会因识别失败就把涉及 Artifact 发布入口的命令退回普通 Shell。
6. 来源只传给 Artifact CLI，初始化和版本检查不获得来源字段；先清除继承的旧来源值，再使用当前可信 turn 的值。
7. 超时、取消或进程级异常会停止整个计划；前一步输出被保留；不改普通工具的接口。

这不是通用 Shell 解释器。把 `ss`、`systemctl` 等任意命令混进 Artifact 敏感调用链仍可能被明确拒绝，它们可以通过各自正常工具调用执行。服务安装和旧应用删除没有因这次修复获得额外权限。

## 5. 给 Yii 的 Skill 补丁

补丁：[artifact-publish-yii-followup.patch](./artifact-publish-yii-followup.patch)。它针对上述 Yii 1.0.7 的实际文件制作，修改 `SKILL.md` 和 `connector/artifact-cli.mjs`。

### 代码变化

- 从 `CATSCO_ARTIFACT_SOURCE_TOPIC_ID`、`CATSCO_ARTIFACT_SOURCE_MESSAGE_ID` 读取当前运行时来源。
- 校验字段成对、消息序号为正的安全整数，再放入请求的 `source_topic_id`、`source_message_id`。
- 没有来源时先查询应用：只有成功确认相同 ID 的已有应用才继续更新；404 停止新建，鉴权失败、服务异常或响应 ID 不匹配都停止。
- 不接受额外的来源命令行参数；保留平台原始拒绝错误，不反复重试、补造来源或回退旧渠道。
- 将请求后的强制 `process.exit()` 改为返回 `main()`、设置退出码，让网络与输出正常结束。此项修复了测试中 Windows Node 24.14.0 在“先查询、再更新”路径触发的 libuv `UV_HANDLE_CLOSING` 断言；Linux Node 22 也通过测试。
- Skill 文档明确来源契约和运行时兼容要求，不把拆命令提示词作为正式修复。

### Yii 的应用与发布步骤

在 Yii 维护的 Skill 源码根目录（包含 `SKILL.md` 与 `connector/`）操作，而不是修改 Fermi 已安装的签名包：

```sh
git status --short
git apply --check /path/to/artifact-publish-yii-followup.patch
git apply /path/to/artifact-publish-yii-followup.patch
git diff --check
```

若源码已变更导致补丁不适用，请按上述逻辑迁移，不要覆盖现有修改或强行套补丁。

本补丁有意不伪造作者、发布时间、签名和新版本号。请 Yii 保留 `yii/artifact-publish` 身份，选择一个未使用的新补丁版本（如 1.0.8），走正常发布流程重新生成内容哈希及签名。**不要覆盖 1.0.7，也不要复制旧签名。**

发布后把准确的 Skill ID、版本和发布记录交回，后续再安装到 Fermi。

## 6. 已完成的验证

- `tsc --noEmit`：通过。
- `git diff --check`：通过。
- 完整 Skill 补丁的 `git apply --check`：通过。
- Windows Node 24.14.0：相关测试共 78 项，64 通过、14 项平台条件跳过、0 失败。
- Linux Node 22.23.2：隔离目录中 50 项通过、0 失败、0 跳过。

测试覆盖组合命令、来源按步骤隔离、后续命令不被吞成参数、失败短路、引号、换行、初始化后包被修改、不同 Bot/撤销、超时和取消。Skill 测试实际把交付补丁应用到 Yii 1.0.7 CLI，再向回环地址的模拟 HTTP 服务发请求；验证新建来源、无来源更新、查询错误停止、非法来源停止和平台错误保留，不使用生产凭据。

主要测试文件：

```text
tests/artifact-command-plan.test.ts
tests/artifact-publish-yii-patch.test.ts
tests/trusted-bot-skill-script-execution.test.ts
tests/execution-router-clean.test.ts
tests/safety.test.ts
tests/shell-current-directory.test.ts
tests/shell-resource-guards.test.ts
```

未验证：Yii 尚未发布的新签名包、部署后的实际 WebSocket 对话、真实注册/隧道启动、“应用”列表展示和更新后的页面内容。单元测试不能替代这些验收。

## 7. 上线与最终验收

1. 同事审阅、合并 XiaoBa 修复；运维核对 Fermi 本地定点修改后部署对应构建，确认服务使用新 `dist`，保留备份。
2. Yii 发布新版 Skill；Fermi 安装该版本，核对 ID、版本、内容哈希和实际加载路径。
3. 在正常 CatsCo 对话要求创建简单页面并发布，不附加拆命令等特殊提示词。可以继续原测试会话，也可以新建会话，不要求使用最初发现故障的会话。
4. 核对日志确实调用 Yii 新版，平台成功注册，连接器与应用本体服务正常，新应用进入“应用”，域名和静态资源可访问。
5. 同一应用更新标题或内容，确认没有创建另一个 ID，页面内容真的更新。
6. 在隔离测试中确认缺来源的新建、伪造或越权来源仍被拒绝；不要通过放宽生产权限来测试。
7. 再检查旧应用仍可访问。旧应用迁移/下架不是此次修复的默认动作，需要独立核对数据、访问地址和授权。

验收全部通过后，才能对外宣称问题闭环。目前应交给同事审阅运行时修复，并由 Yii 处理新版 Skill 发布。
