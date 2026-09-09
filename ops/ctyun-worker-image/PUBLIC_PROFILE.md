# 佛山 7 公网 Worker 镜像

`worker-image.yml` 的手动输入 `deployment_profile` 可选 `private_nat` 或 `public_ip`。标签自动制镜和默认手动操作保持 `private_nat`。工作流仍只接受 `main` 和已验证的稳定版本标签。

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

配置先验证再进行云操作，同一次运行的制镜、失败清理和镜像保留均使用相同区域/项目。历史运行按部署方案筛选，原 NAT 全局变量不被改写。仍共用受保护工作流的串行并发组，临时 TOS 对象按运行标识隔离并清理。

本变更只有制镜和配置能力；工作流测试使用假云 API，不能替代首次佛山 7 制镜及实际用户部署验收。CatsCompany 的控制面配置格式见关联 PR，其 JSON 不包含此处的基础镜像和清理字段。
