#!/usr/bin/env bash
set -Eeuo pipefail

ARTIFACT=""
SHA256=""
EXPECTED_COMMIT=""
EXPECTED_VERSION=""
FINALIZE=0

usage() {
  cat <<'EOF'
Usage:
  prepare-image.sh --artifact FILE --sha256 HEX --version VERSION --commit SHA
  prepare-image.sh --finalize
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --artifact) ARTIFACT="${2:-}"; shift 2 ;;
    --sha256) SHA256="${2:-}"; shift 2 ;;
    --version) EXPECTED_VERSION="${2:-}"; shift 2 ;;
    --commit) EXPECTED_COMMIT="${2:-}"; shift 2 ;;
    --finalize) FINALIZE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Root is required in production. CATSCO_PREPARE_SKIP_ROOT_CHECK is a
# test-only hook used by the isolated probe tests (worker-image-pipeline.test.ts).
if [[ -z "${CATSCO_PREPARE_SKIP_ROOT_CHECK:-}" ]]; then
  [[ $EUID -eq 0 ]] || die "run as root"
fi

if [[ $FINALIZE -eq 1 ]]; then
  systemctl disable --now catsco-agent.service 2>/dev/null || true
  rm -rf \
    /srv/catsco-agent/.env \
    /srv/catsco-agent/.xiaoba \
    /srv/catsco-agent/data \
    /srv/catsco-agent/files \
    /srv/catsco-agent/logs \
    /srv/catsco-agent/skills \
    /root/.ssh/authorized_keys \
    /home/*/.ssh/authorized_keys \
    /tmp/catsco-* \
    /tmp/build-image.sh \
    /tmp/prepare-image.sh \
    /var/tmp/*
  find /var/log -type f -exec truncate -s 0 {} \; 2>/dev/null || true
  rm -f /etc/ssh/ssh_host_* /root/.bash_history /home/*/.bash_history
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  if command -v cloud-init >/dev/null 2>&1; then
    cloud-init clean --logs --seed
  fi
  truncate -s 0 /etc/machine-id
  rm -f /var/lib/dbus/machine-id
  sync
  printf 'image_finalized=yes\n'
  exit 0
fi

[[ -f "$ARTIFACT" ]] || die "artifact not found"
[[ "$SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || die "invalid SHA-256"
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || die "commit must be a full SHA"
[[ "$EXPECTED_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$ ]] || die "invalid version"

ACTUAL_SHA256="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
[[ "${ACTUAL_SHA256,,}" == "${SHA256,,}" ]] || die "artifact checksum mismatch"

export DEBIAN_FRONTEND=noninteractive

# --- Platform hardening (encoded from deploy-catsco-linux-agent skill, 2026-08) ---
# Every fault below was hit on live Tianyi workers provisioned from the same base
# image. Encoding the fixes here means a freshly baked worker starts healthy and
# no manual host surgery is needed after provisioning.
#
# Fail-closed policy: an upgrade that cannot reach the known-safe platform state
# must block the bake. Shipping an image that silently carries the buggy
# systemd/glibc/kernel combo is worse than failing the workflow so it can retry.

# 1. Repair corrupted dpkg file lists ("missing final newline") BEFORE any
#    apt/dpkg transaction. These images can ship broken
#    /var/lib/dpkg/info/*.list files that abort the very first apt or dpkg call
#    (e.g. dpkg-query exits 2 while a list is missing its final newline).
for list in /var/lib/dpkg/info/*.list; do
  [ -f "$list" ] && [ -s "$list" ] || continue
  if ! tail -c1 "$list" | od -An -c | tr -d ' \n' | grep -q '\\n'; then
    printf '\n' >> "$list"
  fi
done
if ! dpkg --configure -a >/tmp/catsco-dpkg-configure-first.log 2>&1; then
  die "dpkg configuration failed after file-list repair; see /tmp/catsco-dpkg-configure-first.log"
fi

apt-get update || die "apt-get update failed"
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  jq \
  poppler-utils \
  ripgrep \
  sudo \
  unzip \
  zip \
  || die "base package install failed"

# 2. Mask fwupd BEFORE upgrading systemd. On systemd 8.16, handling fwupd
#    lifecycle can crash systemd itself ("Caught <ABRT>, from our own process"
#    then "Freezing execution"). The mask is a persistent symlink in /etc, so
#    masking first means the 8.16 daemon (if the upgrade re-execs it) never has
#    to process fwupd lifecycle, and worker servers do not need a firmware
#    update daemon. Each mask is bounded by timeout (a frozen manager must not
#    hang the bake) and VERIFIED through its persistent /etc/systemd/system
#    symlink, which is independent of the running manager. A mask that did not
#    take effect blocks the bake: publishing an image that can still crash
#    systemd on fwupd lifecycle is not acceptable.
mask_unit() {
  local unit="$1"
  timeout 30 systemctl mask "$unit" >/dev/null 2>&1 || true
  if [ "$(readlink "/etc/systemd/system/$unit" 2>/dev/null || true)" != "/dev/null" ]; then
    die "failed to mask $unit (expected /etc/systemd/system/$unit -> /dev/null); refusing to bake an unhardened image"
  fi
}
mask_unit fwupd.service
mask_unit fwupd-refresh.service
mask_unit fwupd-refresh.timer
timeout 30 systemctl stop fwupd.service >/dev/null 2>&1 || true
timeout 30 systemctl stop fwupd-refresh.service >/dev/null 2>&1 || true
timeout 30 systemctl reset-failed fwupd-refresh.service >/dev/null 2>&1 || true

# 3. Upgrade systemd + glibc to the known-safe combination
#    (255.4-1ubuntu8.16 + 2.39-0ubuntu8.8). The original image shipped
#    systemd 8.15 + glibc 8.7 which triggers a _dl_fini assert that freezes
#    systemd ("Caught <ABRT> ... Freezing execution"); every systemctl call then
#    times out. postinst may fail on a running older systemd (expected), so we
#    finish dpkg configuration, retry with the minimal set, and then VERIFY the
#    installed versions with dpkg --compare-versions. Failing to reach the
#    known-safe versions blocks the bake.
if ! apt-get install --only-upgrade -y \
  systemd \
  systemd-sysv \
  systemd-timesyncd \
  systemd-dev \
  libsystemd0 \
  libsystemd-shared \
  libpam-systemd \
  libnss-systemd \
  libc6 \
  libc-bin \
  libc6-dev \
  libc-dev-bin \
  openssh-client \
  openssh-server \
  openssh-sftp-server \
  >/tmp/catsco-systemd-upgrade.log 2>&1; then
  dpkg --configure -a >/dev/null 2>&1 || true
  apt-get install --only-upgrade -y \
    systemd systemd-timesyncd libsystemd0 libc6 libc-bin \
    >/tmp/catsco-systemd-upgrade-retry.log 2>&1 || true
fi
# The final dpkg configuration must actually succeed. A version string alone is
# not enough: a half-configured package can still report the new Version while
# the image ships a broken dpkg database (review: version gate masked configure
# failures). Fail closed here. Note this also means a CLEAN postinst failure
# (as opposed to a timeout) on the running older systemd now blocks the bake
# instead of being silently tolerated — producing an image with an unconfigured
# dpkg database is not acceptable, and a hung manager is already bounded by the
# outer timeouts.
if ! dpkg --configure -a >/tmp/catsco-dpkg-configure-final.log 2>&1; then
  die "dpkg database not fully configured after platform upgrade; see /tmp/catsco-dpkg-configure-final.log"
fi

SYSTEMD_VERSION="$(dpkg-query -W -f='${Version}' systemd 2>/dev/null || true)"
GLIBC_VERSION="$(dpkg-query -W -f='${Version}' libc6 2>/dev/null || true)"
SYSTEMD_STATUS="$(dpkg-query -W -f='${db:Status-Abbrev}' systemd 2>/dev/null || true)"
GLIBC_STATUS="$(dpkg-query -W -f='${db:Status-Abbrev}' libc6 2>/dev/null || true)"
if ! dpkg --compare-versions "$SYSTEMD_VERSION" ge "255.4-1ubuntu8.16"; then
  die "systemd upgrade failed to reach known-safe version (have '$SYSTEMD_VERSION', need >= 255.4-1ubuntu8.16); see /tmp/catsco-systemd-upgrade.log"
fi
if ! dpkg --compare-versions "$GLIBC_VERSION" ge "2.39-0ubuntu8.8"; then
  die "glibc upgrade failed to reach known-safe version (have '$GLIBC_VERSION', need >= 2.39-0ubuntu8.8); see /tmp/catsco-systemd-upgrade.log"
fi
# dpkg-query prints '${db:Status-Abbrev}' with a trailing space for a healthy
# package (e.g. 'ii '), so compare whitespace-normalized values.
if [ "${SYSTEMD_STATUS//[[:space:]]/}" != "ii" ] || [ "${GLIBC_STATUS//[[:space:]]/}" != "ii" ]; then
  die "systemd/glibc are not fully configured (systemd='$SYSTEMD_STATUS' glibc='$GLIBC_STATUS'); refusing to bake an image with a broken dpkg database"
fi

# 4. Upgrade the kernel and regenerate grub. INSTALL (not --only-upgrade) the
#    meta packages: on a base image where they are absent, --only-upgrade
#    silently prints 'Skipping ... it is not installed', returns 0, and the old
#    kernel passes a naive /boot existence check. After installing, verify a
#    non-empty bootable kernel image actually exists under /boot and that grub
#    is regenerated; the running kernel is not a reliable signal because the
#    bake never reboots.
if ! apt-get install -y --no-install-recommends \
  linux-generic linux-image-generic \
  >/tmp/catsco-kernel-upgrade.log 2>&1; then
  die "kernel upgrade failed; see /tmp/catsco-kernel-upgrade.log"
fi
if ! command -v update-grub >/dev/null 2>&1 || ! update-grub >/tmp/catsco-update-grub.log 2>&1; then
  die "update-grub failed; see /tmp/catsco-update-grub.log"
fi
if ! ls -1 /boot/vmlinuz-* >/dev/null 2>&1; then
  die "no bootable kernel image found under /boot after kernel upgrade"
fi
NEWEST_KERNEL_IMG="$(ls -1 /boot/vmlinuz-* 2>/dev/null | LC_ALL=C sort -V | tail -1)"
if [ -z "$NEWEST_KERNEL_IMG" ]; then
  die "no bootable kernel image found under /boot after kernel upgrade"
fi

KERNEL_VERSION="$(uname -r 2>/dev/null || true)"
printf 'platform_systemd=%s glibc=%s kernel=%s\n' \
  "$SYSTEMD_VERSION" "$GLIBC_VERSION" "$KERNEL_VERSION"

# 5. Pre-configure the China-region npm mirror. Direct registry.npmjs.org from
#    Tianyi/华南 hosts is slow and has produced truncated/corrupted tarballs
#    (e.g. TS1127 from a truncated lib.es2017.string.d.ts). Set it for both the
#    service user and root so the first npm ci/install never needs manual setup.
printf 'registry=https://registry.npmmirror.com\n' >/root/.npmrc
chmod 0644 /root/.npmrc
id catsco-agent >/dev/null 2>&1 || useradd \
  --system \
  --create-home \
  --home-dir /srv/catsco-agent \
  --shell /bin/bash \
  catsco-agent

# Service-user npm mirror config (survives finalize; the finalize cleanup list
# deliberately keeps .npmrc so first-boot npm never needs manual setup).
mkdir -p /srv/catsco-agent
printf 'registry=https://registry.npmmirror.com\n' >/srv/catsco-agent/.npmrc
chown catsco-agent:catsco-agent /srv/catsco-agent/.npmrc
chmod 0644 /srv/catsco-agent/.npmrc

RELEASE_ID="${EXPECTED_VERSION}-${EXPECTED_COMMIT:0:8}"
RELEASES_ROOT="/opt/catsco/releases"
RELEASE_ROOT="$RELEASES_ROOT/$RELEASE_ID"
case "$RELEASE_ROOT" in
  "$RELEASES_ROOT"/*) ;;
  *) die "release path escapes $RELEASES_ROOT" ;;
esac
rm -rf -- "$RELEASE_ROOT"
mkdir -p -- "$RELEASE_ROOT" "$RELEASES_ROOT" /srv/catsco-agent

TEMP_EXTRACT="$(mktemp -d /tmp/catsco-release.XXXXXX)"
trap 'rm -rf "$TEMP_EXTRACT"' EXIT
tar -xzf "$ARTIFACT" -C "$TEMP_EXTRACT"
[[ -f "$TEMP_EXTRACT/app/worker-release.json" ]] || die "worker-release.json missing"

MANIFEST_VERSION="$(jq -r '.version' "$TEMP_EXTRACT/app/worker-release.json")"
MANIFEST_COMMIT="$(jq -r '.commit' "$TEMP_EXTRACT/app/worker-release.json")"
[[ "$MANIFEST_VERSION" == "$EXPECTED_VERSION" ]] || die "artifact version mismatch"
[[ "$MANIFEST_COMMIT" == "$EXPECTED_COMMIT" ]] || die "artifact commit mismatch"

cp -a "$TEMP_EXTRACT/app/." "$RELEASE_ROOT/"
[[ -x "$RELEASE_ROOT/runtime/node/bin/node" ]] || die "bundled Node.js runtime missing"
[[ -x "$RELEASE_ROOT/runtime/node/bin/npm" ]] || die "bundled npm runtime missing"
ln -sfn "$RELEASE_ROOT" /opt/catsco/current
chown -R root:root /opt/catsco
chown -R catsco-agent:catsco-agent /srv/catsco-agent
chmod 0755 /opt/catsco /opt/catsco/releases "$RELEASE_ROOT"

cat >/usr/local/bin/catsco-agent <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
exec /opt/catsco/current/runtime/node/bin/node /opt/catsco/current/dist/index.js "$@"
EOF
chmod 0755 /usr/local/bin/catsco-agent
ln -sfn /opt/catsco/current/runtime/node/bin/node /usr/local/bin/node
ln -sfn /opt/catsco/current/runtime/node/bin/npm /usr/local/bin/npm
ln -sfn /opt/catsco/current/runtime/node/bin/npx /usr/local/bin/npx

cat >/etc/systemd/system/catsco-agent.service <<'EOF'
[Unit]
Description=CatsCo virtual employee
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=catsco-agent
Group=catsco-agent
WorkingDirectory=/srv/catsco-agent
Environment=HOME=/srv/catsco-agent
Environment=NODE_ENV=production
Environment=XIAOBA_APP_ROOT=/opt/catsco/current
Environment=XIAOBA_USER_DATA_DIR=/srv/catsco-agent
Environment=XIAOBA_RUNTIME_ROOT=/srv/catsco-agent
Environment=XIAOBA_RUNTIME_SURFACE=catscompany
Environment=NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
EnvironmentFile=-/srv/catsco-agent/.env
ExecStart=/opt/catsco/current/runtime/node/bin/node /opt/catsco/current/dist/index.js catsco
Restart=always
RestartSec=5
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload >/dev/null 2>&1 || true
systemctl disable --now catsco-agent.service 2>/dev/null || true

sudo -u catsco-agent -- bash -c '
  cd /opt/catsco/current
  runtime/node/bin/node -e '\''require("sharp"); const canvas = require("@napi-rs/canvas"); canvas.createCanvas(2, 2); require("deasync")'\''
  runtime/node/bin/node dist/index.js --version >/dev/null
  runtime/node/bin/npm --version >/dev/null
'

dpkg-query -W -f='${Package}\t${Version}\n' | LC_ALL=C sort >/etc/catsco-image-packages.txt
chmod 0644 /etc/catsco-image-packages.txt

jq -n \
  --arg version "$EXPECTED_VERSION" \
  --arg commit "$EXPECTED_COMMIT" \
  --arg releaseId "$RELEASE_ID" \
  '{
    schemaVersion: 1,
    product: "catsco-worker",
    version: $version,
    commit: $commit,
    releaseId: $releaseId
  }' >/etc/catsco-image.json
chmod 0644 /etc/catsco-image.json

if find /opt/catsco -type f \( \
  -name '.env' \
  -o -name '.env.local' \
  -o -name 'id_rsa' \
  -o -name 'id_ed25519' \
  -o -name '*.p12' \
  -o -name '*.pfx' \
\) -print -quit | grep -q .; then
  die "secret-like files found under /opt/catsco"
fi

printf 'image_prepared=yes release_id=%s\n' "$RELEASE_ID"
