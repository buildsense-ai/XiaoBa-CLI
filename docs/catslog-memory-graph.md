# CatsLog daily Memory Graph recall

Daily knowledge entries are the memory corpus. Skills supplement them as reusable procedures. The client reads the server's `memory-graph/1` required-context closure using exact `knowledge_entry(document_id, revision, id)` seeds.

The native `catslog_knowledge_recall` tool supports `action: "graph"`. A document read with an `entry_id` also returns the corresponding graph after resolving its revision. Whole-document JSON/OKF reads retain their document semantics; they are not a claim of complete cross-document graph closure. Original source bodies remain an explicit `read_source` operation.

The current memory Branch follows main's autonomous tool loop:

1. `memory_knowledge_search {query}` returns at most eight metadata candidates for one model-selected literal keyword.
2. `memory_knowledge_graph {ref}` reads a candidate's complete prerequisites and supplement/correction context. It never falls back to the seed's body after a graph error.
3. `finish_memory_search {summary,evidence,inject}` accepts knowledge refs only after a complete graph read in this run. Selecting any node attaches its whole graph to the actual parent-agent observation.

Knowledge searches share the run's two remote-search slots. Graph and projection reads share two expansion attempts and a 16,000-byte UTF-8 retention budget including their graph/projection envelopes. Failed attempts consume a slot. Metadata-only, malformed, stale, cancelled and over-budget graph results cannot become citable knowledge. Whole graphs are admitted or rejected; conditions are never clipped independently.

The older daily-lane presentation helpers remain available for legacy embedded adapters and their bounded presentation tests. They no longer define the production Branch workflow. New tests exercise explicit search/read/finish exchanges and the parent's actual messages.

Availability and identity use the existing read capability, recall switch, role/logout checks and cancellation. The compatible server graph reader must be deployed first; a missing route remains an observable failure. Merging this client does not enable server knowledge generation. The package version follows main (1.6.3).

Native attribution requires the complete graph payload in the actual model input. Disclosure, assistant literal citations and final retained refs stay distinct. Branch graph feedback conservatively uses selected knowledge metadata envelopes with the identity captured at read time; graph source anchors do not assert that original source text was disclosed. A token/identity replacement cannot adopt the old feedback event.

Server-side closure, source validity and relation quality remain server responsibilities. During paired review a direct raw source rewrite at unchanged coordinates was found to remain readable through the server graph path despite its old digest pin. That server issue must be resolved before claiming fully re-proved graph provenance. Bounded closure growth, semantic correctness, unified retrieval and real-task benefit also require separate evaluation.

Focused tests are `catslog-knowledge-graph`, `memory-branch-projection-flow`, `branch-source-citations`, `native-recall-feedback-outbox` and the knowledge transport/lifecycle tests. Runtime validation uses `XIAOBA_TEST_CONCURRENCY=1 node scripts/run-tests.mjs runtime`; TypeScript uses the existing local compiler. Mechanism tests use scripted models and do not establish semantic gains or production cost.
