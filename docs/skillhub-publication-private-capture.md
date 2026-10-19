# Private publication candidate capture

This internal component freezes one source-only candidate for an already
authenticated CatsCo publication entry. It does not register an RPC, model tool,
HTTP route, environment flag or advertised capability. Construction is disabled
unless `enabled:true` is explicitly supplied. Existing publishing is unchanged.

## Trust and scope

The future CatsCo capture adapter must authenticate the entry, original human,
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
count. The explicit internal `readRequest` returns bytes only after fresh checks.
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
end-to-end publishing. Next work is the reserved trusted capture dispatch,
capture-backed grant issuance, pinned upload client and isolated multi-repo
acceptance. Do not wire this to session-only legacy publication or enable a
production workflow based on this component alone.
