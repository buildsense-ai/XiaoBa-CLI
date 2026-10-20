# SkillHub publication source probing

This opt-in adapter implements CatsCo's read-only
`skillhub.publication.sourceProbe.v1` receipt. It does not capture, repair,
validate for publication, upload, or publish a Skill. It is a prerequisite for
the new workflow, not activation of that workflow.

## Activation and trust boundary

`XIAOBA_SKILLHUB_PUBLICATION_PROBE_ENABLED=1` (or `true`, case-insensitive)
enables both advertisement on ordinary server/desktop Bot runtimes and handling.
It defaults off. No deployed environment or production switch is changed here.
Device connectors are not supported. The adapter requires the configured active
Bot, explicit bound human UID, body and installation, plus the existing active
workspace lock/ownership guard. It never falls back to a local account UID,
another Bot, or a legacy body/device identifier.

Requests arrive on the authenticated CatsCo Bot connection. CatsCo must enforce
the reserved tool rule and authoritative human/ownership/device/body/lease and
connection-generation checks introduced in PR627/635. A matching prefix or
source hash is not a credential. Browser/model calls must not be routed directly
to this tool. This adapter does not add an HTTP, shell or model tool entrypoint.

Only request IDs prefixed `pubprobe_` or `pubdelivery_` with a bounded server-random
suffix and an unexpired, at most 31-second remaining lifetime are accepted.
The payload has exactly three strings:

```json
{"bot_uid":"42","local_skill_id":"pubsrc-<48 hex>","workspace_generation":"<64 hex>"}
```

Routing headers must identify the exact bound human (`usr` + UID) and registered
installation. Identity and operational checks run before locking, inside the
lock, and after it. No cached receipt is reused, even for identical request IDs.

The only success fields are:

```json
{"schema_version":1,"local_skill_id":"pubsrc-<48 hex>","workspace_generation":"<64 hex>"}
```

Errors use controlled `publication.source_missing`, `publication.source_changed`,
`publication.source_unsafe`, `publication.runtime_unsupported`, or
`publication.runtime_unavailable` and a fixed message, not raw filesystem paths,
file contents or exceptions. Missing runtime support or source errors must not
fall back to the legacy share operation.

Request failures retain controlled `INVALID_REQUEST`, `OWNER_MISMATCH`,
`DEVICE_MISMATCH`, `BOT_NOT_ACTIVE`, or `REQUEST_EXPIRED` codes with the same
fixed message. Malformed payloads are not source-content changes. CatsCo's
paired request-error adapter maps `INVALID_REQUEST`, `OWNER_MISMATCH` and
`DEVICE_MISMATCH` to its existing terminal `publication.runtime_unsupported`
outcome and expiry to retryable `publication.runtime_timeout`. `BOT_NOT_ACTIVE`
also covers transient workspace switching, so CatsCo preserves its unavailable
fallback and bounded background retries. The adapter does not add DB outcomes or
expose raw runtime messages. Older CatsCo versions safely reject these errors
but normalize them as unavailable, so deploy the paired adapter before enabling
the workflow to avoid unnecessary delivery retries.

## Selectors for the new publication flow

When enabled, each existing workspace list item may additionally contain
`publication_source` with the two source selectors, or a bounded
`publication_source_error`. A future publishing caller must use these selectors
together, not the legacy `local_skill_id` or top-level `workspace_revision`.
The old fields, `can_share`, and legacy pagination/sync revision retain their
existing semantics. No publishing button is changed by this PR.

The 16-MiB snapshot limit and 48-KiB response limit still bound actual serialized
data. Legacy entries are fitted first; optional fields are added only from the
remaining budget. If neither a descriptor nor an error fits, both are omitted.
Omission is not permission to publish or to fall back to legacy identifiers.
Page boundaries and the legacy revision do not depend on enrichment.

The opaque source ID hashes the workspace-relative directory, independent of
the legacy marker or manifest parser. The generation identifies the selected
source within that workspace: it binds Bot/human/body/installation, resolved
workspace root, source directory identity and sorted raw file digests. Unrelated
Skills do not invalidate it. Renaming/replacing the directory, rebinding, or
changing included bytes invalidates the selection. It can be recomputed after a
handler/process restart; no cached browser listing is needed. It is not Cloud's
candidate hash and does not authorize a future read/upload. A later capture
must recheck authority, source and byte limits and create its own consistent copy.

The new fingerprint/probe never parses Skill YAML, JavaScript or JSON metadata,
executes scripts, writes local markers or modifies Skill files. Malformed or
missing descriptions are therefore not source-read failures. The existing
workspace list still uses its legacy listing parser; this PR does not replace
that parser or promise to list every unsupported package layout.

## File and work limits

The source must be a directory below the active workspace with a regular
`SKILL.md`. Ancestors and resolved paths are checked for containment. Symlinks,
hardlinked files and special files are rejected, not followed. Directory
enumeration is streamed; fingerprints read regular files in 64-KiB chunks, with
stat/descriptor comparisons before and after reading to detect concurrent edits.
These checks and the cooperative workspace lock are not an OS sandbox against a
hostile local administrator. They do not lock bytes for later capture.

Per selected-source fingerprint: at most 4,096 directory entries, depth 32,
5 MiB per file and 20 MiB total. Discovery has its own 4,096-entry/depth-32
budget across the whole workspace, including ordinary files and the selected
source. Listing performs the same discovery once before offering any selectors,
using one binding read for the enrichment batch. When discovery exceeds its
budget, all items get `publication.source_unsafe` (space permitting); this code
includes scan-limit failures, not only unsafe file types. A large unrelated
sibling can therefore disable probing, but cannot cause a misleading usable
selector or fail the legacy listing. Hidden directories are not discovered.
`.git`, `node_modules`, `.venv`, `.cache`, `.mypy_cache`, `.pytest_cache`,
`.ruff_cache` and `__pycache__` directories are excluded from content hashing.
Symlinks at their directory entries are still rejected. Oversized/unsupported
sources fail closed; this is a source-probe budget, not Cloud format approval.

At most two requests per handler wait/run. Lock wait is at most one second;
elapsed time is checked throughout discovery/hash work against the request
expiry and a three-second local budget. Optional listing enrichment shares a
one-second budget and reports unavailable rather than failing the old listing.
Filesystem calls are synchronous and these are cooperative deadline checks,
not hard preemption of an OS call or a promise about stalled network mounts.
The existing coordination lock may create/remove its own lock metadata; no
source files, candidates, external requests, model calls or billing are written.

## Verification and remaining work

`tests/skillhub-publication-source.test.ts` is in both the runtime suite and the
mandatory SkillHub regression group. It covers default-off capability, strict
wire receipt, malformed metadata, nonexecution, unchanged legacy revision,
restart/replay, changed content/binding, wrong scope, expiry, unsafe files,
limits and lock-time authority rechecks. Existing regression tests remain enabled.

This is not live CatsCo/Cloud end-to-end acceptance. CatsCo initial admission is
still online/same-node. Durable pre-probe intake, scoped grants, cancellation,
candidate capture/upload, chat context, frontend integration and joint isolated
acceptance are still required. Keep production flags off until those gates pass.

### Paired message contract

`npm run test:cross-repo:publication-probe` uses `CATSCOMPANY_REPO` (default:
the sibling `cats-company` checkout) and requires Go, installed XiaoBa Node
dependencies, and CatsCo including PR642. CI pins that counterpart to the reviewed
PR676 merge, `05245dacc35b6f5b5836a20f63b48ca6bd43e2f1`, and also runs the
[capture RPC contract](skillhub-publication-private-capture.md#reserved-capture-rpc).

The Go tests exercise actual CatsCo admission/delivery handlers, pass their
generated request envelopes unchanged through a test-only JSONL pipe to the
real XiaoBa `SkillHubThinRpcHandler`, and feed its replies back to CatsCo.
Selectors come from a real XiaoBa workspace listing of temporary Skill files.
The test registration follows XiaoBa's installation-ID-as-device-ID convention;
it does not rewrite routing fields to bypass mismatches. Each probe checks that
the Skill tree remains unchanged. No Skill scripts are executed.

Coverage: normal/malformed-metadata source admission and replay; changed or
renamed sources; disabled probing; local owner mismatch; simulated on-disk
workspace-switching mismatch followed by recovery and handler reconstruction,
with bounded-backoff delivery of the original intent. The runner requires all
three named tests and six subcases to execute and pass; missing counterparts,
skips or test-discovery failures fail the job rather than producing a green skip.
Go's overlay adds the test file without editing the CatsCo checkout.

Authority/store fixtures and transport are in-memory, not real user login,
WebSocket authentication, PostgreSQL/Redis persistence, cross-node recovery or
Cloud upload. This gate verifies the implemented message contract only. It does
not enable production flags, publish a Skill, or replace isolated deployed E2E.
