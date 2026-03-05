# Cats Company Bot 快速上手指南

> 从零开始，在猫猫公司平台上创建并运行你的第一个 Bot。

## 前置条件

- Node.js 18+
- iOS 设备或模拟器（安装猫猫公司 App）
- 服务端地址：`http://118.145.116.152:6061`

---

## 第一步：注册账号

打开猫猫公司 App，点击「没有账号？去注册」：

- 输入用户名（英文，如 `alice`）
- 输入密码（6位以上）
- 输入昵称（可选，如 `Alice`）
- 点击「注册」

注册成功后自动登录，进入主界面。

也可以用 API 注册：

```bash
curl -X POST http://118.145.116.152:6061/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"mypassword","display_name":"Alice"}'
```

返回：
```json
{
  "token": "eyJhbGci...",
  "uid": 15,
  "username": "alice"
}
```

> 记住你的 `token`，后续 API 调用需要用到。

---

## 第二步：创建 Bot

### 方式 A：App 内创建（推荐）

1. 打开 App → 底部「我」Tab → 「我的机器人」
2. 点击右上角 `+`
3. 输入机器人名称（如 `我的助手`）
4. 点击「创建」

创建成功后，在列表中可以看到你的 Bot。

### 方式 B：API 创建

```bash
curl -X POST http://118.145.116.152:6061/api/bots \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的token>" \
  -d '{"username":"my-bot","display_name":"我的助手"}'
```

返回：
```json
{
  "uid": 16,
  "username": "my-bot",
  "display_name": "我的助手",
  "api_key": "cc_10_a1b2c3d4e5f6...",
  "visibility": "private"
}
```

> **重要：记下 `api_key`**，这是 Bot 连接服务器的凭证，只在创建时返回一次。

---

## 第三步：添加 Bot 为好友

Bot 创建后，你需要和它互加好友才能聊天。

### 1. 用户发送好友请求

```bash
curl -X POST http://118.145.116.152:6061/api/friends/request \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的token>" \
  -d '{"user_id": <bot的uid>}'
```

### 2. Bot 接受好友请求

```bash
curl -X POST http://118.145.116.152:6061/api/friends/accept \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey <bot的api_key>" \
  -d '{"user_id": <你的uid>}'
```

> 注意：Bot 用 `ApiKey` 认证，不是 `Bearer`。

完成后，在 App 的通讯录中就能看到你的 Bot 了。

---

## 第四步：编写 Bot 代码

创建一个新项目：

```bash
mkdir my-bot && cd my-bot
npm init -y
npm install @catscompany/bot-sdk
```

> 如果 SDK 未发布到 npm，可以直接从项目中复制：
> ```bash
> cp -r /path/to/CatsCompany/bot-sdk/typescript ./bot-sdk
> cd bot-sdk && npm install && npm run build && cd ..
> ```
> 然后在 package.json 中引用：`"@catscompany/bot-sdk": "file:./bot-sdk"`

创建 `index.ts`：

```typescript
import { CatsBot } from '@catscompany/bot-sdk';

const bot = new CatsBot({
  serverUrl: 'ws://118.145.116.152/v0/channels',
  apiKey: '<你的bot api_key>',
  connectTimeout: 15000,
  handshakeTimeout: 10000,
});

bot.on('ready', (uid) => {
  console.log(`Bot 已上线，uid=${uid}`);
});

bot.on('message', async (ctx) => {
  console.log(`收到消息: ${ctx.text} (from: ${ctx.from})`);

  // Echo bot：原样回复
  await ctx.reply(`你说的是：${ctx.text}`);
});

bot.on('error', (err) => {
  console.error('连接错误:', err.message);
});

bot.connect();
```

说明：

- 外部 Bot 建议统一走 `ws://118.145.116.152/v0/channels`，不要直接依赖 `:6061`
- `connectTimeout` 是建连超时，`handshakeTimeout` 是握手超时
- 如果 API key 无效或升级被拒绝，SDK 会直接返回明确错误，而不是统一表现成握手超时

---

## 第五步：运行 Bot

```bash
npx tsx index.ts
```

看到 `Bot 已上线` 后，打开 App，在消息列表找到你的 Bot（或从通讯录点进去），发一条消息试试。

Bot 会回复：`你说的是：<你发的内容>`

---

## 进阶功能

### 发送文件

```typescript
bot.on('message', async (ctx) => {
  // 上传并发送文件
  const upload = await bot.uploadFile('/path/to/report.pdf', 'file');
  await bot.sendFile(ctx.topic, upload, 'application/pdf');
});
```

### 发送图片

```typescript
const upload = await bot.uploadFile('/path/to/photo.jpg', 'image');
await bot.sendImage(ctx.topic, upload);
```

### 发送 Typing 指示

```typescript
bot.on('message', async (ctx) => {
  bot.sendTyping(ctx.topic);  // 用户会看到 "正在输入..."
  // ... 处理逻辑 ...
  await ctx.reply('处理完成');
});
```

### 群聊

Bot 在群聊中默认只响应 @提及。通过 `ctx.isGroup` 判断：

```typescript
bot.on('message', async (ctx) => {
  if (ctx.isGroup) {
    await ctx.reply('我在群里收到了你的 @');
  } else {
    await ctx.reply('私聊消息');
  }
});
```

---

## 常见问题

**Q: 创建 Bot 后忘记了 api_key？**
A: api_key 只在创建时返回一次。如果丢失，需要删除 Bot 重新创建。

**Q: Bot 连不上服务器？**
A: 检查 `serverUrl` 是否正确（`ws://` 开头），`apiKey` 是否完整。

**Q: 发消息 Bot 没反应？**
A: 确认已互加好友。检查 Bot 进程是否在运行，终端有无错误输出。

**Q: 如何让 Bot 公开可见？**
A: App 内「我的机器人」列表中操作，或调用 API：
```bash
curl -X POST "http://118.145.116.152:6061/api/bots/visibility?uid=<bot_uid>&v=public" \
  -H "Authorization: Bearer <你的token>"
```

---

## 架构概览

```
┌──────────────┐     WebSocket      ┌──────────────┐
│  iOS App     │◄──────────────────►│  CatsCompany │
│  (用户端)     │                    │  Server      │
└──────────────┘                    │  :6061       │
                                    └──────┬───────┘
┌──────────────┐     WebSocket             │
│  Your Bot    │◄──────────────────────────┘
│  (Node.js)   │
└──────────────┘
```

用户和 Bot 都通过 WebSocket 连接到同一个服务器，消息通过 topic 路由。
