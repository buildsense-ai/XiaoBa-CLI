#!/bin/bash
# CatsCompany 服务监控脚本

echo "=== CatsCompany 服务状态 $(date) ==="

# 1. 容器状态
echo -e "\n[容器状态]"
docker ps --filter "name=catscompany" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# 2. 资源使用
echo -e "\n[资源使用]"
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" \
  catscompany-server catscompany-mysql catscompany-nginx

# 3. WebSocket 连接数
echo -e "\n[WebSocket 连接]"
ONLINE=$(docker logs catscompany-server --tail 100 2>&1 | grep "online users:" | tail -1 | grep -oP 'online users: \K\d+' || echo "0")
echo "当前在线用户: $ONLINE"

# 4. 最近错误
echo -e "\n[最近错误 (最近10条)]"
docker logs catscompany-server --tail 200 2>&1 | grep -iE "error|panic|fatal" | tail -10

# 5. 数据库连接
echo -e "\n[数据库状态]"
docker exec catscompany-mysql mysqladmin -u openchat -popenchat ping 2>/dev/null && echo "✓ 数据库正常" || echo "✗ 数据库异常"

# 6. 磁盘空间
echo -e "\n[磁盘空间]"
df -h / | tail -1

echo -e "\n=== 监控完成 ==="
