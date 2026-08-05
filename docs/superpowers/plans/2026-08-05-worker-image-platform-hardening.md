# Worker 镜像平台加固（2026-08）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 `deploy-catsco-linux-agent` 部署 skill 在 2026-08 踩过的平台故障固化进 `ops/ctyun-worker-image/prepare-image.sh`，让新 bake 的 worker 镜像自带免疫——新 worker 从镜像启动即健康，手动部署不再需要逐台升级 systemd/glibc、mask fwupd、修复 dpkg、配置 npm 镜像、更新 grub。

**架构：** bake 时（临时 builder 上、制作镜像捕获磁盘状态前）执行一段「平台加固」：dpkg 完整性修复 → systemd+glibc 升级到已知安全组合（255.4-1ubuntu8.16 + 2.39-0ubuntu8.8）→ 内核升级 + `update-grub` → `systemctl mask fwupd` + `fwupd-refresh` → 预配置 China region npm 镜像。所有修复都是落盘持久化状态（升级后的包、`/etc/systemd/system` mask symlink、`.npmrc`），新实例首次启动即生效；bake 环境无需 reboot（镜像捕获的是磁盘，不是内存态 systemd）。

**技术栈：** bash（`prepare-image.sh`，bake 时在 builder 上以 root 执行）、Node test runner + `tsx`（静态断言测试）、GitHub Actions（workflow 不变）。

**关键事实（部署 skill 2026-08 已实测验证）：**
- **systemd 8.15 + glibc 8.7 组合有 `_dl_fini` bug**：journal 出现 `Caught <ABRT>` → `Freezing execution.`，之后所有 `systemctl` 调用超时。5 台 worker 命中 4 台（worker1/worker2/ck-worker/yjz-work）；zh-work 预装 8.16 + 8.8 从未 freeze——证明升级到 8.16+8.8 即可免疫。
- **systemd 8.16 上仍会因 fwupd 触发 ABRT（08-05）**：`fwupd.service` lifecycle 处理时 systemd 自身崩溃（`Caught <ABRT>, from our own process` → `Freezing execution.`）。解法：`systemctl mask fwupd.service` 且**必须同时 mask `fwupd-refresh.service`** 并 `reset-failed`，否则 refresh timer 下一次运行把主机打成 `degraded`。worker 服务器不需要固件更新守护进程。
- **镜像可能携带损坏 dpkg file list**（"missing final newline"）：apt 直接中止，需 `printf '\n' >> /var/lib/dpkg/info/<pkg>.list` 修复。
- **China region 直连 `registry.npmjs.org` 慢/截断损坏**（`node_modules/typescript/lib/lib.es2017.string.d.ts` 被截成 2378 字节 → `TS1127 Invalid character`）：必须用 `registry.npmmirror.com`。
- **内核升级后不 `update-grub` 会仍启动旧内核**：装 `linux-generic` 后必须 `update-grub`（旧内核保留作回滚）。
- **native modules（sharp/@napi-rs/canvas/deasync）**：`prepare-image.sh` 已有 native smoke，无需改动。
- bake 环境升级 systemd 时 postinst 可能在运行中的旧 systemd 上失败（skill 记录为 "expected"）：容忍失败 + `dpkg --configure -a` 兜底 + 最小清单重试即可；镜像捕获磁盘新二进制，新实例用新版本。

**文件结构：**
- **修改：** `ops/ctyun-worker-image/prepare-image.sh` — 新增「平台加固」阶段（dpkg 修复 / systemd+glibc 升级 / 内核+grub / fwupd mask / npm mirror）+ systemd unit `NPM_CONFIG_REGISTRY`
- **修改：** `tests/worker-image-pipeline.test.ts` — 新增静态断言 `platform hardening encodes known Tianyi worker faults`
- **新增：** 本文档（方案/进度记录）

**不做（运行时部署行为，镜像管不了）：** git fetch 超时、bundle 644 权限、`reboot -f` 清 /tmp、settle period、部署脚本本身——这些继续由 `deploy-catsco-linux-agent` skill 处理。

---

## 任务清单

### 任务 1：`prepare-image.sh` 平台加固阶段

插入位置：现有 `apt-get install` 基础包之后、`id catsco-agent` 之前。

- [x] **步骤 1：dpkg 完整性修复**
  循环检测 `/var/lib/dpkg/info/*.list` 尾部缺失换行的文件并补 `\n`；随后 `dpkg --configure -a` 兜底。

- [x] **步骤 2：systemd + glibc 升级到 8.16 + 8.8**
  用 skill 验证过的命令序列 `apt-get install --only-upgrade -y systemd systemd-sysv systemd-timesyncd systemd-dev libsystemd0 libsystemd-shared libpam-systemd libnss-systemd libc6 libc-bin libc6-dev libc-dev-bin openssh-*`；失败则 `dpkg --configure -a` + 最小清单（systemd/systemd-timesyncd/libsystemd0/libc6/libc-bin）重试，均容忍失败。

- [x] **步骤 3：内核升级 + update-grub**
  `apt-get install --only-upgrade -y linux-generic linux-image-generic`；存在 `update-grub` 则执行（失败容忍）。

- [x] **步骤 4：mask fwupd + fwupd-refresh**
  `systemctl mask/stop fwupd.service fwupd-refresh.service` + `systemctl reset-failed fwupd-refresh.service`，全部失败容忍。mask 是 `/etc/systemd/system` 下的持久 symlink，随镜像固化。

- [x] **步骤 5：平台版本 echo（bake 日志审计）**
  `platform_systemd=<ver> glibc=<ver> kernel=<uname -r>` 打到 bake 日志（被 ps1 捕获到 CI 输出，不落盘）。

- [x] **步骤 6：npm mirror 预配置**
  - `/root/.npmrc`：`registry=https://registry.npmmirror.com`（root 侧，先写，无需依赖 useradd）
  - `/srv/catsco-agent/.npmrc`：同上 + `chown catsco-agent:catsco-agent`（在 `useradd` 之后写，目录已由 `--create-home` 创建）
  - systemd unit 增加 `Environment=NPM_CONFIG_REGISTRY=https://registry.npmmirror.com`（双保险，不依赖用户目录）
  - 确认 `.npmrc` 不在 `--finalize` 清理清单内（finalize 只清 `.env/.xiaoba/data/files/logs/skills` 等），随镜像保留。

### 任务 2：测试断言

- [x] **步骤 7：新增静态断言 test**（`tests/worker-image-pipeline.test.ts`）
  `platform hardening encodes known Tianyi worker faults`：断言 fwupd mask / systemd+glibc 升级命令 / dpkg 修复 / update-grub / npm mirror（`.npmrc` + `NPM_CONFIG_REGISTRY`）/ 版本 echo。集成 fake 测试不执行真实 bash，与现有 `prepare-image.sh` 断言模式一致。

### 任务 3：验证与提交

- [ ] **步骤 8：`bash -n` + 单测 + build**
  运行：`bash -n ops/ctyun-worker-image/prepare-image.sh` 与 `npx tsx --test tests/worker-image-pipeline.test.ts`（预期 10/10）；再 `npm run build` 确认无回归。

- [ ] **步骤 9：Commit 并推送 fork**
  在 `feat/ctyun-worker-image-pipeline` 分支：
  ```bash
  git add ops/ctyun-worker-image/prepare-image.sh tests/worker-image-pipeline.test.ts docs/superpowers/plans/2026-08-05-worker-image-platform-hardening.md
  git commit -m "feat(worker): harden image bake against known Tianyi platform faults"
  git push origin feat/ctyun-worker-image-pipeline
  ```

- [ ] **步骤 10：PR 等审核**
  合并前需用户确认；真实 bake 验证在合并后的 workflow（`worker-image.yml`）执行。
