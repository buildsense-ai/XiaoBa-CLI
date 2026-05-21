# CatsCo Review Agent

Review Agent is not a separate agent process. It is XiaoBa-CLI running in a review role on the cloud computer.

It pulls redacted data from Cloud Server A, finds repeated issue patterns, generates proposal files, and can optionally create a GitHub PR. Production prompt, skill, tool, and release changes still require human review.

## Architecture

```text
Cloud Server A
  /catsco/review/* with Review Token
        |
        v
Cloud Computer
  XiaoBa-CLI review command
        |
        v
Proposal files
  .catsco-review/proposals/<run_id>/
        |
        v
Optional PR
  Human review -> merge -> release
```

## Required Cloud Server A State

Cloud Server A must already have the review API deployed:

- `GET /catsco/review/health`
- `GET /catsco/review/summary`
- `GET /catsco/review/failures`
- `GET /catsco/review/sessions`
- `GET /catsco/review/sessions/{session_record_id}/entries`
- `GET /catsco/review/sessions/{session_record_id}/turns`

The cloud computer stores the plaintext Review Token in its local `.env`. Cloud Server A stores only the token hash.

## Environment

Add these values to the XiaoBa-CLI `.env` on the cloud computer:

```text
CATSCO_REVIEW_ENABLED=true
CATSCO_REVIEW_API_BASE_URL=https://logs.catsco.fun:8000
CATSCO_REVIEW_TOKEN=<plaintext Review Token from Cloud Server A>
CATSCO_REVIEW_OUTPUT_DIR=data/catsco-review-agent/runs
CATSCO_REVIEW_LOOKBACK_HOURS=24
CATSCO_REVIEW_INTERVAL_MINUTES=1440
CATSCO_REVIEW_MAX_FAILURES=100
CATSCO_REVIEW_MAX_SESSIONS=30
CATSCO_REVIEW_MAX_ENTRIES_PER_SESSION=200
CATSCO_REVIEW_MAX_TURNS_PER_SESSION=80
CATSCO_REVIEW_TARGET_USER_KEY=
CATSCO_REVIEW_TARGET_DEVICE_KEY=
CATSCO_REVIEW_TARGET_REPO=C:\Catsco\XiaoBa-CLI
CATSCO_REVIEW_PR_BASE_BRANCH=main
CATSCO_REVIEW_GIT_REMOTE=myfork
CATSCO_REVIEW_CREATE_BRANCH=false
CATSCO_REVIEW_COMMIT_CHANGES=false
CATSCO_REVIEW_CREATE_GITHUB_PR=false
```

Use the Tailscale address or internal DNS name for `CATSCO_REVIEW_API_BASE_URL` if Cloud Server A is private.

## Commands

Health check:

```bash
catsco review health
```

Generate local proposal files only:

```bash
catsco review run-once
```

Generate local proposal and usage files for one redacted user/device:

```bash
catsco review run-once --user-key <review-user-key>
catsco review run-once --device-key <review-device-key>
```

Run periodically on the cloud computer in proposal-only mode:

```bash
catsco review daemon
```

`daemon` ignores PR/commit flags and writes local proposal files only. Use Windows Task Scheduler or a process manager to keep it running, or schedule `catsco review run-once` directly.

Each run uses a fixed `uploaded_from`/`uploaded_to` window and paginates failures, sessions, entries, and turns. This prevents a long-running review from chasing newly uploaded logs forever and keeps each proposal tied to a reproducible review window.

Generate proposal files and commit them to a review branch:

```bash
catsco review run-once --create-branch --commit
```

Create a PR with GitHub CLI:

```bash
gh auth login
catsco review run-once --create-branch --commit --create-pr
```

## Output Files

Each run writes:

```text
report.md
findings.json
prompt_suggestions.md
skill_suggestions.md
code_suggestions.md
eval_cases.jsonl
usage_report.md
usage_metrics.json
raw_review_data.server_redacted.local.json
```

When Git mode is enabled, those files are copied to:

```text
.catsco-review/proposals/<run_id>/
```

Git/PR mode copies only `report.md`, `findings.json`, `prompt_suggestions.md`, `skill_suggestions.md`, `code_suggestions.md`, and `eval_cases.jsonl`. `usage_report.md`, `usage_metrics.json`, and `raw_review_data.server_redacted.local.json` stay local and must not be committed.

Public proposal files contain pattern summaries and synthetic eval inputs. Detailed server-redacted review data remains local for manual inspection.

## Safety Model

- The Review Agent uses a separate Review Token, not the log-upload token.
- It reads only redacted review data.
- It does not modify production prompt or skill files by default.
- PR mode commits proposal artifacts only.
- Scheduled daemon mode never creates branches, commits, pushes, or PRs.
- Raw review data and user-level usage reports are kept out of Git/PR output.
- API client calls use bounded response sizes, timeouts, and retry only transient 429/5xx failures.
- Release remains a separate human-approved step.

## Analysis Workflow

The Review Agent treats large log volume as a signal extraction problem:

1. Fetch only redacted Review API data for the fixed review window.
2. Drop known noise such as health checks and scheduled-run completion messages.
3. Normalize ids, timestamps, numbers, and paths into stable pattern keys.
4. Cluster evidence by category and pattern key, then rank by severity, impact score, frequency, affected sessions, and tools involved.
5. Route each pattern to a proposal lane: prompt, skill, tool/code, config, reliability, observability, or eval.
6. Generate public proposals with summarized evidence and synthetic eval cases.
7. Keep raw server-redacted data local for the human reviewer.

## Usage Analysis

Each run also writes local-only usage outputs:

- `usage_report.md`: frequency, main usage topics, tool usage, and time distribution.
- `usage_metrics.json`: structured metrics for local inspection or downstream dashboards.

Usage reports intentionally do not include raw teacher questions or assistant answers. They use topic labels and hashed question references. To analyze a specific teacher, use the redacted `user_key` or `device_key` from Review API output and keep any real-name mapping outside Git.
