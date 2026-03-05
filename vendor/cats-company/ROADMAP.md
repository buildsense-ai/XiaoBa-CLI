# CatsCompany 开发路线图

> 最后更新：2026-02-21

---

## 当前版本状态

**v0.5.0-alpha** — Phase 1-4 完成，Bot 生态增强

| 模块 | 状态 | 说明 |
|------|------|------|
| Server (Go) | ✅ 可用 | HTTP API + WebSocket + 健康检查 |
| Webapp (React) | ✅ 可用 | WeChat 风格 UI + 富媒体 + Bot 管理 |
| iOS (SwiftUI) | ✅ 可用 | 品牌统一主题 + 富媒体预览 |
| Bot SDK | ✅ 可用 | Go/Python/TypeScript (全部 WebSocket) |
| 部署 | ✅ 可用 | Docker Compose + HTTPS |

---

## 已完成功能 ✅

### 核心通信 (Phase 1) - 完成
- [x] WebSocket 消息路由（接收、路由、投递）
- [x] P2P 实时聊天
- [x] 离线消息存储与拉取
- [x] 输入中提示（typing indicator）— 全端完成
- [x] 已读回执 — 全端完成
- [x] 在线状态显示 — 全端完成
- [x] 消息引用/回复

### Bot 生态 (Phase 2) - 完成
- [x] WebSocket Bot 接口
- [x] Go Bot SDK (WebSocket)
- [x] Python Bot SDK (WebSocket)
- [x] TypeScript Bot SDK (WebSocket)
- [x] API Key 认证
- [x] Bot 身份标识展示（bot_disclose）
- [x] Bot 行为限流
- [x] Bot-to-Bot 防护
- [x] Bot 管理后台 UI
- [x] AI Assistant Bot (LLM 对话)
- [x] Xiaoba Bot (TypeScript)

### 富媒体消息 (Phase 3) - 完成
- [x] 图片消息（上传、预览、全屏查看）
- [x] 文件消息（上传、下载、分享）
- [x] 链接预览卡片
- [x] 结构化消息卡片

### 群聊增强 (Phase 4) - 完成
- [x] 群 topic 模型（`grp_{groupId}`）
- [x] 创建群组、邀请成员
- [x] 群消息广播
- [x] 群成员管理（踢人、角色）
- [x] @提及解析与通知
- [x] Bot @触发过滤（群聊 Bot 只在被 @ 时收到消息）
- [x] 群管理员禁言/解禁
- [x] 群公告

### 用户系统
- [x] 用户注册/登录
- [x] Token 认证
- [x] 好友管理（添加、接受、拒绝、列表）
- [x] 用户资料页

### 前端
- [x] React Webapp
- [x] WeChat 风格绿色主题
- [x] iOS 原生 App (SwiftUI)
- [x] 深色模式支持（iOS）
- [x] 图片全屏预览
- [x] 文件下载分享

### 部署与安全 (Phase 5 基础)
- [x] Docker Compose 配置
- [x] MySQL 数据库
- [x] Nginx 反向代理
- [x] 移除硬编码密码（环境变量）
- [x] HTTPS 配置（SSL/TLS）
- [x] 健康检查端点（/health, /ready）
- [x] 数据库连接池优化

---

## 进行中 🚧

### Production 准备
- [ ] 基础监控（Prometheus 指标）
- [ ] 日志收集
- [ ] 自动化测试

---

## 计划中 📋

### Phase 5 — 安全与稳定性

- [x] HTTPS 强制 ✅
- [x] CORS 收紧 ✅
- [ ] JWT 会话失效治理（删号/封号后立即失效，前端强制退出）
- [ ] 消息内容审核
- [ ] Redis Pub/Sub 多节点扩展
- [ ] Prometheus + Grafana 监控
- [ ] 自动化测试

### Phase 6 — Agent 经济系统

**愿景**：Agent-to-Agent 技能交换与算力交易市场

#### 6.1 积分系统（Ctoken）
- [ ] 钱包表设计（balance, frozen）
- [ ] 交易记录表
- [ ] 托管账户表
- [ ] 充值/提现接口（或纯内部积分）

#### 6.2 Skill Card（技能卡）
- [ ] 服务发布结构化描述
- [ ] 定价模型（base + per_unit）
- [ ] 历史案例展示
- [ ] 服务能力声明

#### 6.3 交易市场
- [ ] Skill Card 搜索/筛选
- [ ] Agent 自动比价（LLM 分析）
- [ ] 协商聊天窗口
- [ ] 报价/确认消息类型

#### 6.4 托管与结算
- [ ] 交易创建时锁定资金
- [ ] 卖方抵押机制
- [ ] 交付物提交
- [ ] 买方确认/超时自动确认
- [ ] 争议处理

#### 6.5 信用体系
- [ ] 信用分数计算
- [ ] 信用等级与权益
- [ ] 违约惩罚
- [ ] 评价系统

### Phase 7 — 多端与体验

- [ ] Android App
- [ ] 桌面端（Tauri）
- [ ] 推送通知（APNs / FCM）
- [ ] 消息搜索
- [ ] 语音消息
- [ ] 表情/贴纸

---

## 版本规划

| 版本 | 目标 | 状态 |
|------|------|------|
| v0.3 | Alpha 优化 | ✅ 完成 |
| v0.4 | Phase 1-3 完成 | ✅ 完成 |
| v0.5 | Phase 2-4 完成 | ✅ 当前 |
| v0.6 | 经济系统 MVP | 计划中 |
| v0.7 | 安全加固 | 计划中 |
| v0.8 | 多端支持 | 计划中 |
| v0.9 | Beta | 计划中 |
| v1.0 | 正式版 | 计划中 |

---

## 技术债务

| 问题 | 优先级 | 状态 |
|------|--------|------|
| ~~硬编码密码~~ | 🔴 高 | ✅ 已修复 |
| ~~无健康检查~~ | 🔴 高 | ✅ 已修复 |
| ~~无 HTTPS~~ | 🔴 高 | ✅ 已修复 |
| 删号/封号后旧 JWT 仍可继续调用 API / WS，客户端不会强制退出 | 🔴 高 | 待处理 |
| 无测试覆盖 | 🔴 高 | 待处理 |
| iOS DEVELOPMENT_TEAM 空 | 🟡 中 | 待用户配置 |
| 无 API 文档 | 🟡 中 | 待处理 |
| 无 CI/CD | 🟢 低 | 待处理 |

---

## 更新日志

### 2026-02-21 (2)
- Phase 2 Bot 生态完成：身份展示、管理后台、SDK 统一为 WebSocket
- Phase 4 群聊增强完成：@提及、Bot @触发过滤、禁言、公告
- 版本升级到 v0.5.0-alpha

### 2026-02-21 (1)
- Phase 1 完成：typing indicator、已读回执、在线状态全端实现
- Phase 3 完成：图片/文件富媒体消息全端支持
- Phase 5 基础：安全加固、HTTPS、健康检查、连接池优化

### 2026-02-20
- 新增 iOS 原生 App (SwiftUI)
- 统一品牌主题（WeChat 绿）
- 新增 Phase 6 Agent 经济系统规划

### 2026-02-16
- 初始项目创建
- 核心聊天功能
- Webapp + Docker 部署
