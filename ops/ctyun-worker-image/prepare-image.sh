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
[[ -n "$EXPECTED_VERSION" ]] || die "version is required"

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

id catsco-agent >/dev/null 2>&1 || useradd \
  --system \
  --create-home \
  --home-dir /srv/catsco-agent \
  --shell /bin/bash \
  catsco-agent

RELEASE_ID="${EXPECTED_VERSION}-${EXPECTED_COMMIT:0:8}"
RELEASE_ROOT="/opt/catsco/releases/$RELEASE_ID"
rm -rf "$RELEASE_ROOT"
mkdir -p "$RELEASE_ROOT" /opt/catsco/releases /srv/catsco-agent

TEMP_EXTRACT="$(mktemp -d /tmp/catsco-release.XXXXXX)"
trap 'rm -rf "$TEMP_EXTRACT"' EXIT
tar -xzf "$ARTIFACT" -C "$TEMP_EXTRACT"
[[ -f "$TEMP_EXTRACT/app/worker-release.json" ]] || die "worker-release.json missing"

MANIFEST_VERSION="$(jq -r '.version' "$TEMP_EXTRACT/app/worker-release.json")"
MANIFEST_COMMIT="$(jq -r '.commit' "$TEMP_EXTRACT/app/worker-release.json")"
[[ "$MANIFEST_VERSION" == "$EXPECTED_VERSION" ]] || die "artifact version mismatch"
[[ "$MANIFEST_COMMIT" == "$EXPECTED_COMMIT" ]] || die "artifact commit mismatch"

cp -a "$TEMP_EXTRACT/app/." "$RELEASE_ROOT/"
ln -sfn "$RELEASE_ROOT" /opt/catsco/current
chown -R root:root /opt/catsco
chown -R catsco-agent:catsco-agent /srv/catsco-agent
chmod 0755 /opt/catsco /opt/catsco/releases "$RELEASE_ROOT"

cat >/usr/local/bin/catsco-agent <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
exec /usr/bin/node /opt/catsco/current/dist/index.js "$@"
EOF
chmod 0755 /usr/local/bin/catsco-agent

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
EnvironmentFile=-/srv/catsco-agent/.env
ExecStart=/usr/bin/node /opt/catsco/current/dist/index.js catsco
Restart=always
RestartSec=5
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl disable --now catsco-agent.service 2>/dev/null || true

sudo -u catsco-agent -- bash -c '
  cd /opt/catsco/current
  node -e '\''require("sharp"); const canvas = require("@napi-rs/canvas"); canvas.createCanvas(2, 2); require("deasync")'\''
  node dist/index.js --version >/dev/null
'

cat >/etc/catsco-image.json <<EOF
{
  "schemaVersion": 1,
  "product": "catsco-worker",
  "version": "$EXPECTED_VERSION",
  "commit": "$EXPECTED_COMMIT",
  "releaseId": "$RELEASE_ID"
}
EOF
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
