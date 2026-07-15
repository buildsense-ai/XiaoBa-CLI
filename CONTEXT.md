# XiaoBa Agent Runtime

This context defines the vocabulary for CatsCo/XiaoBa agent runtime behavior, especially background agents, memory, and log-derived knowledge.

## Language

**Runtime**:
A running CatsCo/XiaoBa installation that owns local configuration, logs, schedulers, and tool execution for one agent body.
_Avoid_: Session, conversation, process

**Heartbeat Log Distillation Agent**:
A runtime-scoped background agent that wakes on a schedule to turn local session logs into durable knowledge candidates.
_Avoid_: Session agent, turn branch, log uploader

**Distillation Heartbeat**:
The periodic wake-up cycle used by the heartbeat log distillation agent. The first default cadence is six hours to favor stable evidence over immediacy.
_Avoid_: Turn trigger, session trigger, real-time hook

**Session Log Source**:
A configured producer category from which the Runtime admits session evidence for heartbeat processing. It describes the origin of a log, not an Agent that the Runtime may invoke.
_Avoid_: External Agent, provider model, upload destination

**Internal Session Log Source**:
A session log emitted by the XiaoBa Runtime itself. Internal sources are enabled by default and remain the baseline input for local heartbeat distillation.
_Avoid_: Local-only feature, branch transcript, runtime observation

**External Session Log Source**:
A supported conversation source produced by another coding agent or tool, such as Pi, Codex, or Claude Code. External sources are opt-in and keep their source identity when admitted into the Runtime; they do not gain authority to write Skills or Registry state.
_Avoid_: External Agent executor, cloud source, imported skill

**External Provider Identity**:
A stable, normalized identifier supplied by the external reader for one provider namespace. XiaoBa treats it as opaque rather than enumerating known coding agents, so future providers can join without changing capability semantics.
_Avoid_: Provider enum, model name, display label

**Enabled External Provider Set**:
The Runtime operator-selected set of External Session Log Sources eligible for continuous heartbeat admission. Membership is independent per provider; removing a provider pauses new admission without deleting its cursor, evidence, or audit history.
_Avoid_: Selected provider, active provider, provider rotation target

**External Source Scope**:
The configurable set of xURL threads visible to one External Session Log Source, global by default and optionally narrowed by project path. Scope filters admission without changing provider identity; newly included historical threads must establish an External Activation Baseline before admission.
_Avoid_: Provider identity, cursor namespace, historical backfill range

**External Provider Admission Gate**:
A durable per-provider switch that controls whether a Source Work Lane may claim new external work. Closing the gate cancels replayable reads and lets only an admission already committing settle atomically; reopening it resumes from the preserved cursor.
_Avoid_: Cursor reset, immediate process kill, source deletion

**Session Log Source Adapter**:
A bounded Runtime boundary that reads one supported Session Log Source and presents it in the canonical session-log shape used by Log Cursor and Distillation Unit processing. An adapter may use a provider-specific reader such as xURL, but source-specific discovery does not change heartbeat ownership.
_Avoid_: Direct heartbeat provider call, arbitrary transcript replay, source-specific reviewer

**xURL Rendered Timeline**:
The provider-neutral, numbered User, Assistant, and Context Compacted view that official xURL renders for one external thread. XiaoBa may derive source positions and fingerprints from this view but never treats its Markdown as agent instructions or parses the underlying provider log.
_Avoid_: Raw provider log, custom xURL protocol, trusted prompt

**External Session Log Backfill**:
An explicit, bounded operation that admits pre-existing conversations from an External Session Log Source. It is separate from ordinary source enablement, remains disabled by default, and must not turn on historical scanning implicitly.
_Avoid_: Startup replay, unlimited history import, automatic provider migration

**External Evidence Admission**:
The admission of normalized external session entries into the ordinary Learning Episode and capability-review pipeline. External evidence preserves provider provenance and receives the same evidence, review, transcript, and promotion gates as Internal Session Log Source evidence.
_Avoid_: Trusted import, direct promotion, external-only review path

**External Admission Coordinator**:
The Runtime-owned single writer that durably admits stable pages produced by External Source Work Lanes. Provider reads may overlap, but Episode, Capsule, provenance, and cursor acknowledgement settle through this coordinator in fair, page-sized turns among ready lanes.
_Avoid_: Parallel evidence writers, provider-owned promotion, cursor-first acknowledgement

**External Evidence Page**:
A bounded, replayable batch of stable source events offered by one External Source Work Lane for admission. It may be canceled or discarded before commit begins; once commit starts, its Episode, Capsule, provenance, and final cursor acknowledgement settle as one ordered admission.
_Avoid_: Irrevocable read result, partial cursor advance, full conversation mirror

**Source Event Identity**:
The stable provider-scoped identity and monotonic position used to resume a Session Log Source without duplicating or losing events. Internal JSONL may use a byte position; an External Session Log Source may derive an equivalent identity from its thread, normalized timeline ordinal range, and immutable content fingerprint.
_Avoid_: Fetch timestamp, array index, display title, ephemeral URI

**Evidence Capsule**:
A bounded, locally retained subset of an admitted source episode that is sufficient to reconstruct and verify its Evidence Bundle without mirroring the complete source conversation. It preserves source identity, revision or content hashes, and the selected turns needed by review and audit.
_Avoid_: Full transcript mirror, temporary prompt context, unbounded cache

**Source Work Lane**:
A durable, independently scheduled stream of Session Log Source work within the local Heartbeat Scheduler. Each lane owns its cursor, due time, quota, adapter state, and retry/backoff; the Internal lane settles first, after which distinct External lanes may run concurrently without sharing admission state.
_Avoid_: Parallel heartbeat scheduler, in-memory queue only, global unbounded scan

**External Source Stability Gate**:
The adapter condition that makes an external event range safe for heartbeat admission: a completed User-to-Assistant range has a stable identity and revision, established either by the reader or by repeated identical normalized observations. An in-progress or mutable conversation remains outside the distillation cursor until it reaches this condition.
_Avoid_: Latest fetch, wall-clock age alone, partial conversation admission

**External Reader Compatibility Gate**:
The condition that a new external-reader version must preserve the normalized timeline and existing event fingerprints before a Source Work Lane may continue. A version-number change alone neither grants compatibility nor forces a rebaseline.
_Avoid_: Exact-version pin, best-effort format parsing, automatic history rewrite

**External Activation Baseline**:
A resumable, non-admitting snapshot of every existing thread in one newly enabled External Session Log Source. It records each thread's current rendered timeline position and fingerprints so only later entries can cross the External Provider Admission Gate; an incomplete baseline leaves the provider blocked rather than partially active.
_Avoid_: Historical backfill, first heartbeat import, evidence snapshot

**External Rebaseline**:
An explicit, audited operation that moves one External Session Log Source's admission watermarks to its current stable timelines without admitting the skipped interval. Ordinary disable and enable operations never perform a rebaseline; they pause and later catch up from the preserved cursor.
_Avoid_: Enable, cursor reset, silent gap

**Source-Bound Continuity**:
Continuity Context derived only from the same Session Log Source and conversation identity. Internal and External Session Log Sources do not merge continuity by chronology or text similarity; cross-source relationships require explicit evidence references.
_Avoid_: Global timeline stitching, provider blending, similarity-based continuity

**Source-Neutral Evidence Weight**:
The default policy that Internal and External Session Log Source evidence uses the same eligibility, Evidence Bundle, review, and promotion gates. Provenance remains visible, but source category alone does not grant trust, suspicion, or corroboration weight.
_Avoid_: Provider trust score, automatic corroboration bonus, external evidence downgrade

**Log Cursor**:
A per-session-log checkpoint that records how far the heartbeat log distillation agent has processed an append-only log file.
_Avoid_: Last processed date, file marker

**Continuity Context**:
Prior turns included with newly appended log lines so the distiller can understand a continuing task. It normally comes from the same session file; it may cross into the immediately preceding file only when the Runtime session identity matches and the new work begins with a Continuation Signal. It remains bounded to ten completed turns.
_Avoid_: Full history, global memory search, cross-group transcript merge

**Continuation Signal**:
An explicit user expression that the current work resumes the preceding task, such as "continue", "redo", "继续", or "接着做".
_Avoid_: Mere chronological proximity, same group membership

**Distillation Unit**:
A chunk of one session log file made from newly appended turns plus continuity context, processed independently by the distiller.
_Avoid_: Daily batch, global log batch

**Learning Episode**:
A prefilter-selected completed task attempt that may be worth capability review. Each completed delivery attempt is independent; corrections and retries become separate attempts connected only through bounded source context. An episode is selected by observable delivery, composition, recovery, or complexity signals, but it makes no claim that a reusable capability exists.
_Avoid_: Promoted capability, solved loop, every assistant reply, multi-attempt task graph

**Capability**:
A reusable problem-handling pattern distilled from one or more completed tasks, including the situation where it applies and the action pattern that helped.
_Avoid_: Fact, preference, raw log summary

**Capability Handle**:
An opaque runtime-owned identifier assigned when a new Capability is first persisted. It links Registry state, snapshots, and evidence without claiming to encode semantic similarity; semantic matching is a Branch Promotion Reviewer responsibility.
_Avoid_: Title hash, source-turn hash, semantic classifier, user-facing skill name

**Referenced Skill**:
An existing manually managed or bundled skill that a distilled capability depends on for its base workflow. A distilled capability may link to a Referenced Skill, but the heartbeat never rewrites, copies, or assumes ownership of it.
_Avoid_: Generated snapshot, managed dependency copy, registry-owned skill

**Composition Capability**:
A distilled capability that adds a reusable decision, tool sequence, validation rule, or boundary around a Referenced Skill. It complements the base skill rather than restating it.
_Avoid_: Duplicate skill, manual-skill rewrite, execution transcript

**Skill Reference Snapshot**:
The name and observed version or content fingerprint of a Referenced Skill recorded when a Composition Capability is distilled. It supports provenance and drift diagnosis; runtime execution resolves the Referenced Skill by its current name rather than replaying the recorded content.
_Avoid_: Pinned dependency copy, frozen manual-skill body, ownership transfer

**Capability Provenance**:
The evidence trail that explains how a capability was derived, including source turns, related agent logs, and the reasoning chain needed to trust or revisit the pattern.
_Avoid_: Source, citation, raw transcript

**Traceability Contract**:
The part of a distilled skill that tells an agent how much to trust the pattern, when to check applicability and boundaries, and which provenance refs to inspect when backup evidence is needed.
_Avoid_: Full log dump, citation list

**Capability Candidate**:
A pre-promotion proposal produced by log distillation, consisting of evidence and a possible Skill Draft but no Capability Handle. A Branch Promotion Reviewer decides whether it belongs to an existing Capability or represents a new one.
_Avoid_: Accepted skill, final memory, preassigned capability identity

**Distilled Knowledge Candidate**:
A durable knowledge candidate produced from logs by a runtime-scoped background agent. The first supported kind is capability, but the concept intentionally leaves room for facts, preferences, decisions, workflows, and anti-patterns later.
_Avoid_: Skill, memory, daily summary

**Skill Draft**:
A single Markdown guidance body authored from distilled knowledge but not yet installed as an active runtime skill. It contains the agent-facing procedure and must not carry runtime-owned identity or audit frontmatter.
_Avoid_: Installed skill, final skill, duplicate structured guidance model

**Skill Authoring Envelope**:
The minimal structured result returned with a Skill Draft: a promotion decision, Referenced Skills, evidence refs, and an optional target capability. It is the machine-verifiable control plane; the draft body remains the sole source of agent-facing guidance.
_Avoid_: Second skill representation, arbitrary runtime metadata, direct filesystem write

**Promotion Packet**:
The complete review bundle used to decide whether a skill draft should become an installed skill, including the draft content, provenance, solved-loop evidence, risks, and a recommendation.
_Avoid_: Approval, score, metadata

**Promotion Reviewer**:
A runtime-internal reviewer that reads a promotion packet and decides whether a skill draft should be installed, held for review, or rejected. A Branch Promotion Reviewer is the required reviewer for Settling Candidates; the Deterministic Promotion Reviewer remains only for legacy candidates, tests, and explicit compatibility fallback.
_Avoid_: Distiller, heartbeat agent, silent downgrade

**Branch Promotion Reviewer**:
A constrained runtime review workflow comprising a Skill Author Branch and an independent Skill Verifier Branch. It turns bounded source evidence, Registry context, and any Referenced Skill into a verified transition proposal; neither branch writes skills or mutates Registry state directly.
_Avoid_: Unbounded autonomous agent, direct file writer, global memory search, self-approval

**Skill Author Branch**:
A constrained branch that turns bounded evidence into one Markdown Skill Draft and its Skill Authoring Envelope. It can propose guidance but cannot certify, install, or mutate it.
_Avoid_: Verifier, direct file writer, policy authority

**Skill Verifier Branch**:
An independent constrained branch that tests a Skill Draft against its cited evidence and Referenced Skills. It checks task necessity, evidence support, privilege expansion, and source-instruction contamination before the runtime may commit a transition.
_Avoid_: Draft author, direct file writer, execution authority

**Reviewer Model Override**:
An optional runtime configuration that gives the Skill Verifier Branch a separately selected provider or model. The default verifier uses the runtime AI service in an isolated context; provider diversity is an enhancement, not a required trust boundary.
_Avoid_: Mandatory dual provider, shared author context, execution permission

**Bounded Author Verifier Loop**:
At most two author-verifier revision rounds over one fixed evidence bundle. The Verifier reports structured issues; the Author may remove or clarify unsupported guidance but may not expand source search, evidence scope, or permissions to obtain approval.
_Avoid_: Infinite self-review, evidence fishing, silent rewrite

**Evidence Bundle**:
The complete runtime-constructed, fixed input shared by the Skill Author and Skill Verifier Branches for one Learning Episode. It includes the episode, completion evidence, Settlement Evidence Window, bounded continuity, applicable Referenced Skills, and related current skills; author-selected refs are claims within this bundle, not its boundary.
_Avoid_: Author-selected transcript, global session search, mutable review context

**Deterministic Promotion Reviewer**:
The legacy rule-based implementation of Promotion Reviewer behavior. It may process legacy candidates and test fixtures, but it must not automatically promote a Settling Candidate when the Branch Promotion Reviewer is unavailable.
_Avoid_: Branch Promotion Reviewer, semantic author, default Settling Candidate fallback

**Faithful Rewrite**:
A promotion reviewer edit that improves wording or structure without adding capability claims that are not supported by provenance.
_Avoid_: Creative rewrite, new guidance

**Completion Evidence**:
An observable signal that an agent task reached its requested result, such as explicit user acceptance, a verified artifact, a successful tool result, or delivery of the requested output. Its strength depends on the signal; it is not limited to a user saying thanks.
_Avoid_: Assistant self-assertion, unverified completion

**Contradiction Signal**:
An immediate user correction, complaint, argument, or failure report that materially weakens the claim that the preceding action pattern worked.
_Avoid_: Ordinary follow-up, preference refinement, unrelated new request

**Settlement Window**:
The configurable runtime interval after Completion Evidence during which a Contradiction Signal can prevent automatic promotion. The production default is three hours; tests and runtime operators may override it without changing candidate semantics. It delays promotion to observe refutation; silence does not create Completion Evidence.
_Avoid_: Fixed six-hour delay, permanent acceptance, independent success evidence, human approval wait

**Settlement Wake**:
A deadline-driven heartbeat wake that processes due Settling Candidates without performing a full session-log scan. The runtime restores overdue wakes after restart; its schedule is independent of the lower-frequency discovery heartbeat.
_Avoid_: Full scan timer, best-effort six-hour delay, user-turn trigger

**Optimistic Capability Commit**:
A concurrent review protocol in which Branch Promotion Reviewers read Capability revisions in parallel, then the runtime atomically applies a transition only if its relevant read set is unchanged. A conflict causes only the affected candidate to refresh its context and re-review.
_Avoid_: Global reviewer lock, blind last writer wins, full-batch retry

**Settling Candidate**:
A durable Capability Candidate backed by sufficient Completion Evidence but still inside its Settlement Window. It preserves provenance and a promotion deadline across process restarts. At the deadline it is automatically reviewed; a Contradiction Signal before then resolves it as rejected with the contradictory source evidence retained.
_Avoid_: Needs Review Queue entry, transient timer, hidden draft, human approval request

**Solved Loop**:
A task episode where the user problem, agent action, Completion Evidence, and absence of a Contradiction Signal form enough evidence that a problem-handling pattern worked. Explicit user acceptance is strong Completion Evidence, but is not the only form.
_Avoid_: Successful reply, completed turn

**Auto-Installed Skill**:
A generated current skill installed into the runtime skill directory after promotion review. Each Capability exposes at most one callable current `SKILL.md`; later material changes replace it atomically.
_Avoid_: Skill draft, bundled skill, manually installed skill, retained snapshot history

**Internal Distilled Skill**:
A generated current skill whose semantic routing name and description are discoverable through the existing skill mechanism. It is user-invocable so the main agent can discover and load it without a separate retrieval path, while its traceability remains runtime-owned metadata.
_Avoid_: Hidden skill, command skill, special retrieval path

**Prior Distilled Knowledge**:
An existing auto-installed skill, its provenance, and its source logs treated as read-only bootstrap evidence when a newer distillation policy reassesses accumulated learning. Its guidance is valuable semantic input even when the old artifact, identity, and state schema are removed after reassessment.
_Avoid_: Compatibility identifier, permanent audit artifact, authority to rewrite a manual skill

**Semantic Reassessment**:
A Branch Promotion Reviewer process that evaluates Prior Distilled Knowledge together with its source evidence and decides to adopt it, improve it, merge it into another Capability, or retire it. After the decision is durably logged, prior generated artifacts are removed; source logs and V3 branch transcripts preserve traceability.
_Avoid_: Blind format migration, compatibility archive, text-only copy

**Bootstrap Reassessment**:
The one-time V3 process that evaluates each prior generated skill independently. A prior artifact remains available only until its V3 Transition Audit has committed; it is then deleted. Deferral or operational failure retains that one artifact temporarily, rather than deleting all prior learning before review.
_Avoid_: Bulk deletion before learning, permanent compatibility mode, global cutover transaction

**Skill Evidence Append**:
An additive update that attaches new solved-loop evidence to an existing distilled capability without forgetting or retiring earlier evidence. It extends the capability's provenance trail and does not change the current skill guidance unless review identifies a material change.
_Avoid_: Guidance overwrite, evidence forgetting, retirement

**Capability Registry**:
A durable active-only runtime index of callable Capabilities. It tracks each Capability Handle, current skill, routing description, evidence refs, and update time. Merge and retirement remove their source entries; the Registry is the current directory, not a historical record.
_Avoid_: Skill directory, review outcomes log, memory search index, tombstone store

**Capability Match**:
The promotion-review judgment that relates a new capability candidate to existing capabilities. A match can indicate a new capability, evidence for an existing capability, a near duplicate, a conflict, or a case that needs review.
_Avoid_: Text similarity score, duplicate check only

**Capability Prefilter**:
A deterministic recall step that selects a small set of potentially related capabilities from the Capability Registry before the promotion reviewer branch makes the final match decision. It narrows reviewer scope without treating text similarity as the source of truth.
_Avoid_: Final dedup decision, semantic oracle, full registry scan by reviewer

**Source Ref Window**:
A bounded source-log window around a provenance ref that a promotion reviewer branch may read to verify local context. The default v2 boundary is the referenced turn plus up to two neighboring completed turns before and after it. The reviewer may use this window to check continuity, corrections, and acceptance, but may not expand into arbitrary log search.
_Avoid_: Full session replay, global memory search, unrestricted grep

**Settlement Evidence Window**:
A deterministic source-log window used only to settle a Settling Candidate. It starts at the turn containing Completion Evidence and ends at that candidate's Settlement Window deadline; it contains all user turns in the same Runtime session plus their directly associated assistant and tool-result records. It does not cross groups, sessions, or the deadline, and does not relax the ordinary Source Ref Window.
_Avoid_: Full session replay, global memory search, unrestricted provenance expansion

**Current Skill**:
The sole active `SKILL.md` selected by the Capability Registry as the executable expression of a Capability. It is the current pointer over revisioned guidance, not the complete history. Evidence append may advance the revision without changing the public route; a material action-pattern or boundary change atomically advances the revision and updates the active pointer while prior revisions remain addressable through audit/history.
_Avoid_: Overwriting the only historical copy, latest-file heuristic, merged skill with no revision boundary

**Skill Routing Name**:
The stable, semantic, user-visible skill name used by existing skill discovery to route a Capability. It is proposed by the Skill Author, validated by the runtime, cannot collide with a manually managed skill, and is not the Capability Handle.
_Avoid_: Opaque handle, source hash, silent rename, manual-skill override

**Semantic Skill Name**:
A lifecycle-neutral name that describes the reusable user capability supported by bounded evidence. It names the task outcome or decision pattern rather than the Runtime state, source episode, or implementation tool that happened to produce it.
_Avoid_: Settled artifact delivery, eligible episode, OpenCLI command name

**Skill Naming Authority**:
The Skill Author proposes a Semantic Skill Name from the fixed Evidence Bundle, the Skill Verifier checks that the name is supported and appropriately bounded, and Runtime only enforces structure, uniqueness, and safety constraints.
_Avoid_: Runtime-assigned semantic name, verifier-invented capability, evidence-free rename

**Semantic Observation**:
A bounded, source-linked observation supplied to a Skill Author and Verifier about user intent, workflow operations, artifact shape, or referenced skills. It is evidence for naming and guidance, not a Runtime-assigned capability label.
_Avoid_: Semantic verdict, generated name, unbounded transcript, similarity score

**Deterministic Observation Extraction**:
The replayable Runtime boundary that derives Semantic Observations from bounded user text, tool arguments and results, artifact metadata, and Referenced Skill snapshots without asking an Agent to classify or name the Capability.
_Avoid_: Semantic Classifier Agent, naming oracle, unrestricted transcript summarizer

**Skill Name Migration**:
An explicit atomic Capability Transition that changes the active Skill Routing Name while preserving the same Capability Handle, evidence, revisions, and audit trail. It updates the active route and records the former route as a Durable Route Redirect; it is never a silent file or Registry mutation.
_Avoid_: New logical capability for a display rename, un-audited alias, evidence reset, route-only string replacement

**Agent Semantic Selection**:
The Skill Author's bounded judgment about which supplied Semantic Observations belong to the reusable capability and how they combine into a name and procedure. It may prioritize or exclude observations inside the fixed Evidence Bundle, but it may not expand the source window or search for additional evidence.
_Avoid_: Runtime preclassification, free-form memory search, evidence fishing

**Naming Deferral**:
A review outcome used when the fixed Evidence Bundle does not support a precise, lifecycle-neutral Skill Routing Name after the bounded Author–Verifier loop. The candidate remains durable for a later evidence-gated retry instead of receiving a generic Runtime-assigned name.
_Avoid_: Generic fallback name, silent acceptance, discarded candidate

**Public Semantic Naming**:
The user-visible naming surface of a Capability: its title, Skill Routing Name, description, and generated Skill heading. It is distinct from durable internal identities, lifecycle statuses, source refs, and Transition Audit fields.
_Avoid_: Renaming the Capability Handle, changing episode identity, audit metadata as prose

**Naming Safety Gate**:
The Runtime boundary that rejects malformed, colliding, or obviously lifecycle-bound Skill Routing Names without selecting a semantic replacement. Semantic adequacy remains a Verifier judgment.
_Avoid_: Runtime naming oracle, automatic generic fallback, silent correction

**Durable Semantic Observation**:
A Semantic Observation admitted and stored with a Learning Episode before the Log Cursor advances. It remains fixed across settlement, restart, review retry, and Skill Name Migration while retaining its source refs.
_Avoid_: Recomputed review hint, mutable classifier output, transient prompt context

**Semantic Name Collision Resolution**:
A Capability Match decision that treats an existing Capability's stable Skill Routing Name as the discovery identity when a new Author proposal describes the same reusable ability. The transition appends evidence or merges boundaries instead of creating a duplicate route.
_Avoid_: Name-based duplicate, silent route replacement, competing Current Skills

**Bounded Observation Value**:
The length-limited factual text attached to a Semantic Observation so an Author can reason about the capability without receiving a copied transcript. It preserves salient intent or operation details and points to exact source refs for verification.
_Avoid_: Full tool output, unrestricted transcript, executable instruction payload

**Candidate Evidence Summary**:
The backward-compatible title, applicability, and action summary carried on a Capability Candidate for review context. It is not a Public Semantic Name and cannot override the Author's observation-based naming decision.
_Avoid_: Runtime-assigned title, routing authority, final Skill heading

**Retired Skill Route**:
A former Skill Routing Name removed from active discovery after a successful Skill Name Migration. Its Capability provenance and Transition Audit remain addressable, and a non-public Durable Route Redirect may resolve historical references or explicit legacy calls to the canonical current route; it is not listed as a separate Current Skill.
_Avoid_: Public duplicate, redirect cycle, route reuse, deleted audit history

**User Intent Observation**:
A bounded, source-linked observation of what the user asked the Runtime to accomplish for a Learning Episode. It is the primary domain signal for Agent Semantic Selection; assistant prose is supplementary only when no stronger tool evidence exists.
_Avoid_: Full conversation summary, assistant self-assertion, inferred user preference

**Agent Naming Contract**:
The testable boundary in which a fixed Evidence Bundle supplies observations and the Author proposes public semantic naming while the Verifier checks support, safety, and consistency. It validates naming behavior without requiring a specific live-model phrase.
_Avoid_: Snapshotting model wording, Runtime-selected name, untestable prompt promise

**Observation Budget**:
The explicit count, per-value length, and total payload limits applied to Semantic Observations before they enter an Evidence Bundle. It bounds prompt cost and source-instruction exposure without changing the original source evidence.
_Avoid_: Unbounded observation copy, full transcript replay, silent evidence deletion

**Naming Transition Audit**:
The explicit prior and resulting Public Semantic Names recorded alongside a Capability Transition so Skill Name Migration and collision resolution remain understandable after old routes leave active discovery.
_Avoid_: Inferring names from mutable Registry state, untracked rename, route history hidden in prose

**Observation Schema Migration**:
The explicit Learning Episode schema transition that adds Durable Semantic Observations while preserving prior evidence and lifecycle links. Legacy episodes without observations remain identifiable as incomplete semantic input and are reassessed rather than assigned fabricated observations.
_Avoid_: Silent optional-field drift, evidence reconstruction without provenance, automatic legacy naming

**Revisioned Skill Update**:
An atomic update that archives the prior active guidance as an immutable history snapshot, switches the Capability Registry's active pointer while keeping the stable active path, and retains prior revision metadata, evidence refs, and Transition Audit history. It distinguishes normal capability evolution from a public route rename.
_Avoid_: Destructive overwrite, untracked content mutation, route change hidden inside an evidence append

**Durable Route Redirect**:
An append-only compatibility record for a generated Capability, mapping a retired Skill Routing Name to the stable Capability Handle whose canonical current route is resolved from the Registry. It is used for historical references, embedded generated-Skill metadata, and explicit legacy calls, but is not a public Skill listing or a second Capability. Hand-written Skills are outside this boundary.
_Avoid_: Public alias, mutable redirect target, redirect without migration audit

**Canonical Redirect**:
The resolution rule that follows a Durable Route Redirect to the current route in one hop. Redirect targets are normalized, cycles are rejected, and the retired route can never be reused for another Capability.
_Avoid_: Redirect chains, route resurrection, ambiguous historical lookup

**Route Reuse Prohibition**:
The invariant that a retired Skill Routing Name remains reserved forever in route history, even after it leaves active discovery. New Capabilities must choose a different Public Semantic Name.
_Avoid_: Name recycling, historical reference ambiguity, silent reassignment

**Generated Capability Route Scope**:
The explicit boundary that Skill Name Migration, Revisioned Skill Update, Durable Route Redirect, and route reuse prohibition apply to `generated-distilled` Capabilities only. Hand-written Skill rename and compatibility behavior remain a separate future lifecycle; descriptions may inform a later semantic match but cannot serve as durable identity.
_Avoid_: Cross-lifecycle redirect, description-as-identity, implicit manual-skill migration

**Canonical Skill Resolution**:
The single lookup rule used by SkillManager and its callers: resolve an active route directly, or resolve a retired generated route through its Capability Handle redirect and then the Registry's current route. Redirects are not included in discovery listings.
_Avoid_: Caller-specific redirect logic, route aliases in listings, semantic guessing on stale redirects

**Registry Catalog Revision**:
The durable, monotonically increasing integer in Registry state used by long-lived SkillManager instances to detect an atomic Capability update or route migration and lazily refresh their generated-skill cache and redirect map before lookup. It changes only when durable capability-addressing or guidance state changes.
_Avoid_: Wall-clock freshness, stale in-memory catalog, process-local event bus as the only refresh path, cache invalidation without durable state

**Semantic Reassessment Identity**:
The stable bundle identity for legacy/generated-Skill semantic reassessment, derived from the Capability Handle, active guidance hash, and semantic-observation hash rather than a mutable Skill Routing Name. It makes startup retries, crash recovery, and verifier retries idempotent while allowing genuinely changed evidence or guidance to create a new task.
_Avoid_: Route-based task identity, random retry bundle IDs, duplicate migration after restart

**Semantic Reassessment Wake**:
A targeted Runtime Learning wake driven by the durable reassessment manifest's `nextRetryAt`. It performs generated-Capability semantic reassessment and route migration without scanning session logs or admitting new evidence. Startup may discover pending entries immediately; deferred and operational failures schedule later retries through the DueWorkPlanner.
_Avoid_: Evidence-ingestion masquerade, full discovery scan, process-memory-only retry

**Dependent Skill Reassessment**:
A bounded maintenance task created when a referenced generated Capability's revision or route changes and an active generated Skill stores a stale handle/revision/guidance snapshot. It uses a Registry reverse scan and the same Semantic Reassessment Wake; it is not a general-purpose task graph.
_Avoid_: Broad dependency DAG, automatic body rewrite, blocking the referenced Capability update

**Reference Metadata Refresh**:
An atomic Registry-only update that refreshes a generated Skill's referenced Capability handles, revisions, or guidance fingerprints without changing executable guidance. It advances catalog state and audit metadata but does not create a new guidance revision or rewrite `SKILL.md`.
_Avoid_: Guidance churn for metadata drift, silent reference loss, treating a metadata refresh as a new capability

**Semantic Reassessment Manifest**:
A durable, domain-specific work record for reassessing existing generated Capabilities. It tracks the stable reassessment identity, target handle, current hashes, status, retry time, errors, and bounded source refs; it is distinct from the Learning Episode candidate Review Queue while reusing the same Author/Verifier and atomic Transition Journal.
_Avoid_: Synthetic Learning Episode candidate, duplicated full transcript, process-memory-only migration state

**Immutable Guidance Snapshot**:
A content-addressed historical copy of generated Skill guidance stored under the Capability Handle's history directory by `guidanceHash`. Archive writes are idempotent and never overwrite a different body at the same hash; the active `SKILL.md` remains the stable lookup path.
_Avoid_: Random archive identity, destructive history overwrite, snapshot path based only on mutable route name

**Explicit Revision Restore**:
An audited operation that selects an immutable historical guidance snapshot as the active revision without deleting newer revisions or rewriting prior audit facts. It is available for deliberate recovery, not triggered automatically by a naming migration or a single usage contradiction.
_Avoid_: Automatic rollback oscillation, destructive revert, untracked file copy

**Guidance Change Signal**:
The existing per-Capability `revision` is the optimistic-concurrency version for all Registry mutations, while `guidanceHash` is the semantic signal for executable guidance change. Metadata/evidence mutations may advance revisions without triggering dependent guidance reassessment; a changed guidance hash does.
_Avoid_: Treating every Registry write as a guidance rewrite, duplicate revision concepts, dependency churn on evidence-only updates

**Needs Review Queue**:
A durable deferred-candidate queue for proposals that cannot yet be safely created, appended, replaced, merged, retired, or rejected. Entries preserve evidence, reviewer rationale, questions, and retry conditions for a later Branch Promotion Reviewer pass. It is not a human approval workflow; the runtime progresses when new evidence or a stronger reviewer becomes available.
_Avoid_: Human approval queue, error log, rejected candidates, TODO list

**Evidence-Gated Review Retry**:
A retry rule for deferred candidates: the runtime should not blindly re-run the same reviewer over the same evidence on every heartbeat. A queued review becomes eligible again when new evidence arrives, the reviewer version changes, a relevant capability registry state changes, or an explicit runtime command requests a retry.
_Avoid_: Periodic retry loop, stuck cron review

**Operational Review Retry**:
A persisted exponential-backoff retry for a Branch Promotion Reviewer that failed to run, timed out, or returned invalid schema. It is distinct from semantic deferral, retains the candidate and failure transcript, and never falls back to deterministic automatic promotion.
_Avoid_: Evidence-gated defer, dropped candidate, silent deterministic fallback

**Capability Transition**:
One atomic V3 outcome from Branch Promotion Review: create a current skill, append evidence, replace a current skill, merge into another Capability, retire a Capability, defer a candidate, or reject a candidate.
_Avoid_: Snapshot lifecycle, human approval state, multiple partial writes

**Transition Audit**:
An append-only compact record of a Capability Transition. It links the bounded branch transcript, source evidence refs, reviewer and prompt version, involved Capability Handles, and pre/post guidance content hashes. It is the index into audit material after an old skill file has been removed.
_Avoid_: Retained skill body, mutable registry history, unindexed raw transcript

**Transition Journal**:
A short-lived write-ahead record of the complete target state and expected hashes for one Capability Transition. It lets runtime startup finish or recover an interrupted multi-file commit; it is removed after commit and is not a skill or audit-history store.
_Avoid_: Snapshot history, compatibility archive, discoverable skill file

**Skill Usage Ledger**:
An append-only record of a generated Current Skill successfully loading and of its factual association with a concrete Learning Episode outcome. It supplies operational evidence to curation; loading and same-episode association do not claim that the skill caused the result.
_Avoid_: Mutable usage counter, claimed causal usefulness, manual-skill ownership

**Curator**:
A low-frequency runtime maintenance workflow that uses Skill Usage Ledger evidence to select generated Current Skills for bounded Author and Verifier reassessment. It reuses Capability Transitions and does not directly edit, archive, or delete a skill based only on age or view count.
_Avoid_: Separate lifecycle writer, age-only garbage collector, manual-skill manager

**Usage Outcome Signal**:
An observed result of applying a generated Current Skill to a Learning Episode. A direct Contradiction Signal triggers curation promptly; repeated verifiable success or deferral supplies lower-urgency reassessment evidence; age and loading count alone do not decide lifecycle.
_Avoid_: View-count verdict, age-based deletion, manual-skill lifecycle signal

**Expedited Curator Wake**:
A coalesced prompt review wake for a generated Current Skill that receives a direct Contradiction Signal after application. It does not suspend the skill or decide retirement; the Author and Verifier workflow decides the transition from the combined evidence.
_Avoid_: Automatic quarantine, duplicate branch storm, daily-only delay

**Skill Evolution Config**:
The single runtime configuration surface for discovery cadence, Settlement Window, curator cadence, reviewer concurrency, operational retry, Author and Verifier model selection, and V3 enablement. Its production defaults are policy values that operators may change without migrating capabilities or audit state. Tests inject this configuration directly rather than waiting for production timers.
_Avoid_: Scattered constants, private test hooks, hidden timing policy

**Promotion Review Attempt**:
One end-to-end Branch Promotion Reviewer execution for a fixed Evidence Bundle, including the bounded Author, Verifier, and any allowed revision rounds. It is the unit that succeeds with a Capability Transition or fails into Operational Review Retry.
_Avoid_: Individual model call, single branch turn, heartbeat run

**Review Deadline**:
The shared wall-clock budget for one Promotion Review Attempt. Author and Verifier branches consume the same deadline, while each branch also observes a separate bounded turn budget; expiry aborts the attempt and preserves it for Operational Review Retry.
_Avoid_: Per-provider timeout, Settlement Window, evidence-gated defer

**Coalesced Wake**:
A Runtime Learning wake request recorded while another wake is running. Multiple pending reasons are merged into one follow-up wake whose discovery and due-work stages cover the union of all requests; no trigger is silently discarded and no concurrent state-writing wake is started.
_Avoid_: Dropped trigger, parallel heartbeat, last-reason-wins wake

**Branch Transcript Contract**:
The audit requirement that a Skill Author or Skill Verifier transcript is durably readable and contains the events needed to reconstruct its review before a Capability Transition can commit. Observation Branch transcripts remain diagnostic material and do not impose this promotion gate.
_Avoid_: Best-effort promotion evidence, heartbeat record, raw source log

**Review Abort**:
The explicit termination reason for a Promotion Review Attempt. Shutdown cancellation stops work without retry, while a Review Deadline or provider timeout becomes `branch_timeout` and enters Operational Review Retry; unrelated errors remain `branch_failure`.
_Avoid_: Generic aborted request, semantic rejection, silent retry

**Review Transcript Retention**:
The lifecycle rule for branch audit material: Author and Verifier transcripts linked to a committed Capability Transition remain until that Capability is retired, while uncommitted and observational transcripts use the runtime's bounded retention period. Retention never removes source session logs or durable transition state.
_Avoid_: Uniform log deletion, audit deletion, source-log retention policy

**Graceful Runtime Drain**:
The shutdown behavior that stops new wake scheduling and lets the active Runtime Learning wake finish within its Review Deadline. A normal drain is not a review failure; an active attempt that reaches its deadline is persisted as Operational Review Retry.
_Avoid_: Immediate branch cancellation, dropped wake, unbounded shutdown
