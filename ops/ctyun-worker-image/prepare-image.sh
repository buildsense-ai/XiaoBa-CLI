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

[[ $EUID -eq 0 ]] || die "run as root"

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
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  jq \
  poppler-utils \
  ripgrep \
  sudo \
  unzip \
  zip

# --- Platform hardening (encoded from deploy-catsco-linux-agent skill, 2026-08) ---
# Every fault below was hit on live Tianyi workers provisioned from the same base
# image. Encoding the fixes here means a freshly baked worker starts healthy and
# no manual host surgery is needed after provisioning.

# 1. Repair corrupted dpkg file lists ("missing final newline"). These images can
#    ship broken /var/lib/dpkg/info/*.list files that abort later apt commands.
for list in /var/lib/dpkg/info/*.list; do
  [ -f "$list" ] && [ -s "$list" ] || continue
  if ! tail -c1 "$list" | od -An -c | tr -d ' \n' | grep -q '\\n'; then
    printf '\n' >> "$list"
  fi
done
dpkg --configure -a >/dev/null 2>&1 || true

# 2. Mask fwupd BEFORE upgrading systemd. On systemd 8.16, handling fwupd
#    lifecycle can crash systemd itself ("Caught <ABRT>, from our own process"
#    then "Freezing execution"). The mask is a persistent symlink in /etc, so
#    masking first means the 8.16 daemon (if the upgrade re-execs it) never has
#    to process fwupd lifecycle, and worker servers do not need a firmware
#    update daemon.
systemctl mask fwupd.service >/dev/null 2>&1 || true
systemctl stop fwupd.service >/dev/null 2>&1 || true
systemctl mask fwupd-refresh.service >/dev/null 2>&1 || true
systemctl stop fwupd-refresh.service >/dev/null 2>&1 || true
systemctl mask fwupd-refresh.timer >/dev/null 2>&1 || true
systemctl reset-failed fwupd-refresh.service >/dev/null 2>&1 || true

# 3. Upgrade systemd + glibc to the known-safe combination
#    (255.4-1ubuntu8.16 + 2.39-0ubuntu8.8). The original image shipped
#    systemd 8.15 + glibc 8.7 which triggers a _dl_fini assert that freezes
#    systemd ("Caught <ABRT> ... Freezing execution"); every systemctl call then
#    times out. postinst may fail on a running older systemd (expected), so we
#    tolerate it, finish dpkg configuration, and retry with the minimal set.
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
dpkg --configure -a >/dev/null 2>&1 || true

# 4. Upgrade the kernel and regenerate grub. A new kernel without update-grub can
#    still boot the old one, and old kernels are retained for rollback.
apt-get install --only-upgrade -y \
  linux-generic linux-image-generic \
  >/tmp/catsco-kernel-upgrade.log 2>&1 || true
if command -v update-grub >/dev/null 2>&1; then
  update-grub >/dev/null 2>&1 || true
fi

SYSTEMD_VERSION="$(dpkg-query -W -f='${Version}' systemd 2>/dev/null || true)"
GLIBC_VERSION="$(dpkg-query -W -f='${Version}' libc6 2>/dev/null || true)"
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
