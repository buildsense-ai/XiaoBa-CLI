#!/bin/bash
# Check cloud server status

CLOUD_NAME="$1"
CLOUD_HOST="$2"
CLOUD_PASS="$3"

if [ -z "$CLOUD_PASS" ]; then
  # SSH key auth
  ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no "$CLOUD_HOST" "
    echo '=== $CLOUD_NAME ==='
    echo 'Disk:'
    df -h / | tail -1
    echo ''
    echo 'Memory:'
    free -h | grep Mem
    echo ''
    echo 'Containers:'
    docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || echo 'Docker not available'
  "
else
  # Password auth
  expect -c "
    spawn ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no $CLOUD_HOST {
      echo '=== $CLOUD_NAME ==='
      echo 'Disk:'
      df -h / | tail -1
      echo ''
      echo 'Memory:'
      free -h | grep Mem
      echo ''
      echo 'Containers:'
      docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || echo 'Docker not available'
    }
    expect \"password:\"
    send \"$CLOUD_PASS\r\"
    expect eof
  " 2>/dev/null
fi
