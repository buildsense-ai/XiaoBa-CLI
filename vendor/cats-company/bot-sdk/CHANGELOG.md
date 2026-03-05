# Bot SDK 更新日志

## v0.1.1 (2026-03-05)

**修复：**
- 增加 ack timeout 从 10秒到 30秒
- 修复 bot displayName 在握手时显示"未设置"
- 修复 401 错误导致连接断开

**如何更新：**

### 方法 1：从 GitHub 安装（推荐）
```json
{
  "dependencies": {
    "@catscompany/bot-sdk": "github:buildsense-ai/cats-company#main:bot-sdk/typescript"
  }
}
```

### 方法 2：使用本地 vendor
```bash
cd vendor/cats-company
git pull origin main
cd ../..
npm install
```

### 方法 3：npm（即将支持）
```bash
npm install @catscompany/bot-sdk@latest
```
