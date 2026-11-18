# Monday memory upload

This independent uploader is enabled by default for a bound Bot. It requires no memory API key, project selection, capability grant or client dataset setting. It does not use CatsLog configuration or progress. Inspector runtimes do not start it; a runtime without a known Bot UID waits until one becomes available.

Optional independent settings:

```dotenv
XIAOBA_MEMORY_UPLOAD_ENABLED=true
XIAOBA_MEMORY_UPLOAD_URL=https://memory.catsco.cn:18443
XIAOBA_MEMORY_UPLOAD_FALLBACK_URL=https://memory.catsco.cc:18443
```

Set `XIAOBA_MEMORY_UPLOAD_ENABLED=false` to disable this uploader. Its default receiver is Monday's HTTPS upload ingress on TCP 18443, with `.cn` primary and `.cc` fallback. Both must have valid public certificates and return the same dataset. `MONDAY_MEMORY_*` was the earlier opt-in prototype and no longer controls this uploader. The CatsLog upload setting remains independent. Search, workbench and original-source read authorization are server concerns and are not removed by keyless upload.

An explicit `XIAOBA_MEMORY_UPLOAD_URL` overrides the default route and disables implicit fallback; set `XIAOBA_MEMORY_UPLOAD_FALLBACK_URL` explicitly if wanted. An internal receiver such as `http://10.0.0.11` remains supported as an explicit deployment override. Public defaults never downgrade to HTTP or disable certificate checks. Deployment of the default URL requires the receiver's certificate and Nginx listener; a DNS record alone is insufficient.

## Endpoint migration and fallback

The endpoint is routing metadata, not the source identity. On address changes the uploader loads its existing independent state and verifies the new receiver's dataset before changing that metadata. It retains the installation ID, file generations, B0, manifests and acknowledged offsets. A different dataset stops processing and leaves the state unchanged; do not delete state just to change HTTP/IP to HTTPS/domain.

Connection failures, timeouts and HTTP 502/503/504 can try the configured backup once per operation. Before replaying a POST there, the uploader verifies that backup's dataset. The request body, source coordinates and dataset are unchanged, so the receiver's existing idempotency handles an accepted request whose ACK was lost. A healthy backup is reused and the primary is rechecked after 15 minutes. Request errors, 429, invalid JSON/config and dataset mismatches do not trigger fallback. There is no simultaneous mirrored upload.

## Bot ownership

The current Bot UID and display name come from the existing CatsCo runtime binding; memory upload does not require the Bot's API key. The resolver rereads the binding for each upload so a local name change is sent with the next request. UID is stable identity; name is mutable display metadata. Historical files with `agent_identity.agent_id` use that recorded UID (`usr365` normalizes to `365`). Older files without an identity inherit the currently bound Bot. The receiver marks whether attribution came from the original or from the uploader.

Manifests group files by Bot UID, session and history/incremental lane. Each upload goes to `/v1/bots/{uid}/ingest/{manifests,batches,fragments}` with the current `bot_name` when available. The server updates names without rewriting original log bytes or creating a new Bot identity. Explicit record identities must agree with the selected Bot; a conflicting or mixed-identity file is left at its source offset with an error, not reassigned. Source instances and file generations remain separate from Bot identity so multiple installations do not collide at byte offset zero.

## First enable and future scans

The first discovery freezes each existing session JSONL file's complete-line end, B0. All bytes before B0 are historical backfill. Later appends and newly discovered files are incremental. Discovery runs on first activation and Beijing 03:00/15:00. Saved historical ranges continue draining between scans in bounded chunks; increments receive a turn before history. Files may still be active; incomplete final lines wait. The server requires complete runtime Episodes and a ten-minute delay after completion before model processing.

Files are read from `logs/sessions/{chat,cli,catscompany,feishu,weixin}/YYYY-MM-DD/*.jsonl`. State is exclusively `data/monday-memory-upload/state.json` and its process lock. This new ledger intentionally does not read the earlier key-based prototype ledger or CatsLog markers: first activation of this protocol includes all history. Ordinary restarts preserve B0, source identity, manifests, ACK/hash cursors and errors and do not reupload completed ranges.

The receiver's `/v1/bot-ingest/config` supplies a dataset identifier automatically. Once saved, an unexpected dataset change pauses the uploader rather than silently resetting acknowledged progress. Explicit server rebuilds archive only this independent ledger before a new first scan. Original logs and third-party state remain intact.

## Reliable transport and model batches

An offset advances only after the response offset and SHA-256 match the actual outgoing bytes, which are checked again against the source file. Lost ACKs replay the same coordinates. Ordinary chunks are at most 1 MiB, encoded requests at most 3 MiB. A larger complete JSONL record uses resumable 1 MiB fragments with a 64 MiB whole-record limit. Larger individual records remain visibly blocked; no source text is truncated or skipped. Source rewrites, rejected records and discovery errors are isolated by file.

Transport chunks do not define model batches. Monday stores immutable raw records, indexes complete Episodes, groups by 03:00 logical day and request budget, and pipelines Stage1/Stage2 jobs. It can process complete files and earlier closed days while a larger historical range is still arriving. Upload ACK is not Wiki completion.

## Verification

```sh
npm run build
node --import tsx --test tests/monday-memory-uploader.test.ts tests/monday-memory-transport.test.ts tests/runtime-command-support.test.ts tests/catsco-log-agent-config.test.ts tests/catsco-log-agent-state.test.ts
```

Real HTTP/temp-file tests cover no authorization header, default-on independent configuration, dynamic name changes, recorded/fallback UID routing, full history, later appends, lost ACKs, restart, fragments, partial lines, read-only source bytes, isolated errors and invalid state rejection.
