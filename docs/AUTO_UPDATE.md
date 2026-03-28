# 自动更新配置指南

## 使用方法

### 1. 设置 GitHub Token

发布需要 GitHub Token，在环境变量中设置：

```bash
export GH_TOKEN="your_github_token"
```

或在 `.env` 中添加：
```
GH_TOKEN=your_github_token
```

### 2. 更新版本号

修改 `package.json` 中的 `version` 字段：
```json
{
  "version": "0.1.1"
}
```

### 3. 发布新版本

```bash
./scripts/release.sh
```

或手动执行：
```bash
npm run build
npm run electron:build
npx electron-builder --publish always
```

## 工作原理

1. 应用启动 3 秒后自动检查 GitHub Releases
2. 发现新版本时弹窗提示用户
3. 用户确认后下载更新
4. 下载完成后提示重启应用

## 注意事项

- 只有打包后的应用才会检查更新
- 需要在 GitHub 创建 Release 并上传安装包
- 确保 `package.json` 中的 `repository` 配置正确
