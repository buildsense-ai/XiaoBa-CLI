# Linked Skill workspace recovery evidence

A model-only BotDefinition update first tries to reuse the verified managed
Skill workspace. If package hashes no longer match Base, activation restores
verified Cloud packages instead. Previously, any nested symbolic link in Local
made the pre-replacement evidence snapshot fail, rolling back the model update
even when the Cloud packages were valid. This also affected startup restoration.

## Evidence format and activation

- Ordinary files still enter `local-pending/<bot>/<snapshot>/package/` with their
  sizes and SHA-256 hashes. Real regenerable directories remain excluded.
- Nested links are recorded as `{ "path": "...", "target": "..." }` using
  `readlink`. Their targets are neither traversed nor copied. Link targets may
  be missing, external, or cyclic; recording the text does not grant access.
- Snapshots with links use `xiaoba.bot-skill-local-pending.v2`, with a `links`
  array in `manifest.json`. Files-only snapshots retain the v1 schema and
  fingerprint, so existing evidence can still be verified and deduplicated.
- Link records participate in the fingerprint and source stability check.
  Changed links, corrupted manifests/files, and links inserted into an evidence
  package cannot qualify that snapshot for deduplication.
- No actual links are created in `package/`. The existing restore path excludes
  links from the staged workspace; managed Skills must still come from verified
  Cloud packages. Activation logs the number of excluded links and evidence
  location, and returns an optional `localPendingEvidence.linkCount`.

An operator recovering a link must inspect its recorded source path, target,
and ownership first. The manifest is evidence, not an automatically runnable
workspace or permission to recreate a link. Relative targets are relative to
the link's original parent under the recorded source workspace, **not** to the
evidence package. An unmanaged linked Skill may need deliberate reinstallation
as regular verified files; this change does not activate its linked target.

## Boundaries

A nonempty workspace whose root itself is a link still fails closed. Unsupported
special files and failed copies, package validation failures, and concurrent
source changes still block replacement. Bot ownership, revocation, trusted
execution checks, model rollback, and revision acknowledgements are unchanged.
This fixes nested-link evidence failures; it does not suppress arbitrary Skill
errors or introduce partial-success BotDefinition acknowledgements.

The model update regression exercises successful restore and ACK, a tampered
Cloud package (no success ACK or connector replacement), and connector startup
failure (old model recovery). Workspace regressions cover managed directory
links, local-only links, and dependency links. Snapshot tests cover external and
cyclic targets, dangling/file links on POSIX, evidence tampering, deduplication,
source changes, and cleanup on failure. Root-link and trusted-script safety
tests continue to run unchanged.
