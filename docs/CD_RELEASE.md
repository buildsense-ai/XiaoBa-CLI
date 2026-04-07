# 桌面端 CD 发布说明

这条 CD 只负责桌面端安装包发布。

## 触发规则

- 只有 `git push` 的 tag 匹配 `v*` 时，才会触发 GitHub Actions 发布流程
- 普通分支 push 不会触发这条 CD
- 当前 workflow 文件：`.github/workflows/release.yml`

## 版本规则

- 发布时版本号以 tag 为准，例如 `v0.1.2` 会注入为 `0.1.2`
- 如果没有 tag，默认版本来自 `package.json`
- Dashboard 显示、CLI 版本、Release 版本名都会跟随这一套规则

## 标准发布步骤

1. 确认代码已经合入并推送到远端分支
2. 如需更新默认版本，先修改 `package.json` 里的 `version`
3. 创建发布 tag，例如：

```bash
git tag v0.1.2
git push origin v0.1.2
```

4. 等待 GitHub Actions 完成三端构建和 Release 发布

## Workflow 会做什么

1. 在 macOS、Windows、Linux 三个平台分别执行 `npm ci`
2. 运行 `node scripts/inject-version.js`
3. 构建三端 Electron 安装包
4. 上传各平台产物为 workflow artifacts
5. 最后统一创建一个 GitHub Release，并挂载三端安装包

## 产物说明

- macOS：`.dmg`
- Windows：`.exe`
- Linux：`.AppImage` 和 `.deb`

## 注意事项

- 构建阶段的 `electron-builder` 已固定为 `--publish never`，不会在单个平台构建时提前发布
- 真正的 GitHub Release 只会在最后一个 `release` job 中统一创建
- 如果 tag 打错了，先删除远端 tag，再重新打正确的 tag
- `scripts/release.sh` 是旧流程遗留，不作为当前标准发布入口
