# Worker 应用制品更新计划（已被当前发布链路取代）

本计划的早期实现已经完成，但其中的固定机器 SSH 矩阵和 GitHub Actions 分发器
不再适用于动态云员工架构。保留本文件作为历史索引，避免把过时的客户机器名或
目标列表继续当成运维契约。

当前契约：

- 稳定 `vX.Y.Z` tag 由 `release.yml` 自动构建桌面应用和 Linux Worker 制品；
- 制品发布到私有 TOS 的 `update/worker/<version>/`；
- `worker-image.yml` 自动 bake 包含新版本的云镜像；
- 已有云员工由 CatsCompany 控制面按版本获取制品，并调用
  `scripts/update-worker-artifact.sh` 完成校验、切换、重启和自动回滚；
- XiaoBa 仓库不保存客户机器名、SSH 目标矩阵或客户凭据；
- `scripts/deploy-worker-artifact.mjs` 仅作为显式指定目标的人工应急工具，不能
  省略 `--targets`，也不属于正式 CD。

旧实现中的固定目标、kill switch 和自动 SSH 分发工作流均已移除。需要调整正式
发布链路时，以 `docs/worker-artifact-update.md`、`release.yml` 和
`worker-image.yml` 为准。
