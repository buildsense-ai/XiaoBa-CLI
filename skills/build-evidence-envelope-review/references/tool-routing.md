# Tool and Sub-Skill Routing

The main Skill owns the review. Sub-skills and scripts only acquire or present evidence.

## Read and search

Use file listing, grep, and targeted reads to locate sources, code paths, configs, tests, and existing artifacts. Start narrow; expand scope only when the hypothesis ledger justifies it.

## Deterministic collectors

Write a read-only collector when manual counting, clustering, or extraction would be error-prone. Save:

- script;
- exact input scope and cutoff;
- machine-readable output;
- run log;
- script/input/output hashes;
- limitations.

## Code graph

Use a code-graph skill when an unfamiliar repository or cross-component runtime path makes ownership and dependencies unclear. Static edges are code-site evidence, not runtime frequency.

## Focused tests

Use tests to verify local semantics, boundaries, and regressions. Record runtime version and exact selection. Environment crashes must be separated from product failures.

## Controlled reproduction

Use the lowest-risk faithful layer: pure function, component, local HTTP/SSE, staging, replay, then production only with authorization. Record what the reproduction proves and does not prove.

## Production sampling

Use only when existing evidence cannot discriminate material hypotheses. Prefer default-off, event-triggered, redacted, bounded, shape-only attempt records. Define allowed and forbidden fields, authorization, duration, stop conditions, and rollback.

## Independent reviewer

Use a separate reviewer for hypothesis coverage, provenance, completeness gates, and language. The main reviewer must verify objections against source artifacts.

## Human report

Generate the report only after the machine envelope is internally consistent. Use a separate report renderer when useful, then visually verify every page before delivery.
