# XiaoBa Integration

GauzMem is a sidecar. XiaoBa should integrate it as a thin HTTP client.

## Runtime Boundary

```text
GauzMem
  owns LLM key
  owns graph store
  owns source allowlist
  exposes HTTP API

XiaoBa
  sends current query
  receives transient memory bundle
  records run ids after the turn
  never stores GauzMem LLM key
```

XiaoBa supports two transports:

- `GAUZMEM_MODE=http`: use an already running GauzMem HTTP sidecar.
- `GAUZMEM_MODE=managed`: XiaoBa starts `modules/gauzmem/src/cli.js serve` on first use, then calls it through the same HTTP API.

## XiaoBa Environment

Put only these values in XiaoBa's `.env`:

```bash
GAUZMEM_ENABLED=true
GAUZMEM_MODE=managed
GAUZMEM_URL=http://127.0.0.1:8788
GAUZMEM_ROOTS=logs/sessions
GAUZMEM_TIMEOUT_MS=45000
GAUZMEM_MODULE_ROOT=modules/gauzmem
GAUZMEM_STORE_ROOT=modules/gauzmem/.gauzmem-zero
```

If the sidecar has a token:

```bash
GAUZMEM_HTTP_TOKEN=...
```

## Required XiaoBa Adapter Pieces

The adapter consists of:

- `src/utils/gauzmem-client.ts`
- `src/tools/gauzmem-search-tool.ts`
- passive recall injection in `TurnContextBuilder`
- active run tracking in `ConversationRunner`
- post-turn metadata in `AgentTurnController`
- tool registration in `ToolManager`
- `ToolExecutionContext` fields for `toolCallId`, `gauzMemRunIds`, and `gauzMemRuns`

The XiaoBa repository contains the adapter directly, plus `modules/gauzmem` for managed mode.

## Dashboard View

XiaoBa also serves a read-only GauzMem dashboard from the normal dashboard server:

```text
http://localhost:3800/gauzmem.html
```

The page calls:

```text
GET /api/gauzmem/dashboard
GET /api/gauzmem/summary
GET /api/gauzmem/sessions
GET /api/gauzmem/graph
```

The API reads the local JSONL store only. It does not start retrieval, call the
LLM, modify weights, or create fake memory. If the store is empty, the page
renders an empty replay/graph/metabolism state until XiaoBa uses GauzMem.

## Run Order

For `http` mode, start GauzMem manually:

```bash
cd modules/gauzmem
npm run serve
```

Then enable XiaoBa sidecar access in XiaoBa's local `.env`:

```bash
GAUZMEM_ENABLED=true
GAUZMEM_MODE=http
GAUZMEM_URL=http://127.0.0.1:8788
GAUZMEM_ROOTS=logs/sessions
GAUZMEM_TIMEOUT_MS=45000
```

Do not put `GAUZMEM_LLM_API_KEY` in XiaoBa. It belongs in GauzMem's own `.env`.
