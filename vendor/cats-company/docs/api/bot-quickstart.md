# Bot 快速开始

## 1. 注册 Bot

通过管理员或用户界面创建 Bot，获取 API Key。

格式：`cc_{uid_hex}_{random}`

## 2. 安装 SDK

```bash
npm install @catscompany/bot-sdk
```

或使用本地版本：
```bash
npm install file:../../bot-sdk/typescript
```

## 3. 基础示例

```typescript
import { CatsBot } from '@catscompany/bot-sdk';

const bot = new CatsBot({
  serverUrl: 'ws://118.145.116.152:6061/v0/channels',
  apiKey: 'your-bot-api-key',
});

bot.on('ready', (uid, name) => {
  console.log(`Bot online: ${uid}`);
});

bot.on('message', async (ctx) => {
  console.log(`收到消息: ${ctx.text}`);
  await ctx.reply('你好！');
});

bot.run();
```

## 4. 消息类型

**文本消息：**
```typescript
await ctx.reply('Hello!');
```

**回复消息：**
```typescript
await ctx.reply('收到', ctx.seq);
```

**发送图片：**
```typescript
const upload = await bot.uploadFile('./image.jpg', 'image');
await bot.sendImage(ctx.topic, upload);
```

**发送文件：**
```typescript
const upload = await bot.uploadFile('./doc.pdf', 'file');
await bot.sendFile(ctx.topic, upload);
```

## 5. 事件

- `ready`: 连接成功
- `message`: 收到消息
- `typing`: 对方正在输入
- `read`: 对方已读
- `disconnect`: 连接断开
- `reconnecting`: 正在重连
- `error`: 错误

## 6. 配置选项

```typescript
{
  serverUrl: string;           // WebSocket URL
  apiKey: string;              // Bot API Key
  httpBaseUrl?: string;        // HTTP API base (自动推导)
  reconnectDelay?: number;     // 重连延迟 (默认 3000ms)
  connectTimeout?: number;     // 连接超时 (默认 15000ms)
  handshakeTimeout?: number;   // 握手超时 (默认 10000ms)
  pingTimeout?: number;        // Ping 超时 (默认 70000ms)
}
```

## 7. 完整示例

参考：`/bots/xiaoba-ts/src/main.ts`
