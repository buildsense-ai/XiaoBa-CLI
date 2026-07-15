# macOS 自动更新缺失 ZIP 事故复盘

- 日期：2026-07-15
- 影响版本：至少 v1.0.3、v1.4.0 至 v1.4.3；问题配置早于自动更新功能接入
- 影响平台：macOS x64、macOS arm64
- 状态：代码已修复，等待下一桌面版本发布后恢复线上自动更新

## 摘要

macOS 客户端可以读取线上 `latest-mac.yml` 并发现新版本，但点击下载后立即报错：

```text
ERR_UPDATER_ZIP_FILE_NOT_FOUND: ZIP file not provided
```

下载进度保持 `0 B / 0 B`。线上只发布了 DMG，缺少 Squirrel.Mac 自动更新所需的 ZIP。用户仍可手动下载 DMG 覆盖安装；Windows 不受该问题影响。

## 时间线

- 2026-03-20：Electron 打包配置加入 `mac.target: ["dmg"]`。
- 2026-03-28：项目接入 `electron-updater`，但没有把 macOS target 恢复为默认的 `dmg + zip`。
- 2026-07-14：v1.4.3 发布成功；CI 只验证更新清单 URL 返回 HTTP 200。
- 2026-07-15：从 v1.4.1 更新到 v1.4.3 时发现下载失败；核对 CDN 清单、GitHub Release 和 `electron-updater` 实现后确认缺少 ZIP。

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

## 促成因素

1. 发布 workflow 的 artifact、GitHub Release 和 CDN 上传列表只包含 DMG。
2. 发布后检查只对 `latest-mac.yml` 做 HTTP HEAD，没有解析清单内容。
3. 没有在构建阶段断言 DMG、ZIP 和目标架构都存在。
4. 通用错误分类先匹配到错误正文中的 `sha512`，导致缺包事故被标记成校验失败。
5. 发布文档只写了 macOS DMG，没有说明 ZIP 是自动更新的必要产物。

## 修复

1. `build.mac.target` 固定为 `dmg + zip`。
2. workflow 上传并发布两个架构的 ZIP 和 ZIP blockmap。
3. 新增 macOS 更新产物校验脚本：
   - 构建后解析 `latest-mac.yml`。
   - 强制要求同架构的 DMG 和 ZIP。
   - 强制要求本地产物存在且非空。
   - 发布后回读 CDN 清单，并对 DMG、ZIP 执行可访问性检查。
4. 常规 CI 的 release preflight 强制检查 macOS target 同时包含 DMG 和 ZIP。
5. 客户端单独识别 `ERR_UPDATER_ZIP_FILE_NOT_FOUND`，显示简洁提示并限制公开错误长度；原始错误保留在日志中。

## 恢复计划

发布包含本修复的下一版本。旧客户端会重新读取最新 `latest-mac.yml`，只要新版本清单包含可访问的 ZIP，就可以直接跨版本自动更新，不要求先安装 v1.4.3。

下一版本发布完成后必须在真实 Intel Mac 和 Apple Silicon Mac 上分别验证：

1. 旧版本能发现新版本。
2. 下载进度从 0 正常增长并完成。
3. “安装并重启”后版本号正确更新。
4. 手动 DMG 下载仍可用。
5. GitHub Release 与 CDN 均包含两个架构的 DMG、ZIP 和对应元数据。

## 长期教训

- 发布成功必须定义为“客户端能完成更新”，不能只定义为 workflow 绿色或清单 URL 存在。
- 更新清单和被引用的二进制产物必须作为一个整体校验。
- 多架构发布必须验证架构匹配，不能依赖文件名肉眼检查。
- 面向用户的错误应短且准确，原始诊断信息写入日志，不直接塞进弹窗。
- 修改打包 target、artifact glob 或 CDN 路径时，必须同步更新发布断言和端到端验证清单。
