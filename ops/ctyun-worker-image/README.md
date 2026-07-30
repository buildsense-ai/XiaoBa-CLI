# CatsCo Tianyi Cloud Worker Image

This directory builds a source-free Linux worker image. It never snapshots an
existing user worker. The image contains the compiled CatsCo worker, production
Node.js dependencies, a disabled systemd unit, and no bot account, relay key,
session, skill installation, or runtime `.env`.

## Release Policy

- Only stable `vX.Y.Z` tags whose commit is contained in `main` may bake an
  image automatically. Manual runs are restricted to `main` and default to
  not baking until the operator explicitly checks the input.
- The source-free worker artifact stays on the GitHub runner and is copied
  directly to the disposable builder over SSH. It is never uploaded to TOS,
  a public release bucket, or a GitHub Actions artifact.
- A Tianyi Cloud private ECS image is baked only for a stable release selected
  for provisioning, or when the base OS/system dependencies change.
- `CTYUN_AUTO_BAKE_WORKER_IMAGE=true` makes every stable tag bake an image;
  changing it to `false` is the emergency cost and incident kill switch.
- The application version and full Git commit are stored in both
  `/opt/catsco/current/worker-release.json` and `/etc/catsco-image.json`.
- Keep the newest two active images plus the image currently referenced by the
  production launch template. Deactivate older images before deleting them.

This avoids rebuilding a large system disk for documentation-only or emergency
application releases while still allowing new workers to start without GitHub.

## Layout

| Path | Ownership | Purpose |
| --- | --- | --- |
| `/opt/catsco/releases/<version>-<sha>` | root, immutable | Compiled application |
| `/opt/catsco/current` | root symlink | Active application release |
| `/srv/catsco-agent` | `catsco-agent` | Per-worker account, sessions, skills and files |
| `/etc/catsco-image.json` | root, read-only | Image provenance |

The image ships with `catsco-agent.service` disabled. Provisioning must inject a
short-lived bootstrap credential into the data root and enable the service only
after the worker has claimed its bot identity.

## Local Bake

`New-CatsCoWorkerImage.ps1` defaults to plan mode. Execute mode creates a new
temporary on-demand ECS named `catsco-img-*`, copies in a checked source-free
artifact, stops that temporary instance, creates a private image, and then
deletes the builder and its temporary key pair.

CI names builders and key pairs from the workflow sequence and retry:
`catsco-img-000123-01` and `catsco-img-key-000123-01`. This keeps names
recognizable while preventing a rerun from colliding with an uncertain prior
attempt.

The script refuses to stop or delete any instance whose name does not begin
with `catsco-img-`. Existing `worker1`, `worker2`, and `ck-work` instances are
therefore outside its mutation boundary.

```powershell
pwsh ops/ctyun-worker-image/New-CatsCoWorkerImage.ps1 `
  -Mode Plan `
  -RegionID '<region-id>' `
  -AzName '<availability-zone>' `
  -BaseImageID '<ubuntu-24.04-image-id>' `
  -FlavorID '<2c4g-flavor-id>' `
  -VpcID '<vpc-id>' `
  -SubnetID '<subnet-id>' `
  -SecurityGroupID '<security-group-id>'
```

Run the same command with `-Mode Create`, `-ArtifactPath`, and
`-ArtifactSha256` only after reviewing the plan. The machine running it needs
`ctyun-cli`, Git, OpenSSH, SCP, `ssh-keygen`, and GNU `timeout`.

The builder verifies the artifact checksum again before extracting it. Remote
transfer and preparation have hard timeouts. The script resolves a newly
ordered instance by both the order resource ID and its exact temporary name,
so it can still clean up after an ambiguous create response. A failed image is
deleted, and unconfirmed ECS, image, or key-pair deletion fails the workflow
instead of being reduced to a warning.

The workflow also pins both GitHub Actions by commit and verifies the exact
Tianyi CLI package SHA-256 before installing it; it does not execute a remote
installer script.

The resulting system image is not a TOS object. `CreateImage` writes it to the
Tianyi Cloud private image repository for the configured region and account.

## Managed Worker Updates

Workers must not receive Tianyi Cloud account credentials. CatsCompany's
control plane should list private images by the `product=catsco-worker` label
and compare the newest image version with `/etc/catsco-image.json` reported by
each worker heartbeat.

For future paid workers, mount a separate persistent data disk at
`/srv/catsco-agent`. An owner-approved update can then:

1. mark the worker as draining and stop accepting new tasks;
2. wait for the active task to finish, then stop `catsco-agent.service`;
3. back up the data disk and switch the ECS system disk to the selected private
   image while retaining the instance, EIP and data disk;
4. remount `/srv/catsco-agent`, run migrations, start the service and verify its
   CatsCompany heartbeat;
5. return to the old image if health checks fail.

The web UI should show the expected maintenance window and require explicit
owner confirmation. Existing workers whose data still lives on the system disk
must be migrated to a separate data disk before image-based updates are enabled.

## First-Boot Contract

Provisioning from this image must:

1. create or attach the per-worker data disk;
2. write only the worker's scoped runtime configuration under
   `/srv/catsco-agent`;
3. set ownership to `catsco-agent:catsco-agent` and permissions to `0600` for
   credentials;
4. enable and start `catsco-agent.service`;
5. require a successful CatsCompany registration and heartbeat before marking
   the paid worker ready.

Never place a long-lived account password, relay administrator key, or shared
bot token in image metadata or Cloud-init user data.
