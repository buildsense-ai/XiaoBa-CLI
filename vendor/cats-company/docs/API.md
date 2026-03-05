# Cats Company API 接入文档

> 版本：v0.5.0-alpha | 更新：2026-02-26

## 概述

Cats Company 是一个独立的即时通讯平台，提供：
- REST API（HTTP）— 用户管理、好友、群组、文件上传
- WebSocket — 实时消息收发
- Bot SDK（Go / Python / TypeScript）— 快速开发 Bot

### 系统边界

```
┌─────────────────────────────────────────────────┐
│                  Gauz Platform                   │
│            （用户注册 / 账号体系）                  │
└──────────────────────┬──────────────────────────┘
                       │ 用户账号
┌──────────────────────▼──────────────────────────┐
│              Cats Company Server                 │
│                                                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ REST API │  │ WebSocket │  │ File Storage │  │
│  └──────────┘  └───────────┘  └──────────────┘  │
│                                                  │
│  认证方式：                                       │
│  • 用户：JWT Token（登录获取）                     │
│  • Bot：API Key（管理员注册获取）                   │
└──────────────────────────────────────────────────┘
        ▲              ▲              ▲
        │              │              │
   ┌────┴───┐   ┌──────┴─────┐  ┌────┴──────┐
   │ iOS App│   │  Web Client │  │ 第三方 Bot │
   │        │   │  (React)    │  │ (OpenCrawl │
   │        │   │             │  │  等)       │
   └────────┘   └────────────┘  └───────────┘
```

### 服务地址

| 环境 | HTTP API | WebSocket |
|------|----------|-----------|
| 生产 | `http://118.145.116.152` | `ws://118.145.116.152/v0/channels` |
| 本地 | `http://localhost:6061` | `ws://localhost:6061/v0/channels` |

---

## 1. 认证

### 1.1 用户认证（JWT）

通过登录接口获取 JWT Token，有效期 7 天。

```
Authorization: Bearer <token>
```

或 query 参数：`?token=<token>`

### 1.2 Bot 认证（API Key）

Bot 通过管理员注册获取 API Key，格式：`cc_{hex_uid}_{random_32_bytes}`

```
Authorization: ApiKey <api_key>
```

或 query 参数：`?api_key=<api_key>`

---

## 2. REST API

所有请求 Content-Type 为 `application/json`。需要鉴权的接口在 Header 中携带 Token 或 API Key。

### 2.1 健康检查（无需鉴权）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/ready` | 就绪检查（含 DB 状态） |

### 2.2 认证接口（无需鉴权）

#### POST /api/auth/register

```json
// Request
{ "username": "alice", "password": "mypassword", "display_name": "Alice" }

// Response 200
{ "uid": 1, "username": "alice" }
```

#### POST /api/auth/login

```json
// Request
{ "username": "alice", "password": "mypassword" }

// Response 200
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "uid": 1,
  "username": "alice",
  "display_name": "Alice"
}
```

### 2.3 用户接口

#### GET /api/users/search?q={query}

搜索用户（最少 2 字符）。无需鉴权。

#### GET /api/users/online

获取好友在线状态。需要鉴权。返回 `{ "online_uids": [2, 5, 8] }`

### 2.4 好友接口（需要鉴权）

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| GET | `/api/friends` | 好友列表 | - |
| GET | `/api/friends/pending` | 待处理请求 | - |
| POST | `/api/friends/request` | 发送好友请求 | `{ "to_uid": 2, "message": "Hi!" }` |
| POST | `/api/friends/accept` | 接受请求 | `{ "request_id": 1 }` |
| POST | `/api/friends/reject` | 拒绝请求 | `{ "request_id": 1 }` |
| POST | `/api/friends/block` | 屏蔽用户 | `{ "user_id": 2 }` |
| DELETE | `/api/friends/remove?user_id={id}` | 删除好友 | - |

### 2.5 消息接口（需要鉴权）

#### POST /api/messages/send

REST 备用通道（推荐使用 WebSocket）。

```json
// Request
{ "topic_id": "p2p_1_2", "content": "Hello!" }

// Response 200
{ "seq": 42 }
```

#### GET /api/messages?topic_id={id}&limit={n}&offset={n}

获取消息历史。

### 2.6 群组接口（需要鉴权）

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| GET | `/api/groups` | 我的群组列表 | - |
| POST | `/api/groups/create` | 创建群组 | `{ "name": "群名", "member_ids": [2,3] }` |
| GET | `/api/groups/info?id={groupId}` | 群详情 | - |
| POST | `/api/groups/invite` | 邀请成员 | `{ "group_id": 1, "user_ids": [4,5] }` |
| POST | `/api/groups/leave` | 退出群组 | `{ "group_id": 1 }` |
| POST | `/api/groups/kick` | 踢出成员 | `{ "group_id": 1, "user_id": 4 }` |
| POST | `/api/groups/mute` | 禁言 | `{ "group_id": 1, "user_id": 4 }` |
| POST | `/api/groups/unmute` | 解禁 | `{ "group_id": 1, "user_id": 4 }` |
| POST | `/api/groups/announcement` | 设置公告 | `{ "group_id": 1, "content": "..." }` |
| POST | `/api/groups/disband` | 解散群组 | `{ "group_id": 1 }` |
| POST | `/api/groups/role` | 修改角色 | `{ "group_id": 1, "user_id": 4, "role": "admin" }` |

### 2.7 文件上传（需要鉴权，支持 JWT 和 API Key）

#### POST /api/upload?type={image|file}

使用 `multipart/form-data`，字段名 `file`。

```json
// Response 200
{
  "file_key": "abc123",
  "url": "/uploads/2026/02/abc123.png",
  "name": "photo.png",
  "size": 102400,
  "type": "image"
}
```

#### GET /uploads/{path}

访问已上传的文件（无需鉴权）。

### 2.8 Bot 管理接口

#### 2.8.1 用户端 Bot 管理（需要用户 JWT 鉴权）

用户可以自行创建、管理自己的 Bot。

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| GET | `/api/bots` | 列出我创建的 Bot | - |
| POST | `/api/bots` | 创建新 Bot | `{ "username": "my_bot", "display_name": "My Bot" }` |
| DELETE | `/api/bots?uid={uid}` | 删除我的 Bot | - |
| PATCH | `/api/bots/visibility` | 设置 Bot 可见性 | `{ "uid": 10, "visibility": "public" }` |

#### POST /api/bots — 创建 Bot

```json
// Request (Authorization: Bearer <user_token>)
{ "username": "my_assistant", "display_name": "我的助手" }

// Response 200
{
  "uid": 10,
  "username": "my_assistant",
  "display_name": "我的助手",
  "api_key": "cc_0a_a1b2c3d4e5f6...",
  "visibility": "public"
}
```

创建成功后返回 `api_key`，Bot 即可用此 key 通过 WebSocket 接入。

#### PATCH /api/bots/visibility — 设置可见性

```json
// Request
{ "uid": 10, "visibility": "private" }

// Response 200
{ "ok": true }
```

`visibility` 可选值：`"public"`（所有人可见）、`"private"`（仅创建者可见）。

#### 2.8.2 管理员 Bot 管理（需要管理员鉴权）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/bots` | 列出所有 Bot |
| POST | `/api/admin/bots/register` | 注册新 Bot |
| POST | `/api/admin/bots/toggle?uid={uid}` | 启用/禁用 Bot |
| POST | `/api/admin/bots/rotate-key?uid={uid}` | 轮换 API Key |
| GET | `/api/admin/bots/stats?uid={uid}` | Bot 统计 |
| GET | `/api/admin/bots/debug?uid={uid}&limit={n}` | Bot 调试日志 |

#### POST /api/admin/bots/register — 管理员注册 Bot

```json
// Request
{
  "username": "opencrawl_bot",
  "password": "bot_password",
  "display_name": "OpenCrawl Bot",
  "model": "custom",
  "api_endpoint": "https://opencrawl.example.com/webhook"
}

// Response 200
{
  "uid": 10,
  "username": "opencrawl_bot",
  "type": "bot",
  "api_key": "cc_0a_a1b2c3d4e5f6..."
}
```

拿到 `api_key` 后，Bot 即可通过 WebSocket 或 REST API 接入。

---

## 3. WebSocket 协议

### 3.1 连接

```
ws://118.145.116.152/v0/channels?api_key=<api_key>
```

用户连接使用 `?token=<jwt>`，Bot 连接使用 `?api_key=<key>`。

### 3.2 握手

连接建立后，客户端必须发送握手消息：

```json
// Client → Server
{ "hi": { "id": "1", "ver": "0.1.0" } }

// Server → Client (成功)
{ "ctrl": { "id": "1", "code": 200, "text": "ok", "params": { "uid": "10", "build": "catscompany" } } }
```

收到 `code: 200` 且 `build: "catscompany"` 即握手成功。

### 3.3 消息类型 — Client → Server

#### 发送消息 (pub)

```json
{
  "pub": {
    "id": "2",
    "topic": "p2p_1_10",
    "content": "Hello from bot!",
    "reply_to": 5
  }
}
```

- `topic`: P2P 格式 `p2p_{小uid}_{大uid}`，群组格式 `grp_{groupId}`
- `content`: 字符串（纯文本）或富媒体对象（见 3.5）
- `reply_to`: 可选，引用的消息 seq

#### 拉取历史 (get)

```json
{ "get": { "id": "3", "topic": "p2p_1_10", "what": "history", "seq": 0 } }
```

#### 输入中提示 (note)

```json
{ "note": { "topic": "p2p_1_10", "what": "kp" } }
```

#### 已读回执 (note)

```json
{ "note": { "topic": "p2p_1_10", "what": "read", "seq": 42 } }
```

### 3.4 消息类型 — Server → Client

#### 控制消息 (ctrl)

```json
{ "ctrl": { "id": "2", "code": 200, "text": "ok", "params": { "seq": 43 } } }
```

常见 code：`200` 成功，`404` 未找到，`429` 限流，`500` 服务器错误。

#### 数据消息 (data)

```json
{
  "data": {
    "topic": "p2p_1_10",
    "from": "1",
    "seq": 43,
    "content": "Hello!",
    "reply_to": 5
  }
}
```

#### 在线状态 (pres)

```json
{ "pres": { "topic": "me", "what": "on", "src": "2" } }
```

`what` 值：`on`（上线）、`off`（下线）、`msg`（新消息）、`upd`（更新）

#### 通知 (info)

```json
// 输入中
{ "info": { "topic": "p2p_1_10", "from": "1", "what": "kp" } }

// 已读
{ "info": { "topic": "p2p_1_10", "from": "1", "what": "read", "seq": 42 } }
```

### 3.5 富媒体消息格式

`content` 字段除了纯文本字符串外，还支持以下结构化类型：

#### 图片

```json
{
  "type": "image",
  "payload": {
    "url": "/uploads/2026/02/abc.png",
    "name": "photo.png",
    "size": 102400,
    "width": 800,
    "height": 600
  }
}
```

#### 文件

```json
{
  "type": "file",
  "payload": {
    "url": "/uploads/2026/02/doc.pdf",
    "name": "report.pdf",
    "size": 204800,
    "mime_type": "application/pdf"
  }
}
```

#### 链接预览

```json
{
  "type": "link_preview",
  "payload": {
    "url": "https://example.com/article",
    "title": "Article Title",
    "description": "A brief summary...",
    "image_url": "https://example.com/thumb.jpg"
  }
}
```

#### 卡片

```json
{
  "type": "card",
  "payload": {
    "title": "Task Complete",
    "description": "Crawl finished: 128 pages",
    "image_url": "/uploads/preview.png",
    "actions": [
      { "label": "View Report", "url": "https://example.com/report" },
      { "label": "Re-run", "action": "rerun_crawl" }
    ]
  }
}
```

### 3.6 Topic 命名规则

| 类型 | 格式 | 示例 | 说明 |
|------|------|------|------|
| P2P | `p2p_{小uid}_{大uid}` | `p2p_1_10` | UID 排序，确定性生成 |
| 群组 | `grp_{groupId}` | `grp_5` | 创建群组时获得 |
| 系统 | `me` | `me` | 在线状态通知 |

### 3.7 群聊 Bot 行为

- 群聊中 Bot 默认只在被 `@` 时收到消息
- P2P 中 Bot 收到所有消息
- Bot 之间互相不投递消息（防止循环）

---

## 4. Bot SDK 快速接入

### 4.1 接入流程

```
1. 用户创建 Bot（POST /api/bots）或管理员注册 Bot → 获得 api_key
2. 用户添加 Bot 为好友
3. Bot 通过 WebSocket 连接 → 握手 → 收发消息
```

### 4.2 TypeScript SDK

```bash
npm install @catscompany/bot-sdk
```

#### SDK 方法参考

| 方法 | 说明 |
|------|------|
| `new CatsBot(config)` | 初始化，传入 `serverUrl`、`apiKey`，可选 `connectTimeout` / `handshakeTimeout` |
| `connect()` | 建立 WebSocket 连接并完成握手 |
| `run()` | connect + 保持连接（含自动重连） |
| `disconnect()` | 断开连接 |
| `sendMessage(topic, content, replyTo?)` | 发送消息，返回 seq |
| `sendImage(topic, upload, opts?)` | 发送图片（需先 upload） |
| `sendFile(topic, upload, mimeType?)` | 发送文件（需先 upload） |
| `sendLinkPreview(topic, payload)` | 发送链接预览卡片 |
| `sendCard(topic, payload)` | 发送富卡片 |
| `sendTyping(topic)` | 发送输入中提示 |
| `sendReadReceipt(topic, seq)` | 发送已读回执 |
| `getHistory(topic, sinceSeq?)` | 拉取消息历史 |
| `uploadFile(filePath, type?)` | 从磁盘上传文件 |
| `uploadBuffer(buffer, filename, type?)` | 从 Buffer 上传 |
| `on(event, listener)` | 监听事件 |

#### 事件列表

| 事件 | 回调参数 | 说明 |
|------|----------|------|
| `ready` | `(uid: string)` | 连接成功，握手完成 |
| `message` | `(ctx: MessageContext)` | 收到消息 |
| `ctrl` | `(ctrl: MsgServerCtrl)` | 收到控制消息 |
| `disconnect` | `(code, reason)` | 连接断开 |
| `reconnecting` | `(attempt: number)` | 正在重连 |
| `error` | `(err: Error)` | 连接错误 |

#### MessageContext 属性和方法

| 属性/方法 | 说明 |
|-----------|------|
| `text` | 提取纯文本内容 |
| `topic` | 消息所在 topic |
| `from` | 发送者 uid |
| `seq` | 消息序号 |
| `content` | 原始 content（string 或 rich object） |
| `isP2P` | 是否 P2P 消息 |
| `isGroup` | 是否群组消息 |
| `reply(content)` | 回复到同一 topic |
| `replyWithTyping(content, delay?)` | 先 typing 再回复 |
| `sendTyping()` | 发送输入中提示 |
| `markRead()` | 标记已读 |

```typescript
import { CatsBot } from '@catscompany/bot-sdk';

const bot = new CatsBot({
  serverUrl: 'ws://118.145.116.152/v0/channels',
  apiKey: 'cc_0a_your_api_key_here',
  connectTimeout: 15000,
  handshakeTimeout: 10000,
});

bot.on('ready', (uid) => {
  console.log(`Bot online, uid: ${uid}`);
});

bot.on('message', async (ctx) => {
  console.log(`[${ctx.topic}] ${ctx.from}: ${ctx.text}`);

  // 回复消息
  await ctx.reply('Got it!');

  // 带 typing 效果的回复
  await ctx.replyWithTyping('Processing...');

  // 发送卡片
  await bot.sendCard(ctx.topic, {
    title: 'Crawl Result',
    description: '128 pages crawled',
    actions: [{ label: 'View', url: 'https://example.com' }],
  });
});

bot.run();
```

说明：

- 外部 Bot 建议统一连接 nginx 暴露的入口：`ws://118.145.116.152/v0/channels`
- `connectTimeout` 控制 TCP/WebSocket 建连阶段超时
- `handshakeTimeout` 控制 `hi -> ctrl` 握手阶段超时
- 如果升级请求在握手前被 HTTP 拒绝，SDK 会直接抛出带 `statusCode` 的 `HandshakeError`

### 4.3 Go SDK

```go
package main

import (
    "fmt"
    bot "github.com/catscompany/bot-sdk-go"
)

func main() {
    b := bot.New(bot.Config{
        ServerURL: "ws://118.145.116.152/v0/channels",
        APIKey:    "cc_0a_your_api_key_here",
    })

    b.OnReady(func(uid string) {
        fmt.Println("Bot online, uid:", uid)
    })

    b.OnMessage(func(ctx *bot.Context) {
        fmt.Printf("[%s] %s: %s\n", ctx.Topic, ctx.From, ctx.Text())
        ctx.Reply("Got it!")
    })

    b.Connect()
}
```

### 4.4 不使用 SDK — 裸 WebSocket 接入

如果你的语言没有 SDK，可以直接用 WebSocket 接入。以下是 Python 示例：

```python
import json
import websocket

API_KEY = "cc_0a_your_api_key_here"
WS_URL = f"ws://118.145.116.152/v0/channels?api_key={API_KEY}"

ws = websocket.create_connection(WS_URL)

# 1. 握手
ws.send(json.dumps({"hi": {"id": "1", "ver": "0.1.0"}}))
resp = json.loads(ws.recv())
assert resp["ctrl"]["code"] == 200
uid = resp["ctrl"]["params"]["uid"]
print(f"Connected as uid={uid}")

# 2. 收消息循环
while True:
    msg = json.loads(ws.recv())
    if "data" in msg:
        topic = msg["data"]["topic"]
        text = msg["data"]["content"]
        # 3. 回复
        ws.send(json.dumps({
            "pub": {"id": "2", "topic": topic, "content": f"Echo: {text}"}
        }))
```

---

## 5. 第三方接入指南（如 OpenCrawl）

### 5.1 接入步骤

```
步骤 1: 联系管理员注册 Bot 账号
        → 管理员调用 POST /api/admin/bots/register
        → 你拿到 api_key

步骤 2: 用户添加你的 Bot 为好友
        → 用户在 App/Web 中搜索你的 Bot username 并添加

步骤 3: 你的服务连接 WebSocket
        → ws://118.145.116.152/v0/channels?api_key=<your_key>
        → 完成握手

步骤 4: 收发消息
        → 监听 data 消息，处理用户请求
        → 通过 pub 回复结果
```

### 5.2 Bot 能力清单

作为 Bot 接入后，你可以：

| 能力 | 方式 | 说明 |
|------|------|------|
| 收发文本消息 | WebSocket pub/data | 核心能力 |
| 发送图片 | 先 POST /api/upload，再 pub | 需要先上传 |
| 发送文件 | 先 POST /api/upload，再 pub | 需要先上传 |
| 发送链接预览 | WebSocket pub | 直接发送 |
| 发送卡片消息 | WebSocket pub | 直接发送 |
| 输入中提示 | WebSocket note | 提升体验 |
| 已读回执 | WebSocket note | 提升体验 |
| 拉取历史消息 | WebSocket get | 上下文恢复 |

### 5.3 Bot 限制

- Bot 有发送频率限制（rate limit），超限返回 `429`
- Bot 之间不互相投递消息
- 群聊中 Bot 只在被 `@` 时收到消息
- Bot 不能调用好友管理、群组管理等用户接口

---

## 6. 错误码

| Code | 含义 |
|------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 未认证 / Token 无效 |
| 403 | 无权限 |
| 404 | 资源不存在 |
| 409 | 冲突（如用户名已存在） |
| 429 | 请求过于频繁（限流） |
| 500 | 服务器内部错误 |
