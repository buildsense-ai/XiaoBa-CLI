# CatsLog recall layering

CatsLog keeps three layers: Session Graph (what happened), Memory Graph (cleaned sessions) and Wiki/Diary (document entries). XiaoBa reads them through two agents with different jobs.

| Agent | Layer | Purpose | Surface |
| --- | --- | --- | --- |
| Main agent | Wiki/Diary documents | Converge on maintained, revision-pinned knowledge | `catslog_knowledge_recall` with `search`, `read`, `graph` |
| Memory Branch | Memory and sessions | Bounded divergence into surrounding context | local `memory_search`/`memory_read_turn`/`memory_neighbors`, remote `memory_remote_search`/`memory_source_read`, cited `memory_node_read` |

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
- **B8** The Branch reads a node other than an exact seeded anchor, or delivers a response that is not the canonical `memory-graph/3` view of that anchor.
