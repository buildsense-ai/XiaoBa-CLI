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
桌面源码未使用、仅供 Worker 制品验收的 `deasync` 会在 `afterPack` 阶段移除。
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

### 安装交接必须允许应用退出

macOS 上真正的安装由 Squirrel 的 `ShipIt` 在**应用完全退出后**执行。`autoUpdater.quitAndInstall()` 会先关闭所有窗口、窗口全部关闭后才触发 `before-quit` 并退出应用。

因此窗口层必须配合：

- 应用平时为了托盘常驻，会拦截窗口 `close` 并改成隐藏；这个拦截必须在这一刻放行，否则窗口永远关不掉、`before-quit` 永不触发、应用永不退出，`ShipIt` 会一直等待一个仍在运行的进程，表现为界面长期停在「安装中」而版本始终不更新。
- 具体做法是先标记退出（`app.isQuitting = true`），再请求安装交接；`electron/update-controller.js` 的 `beforeInstallHandoff` 就是给这一步用的钩子。
- 退出标记是**单向闩锁**，而「请求了交接」不等于「应用会退出」：更新器可能直接拒绝安装（例如安装包缺失、Squirrel 没有接住更新），此时应用继续存活，闩锁却留在 true。因此交接必须有对称的复位钩子 `installHandoffAborted`，在交接抛错或看门狗判定 `UPDATE_INSTALL_DID_NOT_START` 时把标记放回去。否则用户下一次照常关窗口会直接退出应用（破坏托盘常驻），`render-process-gone` 的 `if (app.isQuitting) return;` 自愈分支也会被永久关闭。
- `ShipIt` 拒绝安装时的措辞是 `App Still Running Error`（`SQRLInstallerErrorDomain Code=-9`），日志见 `~/Library/Caches/com.catcompany.xiaoba.ShipIt/ShipIt_stderr.log`。排查安装失败时先看这个文件。
- 应用退出后不要在几十秒内马上重新打开：`ShipIt` 会重新检查实例数，检测到有实例在运行就会放弃本次安装。

历史症状记录（2026-09-15，1.5.5 真机）：`/api/update/status` 长期停在 `stage: "installing"`，`ShipIt` 日志停在 `Detected this as an install request`，版本一直是 1.5.5，直到手工触发一次真正的退出才装上 1.5.8。

2026-07-15 的缺失 ZIP 事故见 [事故复盘](./incidents/2026-07-15-macos-auto-update-missing-zip.md)。
