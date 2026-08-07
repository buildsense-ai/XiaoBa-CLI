# Worker 云端控制与镜像生命周期（2026-08）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

## 当前状态（2026-08-07）

- **已完成：** 镜像 bake 闭环（v1.4.8 成功 + 六条验收通过，见 `2026-08-05-worker-image-platform-hardening.md` 步骤 10）；worker 镜像产出可用。
- **本计划目标：** 把云虚拟员工（worker）的**创建 / 版本展示 / 回滚 / 重置**统一到**控制面 web（"云托管"入口）**，并完善**镜像生命周期**（保留 N 个、bake 后自动清理、部署/控制面取最新镜像）。
- **用户当前思路（2026-08-07 确认）：**
  1. 控制面 web 界面放在「**云托管**」按钮这里（截图：AI 助手管理对话框的"自托管 / 云托管"选项，云托管 → 云虚拟员工管理），**所有云虚拟员工的界面配置控制集中在此**。
  2. **私有镜像保留 6 个**（`catsco-worker-*`），**bake 成功后自动触发清理**旧镜像。
  3. 虚拟员工**显示版本**；有历史镜像可选时支持**镜像回滚**。
  4. web 按钮带「**可创建云虚拟员工次数**」配额——有剩余次数就能点按钮触发创建，后端跑脚本（复用现有 bake/供给流程）。**配额用环境变量控制**（谁能开、开几个），**初始值 0**。
  5. **重置**是**针对单个服务器上的那个虚拟员工**，用户一般**一个一个**重置（非批量）。
  6. **Part A（应用制品更新 / 有数据回滚）** 作为后续项（已有 plan：`2026-08-04-worker-artifact-update.md`），本计划聚焦控制面 + 镜像生命周期。
  7. **「回滚」与「重置」两个动作都提供，且必须在 UI 与文档中写清楚分开**：回滚=保留数据（制品切版本）；重置=重装镜像（数据全丢）。

**技术栈：** XiaoBa-CLI 侧（脚本、镜像生命周期）、cats-company 侧（控制面 web / 云托管）、GitHub Actions（bake 后自动清理）、复用 `New-CatsCoWorkerImage.ps1` 与 `deploy-catsco-linux-agent` 部署约定。

**跨仓库：** 控制面 web 在 `E:\work\cats\cats-company`（Part B），XiaoBa-CLI 提供脚本能力（镜像生命周期、resolve 最新镜像、重置/回滚脚本）。跨组件调试需两仓库联查。

---

## 模块 A：镜像生命周期管理（XiaoBa-CLI 侧）

**目标：** 私有 `catsco-worker-*` 镜像**最多保留 6 个**；bake 成功后自动清理更旧的；提供"取最新镜像"能力供部署/控制面使用；支持列出历史镜像供回滚选择。

### A1. 镜像保留与自动清理
- [ ] **步骤 A1-1：清理逻辑设计**
  - 在 bake **成功后**（result=created/reused/recovered 后）自动触发 `Invoke-CleanupOldWorkerImages`（幂等，可独立调用）。
  - 规则：列出私有镜像 `catsco-worker-*`（`ims ListImage --imageVisibilityCode 0`），按 `createdTime` 排序，**保留最新 6 个**，删除更旧的。
  - **安全（fail-closed）**：只删名称以 `catsco-worker-` 开头且带 `bake` label 的镜像；删除前连续空读确认；删除失败聚合报告（沿用 `Invoke-ExactBakeCleanup` 模式）。
  - 触发：bake workflow 成功步骤后调用；也支持独立 `workflow_dispatch` / 本地命令。
- [ ] **步骤 A1-2：测试**
  - fake `ims ListImage/DeleteImage` 支持多镜像排序；场景：6 个内不删、第 7 个起删最旧、删除失败 fail-closed 报告。
- [ ] **步骤 A1-3：实现 + 验证**
  - `New-CatsCoWorkerImage.ps1` 新增 `Invoke-CleanupOldWorkerImages`（或独立 `ops/ctyun-worker-image/cleanup-old-images.ps1`）；`worker-image.yml` 成功路径接入；`npm run build` + 测试全绿。

### A2. 部署/控制面取最新镜像
- [ ] **步骤 A2-1：`resolve-latest-worker-image` 脚本**
  - 列出 `catsco-worker-*` 私有镜像，按 `labels.bake`/`createdTime` 取最新（即最后 bake 的），输出 `imageID`。
  - 部署脚本 / 控制面（Part B）用它创建新 worker。
- [ ] **步骤 A2-2：历史镜像列表（供回滚选择）**
  - 提供 `list-worker-images` 输出 `imageID / version / commit / createdTime`，控制面据此展示"镜像回滚"可选列表（保留 6 个内的历史镜像）。

---

## 模块 B：控制面 web（cats-company 侧，Part B）

**目标：** 在「云托管」入口提供云虚拟员工的统一管理界面：创建（带配额）、版本展示、镜像回滚、单个重置。

- [ ] **步骤 B-1：云托管入口与员工列表**
  - 「AI 助手管理」对话框的「云托管」选项 → 云虚拟员工管理页：列出所有云虚拟员工（名称、状态、**版本**、镜像、创建时间）。
- [ ] **步骤 B-2：创建配额（环境变量控制，初始 0）**
  - 「可创建云虚拟员工次数」由**环境变量**控制（例如服务端 `CATSCO_WORKER_CREATE_QUOTA=<user>=<n>,...` 或按账号维度；具体变量名实现时定），**初始值 0**（未配置即不可创建）。
  - 配额展示在按钮上；有剩余 → 按钮可点，触发创建（后端调脚本：resolve 最新镜像 → 起实例 → 初始化供给）；无剩余 → 置灰并提示剩余 0。
  - 创建成功扣减次数；失败不扣（或扣减策略实现时明确）。
- [ ] **步骤 B-3：版本展示**
  - 每个员工显示当前版本（来自镜像 label `version`/`commit` / 运行状态）。
- [ ] **步骤 B-3a：「回滚」= 保留数据（制品切版本，走 Part A）**
  - 语义：**数据保留**，把应用切回上一个/历史 release 版本（`update-worker-artifact.sh --rollback`，Part A）。
  - UI 明确标注「回滚（保留数据）」；仅当目标 worker 已接入制品通道时可用（否则置灰/提示）。
- [ ] **步骤 B-3b：「重置 / 重装」= 丢弃数据（销毁重建到镜像）**
  - 语义：**数据全部丢失**，销毁该 worker 云实例 → 从所选历史镜像（A2-2 列表）或最新镜像重建 → 初始化供给。
  - UI 明确标注「重置 / 重装（丢弃数据，不可恢复）」+ **强二次确认**（输入确认文案）。
  - 用户逐个操作单个 worker。
  - ⚠️ **两个动作在 UI 和文档中严格分开**（不同入口/不同警示色/不同确认文案），防止误触。

---

## 模块 C：Part A 应用制品更新（有数据回滚）—— 后续项

- 已有完整 plan：`2026-08-04-worker-artifact-update.md`（`update-worker-artifact.sh --rollback` 保留 `/srv/catsco-agent` 数据）。
- 本计划不重复实现；完成后控制面"有数据回滚"与"镜像回滚"并存：制品回滚（快，保留数据）/ 镜像回滚（重装）。

---

## 关键决策（已确认 / 待确认）

- ✅ 镜像保留 **6 个**；bake 成功后自动清理。
- ✅ 重置为**单 worker** 逐个操作（强确认）。
- ✅ 控制面入口为「云托管」按钮，含创建配额。
- ✅ **回滚与重置两个动作都提供并写清楚分开**：「回滚」=保留数据（Part A 制品切版本）；「重置/重装」=丢弃数据（销毁重建到镜像）。
- ✅ **创建配额用环境变量控制，初始 0**（未配置即不可创建）。
- ✅ **协作规则：文档更新可直推 main；代码改动一律走 PR，不用 admin 权限合并。**
- ❓ bake 自动清理失败时是否阻塞/告警（建议：清理失败仅告警，不阻塞镜像产出）。

## 依赖与顺序

1. **模块 A**（XiaoBa-CLI：清理 + resolve）→ 独立可交付，先行。
2. **模块 B**（控制面）→ 依赖 A2（取最新/列历史镜像）。
3. **模块 C**（Part A）→ 后续，独立。
