#!/usr/bin/env bash
set -Eeuo pipefail

DEFAULT_XIAOBA_REPO=$(git -C "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)" remote get-url origin 2>/dev/null || true)
DEFAULT_XIAOBA_REPO=${DEFAULT_XIAOBA_REPO:-https://github.com/buildsense-ai/XiaoBa-CLI.git}

host=
ssh_user=root
ssh_port=22
identity_file=
xiaoba_repo=$DEFAULT_XIAOBA_REPO
xiaoba_branch=main
xiaoba_dir=/opt/xiaoba-cli
opencli_repo=https://github.com/CatsCo-Gauz/OpenCLI.git
opencli_dir=/opt/opencli
dashboard_port=3800
assume_yes=false
dry_run=false

usage() {
  cat <<'EOF'
Interactive Ubuntu deployment for XiaoBa Dashboard and OpenCLI.

Usage:
  scripts/deploy-ubuntu.sh [options]

Options:
  --host HOST                 SSH host or IP (prompted when omitted)
  --user USER                 SSH user; must be root (default: root)
  --ssh-port PORT             SSH port (default: 22)
  --identity-file PATH        SSH private key
  --xiaoba-repo URL           XiaoBa Git repository (default: current origin)
  --xiaoba-branch BRANCH      XiaoBa branch (default: main)
  --xiaoba-dir PATH           XiaoBa install path (default: /opt/xiaoba-cli)
  --opencli-repo URL          OpenCLI Git repository
  --opencli-dir PATH          OpenCLI install path (default: /opt/opencli)
  --dashboard-port PORT       Loopback Dashboard port (default: 3800)
  --yes                       Skip the final confirmation
  --dry-run                   Print the sanitized plan; do not contact SSH
  -h, --help                  Show this help

Security defaults:
  The Dashboard listens only on 127.0.0.1, API-key auth is disabled, and no
  Nginx is installed. Access it through the printed SSH tunnel command.
  SSH reads a password from its own hidden terminal prompt when no key is used.
  Passwords are never accepted as command-line arguments or stored by this script.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 2
}

need_value() {
  [[ $# -ge 2 && -n $2 ]] || die "$1 requires a value"
}

is_port() {
  [[ $1 =~ ^[0-9]+$ ]] && (( 1 <= 10#$1 && 10#$1 <= 65535 ))
}

shell_join() {
  local result='' item
  for item in "$@"; do
    printf -v item '%q' "$item"
    result+="${result:+ }${item}"
  done
  printf '%s' "$result"
}

while (($#)); do
  case $1 in
    --host) need_value "$@"; host=$2; shift 2 ;;
    --user) need_value "$@"; ssh_user=$2; shift 2 ;;
    --ssh-port) need_value "$@"; ssh_port=$2; shift 2 ;;
    --identity-file) need_value "$@"; identity_file=$2; shift 2 ;;
    --xiaoba-repo) need_value "$@"; xiaoba_repo=$2; shift 2 ;;
    --xiaoba-branch) need_value "$@"; xiaoba_branch=$2; shift 2 ;;
    --xiaoba-dir) need_value "$@"; xiaoba_dir=$2; shift 2 ;;
    --opencli-repo) need_value "$@"; opencli_repo=$2; shift 2 ;;
    --opencli-dir) need_value "$@"; opencli_dir=$2; shift 2 ;;
    --dashboard-port) need_value "$@"; dashboard_port=$2; shift 2 ;;
    --yes) assume_yes=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    --password|--password=*)
      printf 'Error: password values are not accepted on the command line; let SSH use its hidden prompt.\n' >&2
      exit 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

if [[ -z $host ]]; then
  [[ -t 0 ]] || die "--host is required when stdin is not interactive"
  read -r -p 'Server host or IP: ' host
fi

[[ -n $host ]] || die "host cannot be empty"
[[ $ssh_user == root ]] || die "this deployment currently requires --user root"
is_port "$ssh_port" || die "invalid SSH port: $ssh_port"
is_port "$dashboard_port" || die "invalid Dashboard port: $dashboard_port"
[[ -z $identity_file || -f $identity_file ]] || die "identity file not found: $identity_file"
[[ $xiaoba_dir == /* && $opencli_dir == /* ]] || die "install paths must be absolute"
for remote_value in "$host" "$xiaoba_repo" "$xiaoba_branch" "$xiaoba_dir" "$opencli_repo" "$opencli_dir"; do
  [[ $remote_value != *[$'\r\n\t ']* ]] || die "remote values cannot contain whitespace"
done

ssh_args=(-p "$ssh_port" -o ServerAliveInterval=30 -o ServerAliveCountMax=4)
[[ -z $identity_file ]] || ssh_args+=(-i "$identity_file")
ssh_target="${ssh_user}@${host}"
tunnel_args=(-N -L "${dashboard_port}:127.0.0.1:${dashboard_port}" -p "$ssh_port")
[[ -z $identity_file ]] || tunnel_args+=(-i "$identity_file")
tunnel_args+=("$ssh_target")

cat <<EOF
Deployment plan
  Target:          ${ssh_target}:${ssh_port}
  XiaoBa:          ${xiaoba_repo} (${xiaoba_branch}) -> ${xiaoba_dir}
  Dashboard:       127.0.0.1:${dashboard_port} (API key disabled)
  OpenCLI:         ${opencli_repo} -> ${opencli_dir}
  Browser:         Google Chrome + Chrome for Testing + Browser Bridge
  Fonts:           Noto CJK/Emoji + Fontconfig + PDF verification tools
  Reverse proxy:   none (Nginx is not used or modified)

SSH tunnel after deployment:
  $(shell_join ssh "${tunnel_args[@]}")
EOF

if $dry_run; then
  printf '\nDry run only; SSH was not contacted.\n'
  exit 0
fi

if ! $assume_yes; then
  [[ -t 0 ]] || die "use --yes when stdin is not interactive"
  read -r -p 'Continue with this deployment? [y/N] ' answer
  [[ $answer == [yY] || $answer == [yY][eE][sS] ]] || {
    printf 'Cancelled.\n'
    exit 0
  }
fi

remote_install() {
  set -Eeuo pipefail

  local xiaoba_repo=$1
  local xiaoba_branch=$2
  local xiaoba_dir=$3
  local opencli_repo=$4
  local opencli_dir=$5
  local dashboard_port=$6
  local tmp_dir mise_bin node_bin node_dir npm_bin chrome_zip_url timestamp dashboard_listeners

  log() { printf '\n==> %s\n' "$*"; }
  fail() { printf 'Deployment failed: %s\n' "$*" >&2; exit 1; }

  [[ $(id -u) -eq 0 ]] || fail "run the remote installer as root"
  command -v apt-get >/dev/null || fail "this script requires Ubuntu/Debian with apt"
  [[ $(dpkg --print-architecture) == amd64 ]] \
    || fail "Google Chrome and this Chrome for Testing workflow currently require amd64"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ ${ID:-} == ubuntu || ${ID_LIKE:-} == *debian* || ${ID:-} == debian ]] \
    || fail "unsupported OS: ${PRETTY_NAME:-unknown}"

  tmp_dir=$(mktemp -d /tmp/xiaoba-deploy.XXXXXX)
  trap 'rm -rf -- "$tmp_dir"' EXIT
  timestamp=$(date +%Y%m%d-%H%M%S)
  export DEBIAN_FRONTEND=noninteractive

  log "Installing system, font, browser, and PDF dependencies"
  apt-get update
  apt-get install -y \
    ca-certificates curl git gnupg build-essential python3 unzip xvfb iproute2 \
    fontconfig fonts-noto-cjk fonts-noto-cjk-extra fonts-noto-color-emoji \
    poppler-utils

  log "Installing mise and Node.js 22"
  mise_bin=/root/.local/bin/mise
  if [[ ! -x $mise_bin ]]; then
    curl -fsSL https://mise.run -o "$tmp_dir/mise-install.sh"
    sh "$tmp_dir/mise-install.sh"
  fi
  export PATH="/root/.local/bin:$PATH"
  "$mise_bin" install node@22
  node_bin=$("$mise_bin" which node@22)
  node_dir=$(dirname "$node_bin")
  npm_bin="$node_dir/npm"
  [[ -x $npm_bin ]] || fail "npm was not installed with Node.js 22"
  PATH="$node_dir:$PATH"
  export PATH

  log "Checking for an existing reverse proxy to the Dashboard"
  for proxy_config_dir in /etc/nginx /etc/caddy /etc/apache2; do
    [[ -d $proxy_config_dir ]] || continue
    if grep -R -Eqs "(127\\.0\\.0\\.1|localhost|\\[::1\\]):$dashboard_port" "$proxy_config_dir"; then
      fail "existing reverse-proxy config references Dashboard port $dashboard_port; remove or secure it before disabling Dashboard API auth"
    fi
  done

  update_repo() {
    local repo_url=$1 branch=$2 target=$3
    if [[ -d $target/.git ]]; then
      if ! git -C "$target" diff --quiet || ! git -C "$target" diff --cached --quiet; then
        fail "$target has tracked local changes; refusing to overwrite them"
      fi
      git -C "$target" remote set-url origin "$repo_url"
      git -C "$target" fetch --prune origin "$branch"
      git -C "$target" checkout "$branch" 2>/dev/null \
        || git -C "$target" checkout --track -b "$branch" "origin/$branch"
      git -C "$target" merge --ff-only "origin/$branch"
    elif [[ -e $target ]]; then
      fail "$target exists but is not a Git checkout"
    else
      git clone --branch "$branch" --single-branch "$repo_url" "$target"
    fi
  }

  log "Updating and building XiaoBa"
  update_repo "$xiaoba_repo" "$xiaoba_branch" "$xiaoba_dir"
  (
    cd "$xiaoba_dir"
    "$npm_bin" ci
    "$npm_bin" run build
    [[ -f .env ]] || cp .env.example .env
    if grep -Eq '^[[:space:]]*DASHBOARD_API_KEY[[:space:]]*=' .env; then
      cp .env ".env.before-dashboard-auth-disable.$timestamp"
      chmod 0600 ".env.before-dashboard-auth-disable.$timestamp"
      sed -i '/^[[:space:]]*DASHBOARD_API_KEY[[:space:]]*=/d' .env
    fi
    chmod 0600 .env
  )

  cat >/etc/systemd/system/xiaoba-dashboard.service <<EOF
[Unit]
Description=XiaoBa Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$xiaoba_dir
Environment=HOME=/root
EnvironmentFile=-$xiaoba_dir/.env
ExecStart=$node_bin $xiaoba_dir/dist/index.js dashboard --port $dashboard_port
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  log "Installing Google Chrome Stable"
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    -o "$tmp_dir/google-chrome.deb"
  apt-get install -y "$tmp_dir/google-chrome.deb"

  log "Installing Chrome for Testing"
  curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json \
    -o "$tmp_dir/chrome-versions.json"
  chrome_zip_url=$(python3 - "$tmp_dir/chrome-versions.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    data = json.load(stream)
downloads = data["channels"]["Stable"]["downloads"]["chrome"]
print(next(item["url"] for item in downloads if item["platform"] == "linux64"))
PY
)
  curl -fsSL "$chrome_zip_url" -o "$tmp_dir/chrome-linux64.zip"
  unzip -q "$tmp_dir/chrome-linux64.zip" -d "$tmp_dir/chrome-for-testing"
  if [[ -d /opt/chrome-for-testing ]]; then
    mv /opt/chrome-for-testing "/opt/chrome-for-testing.previous.$timestamp"
  fi
  mv "$tmp_dir/chrome-for-testing" /opt/chrome-for-testing

  log "Updating and building OpenCLI and Browser Bridge"
  update_repo "$opencli_repo" main "$opencli_dir"
  (
    cd "$opencli_dir"
    "$npm_bin" ci
    "$npm_bin" run build
    cd extension
    "$npm_bin" ci
    "$npm_bin" run build
  )
  cat >/usr/local/bin/opencli <<EOF
#!/usr/bin/env bash
exec "$node_bin" "$opencli_dir/dist/src/main.js" "\$@"
EOF
  chmod 0755 /usr/local/bin/opencli

  if ! id opencli >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/opencli-chrome --create-home --shell /usr/sbin/nologin opencli
  fi
  install -d -o opencli -g opencli /var/lib/opencli-chrome /var/lib/opencli-cft

  cat >/etc/systemd/system/opencli-daemon.service <<EOF
[Unit]
Description=OpenCLI daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$opencli_dir
Environment=HOME=/root
ExecStart=$node_bin $opencli_dir/dist/src/daemon.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  cat >/etc/systemd/system/opencli-chrome.service <<EOF
[Unit]
Description=OpenCLI Chrome Browser Bridge
After=network-online.target opencli-daemon.service
Wants=network-online.target

[Service]
Type=simple
User=opencli
Group=opencli
Environment=HOME=/var/lib/opencli-chrome
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1440x900x24" /opt/chrome-for-testing/chrome-linux64/chrome --no-sandbox --disable-dev-shm-usage --disable-gpu --silent-debugger-extension-api --lang=zh-CN --no-first-run --no-default-browser-check --password-store=basic --user-data-dir=/var/lib/opencli-cft --disable-extensions-except=$opencli_dir/extension --load-extension=$opencli_dir/extension about:blank
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  log "Refreshing fonts and starting services"
  fc-cache -f
  systemctl daemon-reload
  systemctl enable --now xiaoba-dashboard.service opencli-daemon.service opencli-chrome.service
  systemctl restart xiaoba-dashboard.service opencli-daemon.service opencli-chrome.service

  log "Verifying services"
  for _ in {1..30}; do
    curl -fsS "http://127.0.0.1:$dashboard_port/api/status" >"$tmp_dir/dashboard-status.json" && break
    sleep 1
  done
  python3 - "$tmp_dir/dashboard-status.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    status = json.load(stream)
if status.get("authRequired") is not False:
    raise SystemExit("Dashboard unexpectedly requires an API key")
PY
  systemctl is-active --quiet xiaoba-dashboard.service
  systemctl is-active --quiet opencli-daemon.service
  systemctl is-active --quiet opencli-chrome.service
  dashboard_listeners=$(ss -H -ltn "sport = :$dashboard_port")
  grep -Eq "(127\\.0\\.0\\.1|\\[::1\\]):$dashboard_port" <<<"$dashboard_listeners"
  if grep -Eq "(0\\.0\\.0\\.0|\\[::\\]|\\*):$dashboard_port" <<<"$dashboard_listeners"; then
    fail "Dashboard is listening on a public interface"
  fi
  for _ in {1..30}; do
    opencli doctor >/dev/null 2>&1 && break
    sleep 1
  done
  opencli doctor
  opencli browser deploy-smoke open https://example.com --window background
  opencli browser deploy-smoke state
  opencli browser deploy-smoke close

  fc-match ':lang=zh-cn:family=sans-serif' | grep -q 'Noto.*CJK'
  cat >"$tmp_dir/chinese-font-check.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<style>
  body { font-family: sans-serif; }
  .serif { font-family: serif; }
</style>
<p>中文字体检查：系统与浏览器使用思源字形。</p>
<p class="serif">中文 PDF 嵌入检查。</p>
HTML
  timeout 60 /opt/chrome-for-testing/chrome-linux64/chrome \
    --headless=new --no-sandbox --disable-gpu \
    --user-data-dir="$tmp_dir/pdf-profile" \
    --print-to-pdf="$tmp_dir/chinese-font-check.pdf" \
    "file://$tmp_dir/chinese-font-check.html"
  pdffonts "$tmp_dir/chinese-font-check.pdf" | grep -q 'Noto.*CJK'
  pdftotext "$tmp_dir/chinese-font-check.pdf" "$tmp_dir/chinese-font-check.txt"
  grep -q '中文字体检查' "$tmp_dir/chinese-font-check.txt"

  log "Deployment complete"
  printf 'XiaoBa SHA: %s\n' "$(git -C "$xiaoba_dir" rev-parse HEAD)"
  printf 'OpenCLI SHA: %s\n' "$(git -C "$opencli_dir" rev-parse HEAD)"
  printf 'Dashboard: http://127.0.0.1:%s (SSH tunnel required)\n' "$dashboard_port"
}

remote_source=$(declare -f remote_install)
printf '%s\nremote_install "$@"\n' "$remote_source" |
  ssh "${ssh_args[@]}" "$ssh_target" bash -s -- \
    "$xiaoba_repo" "$xiaoba_branch" "$xiaoba_dir" \
    "$opencli_repo" "$opencli_dir" "$dashboard_port"

printf '\nDeployment finished. Open the tunnel in another terminal:\n  %s\n' \
  "$(shell_join ssh "${tunnel_args[@]}")"
