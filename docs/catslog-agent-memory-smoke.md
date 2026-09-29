# CatsLog Agent Memory staging smoke

`scripts/catslog-agent-memory-smoke.mjs` verifies the device-bound Agent API
routes served to CatsCo clients. The memory branch itself only consumes the
fused branch route plus the Skills catalog read; the smoke additionally covers
the remaining routes and both explicit writes. It is read-only by default
and never falls back to `CATSCO_LOG_API_BASE_URL`.

## Read-only check

Use a staging CatsLog URL and a CatsCompany user bearer:

```sh
CATSLOG_SMOKE_BASE_URL=https://logs.staging.example \
CATSLOG_SMOKE_USER_TOKEN="$CATSCO_USER_TOKEN" \
pnpm test:cross-repo:catslog-memory
```

This bootstraps a device-bound capability and checks:

- Skills catalog;
- Skill Graph;
- Skill Memory retrieval;
- dedicated session query;
- combined Memory recall.

For each read response it also checks the object envelope, the documented
`content_trust` value, the expected collection shape, and the presence of the
private-cache `ETag`. Requests never send a UID selector; the bearer-bound
capability remains the only scope input.

The two write routes are reported as skipped unless `--write` is passed.

## Explicit write check

Only run this against disposable staging data:

```sh
CATSLOG_SMOKE_BASE_URL=https://logs.staging.example \
CATSLOG_SMOKE_USER_TOKEN="$CATSCO_USER_TOKEN" \
CATSLOG_SMOKE_ALLOW_WRITES=true \
pnpm test:cross-repo:catslog-memory -- --write
```

Write mode retrieves a Skill body to obtain its short-lived receipt, reports a
bounded outcome, and appends one idempotent episode note using the separate
`memory_write_token`. Set `CATSLOG_SMOKE_SKILL_HANDLE` to select a known staging
Skill; otherwise `CATSLOG_SMOKE_TASK` (default `release`) is used. The script
refuses `*.catsco.fun` unless `CATSLOG_SMOKE_ALLOW_PRODUCTION=true` is also set.
If the staging catalog has no matching Skill fixture, the write check stops
before sending either write request.

The memory branch itself is retrieval-only and needs no write switches:

```dotenv
CATSLOG_MEMORY_ENABLED=true
```

The autonomous branch never emits outcome feedback and never writes notes; the
thin v1.3 surface is a fixed two-call pipeline: `assess_memory_need` decides
recall vs skip, retrieval runs mechanically (remote `catslog` branch fan-out +
local log search in parallel, top local turns auto-expanded), and
`finish_memory_search` closes the run. Explicit Skill outcome reports stay on
the `catsco catslog outcome` CLI command path.

## Branch lifecycle smoke

For a local branch-only check (no main-agent wait), run the focused lifecycle
tests:

```sh
pnpm exec tsx --test tests/catslog-branch-lifecycle.test.ts
```

The suite exercises observed-evidence context delivery, unobserved-citation
audit downgrade, audit-only delivery, bounded non-finishing loops, discard on
chitchat, and log redaction. The branch does not claim task outcomes; those are
owned by the main turn runtime. In a live run, inspect
`logs/branches/memory/<date>/*.jsonl` for `published_observation`,
`audited_observation`, `unobserved_refs_audit_only`, and `budget_exhausted`; a
raw `retrieval_receipt` must never appear there.
