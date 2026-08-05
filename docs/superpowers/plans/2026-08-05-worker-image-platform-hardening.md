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

- [x] **步骤 5b：review 修复（2026-08-05，requesting-code-review 自查）**
  - fwupd mask 段**前置到 systemd 升级之前**：mask 是落盘 symlink 不依赖版本；若 systemd 升级 postinst 把 daemon re-exec 到 8.16，先 mask 可保证 8.16 daemon 无需处理 fwupd lifecycle（避免 ABRT freeze 路径）。
  - 额外 `systemctl mask fwupd-refresh.timer`（防止 timer 周期性触发已 mask 的 service 留下 failed 记录）。
  - `/srv/catsco-agent/.npmrc` 写入前加 `mkdir -p /srv/catsco-agent`（防御 base 镜像预建用户而 home 缺失时 `set -e` 中断 bake）。
  - `systemctl daemon-reload` 加 `|| true`（freeze 场景下不再挂起中断 bake；unit 已落盘，新实例启动自动加载）。
  - 测试断言改为匹配实现而非注释（`od -An -c` / `printf '\n' >>`），并新增 `fwupd-refresh.timer` mask 断言。

- [x] **步骤 5c：Nobody-ly 复核 4 项（2026-08-05 04:00，head 284662c）**
  - **High 平台升级 fail-open → 已修**：systemd/glibc 升级最终失败不再静默——用 `dpkg --compare-versions` 做**最低版本断言**（systemd ≥ 255.4-1ubuntu8.16、glibc ≥ 2.39-0ubuntu8.8），不达标 `die`；kernel 升级、`update-grub` 失败也 `die`；`/boot/vmlinuz-*` 存在性检查。升级命令失败 → dpkg configure → 最小清单重试 → 版本断言裁决（postinst 失败 tolerated，版本达标即通过）。
  - **Medium dpkg 修复顺序过晚 → 已修**：dpkg file-list 修复 + 首次 `dpkg --configure -a` **移到任何 apt/dpkg 事务之前**（`apt-get update` 前）。
  - **High cleanup 不删除已发现资源 → 保持 fail-closed（用户决策）**：`Invoke-ExactBakeCleanup` 无 immutable ID 证明时抛错不删，避免误删；在 review 回复中说明这是有意的 fail-closed 权衡（rerun/reconcile 回收）。
  - **Medium pending 恢复保留 key pair → 已修**：`Complete-PendingPublishedImage` 置 `KeyPairCreateAttempted=$true`，靠 pending bake marker + key pair 唯一临时名证明归属后按名清理；两个 pending 恢复场景断言更新为删除 key pair（`keyExists=false`）。Cleanup 模式仍 fail-closed（不删）。
  - **测试证据补强（回应"测试不够充分"）**：新增**真实执行探针测试** `platform hardening fails closed and runs dpkg repair before apt`——隔离环境 mock `sha256sum/apt-get/dpkg/dpkg-query/systemctl/ls/uname/update-grub`（Git Bash + MSYS 路径 + wrapper + `CATSCO_PREPARE_SKIP_ROOT_CHECK` 钩子），六个探针：①systemd 升级失败+版本旧 → 非 0 退出含 `systemd upgrade failed to reach known-safe version`；②glibc 版本不达标 → 含 `glibc upgrade failed to reach known-safe version`（两个断言独立验证）；③全成功 → 首次 `dpkg --configure` 在 `apt-get update` 前且无任何加固错误；④kernel 升级失败 → `kernel upgrade failed`；⑤`update-grub` 失败 → `update-grub failed`；⑥`/boot/vmlinuz-*` 缺失 → `no bootable kernel image`。
  - **子代理全面核查（2026-08-05，独立复测）**：生产代码无 Critical/Important；发现并修复 2 个测试盲区——mock `dpkg` 计数器拆分 systemd/glibc 断言（避免 glibc 兜住 systemd 回归）、probe-3 mock `ls` 让 happy path 真跑通 + 补 kernel/grub/boot 三个失败探针（原来零行为覆盖）。全量 `npm test` **1383 tests / 0 fail**。
  - **CI Linux 失败修复（2026-08-05，head 6dbada6）**：探针测试在 Linux runner 失败——wrapper `exec` 直接执行 `prepare-image.sh`，而 git 检出文件默认无 +x（Linux 严格执行 exec bit，Windows 忽略所以本地过了）。修复：wrapper 改 `exec bash <script>` + mock 命令 `chmod 755`。CI 重跑后应全绿。

- [x] **步骤 6：npm mirror 预配置**
  - `/root/.npmrc`：`registry=https://registry.npmmirror.com`（root 侧，先写，无需依赖 useradd）
  - `/srv/catsco-agent/.npmrc`：同上 + `chown catsco-agent:catsco-agent`（在 `useradd` 之后写，目录已由 `--create-home` 创建）
  - systemd unit 增加 `Environment=NPM_CONFIG_REGISTRY=https://registry.npmmirror.com`（双保险，不依赖用户目录）
  - 确认 `.npmrc` 不在 `--finalize` 清理清单内（finalize 只清 `.env/.xiaoba/data/files/logs/skills` 等），随镜像保留。

### 任务 2：测试断言

- [x] **步骤 7：新增静态断言 test**（`tests/worker-image-pipeline.test.ts`）
  `platform hardening encodes known Tianyi worker faults`：断言 fwupd mask / systemd+glibc 升级命令 / dpkg 修复 / update-grub / npm mirror（`.npmrc` + `NPM_CONFIG_REGISTRY`）/ 版本 echo。集成 fake 测试不执行真实 bash，与现有 `prepare-image.sh` 断言模式一致。

### 任务 3：验证与提交

- [x] **步骤 8：`bash -n` + 单测 + build**
  运行：`bash -n ops/ctyun-worker-image/prepare-image.sh`（通过）、`npx tsx --test tests/worker-image-pipeline.test.ts`（10/10 通过，含 review 修复后的断言）、`npm run build`（通过，无回归）。

- [x] **步骤 9：Commit 并推送 fork**
  在 `feat/ctyun-worker-image-pipeline` 分支：
  ```bash
  git add ops/ctyun-worker-image/prepare-image.sh tests/worker-image-pipeline.test.ts docs/superpowers/plans/2026-08-05-worker-image-platform-hardening.md
  git commit -m "feat(worker): harden image bake against known Tianyi platform faults"
  git push origin feat/ctyun-worker-image-pipeline
  ```

- [ ] **步骤 10：PR 等审核**
  合并前需用户确认；真实 bake 验证在合并后的 workflow（`worker-image.yml`）执行。
