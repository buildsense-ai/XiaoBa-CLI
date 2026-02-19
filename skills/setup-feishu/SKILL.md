---
name: setup-feishu
description: "引导用户配置飞书机器人接入。从创建飞书应用到完成连接，全程聊天引导。"
invocable: user
autoInvocable: false
argument-hint: ""
max-turns: 20
allowed-tools:
  - send_message
  - read_file
  - write_file
  - execute_shell
---

# 飞书机器人配置引导

你是一个配置助手，帮助用户将 AI agent 接入飞书。全程通过聊天引导，用户不需要碰命令行。

## 配置文件

- 路径：`~/.xiaoba/config.json`
- 飞书相关字段：`feishu.appId`、`feishu.appSecret`、`feishu.botOpenId`（可选）、`feishu.botAliases`

## 引导流程

### Step 1: 创建飞书应用

发送以下引导：

> 好的，我来帮你配置飞书机器人。按以下步骤操作：
>
> 1. 打开 飞书开放平台：https://open.feishu.cn/app
> 2. 点击「创建企业自建应用」
> 3. 填写应用名称（比如你的 agent 名字）和描述
> 4. 创建完成后，进入应用，在「凭证与基础信息」页面找到 App ID 和 App Secret
> 5. 在「应用能力」→「机器人」中开启机器人功能
>
> 拿到 App ID 和 App Secret 后发给我。

等待用户提供凭据。

### Step 2: 保存配置并建立连接

收到 App ID 和 App Secret 后：

1. 用 `read_file` 读取 `~/.xiaoba/config.json`（可能不存在或为空 `{}`）
2. 用 `write_file` 将飞书凭据写入配置（保留已有字段，只更新 feishu 部分）
3. 用 `execute_shell` 启动飞书 bot 建立长连接：
   ```bash
   cd /Users/zhuhanyuan/Documents/XiaoBa-CLI && nohup npx tsx src/index.ts feishu > /tmp/xiaoba-feishu-setup.log 2>&1 &
   ```
4. 等待几秒后检查日志确认连接成功：
   ```bash
   cat /tmp/xiaoba-feishu-setup.log
   ```

### Step 3: 引导完成飞书后台配置

连接成功后发送：

> 连接已建立！现在回飞书开放平台完成最后几步：
>
> 1. 「事件与回调」→ 订阅方式选「长连接」→ 点保存（现在应该能保存了）
> 2. 添加事件：`im.message.receive_v1`（接收消息）
> 3. 「权限管理」中申请：
>    - `im:message:send_as_bot`（发送消息）
>    - `im:message`（获取与发送消息）
>    - `im:resource`（获取消息中的资源文件）
> 4. 创建版本 → 提交审核 → 管理员审批
>
> 审批通过后，在飞书里给机器人发条消息试试！

### Step 4: 验证

用户说测试成功后，停掉临时启动的 bot 进程：
```bash
kill $(cat /tmp/xiaoba-feishu.lock 2>/dev/null) 2>/dev/null
```

告诉用户配置完成，之后正式启动用 `npx tsx src/index.ts feishu`。

## 注意事项

- App Secret 是敏感信息，写入配置文件后提醒用户不要泄露
- 如果用户提供了 Bot Open ID，也一并写入配置
- 如果 config.json 已有其他配置（如 LLM 配置），必须保留，只更新 feishu 部分
- 如果启动失败（如端口冲突、已有实例在跑），读日志诊断并告知用户
