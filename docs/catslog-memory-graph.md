# CatsLog daily Memory Graph recall

Diary closures are read by the main agent only; the Memory Branch reads the Memory nodes they cite. See [catslog-recall-layering.md](catslog-recall-layering.md).

Daily knowledge entries are the memory corpus. Skills supplement them as reusable procedures. The client reads the server's `memory-graph/1` required-context closure using exact `knowledge_entry(document_id, revision, id)` seeds.

The native `catslog_knowledge_recall` tool supports `search`, `read` and `graph`. A document read with an `entry_id` also returns the corresponding graph after resolving its revision. Whole-document JSON/OKF reads retain their document semantics; they are not a claim of complete cross-document graph closure. A closure includes `corrects`/`supplements` from either end, so the main agent does not need a separate link expansion. Original sources and session history are Memory-layer reads owned by the Branch.

Whole graphs are admitted or rejected; conditions are never clipped independently. Metadata-only, malformed, stale, cancelled and over-budget graph results cannot become citable knowledge.

Availability and identity use the existing read capability, recall switch, role/logout checks and cancellation. The compatible server graph reader must be deployed first; a missing route remains an observable failure. Merging this client does not enable server knowledge generation. The package version follows main (1.6.3).

Native attribution requires the complete graph payload in the actual model input. Disclosure, assistant literal citations and final retained refs stay distinct. Graph source anchors do not assert that original source text was disclosed.

Server-side closure, source validity and relation quality remain server responsibilities. During paired review a direct raw source rewrite at unchanged coordinates was found to remain readable through the server graph path despite its old digest pin. That server issue must be resolved before claiming fully re-proved graph provenance. Bounded closure growth, semantic correctness, unified retrieval and real-task benefit also require separate evaluation.

Focused tests are `catslog-recall-layering`, `catslog-knowledge-graph`, `catslog-knowledge-recall-tool`, `native-recall-feedback-outbox` and the knowledge transport/lifecycle tests. Runtime validation uses `XIAOBA_TEST_CONCURRENCY=1 node scripts/run-tests.mjs runtime`; TypeScript uses the existing local compiler. Mechanism tests use scripted models and do not establish semantic gains or production cost.
