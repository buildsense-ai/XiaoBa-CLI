#!/bin/bash
# CatsCompany 数据库自动备份脚本

BACKUP_DIR="/root/catscompany-backups"
DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="catscompany-db-${DATE}.sql.gz"

mkdir -p $BACKUP_DIR

# 备份数据库
docker exec catscompany-mysql mysqldump -u openchat -popenchat openchat | gzip > "${BACKUP_DIR}/${BACKUP_FILE}"

# 只保留最近7天的备份
find $BACKUP_DIR -name "catscompany-db-*.sql.gz" -mtime +7 -delete

echo "Backup completed: ${BACKUP_FILE}"
