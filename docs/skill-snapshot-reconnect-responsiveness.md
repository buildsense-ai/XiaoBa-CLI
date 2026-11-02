# Skill snapshot responsiveness during CatsCo reconnect

## Incident evidence (Rachel, 2026-11-02)

After a platform API rollout, Rachel repeatedly hit the 90-second pong watchdog
while reconnect-time Skill Definition reconciliation ran. There were 53 pending
snapshots, approximately 13.254 GB in total (current workspace about 873 MB).
The old dedupe loop read and hashed every historic package before even checking
whether its manifest fingerprint matched. A bounded read-only probe read
1.558 GB in ten seconds across 28 snapshots. Ordinary Skill discovery was fast.

This is strong evidence of an event-loop blocking path, not a live stack profile
proving all of each 94–96-second log gap came from this function. Platform
message redelivery/subscription behavior is a separate investigation.

## Change

- Gate old evidence by manifest schema/fingerprint before reading package data.
- Matching candidates still require full file hashes, list equality and a
  recomputed fingerprint. Corrupted evidence cannot suppress a new snapshot.
- Make both production snapshot call sites await asynchronous directory/file
  I/O. Hash files in bounded 256 KiB stream chunks, not whole-file buffers.
- Preserve the manifest format, exclusions, symlink refusal, verified copy and
  atomic temporary-directory promotion. No evidence is deleted by this change.
- Recheck source contents after yielding to other handlers; concurrent edits
  cause a safe failure/retry rather than replacing Local from stale evidence.
- Revalidate scope after asynchronous snapshot work before activating a restore;
  keep the active workspace path present during evidence I/O, then use the
  existing short rename/journal/rollback mechanism to promote the replacement.
- Coalesce reconnect reconciliation per Bot runtime and check the current Bot
  after idle waits. Failures remain best-effort and do not gate ordinary chat.

This changes an internal helper from a synchronous return value to a Promise;
all repository callers are updated. Tool schemas, model switching protocol,
Skill package format, permissions and the heartbeat deadline are unchanged.

## Verification and rollout limits

Regression tests cover timer progress while creating/checking a 32 MiB evidence
file, unrelated snapshot short-circuiting, dedupe/corruption, ephemeral-directory
exclusion, root/nested links, copy-failure cleanup, reconnect coalescing and stale
Bot fencing. Existing workspace/security/restore tests remain applicable.

Not every Skill filesystem path is asynchronous: local manifest/package scans,
unmanaged-content copying and restore cleanup may still do synchronous work.
This PR targets the measured snapshot amplification, not a promise that no
large workspace can ever block the runtime. Snapshot I/O and disk usage still
exist; historic evidence retention/cleanup is intentionally separate.

After review, deploy to Rachel during an idle window, verify heartbeat stability
during reconnect with her real workspace, and correlate user messages end-to-end.
No restart, evidence cleanup or production change is performed by this PR alone.
