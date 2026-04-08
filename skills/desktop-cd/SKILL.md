---
name: desktop-cd
description: 优化和排查桌面端 GitHub Actions CD、tag 发布、三平台安装包、GitHub Release、electron-builder 自动更新与缓存预热。当任务涉及 release.yml、warm-cache.yml、tag 触发、版本注入、latest.yml、自动更新源或构建耗时时使用此 skill。
invocable: both
argument-hint: "<优化目标或排查问题>"
max-turns: 24
---

# Desktop CD

你负责这个仓库里桌面端发布链路的优化、排查和收口。目标不是泛泛讨论 CI/CD，而是直接围绕这个项目当前的 Electron 桌面发布方案做判断和改动。

## 已验证过的仓库基线

- CD 只应由 `git push` 的 `v*` tag 触发，不应由普通 `main` push 或 PR merge 直接触发。
- 三个平台构建 job 只负责产出安装包和更新元数据，最终 GitHub Release 只在最后一个 `release` job 统一创建。
- 三个平台构建命令应保留 `--publish never`，避免 `electron-builder` 在各平台 job 自己发版。
- 版本规则是 `tag > package.json`。tag 存在时，以 pushed tag 版本为准；没有 tag 时回退到 `package.json`。
- 当前版本注入链路依赖 `scripts/inject-version.js`、`src/version.ts`、`src/index.ts`、`src/dashboard/routes/api.ts` 和 `dashboard/index.html`。
- 自动更新源取决于 `package.json` 里的 `build.publish.owner/repo`。这个值会被打进安装包，切换源后通常需要手动安装一次新源版本。
- 桌面端自动更新检查只在应用启动后约 3 秒执行一次，见 `electron/main.js`；没有内建定时轮询。
- 当前缓存优化思路是：`main` 上预热 npm cache，tag 发布复用该缓存；不要指望 tag 自己的 cache 在下一个 tag 继续复用。

## 必看文件

- `.github/workflows/release.yml`
- `.github/workflows/warm-cache.yml`
- `package.json`
- `scripts/inject-version.js`
- `src/version.ts`
- `src/index.ts`
- `src/dashboard/routes/api.ts`
- `dashboard/index.html`
- `electron/main.js`

## 工作流程

1. 先判断任务属于哪一类：
   - 触发规则问题
   - 版本号问题
   - GitHub Release 产物问题
   - 自动更新问题
   - 构建耗时问题

2. 先读 workflow 和打包配置，再改代码：
   - 看 `.github/workflows/release.yml`
   - 看 `.github/workflows/warm-cache.yml`
   - 看 `package.json` 的 `scripts` 和 `build.publish`

3. 只做最小可信改动：
   - 不把普通 push 误变成发布
   - 不在多个 job 重复发布 release
   - 不同时引入多套版本来源

4. 改完后至少做一种验证：
   - 本地 `npm.cmd run build`
   - 本地 `npm.cmd test`
   - 或者推 tag 后检查 GitHub Actions / Release 产物

## 排查清单

### 1. tag 没触发 CD

- 确认 `.github/workflows/release.yml` 监听的是 `push.tags: 'v*'`
- 确认推送的是 tag，而不是只推了 `main`
- 确认 tag 名字符合 `v0.2.6` 这种格式
- 如需显示版本名，优先使用 `${{ github.ref_name }}`

### 2. 版本号不对

- 先看 pushed tag 是否存在
- 再看 `scripts/inject-version.js` 是否把 tag 版本注入到前端静态内容
- 再看 `src/version.ts` 是否统一从 `package.json` 读取版本
- 规则始终保持：有 tag 用 tag，没有 tag 用 `package.json`

### 3. GitHub Release 成功了，但客户端没收到更新

- 先看 `package.json` 里的 `build.publish.owner/repo` 是否指向正确仓库
- 再看 release 资产是否包含：
  - `latest.yml`
  - `latest-mac.yml`
  - `latest-linux.yml`
  - 三平台安装包
- 再看 `electron/main.js` 的自动更新逻辑是否仍在启动后执行
- 记住：客户端通常要重启后才会检查更新
- 如果刚把更新源从测试仓库切回正式仓库，通常需要先手动安装一次“新源版本”

### 4. GitHub Release 产物有了，但版本显示没同步

- 检查 `scripts/inject-version.js`
- 检查 `src/dashboard/routes/api.ts` 返回的版本
- 检查 `dashboard/index.html` 是否在加载 `/api/status` 后覆盖显示版本
- 检查 CLI 是否使用 `APP_VERSION`

### 5. 构建耗时太久

- 先区分是 `npm ci` 慢还是 `electron-builder` 慢
- 小改动优先：
  - `setup-node` 开启 `cache: npm`
  - 指定 `cache-dependency-path: package-lock.json`
  - `npm ci --prefer-offline --no-audit --fund=false`
  - `main` 分支单独做 cache warm
- 认知基线：
  - 这类优化通常每个平台只省十几秒
  - 真正的分钟级收益通常来自安装包内容瘦身，不属于“小改动”

## 当前仓库里已经验证过的经验

- tag 发布比普通 push 更安全，适合桌面安装包发版。
- `github.ref_name` 比直接使用完整 ref 更稳。
- 自动更新测试如果在 fork 仓库上进行，必须确认 `build.publish.owner/repo` 也切到了 fork。
- tag 自己生成的 cache 对下一个 tag 价值有限；`main` 预热才是更稳的做法。
- 当前这套缓存优化属于“小收益、低风险”方案，预期是每个平台缩短十几秒，而不是几分钟。
- 自动更新源切换后，通常需要先手动安装一次切换后的版本，后续才会继续自动更新。

## 修改时的硬规则

- 不要把 CD 改成普通 push 就自动发布，除非用户明确要求。
- 不要让多个 job 同时创建 release。
- 不要在版本来源上同时依赖 tag、手写常量和多个脚本而不做收口。
- 不要为了追求几秒钟收益引入大范围打包结构重构，除非用户明确同意。
- 遇到自动更新问题时，优先核对“更新源仓库”和 “latest*.yml”，不要先猜客户端逻辑坏了。

## 输出要求

- 给出结论时先说“当前问题属于哪类”
- 再列出你核对过的关键文件
- 如果是排查结果，明确写出“已验证”和“推断”的边界
- 如果是优化建议，优先按“改动小 / 收益确定 / 风险低”排序
