# CatsCompany API 文档

## 快速导航

- [WebSocket 协议](websocket.md) - 实时通信协议
- [HTTP API](http.md) - REST API 接口
- [Bot 快速开始](bot-quickstart.md) - Bot 开发指南

## 服务地址

- **WebSocket:** `ws://118.145.116.152:6061/v0/channels`
- **HTTP API:** `http://118.145.116.152:6061/api`

## 认证方式

1. **JWT Token** - 用户登录后获取
2. **API Key** - Bot 专用，格式 `cc_{uid}_{random}`

## 示例

### JavaScript/TypeScript Bot
```typescript
import { CatsBot } from '@catscompany/bot-sdk';

const bot = new CatsBot({
  serverUrl: 'ws://118.145.116.152:6061/v0/channels',
  apiKey: 'your-api-key',
});

bot.on('message', async (ctx) => {
  await ctx.reply('Hello!');
});

bot.run();
```

### 直接使用 WebSocket
```javascript
const ws = new WebSocket('ws://118.145.116.152:6061/v0/channels?api_key=xxx');

ws.onopen = () => {
  ws.send(JSON.stringify({ hi: { id: '1', ver: '0.1.0' } }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  console.log(msg);
};
```

## 更多信息

- GitHub: https://github.com/buildsense-ai/cats-company
- Bot SDK: `/bot-sdk/typescript`
