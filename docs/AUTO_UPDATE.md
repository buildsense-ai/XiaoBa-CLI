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

不能把 `build.mac.target` 配置成只有 `dmg`。发布 workflow 会在构建后运行 `scripts/verify-macos-update-artifacts.mjs`，校验清单中的架构、文件大小和 SHA-512；CDN 发布后再逐字节比对远端清单，并核对 DMG、ZIP 的远端大小和 SHA-512。任何一项不一致时发布都必须失败。

当前 macOS 包沿用未签名分发方式，用户首次打开或安装时需要在系统中手动确认。发布流程不要求 Apple Developer 证书，也不能把缺少签名当作本次 ZIP 事故的根因。正式签名和 notarization 留作后续独立升级，并在启用前做真机迁移验证。

2026-07-15 的缺失 ZIP 事故见 [事故复盘](./incidents/2026-07-15-macos-auto-update-missing-zip.md)。
