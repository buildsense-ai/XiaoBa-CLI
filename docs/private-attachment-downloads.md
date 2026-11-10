# Private Cats Company attachment downloads

Companion server change: `cats-company` branch `feat/message-attachment-privacy`.

The server authorizes an active human or bot using current read access to a persisted message that actually references the resource. CLI credentials identify the caller; they do not grant access to every upload or infer ownership from the first download. Existing attachment URLs and payloads remain unchanged.

`CatsClient.fetchAttachment` supplies `ApiKey` or `DeviceConnector` only to `/uploads` paths on the configured platform origin. Redirects are followed explicitly, at most five times. Once a chain leaves this trusted scope it remains anonymous, even if redirected back. Unsupported schemes, userinfo and ambiguous upload paths cannot receive platform credentials. External attachment URLs never receive platform credentials or a newly added historical message hint.

Persisted incoming messages pass their real `msg.seq` as `message_id` for trusted platform uploads. The server reloads that message and verifies resource membership and current permission before repairing a historical index. This transport hint is not added to the stored attachment payload. Downloads of newly uploaded draft files omit the hint.

Device connectors require the server-issued `device:download` scope and an active owner; upload scope alone does not authorize reads. Existing paired connectors may need a refresh/re-pair to obtain the new scope after the coordinated server rollout. Bots using an API key retain their normal message-read policy without an extra task restriction.

`MessageSender.downloadFile` streams into an exclusive unique `.part-*` file, enforces a 120-second total timeout and a 300 MiB declared/actual size limit, then renames only after completion. Failed/denied/interrupted downloads remove the partial file, preserve an existing target and return `null`. Download/upload completion logs do not include source URLs or signed query credentials.

Relevant checks:

```sh
node --import tsx --test tests/catscompany-attachment-download.test.ts tests/catscompany-message-sender.test.ts tests/catscompany-upload.test.ts
npm run build
```

Coordinate this client with the protected server, database backfill, browser sessions and origin closure. Client tests do not establish production storage policies or server permission correctness. This change does not merge or deploy either repository.
