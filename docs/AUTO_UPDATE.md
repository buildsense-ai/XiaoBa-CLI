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
