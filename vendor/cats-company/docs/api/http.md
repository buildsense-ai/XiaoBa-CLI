# CatsCompany HTTP API

## 认证

**JWT Token:**
```
Authorization: Bearer <token>
```

**API Key (Bot):**
```
Authorization: ApiKey <api_key>
```

## 端点

### 认证

**POST /api/auth/register**
```json
{
  "username": "user123",
  "password": "pass123"
}
```

**POST /api/auth/login**
```json
{
  "username": "user123",
  "password": "pass123"
}
```

返回：
```json
{
  "token": "jwt_token",
  "uid": 3,
  "username": "user123"
}
```

### 用户

**GET /api/me**
获取当前用户信息

**POST /api/me/update**
更新用户资料

**GET /api/users/search?q=keyword**
搜索用户

### 好友

**GET /api/friends**
获取好友列表

**POST /api/friends/request**
发送好友请求

**POST /api/friends/accept**
接受好友请求

**POST /api/friends/reject**
拒绝好友请求

### 会话

**GET /api/conversations**
获取会话列表（包含最新消息）

返回：
```json
{
  "conversations": [
    {
      "id": "p2p_3_5",
      "name": "张三",
      "is_group": false,
      "preview": "最后一条消息",
      "latest_seq": 123,
      "last_time": "2026-03-05T10:00:00Z",
      "is_online": true
    }
  ]
}
```

### 消息

**GET /api/messages?topic=p2p_3_5&limit=50**
获取消息历史

**POST /api/messages/send**
发送消息（HTTP 方式，推荐用 WebSocket）

### 文件上传

**POST /api/upload**
```
Content-Type: multipart/form-data

file: <binary>
type: image|file
```

返回：
```json
{
  "url": "/uploads/xxx.jpg",
  "name": "image.jpg",
  "size": 12345
}
```

### Bot 管理

**GET /api/bots**
获取我的 Bot 列表

**POST /api/bots**
创建 Bot

**POST /api/bots/deploy**
部署 managed Bot

**POST /api/bots/visibility**
设置 Bot 可见性

### 管理员 API

需要 admin 权限（OC_ADMIN_USERNAMES）

**GET /api/admin/bots**
所有 Bot 列表

**POST /api/admin/bots/register**
注册 Bot

**POST /api/admin/bots/toggle**
启用/禁用 Bot

**POST /api/admin/bots/rotate-key**
轮换 API Key

**GET /api/admin/bots/stats**
Bot 统计信息
