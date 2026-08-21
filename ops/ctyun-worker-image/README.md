# CatsCo Tianyi Cloud Worker Image

This directory builds a source-free Linux worker image. It never snapshots an
existing user worker. The image contains the compiled CatsCo worker, production
Node.js dependencies, a disabled systemd unit, and no bot account, relay key,
session, skill installation, or runtime `.env`.

## Release Policy

- Only stable `vX.Y.Z` tags whose commit is contained in `main` may bake an
  image automatically. Manual runs are restricted to `main` and default to
  not baking until the operator explicitly checks the input.
- The source-free worker artifact, pinned preparation script, and per-run
  bootstrap status object are staged as
  private, per-run TOS objects with short-lived signed URLs. The private
  builder downloads them through cloud-init, and the workflow deletes all three
  objects after the bake. They are never public or retained as GitHub Actions
  artifacts.
- The builder receives only short-lived signed URLs. It writes its current
  bootstrap phase every 30 seconds to the per-run status object; the runner
  prints phase changes live and fails early when bootstrap reports an error,
  does not start, or stops heartbeating. No long-lived TOS credential is placed
  on the builder.
- A Tianyi Cloud private ECS image is baked only for a stable release selected
  for provisioning, or when the base OS/system dependencies change.
- `CTYUN_AUTO_BAKE_WORKER_IMAGE=true` makes every stable tag bake an image;
  changing it to `false` is the emergency cost and incident kill switch.
- The application version and full Git commit are stored in both
  `/opt/catsco/current/worker-release.json` and `/etc/catsco-image.json`.
- `Manage-WorkerImages.ps1` automates housekeeping: `-Action Prune` keeps the
  newest 6 `catsco-worker-*` images (bake-labeled) and deletes older ones
  (fail-closed, deletion confirmed by name-scoped reads). **Prune protects
  production references via `-ProtectedImageIDs`**: the image(s) still
  referenced by the production launch template (or a pinned rollback target)
  are never deleted even when older than `-Keep`, and if deletion is needed
  but no protected list is provided Prune refuses to run (fail-closed). The
  GitHub workflow passes the repo variable `CTYUN_WORKER_PROTECTED_IMAGE_IDS`
  (see “Protected image list maintenance” below).

This avoids rebuilding a large system disk for documentation-only or emergency
application releases while still allowing new workers to start without GitHub.

## Image Lifecycle Management

`Manage-WorkerImages.ps1` manages the private `catsco-worker-*` image set
(created by `New-CatsCoWorkerImage.ps1`):

- `-Action List`   : list all bake-channel images
  (`imageID/name/version/commit/createdTime/status`), newest first.
  > **Contract note**: this PowerShell output (pretty JSON) is for CI / humans
  > on the bake toolchain. The cats-company control plane (`/api/cloud-workers`)
  > runs on a Linux image **without PowerShell**; its image contract is the
  > bash `list-worker-images.sh` (TSV, one image per line) from the
  > cats-company B4-1 scripts. Do not point `CATSCO_WORKER_IMAGES_SCRIPT` at
  > this `.ps1`.
- `-Action Latest` : print the newest imageID (used by deployment to pick the
  latest image)
- `-Action Prune`  : keep the newest `-Keep` images (default 6) and delete
  older bake-labeled `catsco-worker-*` images; each deletion is confirmed by a
  name-scoped `ListImage` read, and failures fail closed.
  Requires `-ProtectedImageIDs` (comma-separated) when there are images to
  delete — protected images are never deleted.

CI runs `Prune -Keep 6` after every successful bake (`continue-on-error`,
30-minute budget), passing `$env:WORKER_PROTECTED_IMAGE_IDS` (repo var
`CTYUN_WORKER_PROTECTED_IMAGE_IDS`).

### Protected image list maintenance

- **What to put in it**: the `imageID` currently referenced by the production
  launch template, plus any pinned rollback/staged-rollout target. The script
  only verifies the list is non-empty; it does not auto-discover the template
  reference, so keep it in sync when the template moves.
- **Local invocation**: `./Manage-WorkerImages.ps1 -Action Prune -Keep 6
  -RegionID <region> -ProjectID 0 -ProtectedImageIDs
  "<imageID1>,<imageID2>"`.
- **Rotating / emergency**: after a bake that becomes the new production
  reference, update the repo var to the new `imageID` (Settings → Variables),
  then the next bake’s Prune can safely clean older images. To disable
  automatic pruning entirely, remove the variable — Prune will refuse to
  delete (fail-closed) instead of guessing.

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

The current cloud image also installs `/etc/sudoers.d/catsco-agent` with
`catsco-agent ALL=(ALL:ALL) NOPASSWD: ALL`, validated by `visudo`. This is an
intentional broad first-stage capability for one-click cloud agents: any Agent
tool execution can become root without a password. Treat the worker as a fully
privileged dedicated VM and do not co-host unrelated workloads. A later
hardening pass should replace this rule with the smallest command/service
aliases that real workloads require.

## Local Bake

`New-CatsCoWorkerImage.ps1` defaults to plan mode. Execute mode creates a new
temporary on-demand ECS named `catsco-img-*` without a public IP. Cloud-init
downloads the checked source-free artifact through a short-lived private URL,
prepares the system, powers the builder off, and creates a uniquely named
`catsco-bake-*` image. After the image is active and its source builder has been
verified, the script publishes it under the stable `catsco-worker-*` name with
a pending bake marker, deletes the builder and its temporary key pair, and only
then replaces that marker with the final release description.

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

Run the same command with `-Mode Create`, `-ArtifactPath`,
`-ArtifactSha256`, `-ArtifactUrl`, `-PrepareScriptUrl`, and
`-PrepareScriptSha256` only after reviewing the plan. Both URLs must be HTTPS
and remain valid until cloud-init downloads the inputs. The
machine running it needs `ctyun-cli`, Git, `ssh-keygen`, and GNU `timeout`.

The builder project and private-image project are explicit, independent
inputs. Set `CTYUN_WORKER_PROJECT_ID` / `-BuilderProjectID` for the temporary
ECS, key pair, VPC, subnet, and NAT scope. Set `CTYUN_IMAGE_PROJECT_ID` /
`-ImageProjectID` for private-image lookup and creation. They may be the same
project (the current production layout) but must not be confused with a
virtual-worker/bot ID. Builders intentionally use `-extIP 0` and rely on the
selected private subnet's NAT gateway for HTTPS downloads.

The builder verifies the artifact checksum again before extracting it. Builder
preparation and every Tianyi Cloud API call have hard timeouts. The
whole bake also has a deadline separate from its cleanup deadline, while the
GitHub job keeps additional time in reserve for compensating cleanup. The script resolves a newly
ordered instance by both the order resource ID and its exact temporary name,
so it can still clean up after an ambiguous create response. A failed image is
resolved by its per-run name and deleted only when `sourceServerID` matches the
current builder. Unconfirmed ECS, image, or key-pair deletion fails the
workflow instead of being reduced to a warning. If image deletion is
temporarily unconfirmed, the source builder is retained as ownership evidence
for the workflow's exact-attempt reconciliation rather than deleting that
evidence first.

Rerunning a release is idempotent: an existing active stable image is reused
only when its full version and commit description match. A conflicting or
incomplete image with the same stable name still fails closed. If a prior run
published the image but failed during final cleanup, the next run uses the bake
marker and source instance ID to finish cleaning that exact builder and key
pair before marking the image complete. Missing builder and key-pair reads are
retried during this recovery window so an eventually consistent API response
cannot make the image ready while billable resources still exist. Each new
workflow run also queries the GitHub Actions API for recent cancelled,
timed-out, or failed image runs and reconciles every attempt derived from each
run's exact ID, sequence, and commit. The newest recently failed attempt gets an
additional late-resource discovery window. This covers process termination
before PowerShell can enter `finally`, including failures that would otherwise
be hidden behind a later unsuccessful reconciliation run. Cleanup failures
from runs updated in the last 30 minutes block a new bake, with a bounded
45-minute strict-recovery budget. A rerun applies the same bounded strict policy
to all of its previous attempts. Older conflicts are attempted independently
with a 120-second per-attempt cap and a 10-minute total budget, surfaced as
workflow warnings and in the job summary, and left for manual reconciliation
instead of permanently blocking all future image releases.

The workflow also pins both GitHub Actions by commit and verifies the exact
Tianyi CLI package SHA-256 before installing it; it does not execute a remote
installer script. The supported Node.js patch version used for the source-free
artifact is pinned, and the same Node/npm runtime is bundled into the private
artifact instead of installing a different distro version on the builder.
Installed Debian package versions are recorded in
`/etc/catsco-image-packages.txt` for later provenance checks.

The resulting system image is not a TOS object. `CreateImage` writes it to the
Tianyi Cloud private image repository for the configured region and account.

### Progress monitoring and bake speed

The orchestrator emits timestamped `bake-progress` lines to the GitHub Actions
log. They include the current phase, elapsed seconds, remaining deadline, API
operation latency, builder state, and image capture progress. This makes a
stalled API call or a builder that never shuts down distinguishable from a
slow image capture while the run is still active. The builder has no public IP,
so its private cloud-init log is intentionally not exposed to the internet;
the phase and output files remain inside the temporary builder and are erased
when the image is finalized.

The expensive part of a cold bake is the platform hardening in
`prepare-image.sh` (apt, systemd/glibc, and kernel updates). For faster repeat
bakes, first publish a worker image that has passed those gates, point
`CTYUN_WORKER_BASE_IMAGE_ID` at that image, and set the repository variable
`CTYUN_WORKER_BASE_IMAGE_HARDENED=true`. The workflow passes that claim to the
builder, which still verifies package versions, masks, and a bootable kernel;
if any check fails it automatically performs the full hardening path. Leave the
variable unset/`false` for a stock Ubuntu base. This turns later application
release bakes into a short artifact/install plus image-capture operation without
weakening the fail-closed safety check.

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

## Existing Worker Updates (Part A: Application Artifacts)

- **New workers** get the full baked image (`catsco-worker-*`, provisioned via
  the cloud control plane).
- **Existing workers** are updated at the application layer with a deterministic
  artifact (`npm run worker:artifact`) — no rebake, no system-disk change, and
  `/srv/catsco-agent` data is never touched. See `docs/worker-artifact-update.md`.
- The worker-side updater is `scripts/update-worker-artifact.sh` (checksum +
  manifest verify, native-module smoke, symlink switch, restart, heartbeat
  check, automatic rollback); the dispatcher is
  `scripts/deploy-worker-artifact.mjs` (serial ssh/scp across targets).
- CI trigger: stable tag + repo var `CTYUN_WORKER_APP_UPDATE=true`
  (`.github/workflows/worker-app-update.yml`), or manual workflow_dispatch
  with `update_workers` from `main`, or local dry-run via
  `npm run worker:update:dry`.
- Workers hold no cloud credentials: distribution goes over SSH only.
