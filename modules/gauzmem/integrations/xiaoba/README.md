# XiaoBa Adapter

This folder documents the intended XiaoBa integration boundary.

GauzMem remains an independent module with an HTTP boundary:

- GauzMem owns `.env`, MiniMax credentials, source allowlist, and graph store.
- XiaoBa owns a thin HTTP adapter, transient prompt injection, and optional managed sidecar startup.
- XiaoBa should not receive or persist GauzMem LLM secrets.

Paths below are relative to the XiaoBa repository root.

Runtime env values for XiaoBa:

```bash
GAUZMEM_ENABLED=true
GAUZMEM_MODE=managed
GAUZMEM_URL=http://127.0.0.1:8788
GAUZMEM_ROOTS=logs/sessions
GAUZMEM_TIMEOUT_MS=45000
GAUZMEM_MODULE_ROOT=modules/gauzmem
GAUZMEM_STORE_ROOT=modules/gauzmem/.gauzmem-zero
```
