# Review Agent Runtime v0.1

## Current implementation

The real v0.1 integration is implemented in the application layer under `src/review/`:

- `review-adapter.ts`: Trigger, heartbeat wake-up, human approval, SubAgent dispatch, result reconciliation, restart recovery, Goal Check enforcement, Envelope commit, and public projection.
- `review-run-store.ts`: atomic JSON persistence with schema validation, 0600 permissions, corruption quarantine, and a fail-closed corruption latch.
- `review-runtime-tool.ts`: the session-bound `review_runtime` tool used by the main Reviewer to propose dynamic Tasks, persist a Goal Check before stopping, and commit a completed Task after updating the Envelope.
- `review-envelope-gateway.ts`: confines Envelope paths to the configured workspace, invokes the authoritative validator, then synchronizes the Finding Pool.
- `review-approval-inbox.ts`: private 0700/0600 cross-process handoff. CLI approval text is consumed by the persistent Owner, so a temporary CLI process never owns or interrupts the dispatched SubAgent.
- `review-heartbeat-owner.ts` and `review-workbench-owner.ts`: attach Heartbeat, approval consumption, and the read-only Workbench process to the persistent Dashboard lifecycle, with drain-on-stop behavior.
- `review-adapter-cli.ts`: runnable Trigger, one-shot heartbeat, recovery, safe status inspection, and natural-language or structured approval submission to the persistent Owner.

This is a Review-specific persistence and orchestration layer. It is not a second reasoning runtime. The main Reviewer still runs in `AgentSession`; Skills, Tools, and SubAgents still run through the shared XiaoBa Runtime.

## Runtime flow

1. A manual Trigger or heartbeat discovers a new or unfinished Finding.
2. The Adapter creates or restores the stable `review:<findingId>` Agent Session.
3. The main Reviewer reloads the authoritative Evidence Envelope and follows this Skill.
4. The Reviewer chooses the next action dynamically. Specialist work is persisted with `review_runtime propose_task`.
5. Medium/high-risk work always waits for human approval. Low-risk work can be policy-approved only when explicitly marked as not requiring approval.
6. Approved specialist work is executed by the existing `SubAgentManager`.
7. Candidate results return to the main Reviewer. They remain `result_pending_commit` until the Reviewer updates the Evidence Envelope.
8. `review_runtime commit_task` validates the Envelope, synchronizes the Pool, and only then marks the Task committed.
9. Before every Reviewer turn stops, `review_runtime goal_check` must persist completeness, the next action or blocker, and the stop condition. Missing Goal Check fails closed.
10. A terminal Run is accepted only when the validated Envelope is `COMPLETE_ISSUE` or `COMPLETE_CLOSE` and no Review Task remains unfinished.

## Recovery contract

The Envelope is authoritative for evidence and decision facts. The Review Run store is authoritative only for execution handoffs: Finding-to-Session binding, dynamic Tasks, approval, SubAgent binding, result-pending-commit state, and recovery events.

After a process restart, an in-memory `running` or `waiting_for_input` SubAgent that cannot be found is changed to `interrupted`. It is never silently assumed to have succeeded and is never automatically repeated. Explicit human re-approval is required before retry. Stable Task idempotency keys prevent duplicate proposals across repeated wakes.

A heartbeat skips terminal Runs, running Tasks, user-input waits, approval waits, and Runs whose `nextWakeAt` is not due. An idle incomplete Goal Check defaults to a 24-hour backoff; a failed wake defaults to a one-hour retry. It wakes eligible unfinished Findings and also discovers new Finding directories. The Dashboard-owned loop isolates pulse failures and drains an in-flight pulse before shutdown.

## Public projection

The public projection intentionally excludes:

- Envelope and artifact paths;
- Session keys;
- Task objectives, prompts, safety details, and expected artifact bodies;
- SubAgent result text and output files;
- raw internal errors and approval notes.

It exposes only opaque Run/Finding/Task IDs, controlled Run and Task states, approval/risk flags, Goal Check booleans, counts, timestamps, controlled blocker/error codes, and event types. Goal text, Goal Check prose, Task titles, actors, and event summaries remain private.

## Commands

Run `npm run review:runtime -- help`.

Examples:

```text
npm run review:runtime -- trigger F-2026-001 --workspace review/evidence-envelopes --actor reviewer
npm run review:runtime -- heartbeat --workspace review/evidence-envelopes
npm run review:runtime -- serve --workspace review/evidence-envelopes --interval 60000
npm run review:runtime -- reply F-2026-001 "批准 TASK_ID：bounded diagnostic approved" --actor approver
npm run review:runtime -- approve F-2026-001 TASK_ID --actor approver --note "bounded diagnostic approved"
npm run review:runtime -- reject F-2026-001 TASK_ID --actor approver --note "authorization scope is unclear"
npm run review:runtime -- show F-2026-001 --workspace review/evidence-envelopes
npm run review:runtime -- recover --workspace review/evidence-envelopes
```

## Superseded prototype

`scripts/review_runtime.py` is still present only as an auditable, superseded state-ledger prototype. Its SQLite tables and synthetic tests do not execute an Agent or specialist Task and must not be used as Runtime acceptance evidence.

The old prototype Run `RUN-F-2026-001-20260726T023648Z-b942eed4` remains a prototype record. Do not approve it as proof of the real Runtime path.

## Validation performed

The application test `tests/review-adapter.test.ts` covers:

- atomic persistence and corruption latch;
- dynamic Reviewer Task proposal;
- approval-gated real SubAgent dispatch contract;
- result reconciliation and validated terminal commit;
- Task idempotency;
- restart interruption and explicit re-approval;
- heartbeat discovery and missing-Goal-Check fail-closed behavior;
- rejection of terminal Goal Check with unfinished Tasks;
- negative tests for path, Session, prompt, artifact, and raw-error leakage;
- session binding of the `review_runtime` tool;
- deterministic natural-language approval, ambiguity rejection, and required rejection reasons;
- private approval-inbox atomicity, restart recovery, controlled errors, and no temporary-process dispatch;
- Dashboard Heartbeat/Workbench owner startup, shutdown drain, interval validation, and real Python process lifecycle;
- Workbench exact-field whitelist, interrupted-Task re-approval visibility, read-only guidance, and negative leakage checks.

## Remaining production work

The persistent Dashboard now owns the Review Heartbeat and read-only Workbench when they are enabled. A non-Dashboard deployment still needs an equivalent process supervisor. v0.1 intentionally has no Workbench approval buttons: people approve or reject by natural-language CLI reply, which is handed to the persistent Review Session through the private inbox. Production TLS, authentication, multi-user RBAC, and automated production diagnostics remain outside v0.1. Production-affecting specialist Tasks remain approval-gated.
