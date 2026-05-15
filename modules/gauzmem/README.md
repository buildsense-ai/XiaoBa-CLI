# GauzMem

GauzMem 0.2 is a zero-index, query-driven graph memory sidecar.

It keeps the memory core independent from agent runtimes. Agents such as XiaoBa call GauzMem through HTTP:

```text
XiaoBa / another agent
  -> POST /v1/retrieve
  -> POST /v1/tool/search
  -> POST /v1/events/turn

GauzMem sidecar
  -> grep source roots
  -> optional MiniMax reasoning
  -> JSONL graph store
```

## 0.2 Retrieval Loop

GauzMem 0.2 is no longer a one-shot construct pass. Each retrieve run uses a
frontier loop:

```text
root query
  -> scan existing graph
  -> disclose retrievable graph window
  -> root relevance judge
  -> selected nodes enter graph frontier

while energy remains:
  if graph frontier has available retrievable edges:
    disclose graph
    root relevance judge
    selected nodes continue graph frontier
  else:
    construct from source for the exhausted frontier
    write exact evidence nodes and localAssociation edges only
    return the original frontier node to graph disclose
```

The transient memory bundle stays simple and agent-facing:

```text
[gauzmem_recall]
相关记忆线索：

- evidence text
  可能联想到：
  - related evidence text：whyRelevant
[/gauzmem_recall]
```

Run metadata, source refs, ids, energy traces, step timings, and metabolism state
are persisted in JSONL for dashboard replay and later optimization, but are not
injected into the agent prompt by default.

Detailed algorithm contract: [docs/gauzmem-0.2-algorithm.md](docs/gauzmem-0.2-algorithm.md).

## Layout

```text
src/gauzmem-zero/   core retrieve / construct / graph / store / server
src/cli.js          standalone CLI
tests/              core and real-LLM smoke tests
.env                local secrets, not committed
.gauzmem-zero/      local graph store, not committed
```

## Environment

Copy `.env.example` to `.env` and fill values:

```bash
GAUZMEM_LLM_API_KEY=...
GAUZMEM_LLM_BASE_URL=https://api.minimaxi.com/anthropic
GAUZMEM_LLM_MODEL=MiniMax-M2.7-highspeed
GAUZMEM_ALLOWED_ROOTS=../../logs/sessions
```

GauzMem loads `.env` automatically. You can also set `GAUZMEM_ENV_FILE=/path/to/env`.
When vendored under XiaoBa, GauzMem-specific LLM values are optional: if
`GAUZMEM_LLM_*` is blank, the managed sidecar falls back to XiaoBa's
`GAUZ_LLM_API_KEY`, `GAUZ_LLM_API_BASE`, and `GAUZ_LLM_MODEL`. GauzMem always
uses the Anthropic-compatible `/v1/messages` request shape, matching XiaoBa's
default Anthropic path. GauzMem-specific values still take precedence when present.

## Run

```bash
npm test
npm run serve
```

Or directly:

```bash
node src/cli.js serve --store ./.gauzmem-zero --port 8788
node src/cli.js retrieve --query "之前怎么处理图片上传失败" --root ../../logs/sessions
```

## Dashboard

When GauzMem is vendored inside XiaoBa, the XiaoBa Dashboard exposes a read-only
GauzMem view:

```bash
cd ../..
npm run build
node dist/index.js dashboard -p 3811
```

Open:

```text
http://localhost:3811/gauzmem.html
```

The dashboard reads the JSONL store configured by `GAUZMEM_STORE_ROOT`, defaulting
to:

```text
modules/gauzmem/.gauzmem-zero
```

It shows session replay, the persistent graph, and daily metabolism stats. It
does not write memory data.

## XiaoBa Contract

XiaoBa should not own the GauzMem LLM key.

XiaoBa only needs:

```bash
GAUZMEM_ENABLED=true
GAUZMEM_MODE=http
GAUZMEM_URL=http://127.0.0.1:8788
GAUZMEM_ROOTS=logs/sessions
GAUZMEM_TIMEOUT_MS=45000
```

If GauzMem is vendored under XiaoBa as `modules/gauzmem`, XiaoBa can use
`GAUZMEM_MODE=managed` to start the local sidecar automatically.

The GauzMem sidecar can own:

```bash
GAUZMEM_LLM_API_KEY=...
GAUZMEM_ALLOWED_ROOTS=...
```

If `GAUZMEM_LLM_API_KEY` is blank in managed mode, it inherits XiaoBa's
`GAUZ_LLM_API_KEY` and related model settings from the parent environment.
