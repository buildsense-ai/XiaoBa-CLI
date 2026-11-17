# Monday memory upload

This opt-in module runs with runtime command support. It does not require CatsLog, share its credentials or state, or modify original logs. The matching server change is the Harness Memory stage-pipeline PR.

Configure the runtime environment:

```dotenv
MONDAY_MEMORY_ENABLED=true
MONDAY_MEMORY_URL=http://127.0.0.1:18462
MONDAY_MEMORY_KEY=your-project-key
MONDAY_MEMORY_DATASET=your-rebuild-id
```

The localhost example can be an SSH tunnel to Monday. The URL must be a service origin. The project key establishes authorization; the dataset ID fences old uploader requests after a clean rebuild. Key rotation does not reset upload progress. Use a separate runtime root/state for another project.

## First enable and subsequent scans

First discovery freezes each existing session JSONL file's complete-line end, B0. All bytes before B0 are historical backfill. Appends after B0, and files discovered after initialization, are incremental. Discovery runs on startup if needed and at Beijing 03:00/15:00. Backfill continues between discovery times, transferring bounded chunks in round-robin order; incremental gets a turn before history. No file-idle test blocks active files. Incomplete final lines wait for a newline. The server controls Episode closure, the ten-minute eligibility delay, model batching and generation.

Files are read from `logs/sessions/{chat,cli,catscompany,feishu,weixin}/YYYY-MM-DD/*.jsonl`. State is exclusively `data/monday-memory-state.json` and its process lock. B0, file generation, stable source ID, manifests, acknowledged cursors, hashes and file errors survive restart. Startup fails closed on corrupt/mismatched state and pauses this uploader; the bot remains usable. Never erase state during an ordinary restart.

A request is checkpointed only after offset and SHA-256 acknowledgment match the actual outgoing bytes. Lost ACKs resend identical coordinates. A source rewrite, truncation, invalid response or unsupported log record pauses that file range and is recorded; other files continue, including files in the same session. Discovery errors are separately persisted and do not stop normal file discovery. Current ordinary chunks are at most 1 MiB, and encoded requests are bounded to 3 MiB, below the server's 4 MiB HTTP limit. A larger complete JSONL line (up to 64 MiB) travels through resumable 1 MiB `/ingest/fragments` requests. Only the final whole-record hash/offset ACK advances the local cursor; restart can replay fragments safely. Larger individual records are visibly deferred at their original offset, never truncated or skipped. Hash state is cached only while file size/mtime and cursor remain unchanged; restart or source changes revalidate the acknowledged prefix.

The receiver stores original records before model processing. A manifest identifies the frozen per-session scan range; transport chunks do not become separate model batches. No `/ingest/complete` is called per chunk. Complete files and earlier closed logical days can process before a large session scan finishes; incomplete runtime Episodes always wait for the remaining material. Acknowledged upload does not mean Wiki generation completed: query the server's `/v1/ingest/status` and extraction status for that.

## Explicit clean rebuild

Stop the old Monday companion and this module first. Stop memory workers, clear the selected server project using its documented admin command, set a new matching server/uploader dataset ID, archive only `data/monday-memory-state.json`, then enable this module. Keep logs and CatsLog state untouched. Keep one authoritative uploader per runtime/project. Regular startup, credential rotation and scheduled scans never perform this reset.

## Verification

```sh
npx tsc --noEmit
node --import tsx --test tests/monday-memory-uploader.test.ts tests/runtime-command-support.test.ts
```

The uploader tests use real HTTP servers and temporary log directories. They cover lost normal/fragment ACKs, restart with a rotated key, partial lines, exact transfer, unchanged source bytes, isolated file errors and corrupt nested state rejection.
