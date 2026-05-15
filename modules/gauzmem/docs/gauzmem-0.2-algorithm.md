# GauzMem 0.2 Algorithm

This document is the implementation contract for GauzMem 0.2.

## Goal

GauzMem is a query-time associative memory. It does not pre-index source content into a semantic graph. It builds and reuses a persistent evidence graph while answering real queries.

The central rule is:

```text
Retrieve decides root relevance.
Construct only creates local graph roads.
```

## Inputs

```text
root query
source roots
persistent graph store
energy / frontier budget
retrieval thresholds
reasoner adapter
```

## Outputs

```text
transient memory bundle
JSONL nodes / edges / state / runs / events
dashboard replay data
```

The agent-facing bundle is intentionally natural:

```text
[gauzmem_recall]
相关记忆线索：

- evidence text
  可能联想到：
  - related evidence text：whyRelevant
[/gauzmem_recall]
```

It does not include run ids, source refs, graph ids, or debug stats. Those stay in JSONL and dashboard views.

## Loop

The runtime has two queues:

```text
graphQueue:
  selected graph/evidence nodes waiting for graph disclose

constructQueue:
  exhausted frontier nodes waiting for local source construct
```

`graphQueue` always has priority.

```text
1. Build root search terms.
2. Scan existing graph for node/edge keyword hits.
3. Disclose a graph window from graph seeds.
4. Run root relevance judge on disclosed nodes/edges.
5. Put selected nodes into graphQueue.

while energy and frontier budget remain:
  if graphQueue is not empty:
    pop one node
    disclose retrievable unvisited edges around it
    if edges were disclosed:
      run root relevance judge
      put selected next nodes into graphQueue
    else:
      put the original frontier node into constructQueue
    continue

  if current selected graph is sufficient and forceConstruct is false:
    stop

  if constructQueue is not empty:
    pop one exhausted frontier
    local construct from source
    if new localAssociation edges were written:
      put the original frontier node back into graphQueue
    continue

  if cold start or graph exhausted:
    construct from root query once
    root relevance judge the standalone evidence nodes
    put selected nodes into graphQueue
    continue

  stop
```

## Retrieve

Retrieve is responsible for:

```text
graph scan
graph disclose
root relevance judge
selected / rejected node and edge state updates
memory bundle composition
```

Only retrieve can decide whether something enters the returned bundle.

## Construct

Construct is responsible for:

```text
local grep from source roots
source window extraction
exact evidence node creation
localAssociation edge creation
whyRelevant writing
```

Construct does not root-judge raw source evidence.

For node-local construct, the evidence extractor receives the parent evidence text
as its query and the root query only as auxiliary metadata. This prevents the LLM
extractor from silently doing root relevance filtering before graph disclose.

For a node frontier:

```text
frontier node F
  -> local source search using F as parent
  -> extract exact evidence nodes
  -> write F -> evidence localAssociation edges
  -> put F back into graphQueue
  -> graph disclose sees the new edge
  -> root relevance judge decides whether edge / target node is useful
```

For cold start:

```text
no graph seed
  -> construct from root query
  -> write standalone evidence nodes
  -> root relevance judge those standalone nodes
  -> selected nodes enter graphQueue
```

## Construct Limits

Per run defaults:

```text
maxConstructAttemptsPerNode = 2
maxGraphDiscloseAttemptsPerNode = 3
maxRootConstructAttempts = 1
```

These are run-local safety limits. Persistent cross-run attempt caps are intentionally not part of 0.2 yet.

## Edge Visibility

Created edges are persisted immediately, but they do not enter the agent-facing memory bundle unless graph disclose reveals them and root relevance selects them.

The distinction is:

```text
createdEdgeIds:
  edges written this run

selectedEdgeIds:
  edges accepted by root relevance

returnedEdgeIds / memoryBundle.edgeIds:
  selected edges included in the prompt graph

memoryBundle.createdEdgeIds:
  created edges from this run that were also selected by root relevance
```

This prevents construct from polluting prompt memory with unjudged local associations.

## Source Search Semantics

Root construct uses root query terms.

Node-local construct uses the frontier node as the search parent. This keeps association reusable across queries instead of baking the current root query into every local edge.

The reasoner still receives the root query when writing `whyRelevant`, but local search term generation is parent-centered.

## Energy

Default energy:

```text
passive retrieve: 64
active tool search: 96
```

Default XiaoBa HTTP timeout is `45000ms` because GauzMem 0.2 can make several LLM calls in a single run.

## Replay Data

Run stats include:

```text
retrieveAlgorithm
frontierSteps
graphFrontierSteps
sourceConstructCount
nodeConstructCount
rootConstructCount
constructAttemptCount
graphDisclosureCount
energyTrace
durationMs
timings[]
```

`timings[]` contains small step records such as `root_search_plan`,
`source_search`, `construct_frontier_step`, and LLM phases. Timings are recorded
in memory during a retrieve run and persisted once with the run trace; they do
not include prompts, source windows, or other large payloads.

Search trace entries can include:

```text
phase
parentNodeId
parent
constructReason
```

These fields are for dashboard/debug replay and are not injected into the agent prompt.
