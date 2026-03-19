#!/bin/bash
set -e

# ============================================
#  XiaoBa 一键安装脚本 (macOS / Linux)
# ============================================

REPO_URL="https://github.com/buildsense-ai/XiaoBa-CLI.git"
INSTALL_DIR="$HOME/xiaoba"
DASHBOARD_PORT=3800

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

print_banner() {
  echo ""
  echo -e "${CYAN}"
  echo "  ██╗  ██╗██╗ █████╗  ██████╗ ██████╗  █████╗"
  echo "  ╚██╗██╔╝██║██╔══██╗██╔═══██╗██╔══██╗██╔══██╗"
  echo "   ╚███╔╝ ██║███████║██║   ██║██████╔╝███████║"
  echo "   ██╔██╗ ██║██╔══██║██║   ██║██╔══██╗██╔══██║"
  echo "  ██╔╝ ██╗██║██║  ██║╚██████╔╝██████╔╝██║  ██║"
  echo "  ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝"
  echo -e "${NC}"
  echo "  一键安装程序"
  echo ""
}

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# 检查命令是否存在
has() { command -v "$1" &>/dev/null; }

# ---- 检查 Git ----
check_git() {
  if has git; then
    log "Git 已安装: $(git --version)"
  else
    warn "未检测到 Git，正在安装..."
    if has brew; then
      brew install git
    elif has apt-get; then
      sudo apt-get update && sudo apt-get install -y git
    elif has yum; then
      sudo yum install -y git
    else
      err "无法自动安装 Git，请手动安装后重试"
    fi
    log "Git 安装完成"
  fi
}

# ---- 检查 Node.js ----
check_node() {
  if has node; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -ge 18 ]; then
      log "Node.js 已安装: $(node -v)"
      return
    else
      warn "Node.js 版本过低 ($(node -v))，需要 >= 18"
    fi
  else
    warn "未检测到 Node.js"
  fi

  echo ""
  echo "正在安装 Node.js 20..."

  if has brew; then
    brew install node@20
    brew link --overwrite node@20 2>/dev/null || true
  elif has apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    # 使用 nvm
    if ! has nvm; then
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    fi
    nvm install 20
    nvm use 20
  fi

  log "Node.js 安装完成: $(node -v)"
}

# ---- 检查 Python3 (可选，用于 skill 的 python 依赖) ----
check_python() {
  if has python3; then
    log "Python3 已安装: $(python3 --version)"
  else
    warn "未检测到 Python3（部分 skill 需要），建议稍后安装"
  fi
}

# ---- 克隆/更新仓库 ----
setup_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    log "检测到已有安装，正在更新..."
    cd "$INSTALL_DIR"
    git pull --ff-only || warn "更新失败，使用现有版本继续"
  else
    log "正在下载 XiaoBa..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
}

# ---- 安装依赖 ----
install_deps() {
  log "正在安装依赖..."
  npm install --no-audit --no-fund 2>&1 | tail -1
  log "依赖安装完成"
}

# ---- 构建 ----
build_project() {
  log "正在构建..."
  npm run build 2>&1 | tail -1
  log "构建完成"
}

# ---- 初始化配置 ----
init_config() {
  if [ ! -f "$INSTALL_DIR/.env" ]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    log "已创建 .env 配置文件（请在 Dashboard 中配置 API Key）"
  else
    log ".env 配置文件已存在"
  fi
}

# ---- 创建启动脚本 ----
create_launcher() {
  LAUNCHER="$INSTALL_DIR/start.sh"
  cat > "$LAUNCHER" << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
echo "正在启动 XiaoBa Dashboard..."
npx tsx src/index.ts dashboard &
sleep 2
open "http://localhost:3800" 2>/dev/null || xdg-open "http://localhost:3800" 2>/dev/null || echo "请打开浏览器访问 http://localhost:3800"
wait
EOF
  chmod +x "$LAUNCHER"
  log "启动脚本已创建: $LAUNCHER"
}

# ---- 主流程 ----
main() {
  print_banner

  check_git
  check_node
  check_python
  echo ""

  setup_repo
  install_deps
  build_project
  init_config
  create_launcher

  echo ""
  echo -e "${GREEN}════════════════════════════════════════${NC}"
  echo -e "${GREEN}  XiaoBa 安装完成！${NC}"
  echo -e "${GREEN}════════════════════════════════════════${NC}"
  echo ""
  echo "  安装目录: $INSTALL_DIR"
  echo "  启动命令: $INSTALL_DIR/start.sh"
  echo "  Dashboard: http://localhost:$DASHBOARD_PORT"
  echo ""

  read -p "是否现在启动 Dashboard？[Y/n] " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    cd "$INSTALL_DIR"
    bash start.sh
  fi
}

main
