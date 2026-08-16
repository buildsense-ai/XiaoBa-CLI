#!/usr/bin/env bash
set -Eeuo pipefail

service_name="xiaoba-dashboard.service"
restart_service=0
dry_run=0

usage() {
  cat <<'EOF'
Usage: install-root-runtime-override.sh [--service NAME] [--restart] [--dry-run]

Install the versioned root-runtime systemd override for a XiaoBa dashboard.

Options:
  --service NAME  systemd unit to override (default: xiaoba-dashboard.service)
  --restart       restart the service after reloading systemd
  --dry-run       print actions without changing the host
  -h, --help      show this help
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

run() {
  if ((dry_run)); then
    printf '+ '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

while (($#)); do
  case "$1" in
    --service)
      service_name="${2:-}"
      shift 2
      ;;
    --restart)
      restart_service=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$service_name" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || die "invalid service name: $service_name"
[[ -f "$(dirname "$0")/10-root-runtime.conf" ]] || die "10-root-runtime.conf is missing beside this script"
if (( ! dry_run )); then
  [[ $EUID -eq 0 ]] || die "run as root"
fi

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
unit_dir="/etc/systemd/system/${service_name}.d"
destination="${unit_dir}/10-root-runtime.conf"

run install -d -m 0755 "$unit_dir"
run install -m 0644 "$script_dir/10-root-runtime.conf" "$destination"
run systemctl daemon-reload

if ((restart_service)); then
  run systemctl restart "$service_name"
fi

if ((dry_run)); then
  exit 0
fi

actual_user="$(systemctl show "$service_name" --property User --value)"
actual_group="$(systemctl show "$service_name" --property Group --value)"
actual_no_new_privileges="$(systemctl show "$service_name" --property NoNewPrivileges --value)"

[[ "$actual_user" == "root" ]] || die "expected User=root, found User=$actual_user"
[[ "$actual_group" == "root" ]] || die "expected Group=root, found Group=$actual_group"
case "$actual_no_new_privileges" in
  no|false) ;;
  *) die "expected NoNewPrivileges=no, found NoNewPrivileges=$actual_no_new_privileges" ;;
esac

if ((restart_service)); then
  systemctl is-active --quiet "$service_name" || die "$service_name is not active after restart"
fi

printf 'root_runtime_override_installed service=%s restart=%s\n' "$service_name" "$restart_service"
