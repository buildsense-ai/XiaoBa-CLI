# CatsCo Review Agent

Review Agent is not a separate agent process. It is XiaoBa-CLI running in a review role on the cloud computer.

It pulls redacted data from Cloud Server A, answers flexible natural-language questions from log evidence, finds repeated issue patterns, generates proposal files, and can optionally create a GitHub PR. Production prompt, skill, tool, and release changes still require human review.

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
Flexible log Q&A or proposal files
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
- `GET /catsco/review/turns`
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
CATSCO_REVIEW_LOOKBACK_HOURS=168
CATSCO_REVIEW_INTERVAL_MINUTES=1440
CATSCO_REVIEW_MAX_FAILURES=100
CATSCO_REVIEW_MAX_SESSIONS=30
CATSCO_REVIEW_MAX_ENTRIES_PER_SESSION=200
CATSCO_REVIEW_MAX_TURNS_PER_SESSION=80
CATSCO_REVIEW_MAX_TARGET_TURNS=500
CATSCO_REVIEW_TARGET_USER_ID=
CATSCO_REVIEW_TARGET_DEVICE_ID=
CATSCO_REVIEW_TARGET_DEVICE_NAME=
CATSCO_REVIEW_TARGET_USER_KEY=
CATSCO_REVIEW_TARGET_DEVICE_KEY=
CATSCO_REVIEW_TARGET_SESSION_ID=
CATSCO_REVIEW_TARGET_SESSION_KEY=
CATSCO_REVIEW_TARGET_SESSION_TYPE=
CATSCO_REVIEW_TARGET_ORG_KEY=
CATSCO_REVIEW_TARGET_ORG_TYPE=
CATSCO_REVIEW_TARGET_USER_ROLE=
CATSCO_REVIEW_TARGET_DEVICE_ROLE=
CATSCO_REVIEW_TARGET_CHANNEL_TYPE=
CATSCO_REVIEW_TARGET_WORKSPACE_KEY=
CATSCO_REVIEW_TARGET_REPO=C:\Catsco\XiaoBa-CLI
CATSCO_REVIEW_PR_BASE_BRANCH=main
CATSCO_REVIEW_GIT_REMOTE=myfork
CATSCO_REVIEW_CREATE_BRANCH=false
CATSCO_REVIEW_COMMIT_CHANGES=false
CATSCO_REVIEW_CREATE_GITHUB_PR=false
```

Use the Tailscale address or internal DNS name for `CATSCO_REVIEW_API_BASE_URL` if Cloud Server A is private.

Review API access requires `CATSCO_REVIEW_TOKEN`. Natural-language Q&A also requires the normal XiaoBa-CLI model configuration such as `GAUZ_LLM_PROVIDER`, `GAUZ_LLM_API_BASE`, `GAUZ_LLM_API_KEY`, and `GAUZ_LLM_MODEL`.

## Commands

Health check:

```bash
catsco review health
```

Generate local proposal files only:

```bash
catsco review run-once
```

In the normal XiaoBa-CLI Agent conversation, the Agent can use the built-in `review_logs_query` tool when the user asks log-related questions. This is the preferred path for daily use because the Review capability stays inside the original Agent instead of becoming a separate chat surface.

Ask arbitrary questions over the latest logs in a selected time range:

```bash
catsco review ask "这个老师最近主要用 Agent 做什么？"
catsco review ask "哪些问题导致了最长耗时？" --lookback-hours 72
catsco review ask "这一周所有老师主要问了什么？" --max-sessions 100 --max-turns-per-session 120
catsco review ask "学校用户最近一周主要用 Agent 做什么？" --org-type school
catsco review ask "这个老师的使用情况" --user-id <server-user-id> --max-target-turns 800
catsco review ask "这台教务处电脑最近主要问什么？" --device-name "教务处电脑"
```

Start a terminal debug chat that refreshes logs before each question:

```bash
catsco review chat
catsco review chat --user-key <review-user-key>
catsco review chat --org-key <school-or-customer-key>
catsco review chat --fixed-range
```

`review_logs_query`, `ask`, and `chat` are read-only. They fetch the same Review API data as `run-once`, build a redacted evidence pack, and answer from that evidence instead of a fixed report template. `review_logs_query` and `ask` pull logs up to the current moment every time they run. `chat` is mainly a terminal debugging mode and also refreshes the latest logs before each question by default, so newly uploaded logs can affect later answers. Use `--fixed-range` only when you need a reproducible investigation where every answer is grounded in the exact same fetched data.

The time range is controlled by `--lookback-hours` or `CATSCO_REVIEW_LOOKBACK_HOURS`. The default is the latest 168 hours, not a separate Agent conversation window. Increase the lookback value for older history, while keeping the max result limits high enough for the question.

Target filters can be configured in `.env` or passed on the command line. Stable keys (`user_key`, `device_key`, `session_key`) are preferred for repeatable analysis. Raw server identifiers (`user_id`, `device_id`, `device_name`, `session_id`) are supported only as Review API filters so you can target a known teacher, computer, or session; the client strips those raw fields from API responses and redacts raw identifier patterns before evidence is sent to the model.

Generate local proposal and usage files for one redacted user/device:

```bash
catsco review run-once --user-key <review-user-key>
catsco review run-once --device-key <review-device-key>
catsco review run-once --org-type school
catsco review run-once --user-id <server-user-id>
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
- Raw `user_id`, `device_id`, `device_name`, and `session_id` values are query filters only; Review Agent evidence uses stable keys plus safe org/role/channel context.
- API client calls use bounded response sizes, timeouts, and retry only transient 429/5xx failures.
- Release remains a separate human-approved step.

## Analysis Workflow

The Review Agent treats large log volume as a signal extraction problem:

1. Fetch only redacted Review API data for the selected review time range.
2. Convert summaries, failures, sessions, entries, turns, usage metrics, and analyzer findings into a bounded evidence pack.
3. For Q&A, refresh the latest selected time range per question by default, then score evidence against the user's question with Chinese keyword expansion, stable refs, and recent chat context for follow-ups.
4. For proposals, drop known noise such as health checks and scheduled-run completion messages.
5. Normalize ids, timestamps, numbers, and paths into stable pattern keys.
6. Cluster evidence by category and pattern key, then rank by severity, impact score, frequency, affected sessions, and tools involved.
7. Route each pattern to a proposal lane: prompt, skill, tool/code, config, reliability, observability, or eval.
8. Generate public proposals with summarized evidence and synthetic eval cases.
9. Keep raw server-redacted data local for the human reviewer.

## Usage Analysis

Each run also writes local-only usage outputs:

- `usage_report.md`: frequency, main usage topics, tool usage, and time distribution.
- `usage_metrics.json`: structured metrics for local inspection or downstream dashboards.

Usage reports intentionally do not include raw teacher questions or assistant answers. They use topic labels and hashed question references. To analyze a specific teacher, prefer the redacted `user_key` or `device_key` from Review API output and keep any real-name mapping outside Git. If you only know a server `user_id` or `device_name`, use it as a temporary filter, then rely on the returned stable keys in the answer.

For questions that do need the underlying wording, use `catsco review ask` or `catsco review chat`. These commands pass only a bounded, second-pass-redacted evidence pack to the model and print the answer locally; they do not add raw questions or answers to PR artifacts.
