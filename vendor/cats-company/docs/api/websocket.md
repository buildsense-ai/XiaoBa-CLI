# CatsCompany WebSocket 协议

## 连接

**端点：** `ws://your-server:6061/v0/channels`

**认证方式：**
- JWT Token: `?token=<jwt_token>`
- API Key (Bot): Header `X-API-Key: <api_key>` 或 `?api_key=<api_key>`

## 消息格式

所有消息都是 JSON 格式。

### 客户端 → 服务器

#### 1. 握手 (hi)
```json
{
  "hi": {
    "id": "1",
    "ver": "0.1.0"
  }
}
```

#### 2. 发送消息 (pub)
```json
{
  "pub": {
    "id": "2",
    "topic": "p2p_3_5",
    "content": "Hello!",
    "reply_to": 123
  }
}
```

**content 支持：**
- 纯文本: `"Hello"`
- 富文本: `{"type": "image", "payload": {...}}`

#### 3. 订阅 (sub)
```json
{
  "sub": {
    "id": "3",
    "topic": "p2p_3_5"
  }
}
```

#### 4. 获取历史 (get)
```json
{
  "get": {
    "id": "4",
    "topic": "p2p_3_5",
    "what": "history",
    "seq": 100
  }
}
```

#### 5. 通知 (note)
```json
{
  "note": {
    "topic": "p2p_3_5",
    "what": "kp",
    "seq": 123
  }
}
```

**what 类型：**
- `kp`: 正在输入
- `read`: 已读回执

### 服务器 → 客户端

#### 1. 控制消息 (ctrl)
```json
{
  "ctrl": {
    "id": "1",
    "code": 200,
    "text": "ok",
    "params": {
      "uid": "usr3",
      "name": "张三"
    }
  }
}
```

#### 2. 数据消息 (data)
```json
{
  "data": {
    "topic": "p2p_3_5",
    "from": "usr5",
    "seq": 456,
    "content": "Hi there!",
    "reply_to": 123
  }
}
```

#### 3. 在线状态 (pres)
```json
{
  "pres": {
    "topic": "me",
    "what": "on",
    "src": "usr5"
  }
}
```

#### 4. 信息通知 (info)
```json
{
  "info": {
    "topic": "p2p_3_5",
    "from": "usr5",
    "what": "kp"
  }
}
```

## Topic 格式

- **P2P:** `p2p_{smaller_uid}_{larger_uid}`
- **群组:** `grp_{group_id}`

## 错误码

- `200`: 成功
- `400`: 请求错误
- `401`: 未授权
- `403`: 禁止访问
- `429`: 频率限制
- `500`: 服务器错误
