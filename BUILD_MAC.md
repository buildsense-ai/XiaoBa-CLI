# macOS 构建指南

## 前置准备

在 macOS 机器上执行以下步骤：

### 1. 添加 macOS Node 二进制

```bash
cp $(which node) build-resources/node/node
chmod +x build-resources/node/node
```

### 2. 安装依赖

```bash
npm install
```

### 3. 构建应用

```bash
npm run electron:build:mac
```

### 4. 输出文件

构建完成后，DMG 安装包会生成在 `release` 目录：
- `XiaoBa-{version}-arm64.dmg` (Apple Silicon)
- `XiaoBa-{version}-x64.dmg` (Intel)

## 注意事项

- 确保 `build-resources/node/` 目录同时包含 `node.exe` (Windows) 和 `node` (macOS)
- macOS 构建必须在 macOS 系统上进行
- 代码已支持跨平台，会自动根据系统选择正确的 node 二进制文件
