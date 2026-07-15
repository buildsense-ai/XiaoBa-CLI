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
- `.app` 必须使用有效的 Developer ID Application 证书签名并通过 Apple notarization；未签名、ad-hoc 签名或无 notarization 票据不得发布

不能把 `build.mac.target` 配置成只有 `dmg`。发布 workflow 会在构建后运行 `scripts/verify-macos-update-artifacts.mjs`，校验清单中的架构、文件大小和 SHA-512；CDN 发布后再逐字节比对远端清单，并核对 DMG、ZIP 的远端大小。任何一项不一致时发布都必须失败。

`release-prod` 环境必须配置以下 secrets：

- `MACOS_CSC_LINK`：Developer ID Application 证书（electron-builder 支持的证书文件或 base64 内容）
- `MACOS_CSC_KEY_PASSWORD`：证书密码
- `MACOS_APPLE_API_KEY_BASE64`：App Store Connect `.p8` API key 的 base64 内容
- `MACOS_APPLE_API_KEY_ID`：App Store Connect API key ID
- `MACOS_APPLE_API_ISSUER`：App Store Connect issuer ID
- `MACOS_TEAM_ID`：预期的 Apple Developer Team ID，用于阻止误用其他团队的有效证书

workflow 只在准备证书/构建步骤中注入这些 secrets。构建完成后会执行 `codesign --verify`、`xcrun stapler validate` 和 `spctl --assess`，确保正式签名、notarization 票据和 Gatekeeper 检查全部通过。

从历史未签名或 ad-hoc 签名版本迁移到正式签名版本时，必须做一次真实 Intel Mac 和 Apple Silicon Mac 的升级验证。若旧客户端无法接受签名变化，用户需要手动安装一次正式签名 DMG，之后再恢复正常自动更新。

2026-07-15 的缺失 ZIP 事故见 [事故复盘](./incidents/2026-07-15-macos-auto-update-missing-zip.md)。
