# 自动更新说明

自动更新依赖 GitHub Release 中的桌面端安装包和元数据文件。

## 当前发布入口

当前标准发布方式不是手动执行 `electron-builder --publish always`，而是：

1. 推送代码
2. 打发布 tag，例如 `v0.1.2`
3. 推送该 tag
4. 由 GitHub Actions 自动构建并创建 Release

完整流程见 [CD_RELEASE.md](./CD_RELEASE.md)。

## 自动更新依赖的内容

- GitHub Release
- Windows `latest.yml`
- macOS `latest-mac.yml`
- Linux `latest-linux.yml`

只有当这套 tag 驱动的 CD 成功完成后，客户端自动更新链路才是完整可用的。

## macOS 的额外要求

macOS 发布必须同时生成 `.dmg` 和 `.zip`：

- `.dmg` 用于用户手动下载安装
- `.zip` 是 `electron-updater` / Squirrel.Mac 实际使用的自动更新载荷
- `latest-mac.yml` 必须同时引用对应架构的 DMG 和 ZIP
- x64 和 arm64 的清单、DMG、ZIP 不得混用

不能把 `build.mac.target` 配置成只有 `dmg`。发布 workflow 会在构建后和 CDN 发布后分别执行 `scripts/verify-macos-update-artifacts.mjs`；任何架构缺少 DMG、ZIP 或引用了错误架构时，发布都必须失败。

2026-07-15 的缺失 ZIP 事故见 [事故复盘](./incidents/2026-07-15-macos-auto-update-missing-zip.md)。
