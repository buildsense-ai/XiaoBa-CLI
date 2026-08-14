# Worker 应用制品更新（Part A）

已有虚拟员工（worker）通过**应用制品**（`npm run worker:artifact` 产出的确定性
tar.gz）更新应用层：不切系统盘、不动 `/srv/catsco-agent` 数据，支持校验、
冒烟、自动回滚，可由 CI/控制面触发。

## 触发方式

### 1. CI 自动（打 tag + 开关）

打稳定 tag（`v*`）且仓库变量 `CTYUN_WORKER_APP_UPDATE=true` 时，
`.github/workflows/worker-app-update.yml` 会：

1. 构建确定性制品（`build-linux-worker-artifact.mjs`，含捆绑 Node）
2. 逐台部署到 worker 目标（`deploy-worker-artifact.mjs`，串行）

```bash
gh variable set CTYUN_WORKER_APP_UPDATE --repo buildsense-ai/XiaoBa-CLI --body true
git tag v1.5.0 && git push origin v1.5.0
```

关掉开关（`false`）后打 tag 不会触发分发（kill switch）。

**CI 所需仓库配置（secrets/vars，仅按名引用）：**

```bash
# secrets：SSH 私钥 + 目标主机指纹（known_hosts 内容）
gh secret set WORKER_SSH_KEY --repo buildsense-ai/XiaoBa-CLI --body "$(cat ~/.ssh/id_rsa)"
gh secret set WORKER_SSH_KNOWN_HOSTS --repo buildsense-ai/XiaoBa-CLI \
  --body "$(ssh-keyscan host1 host2)"
# vars：目标主机列表（真实 host，非本地 alias）+ SSH 用户
gh variable set WORKER_SSH_TARGETS --repo buildsense-ai/XiaoBa-CLI --body "host1,host2,..."
gh variable set WORKER_SSH_USER --repo buildsense-ai/XiaoBa-CLI --body root
```

CI 会把私钥/known_hosts 写入 `$RUNNER_TEMP` 临时文件（`chmod 600`）并显式传
`--ssh-key`/`--known-hosts`/`--ssh-user`/`--targets` 给分发器——分发器不从环境
变量读密钥。

⚠️ **严格 SemVer 门控**：只有 `vX.Y.Z`（纯数字三段）tag 才会进入生产分发；
`v1.0.8-fork-volc-dual-bucket-fix-...` 这类非正式 tag 会被拒绝。

### 2. 手动触发

GitHub Actions → workflow_dispatch → 勾选 `update_workers`（仅 `main` 分支生效）。

### 3. 本地 / 运维机

```bash
# 先构建制品
npm run worker:artifact

# 干跑（不真正 ssh/scp）
node scripts/deploy-worker-artifact.mjs \
  --artifact <path.tar.gz> --sha256 <hex> --version <v> --commit <sha> \
  --targets worker1,worker2 --dry-run

# 实际部署
node scripts/deploy-worker-artifact.mjs \
  --artifact <path.tar.gz> --sha256 <hex> --version <v> --commit <sha> \
  --targets host1,host2 \
  [--ssh-user root] [--ssh-key ~/.ssh/id_rsa] [--known-hosts ~/.ssh/known_hosts] \
  [--abort-on-failure]
```

- 未指定 `--targets` 时使用默认矩阵：`worker1 worker2 ck-work-hn2 zh-work yjz-work`
  （本地 SSH alias；**CI 必须显式传真实 host，且 `WORKER_SSH_TARGETS` 为空时
  fail-closed 拒绝执行**，不会回退到 alias）
- 每台执行：`scp 制品+脚本 → update-worker-artifact.sh → 验证`
- 提供 `--known-hosts` 时强制 `StrictHostKeyChecking=yes`，否则 `accept-new`
- SSH 用户通过 `--ssh-user` 编码进 destination（`user@host`），**不向 scp 传
  `-l <user>`**（OpenSSH 的 `scp -l` 是带宽限制，不是用户）
- 单台失败不阻塞后续（除非 `--abort-on-failure`）；结束时清理远端 `/tmp` 临时文件
- 远端 `current` release_id 已是目标版本时自动跳过该台（幂等）
- **回滚归属**：切换后的失败（服务不 active/心跳失败）由 worker 侧脚本自动回滚；
  切换前的失败（checksum/manifest/冒烟）不动 `current`。分发器**不二次回滚**。

## 安全边界

- **只动 `/opt/catsco`**：`/opt/catsco/releases/<version>-<shortCommit>` + 切换
  `/opt/catsco/current` 符号链接 + 重启 `catsco-agent.service`。
- **`/srv/catsco-agent` 数据绝不触碰**（`.env`、`.xiaoba`、数据、技能等）。
- worker 上**无云凭据**：制品分发走 SSH（CI secret `WORKER_SSH_KEY`），
  worker 不需要天翼云 AK/SK。
- 校验链：制品 SHA256 匹配 → manifest `version/commit` 匹配 → 捆绑 Node/npm
  存在 → 原生模块冒烟（`sharp`/`@napi-rs/canvas`，在 release 目录内运行）→
  重启后心跳验证（`journalctl --since @$(date +%s)`，epoch 秒无时区歧义，
  只认本次重启后的日志，含 `已连接`/`握手成功`/`uid=`）。
- 任一验证失败：**自动切回旧 release 并重启**，绝不留指向坏版本的 `current`。

## 回滚

- **自动回滚**：更新失败时脚本自动切回更新前的 release。
- **手动回滚**：每台执行
  `bash /tmp/...sh --rollback`（读 `/var/lib/catsco/previous-release`），
  或直接 `ln -sfn /opt/catsco/releases/<旧版本>-<commit> /opt/catsco/current`
  后 `systemctl restart catsco-agent.service`。
- 查看当前版本：`bash ...sh --status` → `release_id` / `current`。

## 与镜像的关系

| 场景 | 通道 |
|---|---|
| **新 worker**（新建云托管员工） | 完整镜像（bake `catsco-worker-*` + provision） |
| **已有 worker 应用升级** | 应用制品（Part A，本通道）——不重新 bake |
| **已有 worker 重置/重装** | `reset-worker.sh` → 最新镜像重建（丢数据） |

镜像负责系统/运行时底座；应用制品负责 worker 侧应用层迭代。二者并存，
制品更新失败可回退到镜像内旧版本。

## 相关文件

- `scripts/update-worker-artifact.sh` — worker 侧更新/状态/回滚脚本
- `scripts/deploy-worker-artifact.mjs` — 分发器（串行 ssh/scp）
- `scripts/build-linux-worker-artifact.mjs` — 确定性制品构建
- `.github/workflows/worker-app-update.yml` — CI 分发（tag + kill switch）
