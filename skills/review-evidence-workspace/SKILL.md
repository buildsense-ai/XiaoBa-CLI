---
name: review-evidence-workspace
description: Create and maintain a durable investigation workspace for sparse problem reports. Use it to preserve hypotheses, commands, logs, code references, test outputs, screenshots, recordings, failed attempts, and immutable evidence snapshots while an agent autonomously reproduces and locks down a problem.
---

# Review Evidence Workspace

Use this Skill whenever a Review Agent investigates a sparse report or a problem candidate. It preserves process data; it does not prescribe the investigation order or decide whether a problem is confirmed.

## Boundary

Do:

- Keep all observations for one investigation under one stable investigation ID.
- Record raw evidence and failed attempts, not only conclusions.
- Attach files without modifying their originals.
- Create immutable snapshots when the current evidence is ready for review or handoff.
- Continue choosing the next action from the current hypothesis and evidence gap.

Do not:

- Treat these commands as a mandatory pipeline.
- Claim an observation proves a root cause unless the evidence supports that inference.
- Store credentials, private reasoning, unrestricted user data, or unrelated repository files.
- Modify product source code through this Skill.

## Storage Root

The script requires either an explicit --root or XIAOBA_REVIEW_EVIDENCE_ROOT. For runtime use, set the latter to an isolated directory under the Review Agent data root. Never default evidence into the source repository.

Each investigation contains case.json, append-only events.ndjson, and copied artifacts. Snapshots are written separately under bundles and include SHA-256 hashes.

## Commands

The script path is scripts/review-evidence-workspace.mjs relative to this Skill directory.

Create an investigation:

/usr/local/bin/node scripts/review-evidence-workspace.mjs init --root <evidence-root> --title <title> --source <user|log|inspection|pr> --description <sparse-description>

Record an observation or failed attempt:

/usr/local/bin/node scripts/review-evidence-workspace.mjs record --root <evidence-root> --id <investigation-id> --kind <code|log|process|test|agentic|browser|note> --summary <fact> --hypothesis <current-hypothesis> --source <origin>

Attach a log, screenshot, recording, trace, test output, or other file by adding --artifact <path>. The script copies it and records its SHA-256 hash.

Inspect current state:

/usr/local/bin/node scripts/review-evidence-workspace.mjs show --root <evidence-root> --id <investigation-id>

Create an immutable handoff snapshot:

/usr/local/bin/node scripts/review-evidence-workspace.mjs snapshot --root <evidence-root> --id <investigation-id> --assessment <confirmed|not-reproduced|needs-more-evidence> --conclusion <current-conclusion>

## Agentic Use

Before a consequential test, state the hypothesis and what outcome would support or weaken it. After the test, record the observable result, source, environment, and artifact. Then decide the next action from the remaining uncertainty.

Prefer the smallest discriminating test. Expand from code to logs, processes, agentic dialogue, or browser evidence only when it increases information. Stop when the evidence is decision-ready, blocked, disproven, or no longer worth the budget.

## Handoff

A decision-ready handoff should reference the snapshot path and summarize the normalized problem, impact, reproduction, expected versus actual behavior, mechanism or root cause confidence, rejected explanations, proposed direction, acceptance criteria, and remaining uncertainty.
