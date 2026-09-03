#!/bin/bash
set -euo pipefail

# CatsCo Connector lightweight installer (macOS / Linux)
REPO_URL="https://github.com/buildsense-ai/XiaoBa-CLI.git"
INSTALL_DIR="${CATSCO_INSTALL_DIR:-$HOME/catsco}"
BUILD_DIR="${TMPDIR:-/tmp}/catsco-connector-build"
DASHBOARD_PORT=3800

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

print_banner() {
  echo ""; echo -e "${CYAN}  CatsCo Connector${NC}"; echo "  轻量安装程序"; echo ""
}

check_git() {
  has git && { log "Git 已安装: $(git --version)"; return; }
  warn "未检测到 Git，正在安装..."
  if has brew; then brew install git
  elif has apt-get; then sudo apt-get update && sudo apt-get install -y git
  elif has yum; then sudo yum install -y git
  else err "无法自动安装 Git，请手动安装后重试"; fi
}

check_node() {
  if has node && [ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -ge 18 ]; then
    log "Node.js 已安装: $(node -v)"; return
  fi
  warn "需要 Node.js >= 18，正在安装 Node.js 20..."
  if has brew; then brew install node@20; brew link --overwrite node@20 2>/dev/null || true
  elif has apt-get; then curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -; sudo apt-get install -y nodejs
  else err "无法自动安装 Node.js，请安装 Node.js >= 18 后重试"; fi
}

build_connector() {
  rm -rf "$BUILD_DIR"
  log "正在获取最新版 Connector 源码..."
  git clone --depth 1 --single-branch "$REPO_URL" "$BUILD_DIR"
  cd "$BUILD_DIR"
  log "正在准备临时构建环境..."
  npm ci --include=dev --no-audit --no-fund --prefer-offline --progress=false
  npm run build:connector
}

deploy_connector() {
  log "正在部署轻量 Connector..."
  local data_backup=""
  if [ -d "$INSTALL_DIR/.xiaoba" ]; then
    data_backup=$(mktemp -d)
    cp -R "$INSTALL_DIR/.xiaoba" "$data_backup/.xiaoba"
  fi
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR/dist/connector" "$INSTALL_DIR/dist/connector-dashboard" "$INSTALL_DIR/dashboard"
  cp "$BUILD_DIR/dist/connector/index.js" "$INSTALL_DIR/dist/connector/index.js"
  cp "$BUILD_DIR/dist/connector-dashboard/server.js" "$INSTALL_DIR/dist/connector-dashboard/server.js"
  cp "$BUILD_DIR/dashboard/connector.html" "$BUILD_DIR/dashboard/connector.css" "$BUILD_DIR/dashboard/connector.js" "$BUILD_DIR/dashboard/cat-icon.png" "$INSTALL_DIR/dashboard/"
  cp "$BUILD_DIR/connector-package.json" "$INSTALL_DIR/package.json"
  if [ -n "$data_backup" ]; then cp -R "$data_backup/.xiaoba" "$INSTALL_DIR/.xiaoba"; rm -rf "$data_backup"; else mkdir -p "$INSTALL_DIR/.xiaoba"; fi
  rm -rf "$BUILD_DIR"
}

create_launcher() {
  cat > "$INSTALL_DIR/start.sh" <<EOF
#!/bin/bash
set -e
cd "\$(dirname "\$0")"
echo "正在启动 CatsCo Connector..."
export XIAOBA_CONNECTOR_PACKAGE=connector-lite
export XIAOBA_APP_ROOT="$INSTALL_DIR"
export XIAOBA_USER_DATA_DIR="$INSTALL_DIR"
export XIAOBA_DASHBOARD_PORT="$DASHBOARD_PORT"
node dist/connector-dashboard/server.js &
server_pid=\$!
trap 'kill \$server_pid 2>/dev/null || true' EXIT INT TERM
sleep 2
open "http://127.0.0.1:$DASHBOARD_PORT" 2>/dev/null || xdg-open "http://127.0.0.1:$DASHBOARD_PORT" 2>/dev/null || echo "请打开 http://127.0.0.1:$DASHBOARD_PORT"
wait \$server_pid
EOF
  chmod +x "$INSTALL_DIR/start.sh"
}

main() {
  print_banner; check_git; check_node
  build_connector; deploy_connector; create_launcher
  log "安装完成；运行目录仅包含 Connector bundle 和页面"
  echo "  安装目录: $INSTALL_DIR"
  echo "  启动命令: $INSTALL_DIR/start.sh"
  read -r -p "是否现在启动 Connector？[Y/n] " reply
  if [[ ! ${reply:-} =~ ^[Nn]$ ]]; then "$INSTALL_DIR/start.sh"; fi
}

main
