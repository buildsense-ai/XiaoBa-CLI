# Attachment download rollback (#630)

This rolls back XiaoBa-CLI merge PR #630 (`52c6406f407408a1803023b7f0b03289dcbff44c`) against its first parent. Coordinate with the companion CatsCompany rollback of #922 and #930.

**Security downgrade:** attachment access returns to legacy anonymous, link-based access. Possessing an attachment URL may be sufficient to retrieve its contents; current message membership/read permission is no longer checked by this client download flow. Do not describe attachments as private or message-authorized after this rollback.

**Deploy the companion server rollback first**, and verify that legacy upload links are anonymously readable before rolling out this client. Deploying this client against a server that still requires authenticated attachment downloads will cause downloads to fail. This document does not authorize a deployment or any deletion of stored data.

Downloads again use ordinary anonymous `fetch`, including its default redirect behavior, with no added `Authorization` header or `message_id` repair hint. Relative links still resolve against the current client HTTP base (or an explicit sender override), absolute/external links remain unchanged, and target paths plus legacy temporary-file cleanup are preserved. The #630 authenticated redirect helper, streaming size limit and two-minute download timeout are reverted.

Intentional exception: retain upload-completion and download-error log redaction. Do not log full source URLs, signed query credentials or fetch error messages that may embed them.

Version remains **1.6.6**. Later changes, including #635 fetch retry, #637 TLS/domain cooldown and #638 transcript completeness (`d67f2a4`), are retained.

Checks:

```sh
node --import tsx --test tests/catscompany-attachment-download.test.ts tests/catscompany-message-sender.test.ts tests/catscompany-upload.test.ts tests/catscompany-fetch-retry.test.ts tests/catsco-domain-cooloff.test.ts
npm run build
```

Also run the transcript, session-log compatibility, pending-input, session-fork and execution-scope regression tests before shipping.
