# 佛山 7 公网 Worker 镜像

`worker-image.yml` 在启用 `CTYUN_AUTO_BAKE_WORKER_IMAGE=true` 时，稳定版本标签自动分别制作华南 2 和佛山 7 镜像。手动输入 `deployment_profile` 默认 `all`（两地），也可选 `private_nat` 或 `public_ip` 单独补跑。工作流仍只接受 `main` 和已验证的稳定版本标签。

在 `release-prod` 环境设置非敏感变量 `CTYUN_PUBLIC_WORKER_PROFILE_JSON`，字段为：

```json
{
  "CTYUN_WORKER_REGION_ID": "200000004421",
  "CTYUN_WORKER_PROJECT_ID": "<builder-project-id>",
  "CTYUN_IMAGE_PROJECT_ID": "<image-project-id>",
  "CTYUN_WORKER_AZ_NAME": "cn-gd-fos7-1a-public-citycloud",
  "CTYUN_WORKER_BASE_IMAGE_ID": "<Ubuntu-24.04-public-image-id>",
  "CTYUN_WORKER_FLAVOR_ID": "<flavor-id>",
  "CTYUN_WORKER_VPC_ID": "<vpc-id>",
  "CTYUN_WORKER_SUBNET_ID": "<subnet-id>",
  "CTYUN_WORKER_SECURITY_GROUP_ID": "<security-group-id>",
  "CTYUN_WORKER_BASE_IMAGE_HARDENED": "false",
  "CTYUN_WORKER_PROTECTED_IMAGE_IDS": ""
}
```

第一轮使用干净的 Ubuntu 公共镜像，不能选择带历史工作身份的业务镜像。`BASE_IMAGE_HARDENED` 首轮为 false；首次制镜后，把已验收及回滚镜像加入该方案自己的保护名单。保护名单为空时仍拒绝清理旧镜像。

公网制镜机显式申请公网 IPv4 和带宽，用于出网读取短期签名制品与状态地址；过程仍无须入站 SSH。镜像硬化关闭密码和交互式 SSH 认证，终结阶段移除制镜机身份，正式供给时由控制面为每台机器注入独立密钥。

配置先验证再进行云操作，同一次运行的制镜、失败清理和镜像保留均使用相同区域/项目。两地矩阵 job 独立执行，一地失败不会取消另一地；不同工作流运行仍串行排队。历史清理同时核对运行方案与对应地域 job 的结果，不根据另一地域的成功跳过失败清理。原 NAT 全局变量不被改写。

TOS 通用应用制品不需要按天翼云资源池复制永久副本：两地都从广州桶的公开 HTTPS 端点读取短期签名地址，华南 2 经既有 NAT 出网、佛山 7 经独立 EIP 出网。GitHub runner 仍先上传香港暂存桶，再等待复制至广州。临时应用包、制镜脚本和状态回传分别使用 `update/worker/.bake/<run>/<attempt>/<profile>/`，并只清理各自精确对象，避免并行 job 覆盖心跳或删除另一地正在读取的文件。永久 Worker 发布桶及桌面端更新桶保持原用途。

两个地域保留各自镜像 ID、保护名单和镜像保留策略。共同源码和应用版本不表示镜像 ID 可跨地域使用；不依赖已实测不支持的跨资源池镜像复制接口。整体工作流只有两地均成功才算双地域制镜成功，单地补跑也必须核对另一地对应源码版本。

本变更只有制镜和配置能力；工作流测试使用假云 API，不能替代首次佛山 7 制镜及实际用户部署验收。CatsCompany 的控制面配置格式见关联 PR，其 JSON 不包含此处的基础镜像和清理字段。
