# CatsLog recall layering

CatsLog keeps three layers: Session Graph (what happened), Memory Graph (cleaned sessions) and Wiki/Diary (document entries). XiaoBa reads them through two agents with different jobs.

| Agent | Layer | Purpose | Surface |
| --- | --- | --- | --- |
| Main agent | Wiki/Diary documents | Converge on maintained, revision-pinned knowledge | `catslog_knowledge_recall` with `search`, `read`, `graph` |
| Memory Branch | Memory and sessions | Bounded divergence into surrounding context | local `memory_search`/`memory_read_turn`/`memory_neighbors`, remote `memory_remote_search`/`memory_source_read`/`memory_assertion_read`, cited `memory_node_read`, graph `memory_links` |

The layers meet through citations the server already stores: a Diary entry's `source_anchors` pin exact Memory nodes (`source_memory_projection_node`: projection ref, revision, node id). When the main agent has read Diary entries, the Branch receives those anchors as **seed candidates only**. It never receives the document bodies. `memory_node_read` reads one seeded node as its canonical `memory-graph/3` view (selected node, conditions, omissions, mappings), whole or not at all, sharing the two-read cap with discovered projections. Node views have their own 32 KiB whole-or-nothing allowance: a canonical view carries the node's closure, generation contexts and output proofs, and a real two-turn adapter node measured 15,908 bytes, at the edge of the 16,000-byte projection budget. Reading the cited node rather than its whole projection is what keeps real Memory deliverable at all.

No layer falls back to the other. With the Branch disabled, the main agent has no session-history surface; that is intentional.

## Failure modes

Each item has a test that fails if the boundary regresses.

Main agent (documents):

- **M1** The model-facing schema exposes a memory-layer action (`expand`, `read_source`, `source`, `history`).
- **M2** A removed action is silently remapped to another action instead of returning `INVALID_TOOL_ARGUMENTS`, or reaches the backend.
- **M3** `graph`/`read` lose complete-closure delivery or native recall attribution.

Branch (memory):

- **B1** The Branch tool list contains Diary tools (`memory_knowledge_search`, `memory_knowledge_graph`).
- **B2** `finish_memory_search` accepts a `catslog:knowledge:` ref, so a document body can enter the parent through the Branch.
- **B3** A Diary body, title or entry text leaks into Branch input through seeding.
- **B4** Seeds are taken from anything other than a successful `catslog_knowledge_recall` tool result (user text, other tools, assistant prose, malformed JSON).
- **B5** Seeds are unbounded, or seeded node reads bypass the shared two-read / byte budget.
- **B6** Seed refs are attributed to a Branch request pool and reported as downstream citations.
- **B7** A seeded Memory node reaches parent input without the `programmatic_observation` execution binding, or is bound to a model call that preceded its delivery.
- **B8** The Branch reads a node other than an exact seeded or link-issued anchor, or delivers a Memory node response that is not the canonical `memory-graph/3` view of that anchor.

## Collection and Delta roots

CatsLog can also publish two aggregate projections over a set of member results: `result_collection/v1` (a membership index, no semantic nodes) and `result_synthesis_delta/v1` (new assertions plus typed relations to existing members). Both arrive through the same `memory_source_read`. A Collection is a map, not a conclusion: it stays navigable but can never support `finish_memory_search`. A Delta root is delivered like any projection. `memory_assertion_read` then asks the server for one assertion's bounded qualifier closure under a member of a root the Branch already expanded. A complete closure is attached whole to that root (`assertion_closures` on a Delta root, its own `derived_assertion_closure` view for a Collection member); anything else stays reference-only.

Branch (Collection / Delta):

- **D1** A valid `result_synthesis_delta/v1` or `result_collection/v1` projection is rejected by the client, so metadata alone reaches the Branch.
- **D2** A `synthesis-gap-table/v1` aggregate is rejected, or its decoded page gaps are lost from the view; a malformed table or pages that are not covered exactly once are accepted.
- **D3** A Collection membership index is delivered as evidence or accepted by `finish_memory_search`.
- **D4** An assertion read is dispatched for a ref the Branch never expanded, a member not listed in that root, or a node outside the delivered Delta graph.
- **D5** Assertion reads bypass the shared two-read budget, run more than once per Branch run, or a failed read does not consume its slot.
- **D6** A closure whose projection ref, member ref, assertion node, trust labels or byte/node counts disagree with the request is delivered; or a valid closure is rejected because the server omitted an empty array.
- **D7** A `bounded` or `not_found` closure becomes final evidence.
- **D8** The closure's `source_scope` or any other field outside the projected closure reaches a model.
- **D9** An assertion read runs under a capability other than the one that issued the root, follows a redirect, or buffers an unbounded response.
- **D10** A Delta closure is cut to fit the 16,000-byte budget instead of being delivered whole or not at all.

## Graph association

Keyword search only finds a starting point. Association follows the links CatsLog already stores. Production on 2026-11-14 (read-only count): Diary entries cite raw session turns (13,251 `session_query` anchors in 7,467 of 7,847 entries), learning nodes and other entries; no entry cites a `source_memory_projection_node`. Stored links are entry↔entry (`related` 1,415, `derived_from` 1,294, `supplements` 1,244, `continues` 976, `requires` 461, `corrects` 325) and entry→session turn (`derived_from` 10,023). Memory-node seeds alone therefore reach nothing in production; the existing bridge is Diary → session turns.

Seeds widen accordingly. From the Diary entries the main agent actually read (`graph` nodes, `read` entries; never search hits), the Branch receives:

- the entries themselves, as **hop-only** handles: they can be expanded, never read, never cited;
- the session turns and learning nodes those entries cite, as **readable** handles;
- cited Memory nodes, as before.

`memory_links` expands one issued handle through `/knowledge/expand` and returns typed, body-free edges whose remote endpoints become new handles of the same three classes. `related` and `continues`, which `graph` deliberately leaves out of the main agent's closure, are reachable here. `memory_node_read` reads a readable handle: a Memory node as its canonical `memory-graph/3` view, a session turn or learning node as one complete source. The model sees opaque handles and edge kinds only; anchor coordinates stay in the client.

Budgets: three link calls per run, 16 edges per call, 32 handles in total; reads stay inside the shared two-read cap and the 32 KiB whole-or-nothing node allowance.

Branch (graph association):

- **L1** A Diary entry's body, title or text reaches Branch input through seeds or link results.
- **L2** An entry handle can be read, or a Diary ref is accepted as finish evidence.
- **L3** A link expansion or read runs for a handle this run did not issue (not seeded, not a link endpoint); a model-supplied raw anchor reaches HTTP.
- **L4** Link expansion exceeds three calls, 16 edges per call or 32 handles; a failed call does not consume its slot.
- **L5** A link endpoint whose `remote_status` is not `resolved`, or whose anchor fails validation, becomes a handle.
- **L6** A session or learning source is delivered while not `read`, not `complete`, truncated, mismatched with its anchor, or over the shared node allowance; a source read bypasses the two-read cap.
- **L7** Seeds come from anything other than successful `catslog_knowledge_recall` `graph`/`read` results.
- **L8** Anchor coordinates (session, stream, document identifiers) appear in seed or link results shown to the model.
