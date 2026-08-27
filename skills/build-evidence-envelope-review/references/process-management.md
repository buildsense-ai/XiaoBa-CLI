# Finding Process Management

## Two coordinated records

Use SQLite as the queryable Finding Pool and operational coordinator. Use each Evidence Envelope directory for evidence facts and decision provenance.

The Pool owns safe, searchable projections: Finding ID, title, normalized observation and impact, owner, priority, current work stage, review state, next action, stop condition, timestamps, latest events, and a concise evidence directory. The evidence directory contains only ID, type, title, acquisition method/date, redaction, limitations, and source hash. It must not copy source paths or raw evidence payloads.

The Envelope owns observations, claims, hypotheses, full evidence records and provenance, completeness gates, the review recommendation, and the manifest. Never edit evidence conclusions only in the Pool. Update the Envelope, rebuild its manifest, validate it, and synchronize it into the Pool.

The human Workbench is a Finding Pool browser first: what Findings exist, what problem each is, and which evidence exists. Lifecycle controls are secondary operational actions, not the dashboard's primary story.

## Work stages

1. `INTAKE`: normalize the Finding and decision question.
2. `MAPPING`: map plausible mechanism classes and material hypotheses.
3. `COLLECTING`: acquire discriminating positive and negative evidence.
4. `CHALLENGING`: run coverage and adversarial review passes.
5. `JUDGING`: apply completeness gates and draft the recommendation.
6. `TERMINAL`: the validated Envelope supports `COMPLETE_ISSUE` or `COMPLETE_CLOSE`.

The work stage and review state are different. Work can loop backward when a challenge exposes a gap. Review state remains `INCOMPLETE` until the terminal contract is satisfied.

Allowed normal transitions are:

- `INTAKE → MAPPING`
- `MAPPING ↔ INTAKE` or `MAPPING → COLLECTING`
- `COLLECTING ↔ MAPPING` or `COLLECTING → CHALLENGING`
- `CHALLENGING ↔ COLLECTING` or `CHALLENGING → JUDGING`
- `JUDGING → COLLECTING`, `CHALLENGING`, or `TERMINAL`

A terminal Finding can be reopened only to `INTAKE`, with an explicit actor and reason. Preserve the previous decision and reopening event.

## Manager commands

Use `scripts/finding_manager.py` with an explicit workspace.

- Initialize: `python3 scripts/finding_manager.py --workspace review/evidence-envelopes init`
- Create: `python3 scripts/finding_manager.py --workspace review/evidence-envelopes create --id F-2026-001 --title "..." --owner NAME`
- Register existing Envelope: `python3 scripts/finding_manager.py --workspace review/evidence-envelopes register --envelope PATH`
- Synchronize evidence facts: `python3 scripts/finding_manager.py --workspace review/evidence-envelopes sync FINDING_ID`
- Move work stage: `python3 scripts/finding_manager.py --workspace review/evidence-envelopes transition FINDING_ID --to COLLECTING --actor NAME --note "..."`
- Query: `python3 scripts/finding_manager.py --workspace review/evidence-envelopes list --json`

## Human workbench

Start the local workbench with:

`python3 scripts/webapp_server.py --workspace review/evidence-envelopes --port 8765`

The web app presents status, evidence gaps, next action, completeness gates, hypotheses, and event history without exposing raw JSON. It can synchronize an Envelope, update operational ownership, and perform legal stage transitions.

Bind to `127.0.0.1` by default. Do not expose the write-capable app to an untrusted network without authentication and authorization.
