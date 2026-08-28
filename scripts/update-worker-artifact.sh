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
FREE_MARGIN_BYTES="${CATSCO_UWA_FREE_MARGIN_BYTES:-67108864}"

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

# rollback_to switches current back to a previous release. With no valid
# previous target (first deploy), it removes the dangling link so nothing
# points at a broken release.
rollback_to() {
  local target="${1:-}"
  if [[ -n "$target" && "$target" == "$RELEASES_ROOT"/* && -f "$target/worker-release.json" ]]; then
    ln -sfn "$target" "$CURRENT_LINK"
    systemctl restart "$SERVICE"
    return 0
  fi
  rm -f "$CURRENT_LINK"
  echo "warning: no valid previous release; removed current link" >&2
  return 1
}

if [[ "$MODE" == "status" ]]; then
  CUR="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
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
COMPLETE_MARKER="$RELEASE_ROOT/.catsco-release-complete"
case "$RELEASE_ROOT" in
  "$RELEASES_ROOT"/*) ;;
  *) die "release path escapes $RELEASES_ROOT" ;;
esac

# 幂等：只有带完整安装标记的 release 才允许复用。旧安装中断时可能已经
# 写入 worker-release.json，但目录里的其他文件仍是截断或缺失状态。
CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
if [[ "$CURRENT_TARGET" == "$RELEASE_ROOT" \
      && -f "$COMPLETE_MARKER" \
      && "$("$JQ_BIN" -r '.version // ""' "$COMPLETE_MARKER" 2>/dev/null || true)" == "$EXPECTED_VERSION" \
      && "$("$JQ_BIN" -r '.commit // ""' "$COMPLETE_MARKER" 2>/dev/null || true)" == "$EXPECTED_COMMIT" \
      && "$("$JQ_BIN" -r '.sha256 // ""' "$COMPLETE_MARKER" 2>/dev/null || true)" == "${EXPECTED_SHA,,}" \
      && "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == "active" ]]; then
  echo "already up to date: $RELEASE_ID"
  exit 0
fi

# 1) checksum
ACTUAL_SHA="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
[[ "${ACTUAL_SHA,,}" == "${EXPECTED_SHA,,}" ]] \
  || die "checksum mismatch (expected ${EXPECTED_SHA}, got ${ACTUAL_SHA})"

# 2) 在 releases 同一文件系统中预检空间并解压到 staging。这样最终发布只需
# 原子 rename，不会再把一个半写入目录暴露成可复用 release。
[[ "$FREE_MARGIN_BYTES" =~ ^[0-9]+$ ]] || die "CATSCO_UWA_FREE_MARGIN_BYTES must be a non-negative integer"
mkdir -p -- "$RELEASES_ROOT"
ARCHIVE_BYTES="$(gzip -l "$ARTIFACT" | awk 'END {print $2}')"
[[ "$ARCHIVE_BYTES" =~ ^[0-9]+$ && "$ARCHIVE_BYTES" -gt 0 ]] \
  || die "cannot determine uncompressed artifact size"
AVAILABLE_KIB="$(df -Pk "$RELEASES_ROOT" | awk 'END {print $4}')"
[[ "$AVAILABLE_KIB" =~ ^[0-9]+$ ]] || die "cannot determine release filesystem free space"
AVAILABLE_BYTES=$((AVAILABLE_KIB * 1024))
REQUIRED_BYTES=$((ARCHIVE_BYTES + FREE_MARGIN_BYTES))
(( AVAILABLE_BYTES >= REQUIRED_BYTES )) \
  || die "insufficient disk space for atomic update (required=${REQUIRED_BYTES}, available=${AVAILABLE_BYTES})"

TEMP="$(mktemp -d "$RELEASES_ROOT/.staging-${RELEASE_ID}.XXXXXX")"
REPLACED_ROOT="$RELEASES_ROOT/.replaced-${RELEASE_ID}.$$"
cleanup_update() {
  # If interruption happens between moving an old release aside and exposing
  # the validated tree, put the old path back. Once the new complete tree is
  # present, the replaced (normally incomplete) tree is safe to discard.
  if [[ -e "$REPLACED_ROOT" && ! -e "$RELEASE_ROOT" ]]; then
    mv -- "$REPLACED_ROOT" "$RELEASE_ROOT" || true
  fi
  rm -rf -- "$TEMP"
  if [[ -e "$REPLACED_ROOT" && -f "$RELEASE_ROOT/.catsco-release-complete" ]]; then
    rm -rf -- "$REPLACED_ROOT"
  fi
}
trap cleanup_update EXIT
tar -xzf "$ARTIFACT" -C "$TEMP"
[[ -f "$TEMP/app/worker-release.json" ]] || die "worker-release.json missing"
MANIFEST_VERSION="$("$JQ_BIN" -r '.version' "$TEMP/app/worker-release.json")"
MANIFEST_COMMIT="$("$JQ_BIN" -r '.commit' "$TEMP/app/worker-release.json")"
[[ "$MANIFEST_VERSION" == "$EXPECTED_VERSION" ]] \
  || die "artifact version mismatch (manifest ${MANIFEST_VERSION:-?}, expected ${EXPECTED_VERSION})"
[[ "$MANIFEST_COMMIT" == "$EXPECTED_COMMIT" ]] \
  || die "artifact commit mismatch (manifest ${MANIFEST_COMMIT:0:8}, expected ${EXPECTED_COMMIT:0:8})"

# 3) 验证 staging。应用以 catsco-agent 用户运行，发布树内的普通文件和目录
# 必须允许非 root 用户读取/遍历；否则 root 下的冒烟会产生假阳性。
STAGED_ROOT="$TEMP/app"
[[ -x "$STAGED_ROOT/runtime/node/bin/node" ]] || die "bundled Node.js runtime missing"
[[ -x "$STAGED_ROOT/runtime/node/bin/npm" ]] || die "bundled npm runtime missing"
UNREADABLE_FILE="$(find "$STAGED_ROOT" -type f ! -perm -004 -print -quit)"
[[ -z "$UNREADABLE_FILE" ]] || die "release contains a file unreadable by the service user: ${UNREADABLE_FILE#$STAGED_ROOT/}"
UNTRAVERSABLE_DIR="$(find "$STAGED_ROOT" -type d ! -perm -001 -print -quit)"
[[ -z "$UNTRAVERSABLE_DIR" ]] || die "release contains a directory not traversable by the service user: ${UNTRAVERSABLE_DIR#$STAGED_ROOT/}"

# 4) 原生模块冒烟（切换前）：失败则丢弃新 release，不碰 current。
# 必须在 $RELEASE_ROOT 下运行——node -e 按 cwd 解析 node_modules，
# ssh 执行时 cwd 是登录用户目录（参考 prepare-image.sh 先 cd /opt/catsco/current）。
if [[ "$SMOKE" == "1" ]]; then
  if ! (cd "$STAGED_ROOT" && "$STAGED_ROOT/runtime/node/bin/node" -e 'require("sharp"); require("@napi-rs/canvas")') >/dev/null 2>&1; then
    die "smoke test failed; release discarded"
  fi
fi

# 完成标记是控制面复用本地 release 的唯一凭据。先在 staging 内落盘，再
# 将完整目录换入最终路径；任何更早的失败都只会留下可安全清理的 .staging。
printf '{"schemaVersion":1,"version":"%s","commit":"%s","sha256":"%s"}\n' \
  "$EXPECTED_VERSION" "$EXPECTED_COMMIT" "${EXPECTED_SHA,,}" > "$STAGED_ROOT/.catsco-release-complete"

if [[ -e "$RELEASE_ROOT" ]]; then
  mv -- "$RELEASE_ROOT" "$REPLACED_ROOT"
fi
# STAGED_ROOT and RELEASE_ROOT are on the same filesystem. A directory rename
# keeps the validated tree intact and ensures current can never resolve into
# the temporary staging hierarchy. If the rename fails, restore the old tree.
if ! mv -- "$STAGED_ROOT" "$RELEASE_ROOT"; then
  if [[ -e "$RELEASE_ROOT" ]]; then rm -rf -- "$RELEASE_ROOT"; fi
  if [[ -e "$REPLACED_ROOT" ]]; then
    mv -- "$REPLACED_ROOT" "$RELEASE_ROOT" || true
  fi
  die "failed to install release files"
fi
rm -rf -- "$REPLACED_ROOT"

# 5) 记录旧 current（--rollback 读取），切换 symlink，重启
OLD_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
mkdir -p "$(dirname "$PREV_FILE")"
printf '%s\n' "$OLD_TARGET" > "$PREV_FILE"
# 记录重启起始时间：心跳验证只接受本次重启之后的日志（避免命中旧连接日志）。
# 用 epoch 秒（@...）而非本地时间字符串——journalctl --since 解析 @epoch 无
# 时区歧义（非 UTC 主机也不会把 UTC 当本地时间）。
SINCE="@$(date +%s)"
# Keep the link relative to ROOT so it can never retain a staging path if the
# release tree is moved or the host's path translation rules normalize it.
ln -sfn "releases/$RELEASE_ID" "$CURRENT_LINK"
[[ "$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)" == "$RELEASE_ROOT" ]] \
  || { rm -f "$CURRENT_LINK"; die "current link does not resolve to installed release"; }
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
