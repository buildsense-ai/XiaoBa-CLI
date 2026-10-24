# Publication repair: live Runtime source verification

Status: Runtime-only protocol, default off. The CatsCo caller/adapter and production
repair executor are separate changes. This is not a complete publication assistant.

## Why a separate operation

`skillhub.publication.capture.v1` must replay the original retained capture after a
retry, even if the live source was removed or changed. Replaying that receipt does
not prove that a description repair still refers to the current on-disk Skill.

`skillhub.publication.verifyRepairSource.v1` instead calls the existing internal
`PublicationCaptureStore.readRepairCandidate` under the current workspace lock.
The original retained record must exist and match the entire expected receipt;
the live source descriptor must still match the captured selector and generation.
It never captures a missing record or substitutes a same-named Skill.

## Gates and caller boundary

All three switches must explicitly be `1` or `true` (case insensitive):

- `XIAOBA_SKILLHUB_PUBLICATION_PROBE_ENABLED`
- `XIAOBA_SKILLHUB_PUBLICATION_CAPTURE_ENABLED`
- `XIAOBA_SKILLHUB_PUBLICATION_REPAIR_SOURCE_ENABLED`

Only then do server/desktop Runtime capability reports advertise the new marker.
The operation is reserved in the CatsCo Runtime adapter even when disabled: it
cannot fall back to generic model tools and is not a device-grant operation.
No browser route or model tool is added by this change. A future CatsCo internal
caller must authenticate current task/application authority and obtain the
expected capture and source binding from trusted persistence, not caller input.

## Request contract

Use the existing authenticated thin-tool envelope with type `request`, no result
or error, and a request ID matching `^pubrepairsource_[A-Za-z0-9_-]{16,64}$`.
`expires_at` is an integer millisecond timestamp, not expired and no more than
31 seconds ahead. Owner is canonical `usr<ownerUid>`; `device_id` and
`target_device_id` must both match the active installation. Exact payload:

```json
{
  "entry_id": "pubentry_<32 lowercase hex>",
  "bot_uid": "42",
  "local_skill_id": "pubsrc-<48 lowercase hex>",
  "workspace_generation": "<64 lowercase hex>",
  "expected_capture": {
    "schemaVersion": 1,
    "entryId": "pubentry_<same 32 lowercase hex>",
    "candidateRevision": 1,
    "sourceSnapshotHash": "<64 lowercase hex>",
    "requestHash": "<64 lowercase hex>",
    "requestBytes": 123
  }
}
```

`bot_uid` is a canonical positive decimal (at most 19 digits). `requestBytes` is
an integer in `[1, 33554432]`. No additional payload or receipt fields are allowed.
Input facts are snapshotted before asynchronous waits.

## Success and failure

Success contains exactly the six expected capture scalars plus
`"sourceVerified": true`. No source/request bytes, local paths, credentials or
upload grants cross the socket. The result is point-in-time evidence, not a
lease or authority to edit or publish: CatsCo must still recheck its current
application, human, task, cancellation, connection and route before/after use.

The handler shares the existing maximum of two in-flight capture operations and
uses the earlier of request expiry and a 10-second local budget. Every replay
rechecks identity, Bot, body, installation, current workspace and live source;
generic request-ID caching is bypassed. Lock waits recheck authority, expiry and
shutdown. Deleted/changed/unsafe sources, corrupt or missing retained records,
mismatched receipts, changed identities and unavailable workspaces fail closed
with existing sanitized `publication.*` or envelope error codes.

No source files are changed. No model call, billing, publication, description
application, repair round or three-attempt budget is created or reset. Existing
capture/upload retry behavior remains unchanged.
