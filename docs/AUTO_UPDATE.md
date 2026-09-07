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

## Windows 差分更新

Windows NSIS 产物显式启用 `differentialPackage`，发布时必须同时保留
`latest.yml`、当前和上一版本的 `.exe.blockmap` 以及对应安装包。

正式更新源是火山引擎 TOS。该对象存储支持单段 HTTP Range，但多段 Range
请求会返回整个对象，因此 generic provider 必须设置
`useMultipleRangeRequest: false`。这样 electron-updater 会按变化块发起单段
Range 请求，避免差分更新退化为下载完整安装包。

差分下载会在本地重建并校验完整 NSIS 安装器；NSIS 随后仍会更新应用目录。
当前打包只保留 electron-builder 收集的生产依赖树，不再通过
`extraResources` 复制第二套 `node_modules`，以减少安装阶段的文件展开和扫描。
这些依赖由内置 Node 子进程加载，因此打包时关闭 Electron ABI 原生模块重编译；
发布验收仍需从打包目录使用内置 Node 加载实际原生模块。

发布验收必须检查应用 `userData` 目录下的 `logs/updater.log`：

- 出现 `Differential download`，且实际传输量明显小于完整安装包，才算命中差分下载。
- 出现 `fallback to full download` 时，记录具体错误并按完整包下载处理，不能把它标记为差分成功。
- 下载完成后继续验证退出、安装器接管、重新启动和版本号，不能只看下载进度到 100%。

## macOS 的额外要求

macOS 发布必须同时生成 `.dmg` 和 `.zip`：

- `.dmg` 用于用户手动下载安装
- `.zip` 是 `electron-updater` / Squirrel.Mac 实际使用的自动更新载荷
- `latest-mac.yml` 必须同时引用对应架构的 DMG 和 ZIP
- x64 和 arm64 的清单、DMG、ZIP 不得混用

不能把 `build.mac.target` 配置成只有 `dmg`。发布 workflow 会在构建后运行 `scripts/verify-macos-update-artifacts.mjs`，校验清单中的架构、文件大小和 SHA-512；CDN 发布后再逐字节比对远端清单，并核对 DMG、ZIP 的远端大小和 SHA-512。任何一项不一致时发布都必须失败。

当前 macOS 包沿用未签名分发方式，用户首次打开或安装时需要在系统中手动确认。发布流程不要求 Apple Developer 证书，也不能把缺少签名当作本次 ZIP 事故的根因。正式签名和 notarization 留作后续独立升级，并在启用前做真机迁移验证。

2026-07-15 的缺失 ZIP 事故见 [事故复盘](./incidents/2026-07-15-macos-auto-update-missing-zip.md)。
