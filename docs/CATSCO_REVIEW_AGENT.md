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
CATSCO_REVIEW_MAX_FAILURES=100
CATSCO_REVIEW_MAX_SESSIONS=30
CATSCO_REVIEW_MAX_ENTRIES_PER_SESSION=200
CATSCO_REVIEW_MAX_TURNS_PER_SESSION=80
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
eval_cases.jsonl
raw_review_data.redacted.json
```

When Git mode is enabled, those files are copied to:

```text
.catsco-review/proposals/<run_id>/
```

## Safety Model

- The Review Agent uses a separate Review Token, not the log-upload token.
- It reads only redacted review data.
- It does not modify production prompt or skill files by default.
- PR mode commits proposal artifacts only.
- Release remains a separate human-approved step.
