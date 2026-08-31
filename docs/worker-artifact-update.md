# Worker 应用制品发布与更新

稳定 `vX.Y.Z` tag 自动构建桌面应用和 Linux Worker 制品，发布到私有 TOS
`update/worker/<version>/`，并触发 `.github/workflows/worker-image.yml` 自动 bake
云镜像。正常发布无需手动触发；`workflow_dispatch` 仅用于补发或故障恢复。

已有云员工由控制面获取私有制品并调用 `scripts/update-worker-artifact.sh`。更新器
只修改 `/opt/catsco/releases` 与 `/opt/catsco/current`，重启并验证服务，失败自动
回滚；`/srv/catsco-agent` 用户数据、会话、技能和凭据不受影响。

仓库不保存客户机器名、SSH 目标矩阵或客户 SSH 凭据，也没有按固定机器列表自动
分发的 CD。`scripts/deploy-worker-artifact.mjs` 仅作为运维人员显式传入
`--targets host1,host2` 的应急工具，不能省略目标，不参与正式发布。

```bash
bash update-worker-artifact.sh --status
bash update-worker-artifact.sh --rollback
```

新 worker 使用自动 bake 的完整 `catsco-worker-*` 镜像；已有 worker 使用版本化
应用制品更新；重置/重装是独立的镜像流程。
