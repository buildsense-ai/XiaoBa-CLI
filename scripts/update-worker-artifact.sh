#!/usr/bin/env bash
# update-worker-artifact.sh — worker 侧应用制品更新（Part A）
#
# 用法：
#   update-worker-artifact.sh --artifact FILE --sha256 HEX \
#       --version VERSION --commit SHA
#   update-worker-artifact.sh --status        # 打印当前 release_id 与 current 指向
#   update-worker-artifact.sh --rollback      # 切回上一个 release 并重启
#
# 语义：只动 /opt/catsco（release 布局），/srv/catsco-agent 数据绝不触碰。
# 流程：校验 sha256 -> 解压到新 release 目录 -> manifest 校验 -> 原生模块冒烟
#       -> 切换 current symlink -> 重启 service -> 心跳验证，失败自动切回旧版。
#
# 环境（测试可覆盖）：
#   CATSCO_UWA_ROOT            根目录（默认 /opt/catsco）
#   CATSCO_UWA_PREV_FILE       previous-release 记录（默认 /var/lib/catsco/previous-release）
#   CATSCO_UWA_SERVICE         服务名（默认 catsco-agent.service）
#   CATSCO_UWA_SETTLE_SECONDS  重启后等待秒数（默认 5）
#   CATSCO_UWA_SMOKE           原生模块冒烟开关（默认 1；=0 跳过，测试用）
set -Eeuo pipefail

ROOT="${CATSCO_UWA_ROOT:-/opt/catsco}"
RELEASES_ROOT="$ROOT/releases"
CURRENT_LINK="$ROOT/current"
PREV_FILE="${CATSCO_UWA_PREV_FILE:-/var/lib/catsco/previous-release}"
SERVICE="${CATSCO_UWA_SERVICE:-catsco-agent.service}"
SETTLE_SECONDS="${CATSCO_UWA_SETTLE_SECONDS:-5}"
SMOKE="${CATSCO_UWA_SMOKE:-1}"
JQ_BIN="${JQ_BIN:-jq}"

ARTIFACT=""
EXPECTED_SHA=""
EXPECTED_VERSION=""
EXPECTED_COMMIT=""
MODE=""

die() { echo "error: $*" >&2; exit 1; }

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --artifact) ARTIFACT="${2:-}"; MODE=update; shift 2 ;;
    --sha256) EXPECTED_SHA="${2:-}"; shift 2 ;;
    --version) EXPECTED_VERSION="${2:-}"; shift 2 ;;
    --commit) EXPECTED_COMMIT="${2:-}"; shift 2 ;;
    --status) MODE=status; shift ;;
    --rollback) MODE=rollback; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$MODE" ]] || die "no mode specified (update needs --artifact/--sha256/--version/--commit; or use --status/--rollback)"

validate_hex() { # $1=value $2=len $3=label
  local v="$1" n="$2" label="$3"
  [[ "$v" =~ ^[0-9a-fA-F]{$n}$ ]] || die "$label must be exactly $n hex characters"
}

resolve_existing_dir() {
  local target="$1"
  [[ -d "$target" ]] || return 1
  (
    cd -P "$target" || exit 1
    pwd -P
  )
}

# rollback_to switches current back to a previous release. With no valid
# previous target (first deploy), it removes the dangling link so nothing
# points at a broken release.
rollback_to() {
  local target="${1:-}" resolved_target resolved_releases_root
  resolved_target="$(resolve_existing_dir "$target" || true)"
  resolved_releases_root="$(resolve_existing_dir "$RELEASES_ROOT" || true)"
  if [[ -n "$resolved_target" && -n "$resolved_releases_root" \
        && "$resolved_target" == "$resolved_releases_root"/* \
        && -f "$resolved_target/worker-release.json" ]]; then
    ln -sfn "$target" "$CURRENT_LINK"
    systemctl restart "$SERVICE"
    return 0
  fi
  rm -f "$CURRENT_LINK"
  echo "warning: no valid previous release; removed current link" >&2
  return 1
}

if [[ "$MODE" == "status" ]]; then
  CUR="$(resolve_existing_dir "$CURRENT_LINK" || true)"
  echo "root=$ROOT"
  echo "release_id=$(basename "$CUR")"
  echo "current=${CUR:-none}"
  exit 0
fi

if [[ "$MODE" == "rollback" ]]; then
  [[ -f "$PREV_FILE" ]] || die "no previous release recorded at $PREV_FILE"
  PREV="$(tr -d '[:space:]' < "$PREV_FILE")"
  [[ -n "$PREV" ]] || die "previous release record is empty"
  if ! rollback_to "$PREV"; then
    die "cannot roll back to $PREV"
  fi
  echo "rolled back to $PREV"
  exit 0
fi

# --- update mode ---
[[ -n "$ARTIFACT" && -n "$EXPECTED_SHA" && -n "$EXPECTED_VERSION" && -n "$EXPECTED_COMMIT" ]] \
  || die "--artifact, --sha256, --version and --commit are required"
validate_hex "$EXPECTED_SHA" 64 "sha256"
validate_hex "$EXPECTED_COMMIT" 40 "commit"
[[ "$EXPECTED_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$ ]] || die "invalid version: $EXPECTED_VERSION"
[[ -f "$ARTIFACT" ]] || die "artifact not found: $ARTIFACT"

RELEASE_ID="${EXPECTED_VERSION}-${EXPECTED_COMMIT:0:8}"
RELEASE_ROOT="$RELEASES_ROOT/$RELEASE_ID"
case "$RELEASE_ROOT" in
  "$RELEASES_ROOT"/*) ;;
  *) die "release path escapes $RELEASES_ROOT" ;;
esac

# 幂等：current 已指向该 release 且 service active → skip（不重启）
CURRENT_TARGET="$(resolve_existing_dir "$CURRENT_LINK" || true)"
RELEASE_ROOT_RESOLVED="$(resolve_existing_dir "$RELEASE_ROOT" || true)"
if [[ -n "$RELEASE_ROOT_RESOLVED" && "$CURRENT_TARGET" == "$RELEASE_ROOT_RESOLVED" \
      && "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == "active" ]]; then
  echo "already up to date: $RELEASE_ID"
  exit 0
fi

# 1) checksum
ACTUAL_SHA="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
ACTUAL_SHA_NORMALIZED="$(printf '%s' "$ACTUAL_SHA" | tr '[:upper:]' '[:lower:]')"
EXPECTED_SHA_NORMALIZED="$(printf '%s' "$EXPECTED_SHA" | tr '[:upper:]' '[:lower:]')"
[[ "$ACTUAL_SHA_NORMALIZED" == "$EXPECTED_SHA_NORMALIZED" ]] \
  || die "checksum mismatch (expected ${EXPECTED_SHA}, got ${ACTUAL_SHA})"

# 2) 解压到临时目录 + manifest 校验（与 prepare-image.sh 同一布局约定）
TEMP="$(mktemp -d "${TMPDIR:-/tmp}/catsco-uwa.XXXXXX")"
trap 'rm -rf "$TEMP"' EXIT
tar -xzf "$ARTIFACT" -C "$TEMP"
[[ -f "$TEMP/app/worker-release.json" ]] || die "worker-release.json missing"
MANIFEST_VERSION="$("$JQ_BIN" -r '.version' "$TEMP/app/worker-release.json")"
MANIFEST_COMMIT="$("$JQ_BIN" -r '.commit' "$TEMP/app/worker-release.json")"
[[ "$MANIFEST_VERSION" == "$EXPECTED_VERSION" ]] \
  || die "artifact version mismatch (manifest ${MANIFEST_VERSION:-?}, expected ${EXPECTED_VERSION})"
[[ "$MANIFEST_COMMIT" == "$EXPECTED_COMMIT" ]] \
  || die "artifact commit mismatch (manifest ${MANIFEST_COMMIT:0:8}, expected ${EXPECTED_COMMIT:0:8})"

# 3) 部署到 release 目录
rm -rf -- "$RELEASE_ROOT"
mkdir -p -- "$RELEASES_ROOT"
cp -a "$TEMP/app/." "$RELEASE_ROOT/"
[[ -x "$RELEASE_ROOT/runtime/node/bin/node" ]] || die "bundled Node.js runtime missing"
[[ -x "$RELEASE_ROOT/runtime/node/bin/npm" ]] || die "bundled npm runtime missing"

# 4) 原生模块冒烟（切换前）：失败则丢弃新 release，不碰 current。
# 必须在 $RELEASE_ROOT 下运行——node -e 按 cwd 解析 node_modules，
# ssh 执行时 cwd 是登录用户目录（参考 prepare-image.sh 先 cd /opt/catsco/current）。
if [[ "$SMOKE" == "1" ]]; then
  if ! (cd "$RELEASE_ROOT" && "$RELEASE_ROOT/runtime/node/bin/node" -e 'require("sharp"); require("@napi-rs/canvas")') >/dev/null 2>&1; then
    rm -rf -- "$RELEASE_ROOT"
    die "smoke test failed; release discarded"
  fi
fi

# 5) 记录旧 current（--rollback 读取），切换 symlink，重启
OLD_TARGET="$(resolve_existing_dir "$CURRENT_LINK" || true)"
mkdir -p "$(dirname "$PREV_FILE")"
printf '%s\n' "$OLD_TARGET" > "$PREV_FILE"
# 记录重启起始时间：心跳验证只接受本次重启之后的日志（避免命中旧连接日志）。
# 用 epoch 秒（@...）而非本地时间字符串——journalctl --since 解析 @epoch 无
# 时区歧义（非 UTC 主机也不会把 UTC 当本地时间）。
SINCE="@$(date +%s)"
ln -sfn "$RELEASE_ROOT" "$CURRENT_LINK"
systemctl restart "$SERVICE"

# 6) settle + active 验证 + 心跳验证（--since 只认本次重启后），失败自动切回
sleep "$SETTLE_SECONDS"
if [[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" != "active" ]]; then
  rollback_to "$OLD_TARGET" || true
  die "service not active after update; rolled back"
fi
if ! journalctl -u "$SERVICE" --since "$SINCE" -n 100 --no-pager -o cat 2>/dev/null \
   | grep -Eq '已连接|握手成功|uid='; then
  rollback_to "$OLD_TARGET" || true
  die "heartbeat not detected after update; rolled back"
fi

echo "updated: $RELEASE_ID"
