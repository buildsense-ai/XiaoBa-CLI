# A session-scoped Memory Branch for XiaoBa

Design proposal for the XiaoBa runtime

The Memory Branch should be able to answer one question on its own: *What could the main agent learn right now that would change its answer?* The runtime already sees the user's messages, tool calls, and tool results. The Branch can use those events to follow the conversation, explore alternative explanations, and deliver evidence while the main agent works. This requires zero coordination calls from the main agent and zero waiting for a Branch result. Each observation still costs context tokens, so the Branch should earn that space with a specific finding.

## Division of labor

The main agent and the Branch answer different questions. When the user asks explicitly about past work, such as “What work is still open?” or “What happened on the 16th?”, the main agent searches with `catslog_knowledge_recall` in its own tool loop. It uses keyword search ranked by relevance and Diary date, or `action=recent` for a date range, and reads pinned sources before answering. That path serves the first answer.

The Branch covers what the main agent has no reason to search for: a correction to a fact it is about to repeat, an older decision that constrains the current task, or a cross-session result that compaction removed from context. Neither component invokes the other.

## Why the lifetime matters

On November 18, 2026, at 19:12 Beijing time, Abraxas received a message. By 19:12:31 its Memory Branch had read two sources. At 19:12:35 the main reply finished and the Branch was deferred. At 19:12:46 the Branch failed because the original credit task had already ended. The trace recorded two reads and zero injected references. It leaves open whether either source supported a useful finding. (Local trace: `abraxas-injection-followup.jsonl`, grp_7445, 11:12 UTC.)

The Branch took 21 seconds to reach its first read, and the main reply finished four seconds later. A longer lifetime would not have changed that first answer. It would have let a verified finding reach the next related turn.

Today, an observation goes onto the main runner's queue after the Branch produces a valid finish payload. The Abraxas sequence exposes two distinct decisions. A Branch needs enough execution time to verify a finding. Once verified, that finding can be useful even while a second line of inquiry remains open. A background task and an observation therefore need separate completion points. [Current publication code](../src/core/observation-branch-session.ts) · [Lifecycle terms](memory-branch-evaluation-notes.md#lifecycle-terms)

The binding constraint is input admission. It has two gates, and settlement is shared. `AgentSession.handleInput` first rejects input while `creditTurnInFlight` is set ([`agent-session.ts:761`](../src/core/agent-session.ts)). It then rejects any ordinary new input while the session's `creditTask` is still `running` (`:775`). `CreditTaskRuntime.child()` counts children on the parent task. The parent settles only once it has completed and its last child has exited ([`credit-task-runtime.ts:189-197`](../src/core/credit-task-runtime.ts)). The session also holds a single `creditTask` slot backed by one persisted snapshot (`agent-session.ts:782`). Starting turn B while A's child is active would therefore overwrite A's reference and its recovery state. A prototype under `child()` settled credit once after the Branch finished, but the second gate blocked the user's next message. Opening the input switch alone does not separate A's settlement from B's running and recovery state.

## What already exists and what changes

| Mechanism | Today | This proposal |
|---|---|---|
| Late delivery | One-late-turn carryover. The slot is cancelled when the following turn ends. | A session-scoped queue. Observations expire on scope loss, session closure, or budget exhaustion. |
| Delivery eligibility | Every queued observation drains at the next provider call. | An observation drains only after it has been verified against the latest user input. |
| Newer session events | `maybeStartMemoryRefresh` starts a fresh activation at least 15 minutes after the previous one completed, passing `deltaSinceLastRun` and `previousInjections`. | One investigation consumes new events between lookups. `previousInjections` becomes the record of evidence the main agent has already seen. The 15-minute refresh is removed rather than kept alongside. |
| Publication | One observation, after a valid `finish`. | Each verified claim publishes on its own. `finish` ends the investigation. |
| Reference check | At `finish`, every cited remote ref must have been fully delivered by `memory_source_read`. | The same check applies to every publication. |
| Audit | `catsco.memory_branch.v1` records `read_refs`, `injected_refs`, `answer_refs`, and origin and consuming turn IDs. | Unchanged. Adds publication events and the reason each withheld observation was withheld. |
| Credit | The Branch runs inside the turn's credit task and fails once that task completes. The session holds one task slot and one persisted snapshot. | The Branch runs under `child()` of its originating task, and the investigation holds that task in place of the session slot. A new turn gets its own task. The originating task settles once, when its last child exits, without touching the newer task's running or recovery state. |

## How exploration follows a narrowing question

Consider a user who asks the main agent to draft a delivery note for a 60-second film. Nothing in that request prompts the main agent to search history. The following is an illustrative sequence.

| Event the runtime already sees | What the Branch does independently | Evidence worth delivering |
|---|---|---|
| The user asks for a delivery note | Search Diary for the film's project name and its recent decisions. | A source distinguishes approval of the picture edit from an unresolved narration issue. |
| The main agent reads the edit approval | Mark that fact as covered. Search for the narration incident under its project name, the speech tool, and subsequent acceptance notes. | A repair note confirms that speech synthesis worked again. It leaves the delivered film's audio track unverified. |
| The user specifies the export to send | Narrow the question to that export. Check the acceptance record or artifact inspection for that version. | If an inspection identifies an audible narration track on that export, deliver the finding with its source. Otherwise deliver the narrower qualification: repair reported, export unverified. |

The Branch keeps its current question, the evidence already visible to the main agent, and the remaining plausible explanations in its own working state. Before starting another lookup, it consumes newer session events and asks which source could distinguish those explanations. Three events wake it: a user input, a main-agent tool result, and the return of its own lookup. On a new user input, it first rechecks the observations it has published but not yet delivered. Repeated evidence and an unchanged question give it a reason to go idle. The main agent never needs to write a progress summary.

## Publication and delivery

1. **Verify one claim.** Read the source body, identify the object and date or version it covers, and preserve its pinned reference. A search hit is a lead. A source that reports a repair supports an attributed repair report. Confirming the delivered artifact takes evidence about that artifact. A claim citing a ref that was not fully delivered goes to audit only.
2. **Publish when the finding is ready.** Put a short observation in a session-scoped queue. Include the subject, the claim, its source reference, its origin turn, its access scope, its `verifiedThroughInput` (the sequence number of the latest user input the Branch had consumed when it verified the claim), and any qualification that changes how the claim can be used. The Branch can continue exploring after publication. Deduplicate repeated claims and mark which earlier observation a correction supersedes.
3. **Deliver only what is current.** Before an already scheduled provider call, the runtime drains an observation only when two mechanical checks pass. First, its access scope covers the current input's sender and visible scopes. Second, its `verifiedThroughInput` equals the latest user input sequence. A new user input never waits: the main request goes out as usual, and older observations are held. The Branch consumes the new input asynchronously. For each held observation, it either reconfirms the observation or withdraws it. Reconfirming advances `verifiedThroughInput` and makes the observation eligible for subsequent requests. Access scope alone cannot separate topics, because a user switching from project A to project B keeps identical permissions. The sequence check keeps A's findings out of B's requests without asking the main model to sort them and without a topic classifier on the provider path. Tool results and provider calls within the same user input leave eligibility unchanged. The trace records every hold, reconfirmation, and withdrawal. Delivery uses XiaoBa's existing synthetic observation lane, and an in-flight call completes normally. [Branch session architecture](branch-session-architecture.md)
4. **Keep an auditable distinction between reading and delivery.** Record the source read, observation publication, and provider request that actually contained it, using the `catsco.memory_branch.v1` fields. Record explicit citation separately. This lets an operator distinguish a failed lookup, an undelivered finding, and a delivered finding that the answer did not cite.

## Execution ownership

The session owns the observer. Each active investigation runs under `child()` of its originating credit task. It is budgeted, independently cancellable, and attributed to its originating turn and sender. The investigation holds that task in place of the session's `creditTask` slot. Both input gates admit a new turn when the previous task has nothing left but Branch children. `creditTurnInFlight` covers only the foreground turn, and the running-task check passes once the parent's foreground part has completed. The new turn creates its own credit task and persisted snapshot. When the Branch exits, the originating task settles once, and that settlement does not overwrite the newer task's running or recovery state. Completing a reply therefore releases the input slot immediately, and the Branch can finish verifying a source while the user sends another message. Explicit cancellation, scope loss, session closure, or budget exhaustion ends the investigation through the same settlement path.

Observation is event-driven. Coalesce events that arrive during a lookup, reassess their relevance when it returns, and sleep when there is no useful lead. Only a verified finding can consume main-agent context. If no suitable provider call follows, its audit record can show that it was published and never delivered. In a group session, each investigation stays bound to its originating sender's scope; another sender's input can wake it but cannot widen it.

## Out of scope

- The main agent never waits for, polls, or calls the Branch.
- The quality of the first answer to an explicit retrospective belongs to the main agent's recall tool.
- No additional model call on the provider path, including topic classification.
- The opt-in local-log lane and the text transient context lane are unchanged.

## Open decisions

- **Budget unit and default.** The current Memory runtime uses `budgetPolicy: "model_context"` and rejects retired pipeline budgets. A session-scoped observer needs a per-investigation ceiling, most likely provider tokens charged to its child credit task plus a wall-clock limit. Its configuration home and default are undecided.
- **Persistence of concurrent credit tasks.** Today one snapshot per session holds the active task. Either the originating task gets its own persisted key, or the newer task's snapshot records it as a pending child. Either way, recovering the newer task must not resume or settle the older one.
- **Queue retention.** How long an undelivered observation stays queued when no in-scope provider call follows: until session closure, or for a bounded number of turns.

## First implementation and acceptance

Start with the existing Branch, its source validation, and the synthetic observation queue. Run the Branch under `child()` held by the investigation. Let both input gates admit a new turn when only Branch children remain, and give that turn its own task and snapshot. Allow a verified observation to publish before `finish`, gate delivery on `verifiedThroughInput`, and replace the 15-minute refresh with event consumption between lookups.

**Historical replay.** Replay the 19:12 Abraxas sequence with a follow-up input sent right after the main reply. It passes if three things happen:

- After the main reply ends, the Branch keeps running and reaches a terminal state other than `failed`. Publishing, auditing, and suppressing all count.
- The follow-up is admitted immediately.
- A's credit settles once.

Whether the two sources support a finding is not a pass condition. Production logs only prove that they were read.

**Fixtures with known content.** These cases establish delivery timing and ordering, which the historical trace cannot.

| Fixture | Observable pass condition |
|---|---|
| Interleaved credit. A has replied and A's Branch is still running. B arrives. A's Branch then exits. | Both gates admit B immediately. A settles exactly once, after its Branch exits. B's running state and persisted recovery snapshot belong to B throughout, and B's own settlement is unaffected. |
| The Branch publishes before the follow-up's provider request. | That request contains the observation exactly once. |
| The Branch publishes after the follow-up's provider request, and the topic continues. | That request does not contain it. The next request made while the observation is still current contains it once. |
| A held observation is reconfirmed after a same-topic follow-up. | It is absent from the request sent before reconfirmation and present once in the next. |
| The fixture's evidence is insufficient. | Zero publications and zero injections. This passes. |
| The user switches from project A to project B. The provider request for B's input is forced to go out before the Branch processes that input, and the Branch withdraws A's finding afterwards. | B's request contains no evidence from A, because the observation was held, not because the withdrawal won the race. The trace shows the hold, then the withdrawal. |
| The user narrows “speech is fixed” to “does this export have narration?” | The next search targets the export. Tool recovery alone leaves the export's status unverified. A later inspection can resolve it. |
| Two searches return the same repair report, then a later source corrects it. | The initial report enters context once. The correction identifies the affected claim and carries its own pinned reference. |
| Nothing in history bears on the conversation. | Zero publications and zero injections. The Branch goes idle, and its spend stays within budget. |
| Two senders in one group session. | Evidence from sender A's scope never appears in a provider request made for sender B. |

For the replay and each fixture, capture the input-acceptance event, Branch lifecycle events, the actual provider request, and Branch tokens and credit spent. Count main-agent calls made solely to coordinate the Branch; the expected count is zero. Report spend per delivered finding. Judge retrieval quality by whether the right evidence reached the decision it could affect, such as whether the agent had grounds to say the delivered film contained narration.
