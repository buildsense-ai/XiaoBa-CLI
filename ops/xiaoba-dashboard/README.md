# XiaoBa Dashboard Root Runtime

This directory keeps the owner-approved systemd privilege profile for
`xiaoba-dashboard.service` under version control. It intentionally changes
only the service execution boundary:

- `User=root`
- `Group=root`
- `NoNewPrivileges=false`

It does not contain an application path, Node.js path, `.env`, credential, or
runtime data. Those remain in the host's base service unit and persistent data
root.

## Install

Copy this directory to the target host, then run as root:

```bash
./install-root-runtime-override.sh --restart
```

The installer writes
`/etc/systemd/system/xiaoba-dashboard.service.d/10-root-runtime.conf`, reloads
systemd, and restarts the service only when `--restart` is present. It is
idempotent and leaves the base `xiaoba-dashboard.service` unit unchanged.

Use `--dry-run` to inspect the host actions before applying them. A non-default
service name may be passed through `--service NAME`.

## Verify

```bash
systemctl show xiaoba-dashboard.service \
  -p User -p Group -p NoNewPrivileges -p ActiveState -p MainPID
```

The expected effective policy is `User=root`, `Group=root`, and
`NoNewPrivileges=no`. This profile grants the dashboard process the same host
privilege level as root; apply it only to owner-operated hosts.
