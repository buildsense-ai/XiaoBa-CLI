# 应用制品自动更新（Part A: XiaoBa-CLI 侧）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让已有虚拟员工（worker）通过"应用制品"（`npm run worker:artifact` 产出的确定性 tar.gz）更新应用层，不切系统盘、不动 `/srv/catsco-agent` 数据，支持校验、冒烟、自动回滚，可由 CI/控制面触发。

**架构：** CI（打 tag）构建应用制品 → 分发到 worker → worker 侧脚本校验 sha256/manifest → 解压到 `/opt/catsco/releases/<ver>-<sha>`（新目录，旧版本保留）→ 原生模块冒烟 → 切换 `/opt/catsco/current` 符号链接 → 重启 `catsco-agent.service` → 心跳验证，失败自动切回旧 symlink。数据目录 `/srv/catsco-agent` 全程不触碰。

**技术栈：** bash（worker 侧脚本）、TypeScript/Node（分发脚本与测试）、GitHub Actions、复用 `build-linux-worker-artifact.mjs` 与 `ops/ctyun-worker-image/prepare-image.sh` 的 release 目录约定（`/opt/catsco/releases/<version>-<8位commit>` + `/opt/catsco/current`）。

**关联计划：** Part B（cats-company 控制面：新开云员工按钮、版本检查、更新确认与执行）见 `E:\work\cats\cats-company\docs\superpowers\plans\2026-08-04-worker-control-plane.md`。本计划只交付 worker 侧更新能力与分发通道，控制面在 Part B 调用。

**关键事实（实现前已核实）：**
- 制品已存在：`scripts/build-linux-worker-artifact.mjs`（确定性 tar：`--sort=name --mtime=@commitEpoch --owner=0`，捆绑 Node 22.23.1，产 `worker-release.json` + `.sha256`）。
- release 布局约定（与镜像烘焙一致）：`/opt/catsco/releases/<version>-<shortCommit>/`，`/opt/catsco/current -> 活动版本`；`/srv/catsco-agent` 为数据根，绝不修改。
- 现有部署走 `deploy-catsco-linux-agent` skill 的 `update-linux-agent.sh`（git pull + build + restart）；本计划新增"制品更新"通道，二者并存，互为回退。
- 目标矩阵（SSH alias → worktree/数据）：worker1/worker2（`/srv/catsco-agent`）、ck-work-hn2/zh-work/yjz-work（worktree `/srv/catsco-agent/app`，数据 `/srv/catsco-agent`）。制品更新统一只动 `/opt/catsco/releases` + `/opt/catsco/current` + service，不碰数据。

---

## 文件结构

**创建：**
- `scripts/update-worker-artifact.sh` — worker 侧应用制品更新脚本（校验/解压/冒烟/切链接/重启/回滚/幂等）
- `scripts/deploy-worker-artifact.mjs` — 分发器：本地或 CI 环境持有制品与 SSH 通道，逐台串行部署+验证
- `.github/workflows/worker-app-update.yml` — 打 tag 后构建制品并分发到 worker（受仓库变量 kill switch 控制）
- `tests/update-worker-artifact.test.ts` — worker 侧脚本行为测试（临时目录模拟 release 结构，真实执行 bash）
- `tests/deploy-worker-artifact.test.ts` — 分发器测试（fake 目标/制品/校验）
- `docs/worker-artifact-update.md` — 运维说明（触发方式、回滚、安全边界）

**修改：**
- `package.json` — 新增 `worker:update:dry` 等 npm script（可选，便于本地演练）
- `ops/ctyun-worker-image/README.md` — 补充"已有 worker 更新走应用制品"与镜像关系说明

---

### 任务 1：worker 侧更新脚本 `scripts/update-worker-artifact.sh`

**文件：**
- 创建：`scripts/update-worker-artifact.sh`
- 测试：`tests/update-worker-artifact.test.ts`

**脚本契约（与 `prepare-image.sh` 的 release 布局保持一致）：**

```
用法：
  update-worker-artifact.sh --artifact FILE --sha256 HEX \
      --version VERSION --commit SHA
  update-worker-artifact.sh --status        # 打印当前 releaseId + current 指向
  update-worker-artifact.sh --rollback      # 切回上一个 release 并重启
```

- [ ] **步骤 1：编写失败的测试**（`tests/update-worker-artifact.test.ts`，用 Node test runner + `tsx --test`；在临时目录创建 fake `/opt/catsco` 结构，真实调用 bash 脚本，断言行为）

```ts
import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'node:child_process';

function runScript(args: string[], env: Record<string, string>): string {
  const script = path.resolve('scripts/update-worker-artifact.sh');
  return execFileSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

test('refuses to start when artifact checksum does not match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uwa-'));
  try {
    const artifact = path.join(root, 'bad.tar.gz');
    fs.writeFileSync(artifact, 'corrupt');
    assert.throws(() => runScript(
      ['--artifact', artifact, '--sha256', '0'.repeat(64), '--version', '1.4.8', '--commit', 'a'.repeat(40)],
      { CATSCO_UWA_ROOT: root },
    ), /checksum mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx tsx --test tests/update-worker-artifact.test.ts`
预期：FAIL（脚本不存在 / 不通过校验）

- [ ] **步骤 3：编写脚本骨架 + 参数校验**

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
# ... 解析 --artifact/--sha256/--version/--commit/--status/--rollback ...
# 允许通过 CATSCO_UWA_ROOT 覆盖根目录（测试用），默认 /opt/catsco
```

关键校验：`$SHA256` 必须 64 位 hex；`$EXPECTED_COMMIT` 必须 40 位 hex；`$EXPECTED_VERSION` 匹配 `^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$`；`RELEASE_ROOT` 必须在 `$RELEASES_ROOT` 下（防穿越，同 `prepare-image.sh` 的 `case` 守卫）。

- [ ] **步骤 4：实现"校验 + 解压到新 release 目录 + 冒烟"**

```bash
ACTUAL_SHA256="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
[[ "${ACTUAL_SHA256,,}" == "${SHA256,,}" ]] || die "checksum mismatch"
RELEASE_ROOT="$RELEASES_ROOT/$RELEASE_ID"
case "$RELEASE_ROOT" in "$RELEASES_ROOT"/*) ;; *) die "release path escapes";; esac
rm -rf -- "$RELEASE_ROOT"; mkdir -p -- "$RELEASE_ROOT"
TEMP="$(mktemp -d)"; trap 'rm -rf "$TEMP"' EXIT
tar -xzf "$ARTIFACT" -C "$TEMP"
[[ -f "$TEMP/app/worker-release.json" ]] || die "worker-release.json missing"
# 校验 manifest version/commit
# 复制 app 到 RELEASE_ROOT；校验捆绑 node/npm 可执行
# 原生模块冒烟：node -e 'require("sharp"); require("@napi-rs/canvas")...'
```

- [ ] **步骤 5：实现"切换 symlink + 重启 + 心跳验证 + 失败回滚"**

```bash
# 记录旧 current（用于回滚），并持久化到 /var/lib/catsco/previous-release（--rollback 读取用）
CURRENT_LINK="$ROOT/current"
OLD_TARGET="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
mkdir -p /var/lib/catsco
echo "$OLD_TARGET" > /var/lib/catsco/previous-release
ln -sfn "$RELEASE_ROOT" "$CURRENT_LINK"
systemctl restart catsco-agent.service
# settle：等 5s 后再次确认 active（重复 systemctl is-active，避免启动瞬间误判）
# 心跳验证：journalctl -u catsco-agent.service -n 60 --no-pager -o cat
#   | grep -E '已连接|握手成功|uid='（任一即视为已连上；容忍历史告警，只认重启后的新记录）
# 验证失败 -> 读 /var/lib/catsco/previous-release 切回 + systemctl restart + 报错
```

- [ ] **步骤 6：实现 `--status` 与 `--rollback`**

`--status`：打印 `release_id=<version>-<shortCommit>` 与 `current=...`；`--rollback`：读取 `/var/lib/catsco/previous-release` 指向的 release，校验其 `worker-release.json` 存在后切换重启（记录文件缺失或目标非法则报错，不猜测）。

- [ ] **步骤 7：补测试覆盖**

新增测试：成功更新（新 release 目录创建、current 指向新、数据目录 `$CATSCO_UWA_ROOT/srv` 未被触碰）；幂等（同版本已 active 且 current 指向则跳过）；回滚（冒烟失败后 current 指回旧）；`--status` 输出正确。

- [ ] **步骤 8：`bash -n` + 全量测试**

运行：`bash -n scripts/update-worker-artifact.sh` 与 `npx tsx --test tests/update-worker-artifact.test.ts`；再 `npm test` 确认无回归。
预期：全绿。

- [ ] **步骤 9：Commit**

```bash
git add scripts/update-worker-artifact.sh tests/update-worker-artifact.test.ts
git commit -m "feat(worker): apply application artifact updates with validation and rollback"
```

---

### 任务 2：分发器 `scripts/deploy-worker-artifact.mjs`

**文件：**
- 创建：`scripts/deploy-worker-artifact.mjs`
- 测试：`tests/deploy-worker-artifact.test.ts`

**职责：** 运维机/CI 持有制品 + SSH 通道，把制品逐台部署到目标 worker：scp 制品与脚本 → 每台执行 `update-worker-artifact.sh` → 逐台串行、单台失败可回滚或中止后续。

- [ ] **步骤 1：编写失败的测试**（fake 目标：用本地临时目录模拟远端，`--dry-run` 模式不真正 ssh）

```ts
test('deploys artifact to each target serially and reports per-target result', () => {
  // 构造 2 个 fake target（本地临时目录），调用 deploy（注入 fake runner）
  // 断言：两 target 都被部署；结果含 commit/version；失败 target 被标记
});
```

- [ ] **步骤 2：运行确认失败**

运行：`npx tsx --test tests/deploy-worker-artifact.test.ts`；预期 FAIL。

- [ ] **步骤 3：实现 CLI 与目标矩阵**

```ts
// --artifact FILE --sha256 HEX --version V --commit SHA --targets worker1,worker2,...
// 未指定 targets 时读默认矩阵（与 deploy skill 一致）：
const DEFAULT_TARGETS = [
  { alias: 'worker1',     worktree: '/srv/catsco-agent' },        // data=/srv/catsco-agent
  { alias: 'worker2',     worktree: '/srv/catsco-agent' },
  { alias: 'ck-work-hn2', worktree: '/srv/catsco-agent/app' },    // data=/srv/catsco-agent
  { alias: 'zh-work',     worktree: '/srv/catsco-agent/app' },
  { alias: 'yjz-work',    worktree: '/srv/catsco-agent/app' },
];
// 注意：worker 侧更新脚本只操作 /opt/catsco（release 布局），与 worktree 解耦；
// worktree 仅用于 --status 校验"当前 git commit"（可选信息，不参与更新）。
```

- [ ] **步骤 4：实现逐台部署（串行 + 验证 + 回滚）**

```ts
// 对每个 target：
//  1) scp artifact + update-worker-artifact.sh 到 /tmp（唯一名）
//  2) ssh 执行脚本（--expected-* 校验）
//  3) 验证：systemctl is-active + 日志含握手/uid/model（bounded）
//  4) 失败 -> 该台 ssh --rollback，记录失败，继续下一台（或按 --abort-on-failure 中止）
// 每台成功才进入下一台；结束后清理远端 /tmp 临时文件
```

- [ ] **步骤 5：补测试**

覆盖：校验失败中止该台并回滚；跳过已是最新版本的 target（`--status` 比对）；清理临时文件断言。

- [ ] **步骤 6：`npm run build` + 全量测试**

运行：`npm run build`、`npx tsx --test tests/deploy-worker-artifact.test.ts`、`npm test`；预期全绿。

- [ ] **步骤 7：Commit**

```bash
git add scripts/deploy-worker-artifact.mjs tests/deploy-worker-artifact.test.ts
git commit -m "feat(worker): serial artifact deployment across worker targets"
```

---

### 任务 3：CI 自动构建 + 分发（`.github/workflows/worker-app-update.yml`）

**文件：**
- 创建：`.github/workflows/worker-app-update.yml`
- 测试：`tests/worker-app-update-workflow.test.ts`（复用 worker-image-pipeline.test.ts 的 workflow 校验模式：yaml 存在、trigger 限制、权限最小化、secret 引用不硬编码）

- [ ] **步骤 1：编写失败测试**（断言 workflow 关键约束）

```ts
test('worker app update workflow is gated by stable tag and kill-switch variable', () => {
  // 读取 yaml：on.push.tags 含 "v*"；job if 引用 vars.CTYUN_WORKER_APP_UPDATE == 'true'；
  // 不含明文 secret；permissions 最小
});
```

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：编写 workflow**

```yaml
name: Update Worker Application Artifacts
on:
  push:
    tags: ["v*"]
  workflow_dispatch:
    inputs:
      update_workers: { type: boolean, default: false }
permissions: { contents: read, actions: read }
concurrency: { group: worker-app-update, cancel-in-progress: false }
jobs:
  build-and-deploy:
    if: >-
      (github.event_name == 'workflow_dispatch' && inputs.update_workers && github.ref == 'refs/heads/main') ||
      (startsWith(github.ref, 'refs/tags/') && vars.CTYUN_WORKER_APP_UPDATE == 'true')
    runs-on: ubuntu-24.04
    environment: release-prod
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262  # fetch-depth: 0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020  # node 22.23.1
      - run: npm ci --prefer-offline --no-audit --fund=false
      - run: npm run worker:artifact          # 产出 release/worker/*.tar.gz + .sha256
      - run: node scripts/deploy-worker-artifact.mjs --artifact <path> --sha256 <hex> --version <v> --commit <sha>
        env:  # 通过 repo secret 注入 SSH 凭据（仅 names，不硬编码）
          WORKER_SSH_KEY: ${{ secrets.WORKER_SSH_KEY }}
```

- [ ] **步骤 4：测试通过 + 校验**

运行 workflow 校验测试 + `actionlint`（如可用）；确认无明文 secret、权限最小。

- [ ] **步骤 5：Commit**

```bash
git add .github/workflows/worker-app-update.yml tests/worker-app-update-workflow.test.ts
git commit -m "ci(worker): gate worker app artifact updates behind stable tags and a kill switch"
```

---

### 任务 4：文档与收尾

**文件：**
- 创建：`docs/worker-artifact-update.md`
- 修改：`ops/ctyun-worker-image/README.md`

- [ ] **步骤 1：写 `docs/worker-artifact-update.md`**：触发方式（打 tag + `CTYUN_WORKER_APP_UPDATE=true` / 手动 workflow_dispatch / 本地 `node scripts/deploy-worker-artifact.mjs ...`）；安全边界（只动 `/opt/catsco` 与 service，数据 `/srv/catsco-agent` 不碰；worker 无云凭据）；回滚（`--rollback` 或旧 symlink）；与镜像的关系（新 worker 用完整镜像，老 worker 用制品更新）。
- [ ] **步骤 2：改 `ops/ctyun-worker-image/README.md`**：补充"已有 worker 更新 = 应用制品（Part A），新 worker = 完整镜像"的章节说明。
- [ ] **步骤 3：全量测试 + 清理**

运行：`npm test`（全绿）；确认无临时文件残留（worktree/临时目录）。

- [ ] **步骤 4：Commit**

```bash
git add docs/worker-artifact-update.md ops/ctyun-worker-image/README.md
git commit -m "docs(worker): document application artifact update flow and safety boundary"
```

---

## 验收清单

- [ ] worker 侧脚本：校验 sha256/manifest、防穿越、幂等、冒烟、切链接、重启、失败回滚、`--status`/`--rollback`
- [ ] 分发器：串行、逐台验证、失败回滚、清理远端临时文件、支持 dry-run 测试
- [ ] CI：打 tag 自动构建+分发、kill switch 变量、权限最小、无明文 secret
- [ ] 数据目录 `/srv/catsco-agent` 在更新全流程中零改动（测试断言）
- [ ] 全量测试 0 失败；文档就绪
- [ ] 与 Part B 接口对齐：`deploy-worker-artifact.mjs` 可被控制面以子进程/HTTP 方式触发（Part B 计划引用本计划的脚本契约）
