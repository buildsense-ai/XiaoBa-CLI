# Independent CatsCompany session forks

CatsCompany Web can copy an owned, one-user/one-agent conversation into a new
`agent_task`. This is a separate conversation and local AgentSession, not a
branch inside one mutable transcript. No model runs during copying.

## Use

1. Run matching versions of the CatsCompany server, Web and XiaoBa runtime.
2. Wait until the source conversation has completed its current turn.
3. In the conversation header menu, select **复制为新会话**.
4. Wait for initialization, then select **打开新会话**. Continue with the next
   development or review stage there; the source remains independent.

The same bot, configuration and working directory are shared. This does not
create a Git worktree or copy project files. No agent-callable fork, messaging,
or A2A tool is added in this version.

## What is copied

- The server copies visible stored messages, timestamps, authors and supported
  attachments/replies into new message IDs. Historical messages are not replayed
  through live input delivery.
- XiaoBa copies its actual durable context, including retained summaries and
  complete tool exchanges. Runtime hints, provider replay handles, active tasks,
  queues and permissions are not copied.
- Subsequent messages, compaction and history clearing are independent. Current
  runtime instructions and tool capabilities are rebuilt normally.

## Consistency and recovery

The source must be idle, including queued input and pre-turn work. Local locks
protect the snapshot, and the server checks that visible history did not change
during copying. Existing or restarted sessions need no extra model turn.

This copies the source's current state; it does not audit or repair past input
synchronization. If the source already has visible cloud messages absent from
its local context, the same difference is preserved. Missing local context is
never reconstructed from display history merely to make a copy succeed.
Diagnostic/run logs are not migrated. Provenance is shown in Web UI metadata,
not injected as a new model message.

The destination stays non-writable until local initialization is acknowledged.
Retrying an uncertain request uses the same ID and cannot overwrite later child
progress. A terminal failure requires a new request. Pending copies have no
automatic expiry and can be retried after reconnecting, provided the source and
runtime binding still match.

Initial context and identity are atomically published under `data/session-forks`.
Normal saves materialize the usual `data/sessions` transcript atomically; the
bootstrap records that transition so a lost newer transcript cannot revive the
old snapshot. Clearing history retains only an empty identity tombstone to
prevent a delayed initialization from resurrecting cleared content.

A fork whose local context is lost is refused explicitly, including after a
runtime move. This version does not implement cross-device session migration.

## Release order

Deploy the server schema/API support first, then compatible Web and runtime
versions. New clients require the authoritative fork-provenance endpoint before
restoring missing context or opening group composition. Deploying them before
the server can block those operations. An old runtime cannot initialize a fork.

The feature does not require changing the system prompt or installing a Skill.
The three-stage development Skills can be used manually in the resulting chats.
