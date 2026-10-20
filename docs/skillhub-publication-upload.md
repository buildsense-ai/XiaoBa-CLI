# Private publication candidate uploader

The internal `PublicationCandidateUploader` sends an already frozen private
candidate to the fixed Cloud HTTPS candidate endpoint. Construction is disabled
unless explicitly enabled. A reserved server RPC can invoke it with a narrowly
scoped grant; there is no model tool, credential issuer or automatic retry.

## Trusted inputs

The CatsCo adapter must authenticate the publication entry and current
human/Bot/body/installation route, obtain a purpose-scoped upload grant, and
provide a synchronous live-authority guard. Calling this component with a
request-shaped object is not a replacement for that server-side authorization.
The grant envelope is an internal integration type, not an exposed CatsCo API.

The constructor pins distinct canonical HTTPS issuer/audience origins. Callers
cannot select a URL/path per upload. Grants bind action `candidate.upload`,
entry/revision, exact local binding, candidate/request hashes, byte count,
idempotency key, authority epoch 1-8, opaque token and expiry. The internal
expiry is normalized UTC milliseconds, positive and no more than 120 seconds.
No session token, Bot key or general service credential is accepted.

Input and grant fields are copied before waiting. `readCandidate` verifies the
retained receipt and exact request bytes together under the workspace lock;
the lock is released before networking. The uploader never calls capture to
create a missing record, rereads the original Skill, repairs metadata, or
modifies the active workspace. Changed/missing/corrupt captures fail closed.

## Transport and outcomes

The request uses native HTTPS with certificate verification, no redirects or
proxy-environment lookup, and no reused HTTP agent. Credentials are only sent
to `/api/skills/publication-delegations/candidates`. Headers carry the opaque
upload token, entry, epoch, candidate hash, idempotency key and exact length;
the body is the unchanged retained source-only JSON bytes. Test-only transport
injection trusts an ephemeral localhost CA without disabling certificate checks.

Two operation slots cover private reads through actual transport closure.
Requests stop after at most 60 seconds or grant expiry, and support caller
abort. Guards run before the read, before send and before accepting a reply.
There is no automatic retry or authority renewal. After any uncertain upload,
the caller must preserve the same candidate/key, obtain current authorization,
and retry; it must not create a new entry/version to hide an uncertain result.

Headers and responses are bounded to 8 KiB each. Successful JSON requires exact
fields, no duplicate keys, valid UTF-8 and matching hashes/entry/revision. An
older acceptance epoch can be returned for a valid renewed grant. Only minimal
association facts escape the client: no source bytes or credentials. Errors
are static and never retain upstream bodies, options, local paths or causes.

201 means a new private task was accepted; 200 is exact replay. Neither means
validation passed or publication succeeded. Replay can observe cancelled,
committing or published state and unavailable candidate bytes without reviving
them. Cloud independently introspects authority and hashes received bytes;
this receipt cannot replace CatsCo human confirmation or commit authorization.

## Verification and remaining integration

The reserved `skillhub.publication.upload.v1` capability requires all three
`XIAOBA_SKILLHUB_PUBLICATION_PROBE_ENABLED`,
`XIAOBA_SKILLHUB_PUBLICATION_CAPTURE_ENABLED` and
`XIAOBA_SKILLHUB_PUBLICATION_UPLOAD_ENABLED` gates. It also requires distinct
canonical HTTPS `XIAOBA_SKILLHUB_PUBLICATION_ISSUER` and
`XIAOBA_SKILLHUB_PUBLICATION_CLOUD_AUDIENCE`. Defaults stay off. The receiver
routes before generic logging/tools/cache even when disabled, never falling
back to a shell or model operation.

RPC IDs use `pubuploadrpc_`; deadline is bounded and the payload has exactly
entry ID, Bot UID, dedicated local source ID, generation and grant. The handler
clones grant scope before asynchronous work and checks the authenticated local
Owner/Bot/body/install binding before/during/after upload. Two in-flight slots,
a 45-second transport budget and a 250ms shutdown/identity check abort stalled
network I/O. No workspace lock is held during HTTP. Original source deletion
does not change frozen bytes, and missing retained bytes never trigger recapture.

Only `{schemaVersion:1,entryId,authorityEpoch,accepted:true}` is returned. It is
not Cloud's authoritative receipt, validation success or publication success.
The runtime never writes CatsCo publication state, and repeats recheck current
authority instead of using the generic request-ID cache. No raw error, bearer,
path, package contents or Cloud metadata is returned to a conversation.

Mandatory SkillHub/runtime tests use a real localhost TLS server, real capture
store and exact binary source bytes. They cover TLS trust, wrong authority and
digests, missing captures, source removal, caller mutation, dropped replies,
renewed-token replay, redirects, strict response identity/UTF-8/duplicate keys,
bounded bodies, timeout/abort, held slots and source-workspace lock release.

This component does not request grants or schedule uploads. Next comes durable
upload/reconciliation scheduling and isolated three-repository acceptance.
No Bot/server update, production enabling, UI change or model/billing call is
part of this PR. Cloud's matching upload endpoint is tracked in Cloud PR45.

After `npm run build`, run `node scripts/cross-repo-publication-upload.mjs` with
`SKILLHUB_CLOUD_REPO` pointing to that Cloud checkout (optional exact
`SKILLHUB_CLOUD_REVISION`). Missing dependencies fail rather than skip. This
contract uses the real runtime capture/uploader, HTTPS Cloud handler and Cloud
validator; its authority/database adapters are explicit substitutes, not live
CatsCo grant or PostgreSQL evidence. Cloud's own required contract covers those
real service/database components separately.

`npm run test:cross-repo:publication-upload-rpc` uses `CATSCOMPANY_REPO` and a Go
overlay: actual CatsCo capture/grant envelope, actual XiaoBa retained capture
and RPC, certificate-verified local HTTPS, then exact CatsCo ACK handling.
Five mandatory cases cover normal upload, changed/removed original source,
Owner mismatch, disabled receiver and Cloud rejection. No missing dependency
or skipped test counts as success. CatsCo authority/store/socket and Cloud
response are explicit fixtures, not deployed full end-to-end proof.
