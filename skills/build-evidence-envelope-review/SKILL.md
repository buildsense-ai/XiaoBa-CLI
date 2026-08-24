---
name: build-evidence-envelope-review
description: "Drive a software or agentic-system Finding into the most complete practical Evidence Envelope, judge whether the envelope is complete enough for a final reviewer recommendation, and recommend exactly one terminal outcome: open an Issue or close the Finding. Use for findings, anomalous behaviors, audit observations, uncertain bugs, reliability incidents, evidence reviews, and requests to exhaust plausible explanations before deciding whether an issue exists."
---

# Build Evidence Envelope Review

Turn a Finding into an auditable, reproducible, decision-complete Evidence Envelope. The main Skill owns review direction, evidence sufficiency, completeness judgment, and the final recommendation. Sampling, reproduction, log clustering, code graphing, testing, and report generation are subordinate means, not terminal outcomes.

## Terminal Contract

A review has only three review states:

1. `INCOMPLETE`: material evidence gaps remain. Continue evidence work or record the concrete blocker and next evidence action.
2. `COMPLETE_ISSUE`: the envelope is complete enough to recommend opening an Issue.
3. `COMPLETE_CLOSE`: the envelope is complete enough to recommend closing the Finding.

Never present sampling, reproduction, monitoring, more analysis, or a fix as a terminal recommendation. Those are evidence-acquisition actions. A fix begins after an Issue is accepted.

## Output Contract

Maintain one directory per Finding. Produce at minimum:

1. `finding.json`: normalized Finding and review scope.
2. `claims.json`: claims, confidence, and evidence citations.
3. `hypotheses.json`: exhaustive-enough hypothesis ledger with support, counter-evidence, and gaps.
4. `evidence-index.json`: typed evidence records and provenance.
5. `completeness.json`: gate results, material unresolved questions, and review state.
6. `decision.json`: `INCOMPLETE`, `COMPLETE_ISSUE`, or `COMPLETE_CLOSE`, with rationale.
7. `manifest.json`: file hashes, generation time, tool versions, and source boundaries.
8. `reports/human-report.pdf`: human-friendly report.

Use `scripts/scaffold-envelope.py` to initialize the package and `scripts/validate-envelope.py` before delivery.

## Finding Pool, Registry, and Process Ownership

The main Skill owns the review method, the SQLite Finding Pool, per-Finding Evidence Envelopes, the local Workbench, and human reports. These are components of this Skill, not separate products or disconnected skills.

The real Review Runtime integration now lives in `src/review/`. It reuses `createAdapterRuntime`, `MessageSessionManager`, `AgentSession`, and `SubAgentManager`; persists Finding-to-Session-to-Task handoffs in an atomic Review Run store; exposes the `review_runtime` tool for dynamic Task proposals and mandatory Goal Checks; supports human approval, heartbeat wake-up, fail-closed restart recovery, validated Envelope commit, and a strict public projection. Use `npm run review:runtime -- help` for the runnable entry points. See `references/review-agent-runtime-v0.1.md`.

`scripts/review_runtime.py` remains only as a superseded Skill-local state-ledger prototype. It must not be used for Agent execution or Runtime acceptance.

The Workbench's primary job is to let people browse the Finding Pool: what Findings exist, what problem each describes, what evidence exists, who owns it, and what changed most recently. It is not a linear-process report. Do not make fixed lifecycle diagrams or decision prose the primary dashboard experience.

Do not leave Envelope directories as unmanaged files.

Use `scripts/finding_manager.py` and `references/process-management.md` to:

- create or register every Finding in the SQLite registry;
- project each Finding's normalized observation, impact, concise evidence directory, counts, owner, priority, lifecycle state, and recent activity into SQLite for fast Pool queries;
- assign owner and priority;
- track the work stage: `INTAKE`, `MAPPING`, `COLLECTING`, `CHALLENGING`, `JUDGING`, or `TERMINAL`;
- record every stage change, metadata update, synchronization, and reopening as an event;
- synchronize review state and completeness gates from the Evidence Envelope;
- prevent illegal transitions and prevent an incomplete Envelope from becoming terminal;
- query all Findings and present them through the human workbench.

SQLite is the queryable operational projection, not a replacement for evidence. Sync only the safe, concise Pool fields: normalized problem text, ownership, lifecycle state, evidence ID/type/title/acquisition date/method/redaction/limitations and source hash. Do not copy raw source paths, full payloads, prompts, output bodies, credentials, or arbitrary evidence content into the Pool. `evidence-index.json`, claims, hypotheses, completeness, decision and manifest remain the authoritative auditable records.

The operational work stage is not the review outcome. Evidence work may loop backward. The review outcome remains `INCOMPLETE` until the Envelope supports exactly `COMPLETE_ISSUE` or `COMPLETE_CLOSE`.

Start the human-friendly local workbench with `scripts/webapp_server.py`. The default view must be Finding Pool first: Finding ID, title, normalized observation, owner/priority, evidence count and concise evidence titles, material gaps or current recommendation, and latest change. Put lifecycle controls and detailed review mechanics behind a selected Finding or a secondary control. Keep it local unless authentication is added.

## Workflow

### 1. Normalize the Finding

Load the applicable human-owned Review Constitution or explicit product contract and record its version or hash. Follow `references/governance.md`.

State the observed behavior without embedding a cause. Record scope, affected actor, time window, expected behavior, actual behavior, impact, initial source, safety constraints, and the exact decision question.

Separate:

- observation: what was seen;
- interpretation: what it may mean;
- decision question: whether this should become an Issue or be closed.

### 2. Build the hypothesis space

Generate hypotheses by mechanism, not by favorite vendor or component. Cover applicable layers:

- observation or logging artifact;
- expected product behavior or contract ambiguity;
- caller/input/context;
- local business logic;
- parsing, filtering, aggregation, state, or concurrency;
- dependency, provider, relay, storage, or queue;
- HTTP, streaming, network, timeout, or retry behavior;
- configuration, deployment, version, environment, permissions, or capacity;
- data integrity, privacy, security, or request-attribution failure;
- observability insufficiency that prevents discrimination.

Each material hypothesis must have a status: `SUPPORTED`, `WEAKENED`, `EXCLUDED`, or `UNRESOLVED`. See `references/hypothesis-method.md`.

### 3. Collect evidence by value of information

Choose the next action that best separates material hypotheses at acceptable risk and cost. Route the gap to the smallest suitable means:

- source/log/config reading;
- deterministic collector or historical clustering script;
- code graph or runtime-flow inspection;
- focused tests;
- controlled reproduction;
- redacted production sampling;
- independent reviewer challenge;
- report rendering and visual verification.

Follow `references/tool-routing.md`. Preserve raw references; keep derived evidence reproducible. Never silently convert an inference into a direct observation.

### 4. Maintain claim and evidence provenance

For every claim, cite evidence IDs. Classify evidence as `DIRECT`, `DERIVED`, `VALIDATION`, `COUNTER`, or `CONTEXT`. Record source path or endpoint scope, acquisition method, timestamp, redaction, collector/script hash, and limitations.

Do not call an inferred attempt count a saved raw response. Do not call detected event clusters an incident rate without a denominator. Do not treat a missing log field as proof that an event did not occur.

### 5. Push the review limit

Run two challenge passes before judging completeness:

1. Coverage challenge: which plausible mechanism class is absent?
2. Adversarial challenge: if the leading explanation is wrong, which evidence would reveal it?

Use an independent reviewer when available. Require it to find omitted hypotheses, weak provenance, sampling bias, non-representative reproductions, and over-strong language. Return to source evidence for every material objection.

### 6. Judge completeness

Apply all gates in `references/completeness-gates.md`.

The envelope is complete only when:

- the decision question and scope are stable;
- every material claim has traceable evidence;
- all plausible material hypothesis classes were considered;
- no unresolved material hypothesis can flip the Issue-versus-Close recommendation;
- reproduction and sampling are represented with their true evidentiary limits;
- privacy, integrity, and provenance checks pass;
- an independent challenge found no unaddressed material gap;
- the final recommendation follows from evidence, not urgency.

Unknown details may remain only if they cannot change the final recommendation. If a missing observation can still flip Issue versus Close, the envelope is `INCOMPLETE`.

An observability deficiency may justify a separate Issue, but it does not magically complete the original Finding. Reframe and review that deficiency as its own Finding if needed.

### 7. Recommend exactly one terminal outcome

For a complete envelope:

- `COMPLETE_ISSUE`: recommend an Issue when evidence establishes a violated contract, harmful defect, reliability risk, security/privacy risk, or independently actionable infrastructure deficiency.
- `COMPLETE_CLOSE`: recommend closing when evidence shows expected behavior, false positive, duplicate, non-actionable observation, accepted limitation, or insufficiently supported concern after adequate discriminating evidence.

For an incomplete envelope, do not pretend to decide. State the highest-value missing evidence, acquisition method, safety boundary, and stop condition.

### 8. Produce the human report

Follow `references/human-report.md`. The first page must answer in under one minute:

- What is the Finding?
- Is the envelope complete?
- What decisive evidence exists?
- What material gap remains, if any?
- What does the reviewer recommend?

Keep the report visual and sparse. Put audit details in appendices and machine files, not on the executive page. Visually inspect every delivered page.

## Guardrails

- Evidence before explanation; explanation before decision.
- A Finding is not an Issue until the envelope supports it.
- `INCOMPLETE` is a valid state, not a failure; vague “continue observing” is not a valid next action.
- Never modify production or restart a service without authorization.
- Default production diagnostics to off, redacted, event-triggered, and shape-only.
- Do not capture prompts, message bodies, model output text, tool arguments, credentials, tokens, or authorization headers unless explicitly authorized and necessary.
- Keep experimental artifacts outside source code unless the user asks to integrate them.
- Hash immutable inputs and generated artifacts. Record when live logs can drift after hashing.
- Run `python3 scripts/self-test.py` after changing this Skill.
