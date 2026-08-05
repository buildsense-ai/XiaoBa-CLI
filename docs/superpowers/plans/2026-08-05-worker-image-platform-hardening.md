# Worker 镜像平台加固（2026-08）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

## 当前状态（2026-08-05）

- **分支/head：** `feat/ctyun-worker-image-pipeline` @ `5c83dc8`（已 rebase 到 `upstream/main` `dc22252` 之上，相对 main 22 commits）
- **CI：** 最新一次全绿（Build and runtime tests + cross-repo smoke）
- **Review：** 已完成 5 轮处理并回复（自查 / c3811yyds / Nobody-ly 4 项 / atridaisuki 4 项 / 子 agent 独立审核），当前**等复审**；合并前需用户确认
- **测试：** `worker-image-pipeline.test.ts` 11/11、加固探针 7 场景、全量 `npm test`（唯一失败为已知 pre-existing flaky `logger.test.ts`，与改动无关）、`npm run build` 通过
- **下一步：** reviewer 复审 → 合并 → workflow 真实 bake 验证（见步骤 10 验收标准）
- **关联计划：** 应用制品更新 Part A 见 `2026-08-04-worker-artifact-update.md`（worker 更新通道与镜像烘焙并存，互为回退）

**目标：** 把 `deploy-catsco-linux-agent` 部署 skill 在 2026-08 踩过的平台故障固化进 `ops/ctyun-worker-image/prepare-image.sh`，让新 bake 的 worker 镜像自带免疫——新 worker 从镜像启动即健康，手动部署不再需要逐台升级 systemd/glibc、mask fwupd、修复 dpkg、配置 npm 镜像、更新 grub。

**架构：** bake 时（临时 builder 上、制作镜像捕获磁盘状态前）执行一段「平台加固」，**最终形态（含 4 轮 review 演进）**：dpkg 完整性修复（**前置到任何 apt 事务之前**）→ `mask_unit()` 验证 fwupd + fwupd-refresh + timer 的持久 symlink（失败 `die`）→ systemd+glibc 升级到已知安全组合（255.4-1ubuntu8.16 + 2.39-0ubuntu8.8）并做**最低版本断言**（不达标 `die`）→ 内核**安装**（非 only-upgrade）+ `update-grub` + `/boot` 最新 vmlinuz 校验 → 预配置 China region npm 镜像（`/root` + 服务用户 `.npmrc` + unit `NPM_CONFIG_REGISTRY`）。所有修复都是落盘持久化状态，新实例首次启动即生效；bake 环境无需 reboot（镜像捕获的是磁盘，不是内存态 systemd）。**fail-closed 原则**：任何无法达到已知安全平台状态的升级/掩码必须阻断 bake——产出坏镜像比 workflow 失败重试更糟。清理侧：builder/key pair 删除要求连续空读证明（发现 3 次、确认 2 次），Cleanup 模式保持 fail-closed（可证明归属才删）。

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

## 后续改进项（Follow-ups，不阻塞合入）

- **发现阶段 3 次空读无直接测试场景**：Remove-Builder/Remove-KeyPair 的连续空读发现逻辑只在确认阶段有测试覆盖；构造"builder ID 存在但查询为空"场景成本高，防御性逻辑，后续补。
- **`/boot` 校验的 `NEWEST_KERNEL_IMG` 变量是死代码**：非空性已被前置 `ls -1 /boot/vmlinuz-*` 保证，可删除或改为与升级前内核版本做真实比较。
- **`Invoke-ExactBakeCleanup` key pair 单次读**与 Remove-* 的 3 次空读不对称（最终一致性风险低，因 Cleanup 运行在中断后较久），后续可对齐。
- **Cleanup 长期 fail-closed 的计费残留**（用户决策保持）：可后续做"持久化 immutable 资源 ID 后安全按 ID 删除"，替代纯 fail-closed。
- **探针测试硬编码 Git Bash 路径**：无 Git Bash 的 Windows 环境会以难懂错误失败（Linux/macOS 回退 `bash` 正常），后续可探测更稳。

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

- [x] **步骤 5d：atridaisuki 复核 4 项（2026-08-05 06:23，CHANGES_REQUESTED）**
  - **P1 fwupd mask 失败被吞 → 已修**：`mask_unit()` 用 `timeout 30` 包裹 `systemctl mask`（冻结 manager 不再挂起 bake），并**通过持久 symlink 验证**（`readlink /etc/systemd/system/<unit>` 必须指向 `/dev/null`），失败 `die` 拒绝发布未加固镜像。新增探针 7（readlink 返回空 → `failed to mask`）。
  - **P1 内核升级成功假象 → 已修**：`--only-upgrade` 改为 `apt-get install -y`（元包缺失时会真正安装而非 `Skipping` 返回 0）；`/boot` 校验改为"最新 vmlinuz 存在 + 显式 `ls` 检查"（防止旧内核通过）。
  - **P2 Cleanup 漏检只剩 key pair → 已修**：`Invoke-ExactBakeCleanup` 现在按精确 `KeyPairName` 查询 key pair，存在则计入 fail-closed 报告（不再 `nothing-to-clean` 静默漏检）。
  - **P2 单次空响应不能证明删除 → 已修**：`Remove-Builder`/`Remove-KeyPair` 发现阶段要求**连续 3 次空读**才认为资源不存在（非 WaitForLate），删除确认阶段要求**连续 2 次空读**才返回成功（最终一致性防护）。
  - 验证：7 个探针全过、`worker-image-pipeline.test.ts` **11/11 通过**（集成测试 timeout 提到 120s 容纳新增等待）、build 通过。中途遇到本地 `node_modules` 不完整（切分支后 `.bin` 空 + 缺包），`npm ci` 恢复后复测通过。

- [x] **步骤 5e：复测 + 子 agent 独立审核（2026-08-05）**
  - 全量 `npm test`：唯一失败为**已知 pre-existing flaky** `logger.test.ts`（单独跑 1/1 通过，与 #290/#291 同源，与本次改动无关）。
  - 子 agent 独立审核 `d5cd34e`：**可合入**，无 Critical/Important。突变验证确认 probe 7（mask）与 kernel 静态断言真实覆盖回归；`mask_unit` timeout+readlink 设计（冻结 manager 不挂起、持久 symlink 校验独立于运行中 manager）与连续空读终止性均验证无误。
  - 补测（Minor #4a）：新增 **key-pair-only Cleanup 场景**（进程在 `ImportEcsKeypair` 后被 kill、只剩 key pair）——断言 `Automatic historical cleanup refused` + `candidate keyPairName=...` 且不删除。消除修复③无直接测试覆盖的盲区。
  - 记录的后续项：发现阶段 3 次空读无直接场景覆盖（防御性逻辑，确认阶段已有覆盖）；`/boot` 校验的 `NEWEST_KERNEL_IMG` 变量为死代码（非空性已被前置 `ls` 保证）。

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

- [ ] **步骤 10：PR 等审核 + 真实 bake 验收**
  合并前需用户确认。合并后触发 `worker-image.yml`（手动 `workflow_dispatch` 勾选 `bake_image` 或打 `vX.Y.Z` tag 且 `CTYUN_AUTO_BAKE_WORKER_IMAGE=true`）。

  **验收标准（bake 日志 + 新 worker 实例）：**
  1. bake 日志出现 `platform_systemd=255.4-1ubuntu8.16+ glibc=2.39-0ubuntu8.8+ kernel=...` 且最终 `image_prepared=yes`（任一版本不达标 bake 会失败）
  2. 从镜像开一台临时 worker 验证：`readlink /etc/systemd/system/fwupd.service` = `/dev/null`（fwupd/refresh/timer 均 masked）、`systemctl is-system-running` = `running`（无 freeze）
  3. `/srv/catsco-agent/.npmrc` 与 `/root/.npmrc` 存在且含 `registry.npmmirror.com`；`systemctl cat catsco-agent.service` 含 `NPM_CONFIG_REGISTRY`
  4. `/etc/catsco-image-packages.txt` 记录 systemd/glibc/kernel 版本；`/boot/vmlinuz-*` 存在最新内核
  5. 镜像内 `catsco-agent.service` 为 disabled（首次供给由控制面启用）；无临时 key pair/builder 残留（`ecs GetEcsKeypairDetails` 查询 `catsco-img-key-*` 为空）
  6. 确认后删除验证用临时实例，避免计费残留
