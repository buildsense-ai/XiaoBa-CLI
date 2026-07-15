# macOS 自动更新缺失 ZIP 与签名门禁事故复盘

- 日期：2026-07-15
- 影响版本：自动更新功能接入后至 v1.4.3 的 macOS 发布版本
- 影响平台：macOS x64、macOS arm64
- 状态：代码门禁已修复；等待配置正式签名证书、发布过渡版本并完成真机验证

## 摘要

macOS 客户端可以读取线上 `latest-mac.yml` 并发现新版本，但点击下载后立即报错：

```text
ERR_UPDATER_ZIP_FILE_NOT_FOUND: ZIP file not provided
```

下载进度保持 `0 B / 0 B`。线上只发布了 DMG，缺少 Squirrel.Mac 自动更新所需的 ZIP。进一步复核发布日志还发现，v1.4.3 x64 包未签名，arm64 包仅使用 ad-hoc 签名。用户仍可手动下载 DMG 覆盖安装；Windows 不受该问题影响。

## 时间线

- 2026-03-20：Electron 打包配置加入 `mac.target: ["dmg"]`。
- 2026-03-28：项目接入 `electron-updater`，但没有把 macOS target 恢复为默认的 `dmg + zip`。
- 2026-07-14：v1.4.3 发布成功；CI 只验证更新清单 URL 返回 HTTP 200。
- 2026-07-15：从 v1.4.1 更新到 v1.4.3 时发现下载失败；核对 CDN 清单、GitHub Release 和 `electron-updater` 实现后确认缺少 ZIP。
- 2026-07-15：复核 v1.4.3 构建日志，确认 x64 跳过代码签名，arm64 回退为 ad-hoc 签名；`release-prod` 也没有 macOS 签名证书 secrets。

## 影响

- macOS 客户端能发现新版本，但不能通过应用内更新中心下载和安装。
- 自动检查成功会让发布看起来正常，故障直到用户点击“下载更新”才暴露。
- 错误弹窗显示了完整清单对象，内容过长且不利于用户理解。
- 错误正文包含 `sha512` 字段，被本地正则误分类为 `PACKAGE_VALIDATION_FAILED`，掩盖了真正原因。

## 根因

项目显式配置了仅构建 DMG：

```json
"mac": {
  "target": ["dmg"]
}
```

这覆盖了 electron-builder 的 macOS 默认 target。Squirrel.Mac 安装更新时需要 ZIP，DMG 只适合手动分发，不能替代 ZIP 更新载荷。

同时，发布环境没有配置 Developer ID Application 证书。electron-builder 因此允许 x64 跳过签名、arm64 回退为 ad-hoc 签名，但 workflow 没有把这种降级视为失败。macOS 自动更新要求应用使用有效的 Developer ID 签名；仅补 ZIP 不能证明旧客户端到新版本的更新链路一定可用。

## 促成因素

1. 发布 workflow 的 artifact、GitHub Release 和 CDN 上传列表只包含 DMG。
2. 发布后检查只对 `latest-mac.yml` 做 HTTP HEAD，没有解析清单内容。
3. 没有在构建阶段断言 DMG、ZIP 和目标架构都存在。
4. 通用错误分类先匹配到错误正文中的 `sha512`，导致缺包事故被标记成校验失败。
5. 发布文档只写了 macOS DMG，没有说明 ZIP 是自动更新的必要产物。
6. workflow 没有校验签名身份，未签名和 ad-hoc 签名仍可发布。
7. TOS secrets 缺失时，所有 CDN 步骤会被静默跳过，GitHub Release 仍可成功创建。
8. CDN 发布后只检查 HTTP 200，旧清单或大小不一致的产物也可能通过。

## 修复

1. `build.mac.target` 固定为 `dmg + zip`。
2. workflow 上传并发布两个架构的 ZIP 和 ZIP blockmap。
3. 新增 macOS 更新产物校验脚本：
   - 构建后解析 `latest-mac.yml`。
   - 强制要求同架构的 DMG 和 ZIP。
   - 强制要求本地产物大小和 SHA-512 与清单一致。
   - 发布后逐字节比对 CDN 清单，并检查 DMG、ZIP 的远端大小。
4. 常规 CI 的 release preflight 强制检查 macOS target 同时包含 DMG 和 ZIP。
5. 客户端单独识别 `ERR_UPDATER_ZIP_FILE_NOT_FOUND`，显示简洁提示并限制公开错误长度；原始错误保留在日志中。
6. macOS 构建必须提供签名与 App Store Connect API key secrets；electron-builder 完成签名和 notarization 后，再用 `codesign`、`stapler` 和 `spctl` 验证 Developer ID、票据与 Gatekeeper。
7. TOS 凭据改为必需项，缺失时在创建 GitHub Release 前失败，不再静默跳过 CDN 发布。
8. GitHub Release 先保持 draft；CDN 清单与二进制大小、SHA-512 全部验证成功后才公开。

## 恢复计划

先在 GitHub `release-prod` 环境配置 Developer ID Application 证书，再发布包含本修复的过渡版本。由于已安装的旧版本可能未签名或仅 ad-hoc 签名，不能预先承诺它们都能直接自动升级：必须先用真实 Intel Mac 和 Apple Silicon Mac 验证旧版到正式签名过渡版的路径。如果系统拒绝该更新，则需要用户手动安装一次正式签名 DMG；之后再验证正式签名版本之间的自动更新。

下一版本发布完成后必须在真实 Intel Mac 和 Apple Silicon Mac 上分别验证：

1. 旧版本能发现新版本。
2. 下载进度从 0 正常增长并完成。
3. “安装并重启”后版本号正确更新。
4. 手动 DMG 下载仍可用。
5. GitHub Release 与 CDN 均包含两个架构的 DMG、ZIP 和对应元数据。
6. `codesign -dv --verbose=4` 显示 Developer ID Application 签名，且 `codesign --verify --deep --strict` 通过。
7. `xcrun stapler validate` 和 `spctl --assess` 均通过。
8. 正式签名版本到下一正式签名版本的自动更新通过。

## 长期教训

- 发布成功必须定义为“客户端能完成更新”，不能只定义为 workflow 绿色或清单 URL 存在。
- 更新清单和被引用的二进制产物必须作为一个整体校验。
- 多架构发布必须验证架构匹配，不能依赖文件名肉眼检查。
- 面向用户的错误应短且准确，原始诊断信息写入日志，不直接塞进弹窗。
- 修改打包 target、artifact glob 或 CDN 路径时，必须同步更新发布断言和端到端验证清单。
- 签名降级和发布目的地跳过都必须是硬失败，不能依赖构建工具的警告或条件跳过。
