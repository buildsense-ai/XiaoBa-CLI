# CatsLog Agent Memory staging smoke

`scripts/catslog-agent-memory-smoke.mjs` verifies the device-bound Agent API
from the same boundary used by the memory branch. It is read-only by default
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

The memory branch itself remains read-only by default:

```dotenv
CATSLOG_MEMORY_ENABLED=true
CATSLOG_SKILL_OUTCOMES_ENABLED=false
CATSLOG_MEMORY_WRITE_ENABLED=false
```

Outcome feedback in the branch is receipt-bound. Legacy no-receipt outcomes are
kept on the explicit CLI command path, not exposed to the autonomous branch.
