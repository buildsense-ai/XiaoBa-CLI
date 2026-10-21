# Private publication candidate capture

This internal component freezes one source-only candidate for an already
authenticated CatsCo publication entry. The store itself is disabled unless
`enabled:true` is explicitly supplied. The reserved RPC adapter below can call
it only when both runtime gates are enabled. There is no model tool or HTTP
route, and existing publishing is unchanged.

## Trust and scope

The CatsCo capture adapter must authenticate the entry, original human,
Bot, exact body/installation and live runtime route before calling this API.
`checkAuthority` is a mandatory synchronous guard, not a credential or a substitute
for server authorization. Its promise-returning misuse fails closed. Capture and
private read both recheck the configured binding and active workspace while
holding the existing cross-process workspace lock. Connectors are not supported.

Inputs contain only an exact entry ID, binding and opaque publication source
descriptor. A caller cannot choose an absolute source path. The descriptor is
copied before waiting; the source resolver and complete bounded byte walk are
shared with the existing source probe. Capture adds byte retention only after
the whole walk verifies; ordinary probes do not start buffering package bytes.
The original Skill is never rewritten, parsed, imported, repaired or executed.
Invalid YAML/descriptions remain unchanged for Cloud to report.

## Durable copy and retries

The committed record is under `runtimeRoot/data/skillhub-publications`, outside
the active Skill path, keyed by entry ID. It contains the original binding and
descriptor, exact source-only JSON request bytes and a minimal receipt. Binary
files use padded base64. The Cloud `skillhub-publish-candidate-v1` digest uses an
empty explicit manifest and sorted file facts; it is not workspace generation.
Cloud must independently validate and recompute it before accepting anything.

Writes use an exclusive random staging file, file fsync, and rename under the
workspace lock. POSIX additionally fsyncs the parent. Windows restart checks
detect missing/torn data, but portable directory fsync/power-loss durability is
not claimed. A failed/uncertain call is not proof that no copy was committed.
Retrying the same entry reads the same bytes, even after source edits/removal;
it never silently recaptures changed content or resets a candidate revision.
Different input for a retained entry, corruption, or changed principal fails.

Receipts contain only schema, entry, revision, candidate/request digests and byte
count. The explicit internal `readRequest` returns bytes only after fresh checks;
`readCandidate` returns the verified receipt and bytes together for the
[internal uploader](skillhub-publication-upload.md), without a second capture.
Never send its result to chats, generic RPC logs, model context or browser state.
Captures contain no upload credential and authorize neither upload nor publish.

New directories/files request POSIX modes 0700/0600 and reject broad final modes;
Windows protection relies on the runtime root's inherited user ACL. Source/store
symlinks and hardlinked files are rejected. Cooperative locking and path checks
are not an OS sandbox against a malicious local administrator or unrelated writer.
Provision a private runtime root before using this component.

## Budgets and retention

Source limits remain 4096 visited entries, 32 directory levels, 5 MiB per file
and 20 MiB included bytes. Capture additionally enforces at most 500 files,
180-character/12-component safe paths and a 32 MiB persisted-record ceiling.
At most 32 records/staging files and 256 MiB may be retained per runtime root.
The operation has a ten-second cooperative budget and a one-second lock wait.

Known cache directories follow the same probe exclusions. Other included bytes
are preserved, not silently sanitized; capture is not a secrets/security audit.
Quota exhaustion stops new captures but does not hide existing evidence. A live
failure removes only its own uncommitted staging file; crash leftovers count
against quota. There is no automatic GC, overwrite, source deletion or retention
reset. Cleanup needs a later lifecycle policy coordinated with Cloud acceptance.

## Verification and next integration

Mandatory runtime/SkillHub tests cover byte preservation, invalid metadata,
restart replay, source changes, scope mismatch, concurrent capture, authority
changes, torn records, interrupted writes, links, permissions and quotas.
The separate cross-repo command requires a real Cloud checkout (no silent skip):

```sh
SKILLHUB_CLOUD_REPO=/path/to/catsco-skillhub-cloud npm run test:cross-repo:publication-capture
```

It compares three actual runtime captures against Cloud's real validator,
including malformed/script-like frontmatter and binary/Unicode file names.
Linux CI provides POSIX permission/link coverage. This is not live Bot upload or
end-to-end publishing. Capture-backed grant issuance and the pinned upload client
exist as separate internal components; durable scheduling and grant delivery
still need to connect them. Do not enable a production workflow based on this
component alone.

## Reserved capture RPC

The ordinary server/desktop Bot runtime advertises and handles
`skillhub.publication.capture.v1` only when both
`XIAOBA_SKILLHUB_PUBLICATION_PROBE_ENABLED` and
`XIAOBA_SKILLHUB_PUBLICATION_CAPTURE_ENABLED` equal `1` or `true`
(case-insensitive). Both default off. The handler snapshots these settings at
construction. This change does not turn on any deployed environment.

The authenticated CatsCo connection carries a server-generated `pubcapture_`
request ID, an unexpired deadline with at most 31 seconds remaining, and exactly
four payload fields: `entry_id`, `bot_uid`, `local_skill_id`,
`workspace_generation`. Owner headers must be exactly `usr` plus the bound
human UID; target/device headers must both match the installation. CatsCo
PR676 verifies admission, persisted source verification and current runtime
route before dispatch, and rechecks authority before recording the response.
The prefix is correlation, not authentication. Generic browser/model RPCs must
remain blocked by CatsCo, and generic device tools cannot invoke this operation.

CatsCo's admission selectors are opaque references, not necessarily digests.
This XiaoBa implementation resolves only its own `publication_source`
descriptors: `pubsrc-` plus 48 lowercase hex characters and a 64-character
content fingerprint. Legacy workspace UUIDs and arbitrary admission references
are not silently mapped to local paths. The existing source probe must succeed
for the same descriptor before CatsCo dispatches capture.

At most two captures per handler can run or wait. Each rechecks deadline,
shutdown and binding before locking, under the workspace lock and before
returning, with the ten-second cooperative capture budget. No owner login
session is needed; the explicit Bot binding remains mandatory. Retried requests
read the original durable candidate, not an in-memory request-ID cache.

The only success fields are `schemaVersion`, `entryId`, `candidateRevision`,
`requestHash`, `sourceSnapshotHash`, `requestBytes`. They contain no source text,
local path or credential. Errors have controlled codes and a fixed message.
An uncertain failure can leave a committed private candidate; it does not
authorize upload or publication. The reserved adapter handles disabled requests
as disabled, without falling back to ordinary tools or legacy share.

`npm run test:cross-repo:publication-capture-rpc` uses `CATSCOMPANY_REPO` and Go
overlays without editing that checkout. CI pins the CatsCo PR689 merge
`9b399165601699f8bb28787874538d2ecafe8a96`. Three suites and seven subcases must
execute without skips: normal/malformed source capture, handler reconstruction
and replay after source removal, source changes, disabled runtime, owner/workspace
mismatch, and CatsCo authority changes before a late receipt. It uses actual
CatsCo transport and XiaoBa handlers/storage, but an in-memory CatsCo store and
synthetic socket bridge. It does not replace real deployed end-to-end acceptance.
