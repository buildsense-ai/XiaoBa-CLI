# Methods

## 3.1 Overview

We propose **Key Fact Logic Graph (KFLG)**, a deterministic reasoning memory architecture that models the context space as a hybrid manifold with four orthogonal dimensions: semantic, temporal, logical, and scale. Unlike traditional Vector RAG systems that rely solely on semantic similarity, KFLG constructs a recursive logic graph as a discrete approximation of this manifold, enabling System 2 reasoning capabilities for LLM agents.

As illustrated in Figure 2, KFLG consists of three hierarchical layers: **L1 (Entity Layer)** serves as a sparse associative bus connecting atomic entities, **L2 (Key Fact Layer)** captures causal relationships between entities through predefined bootstrap relations, and **L3 (Narrative Layer)** organizes facts into coherent storylines. This architecture is built through a top-down recursive extraction process and supports intent-driven dimensional activation during retrieval.

## 3.2 Theoretical Framework: Hybrid Context Manifold

### 3.2.1 Manifold Hypothesis for Context Space

We posit that meaningful information in natural language is not uniformly distributed in the high-dimensional embedding space, but rather lies on a low-dimensional intrinsic manifold constrained by physical laws and logical causality. Formally, we define the **Hybrid Context Manifold** as:

```
M = S_semantic × T_temporal × L_logical × Z_scale
```

where:
- **S_semantic**: Semantic similarity dimension, capturing conceptual relatedness (continuous)
- **T_temporal**: Temporal ordering dimension, encoding event sequences and time dependencies (discrete)
- **L_logical**: Logical causality dimension, representing causal relationships (discrete, graph-structured)
- **Z_scale**: Scale dimension, organizing information at different granularities (discrete, hierarchical)

This formulation unifies two previously isolated paradigms: Vector RAG operates primarily on S_semantic, while Knowledge Graphs focus on L_logical. Our manifold framework integrates all four dimensions, enabling richer context representation.

### 3.2.2 Discrete Approximation via Logic Graph

Since the continuous manifold M is intractable for direct computation, we construct a **discrete approximation** through a recursive logic graph. This graph serves as a finite sampling of the manifold, where:
- **Nodes** represent information units at different scales (entities, facts, narratives)
- **Edges** encode relationships along the logical dimension (causal, temporal, hierarchical)
- **Node embeddings** capture the semantic dimension
- **Edge types** and **layer hierarchy** encode the logical and scale dimensions

The construction process follows the **Minimum Description Length (MDL) principle** [REF_TODO]: we extract information units that maximize compression of the original context while preserving logical coherence. This ensures that the graph captures the intrinsic structure of the manifold rather than surface-level patterns.

### 3.2.3 Bayesian Refinement with LLM Prior

To handle uncertainty in relationship extraction, we employ a **Bayesian refinement** framework where the LLM serves as a universal logical prior:

```
P(relation | context) ∝ P(context | relation) × P_LLM(relation)
```

where P_LLM(relation) is the prior probability estimated by the LLM based on its pre-trained knowledge. This mechanism allows KFLG to leverage both data-driven evidence and commonsense reasoning, reducing false positives in causal relationship extraction.

## 3.3 KFLG Architecture

### 3.3.1 Three-Layer Hierarchy

KFLG organizes information into three hierarchical layers, each operating at a different scale on the manifold:

**L1 (Entity Layer)**: The atomic layer consists of named entities and key concepts extracted from the context. Each entity node e_i is represented as:

```
e_i = {name, type, embedding, metadata}
```

L1 serves as a **sparse associative bus** that enables efficient cross-fact navigation. By maintaining direct connections between co-occurring entities, L1 reduces the graph traversal complexity from O(N²) to O(k), where k is the average entity degree (typically k << N).

**L2 (Key Fact Layer)**: The fact layer captures atomic propositions and their causal relationships. Each fact node f_j is defined as:

```
f_j = {subject, predicate, object, relation_type, confidence, timestamp}
```

where relation_type ∈ {caused_by, leads_to, conflicts_with, supports, precedes, ...} is drawn from a predefined bootstrap relation set. This layer operates primarily on the logical dimension L_logical, encoding the causal structure of the context.

**L3 (Narrative Layer)**: The narrative layer organizes facts into coherent storylines or thematic clusters. Each narrative node n_k represents:

```
n_k = {fact_sequence, theme, summary, temporal_span}
```

L3 operates on both the temporal dimension T_temporal (through fact_sequence ordering) and the scale dimension Z_scale (by aggregating multiple facts into higher-level narratives). This layer is currently under development and not evaluated in this work.

### 3.3.2 Recursive Fractal Topology

A key design principle of KFLG is its **recursive fractal structure**: each layer can theoretically spawn sub-layers with finer granularity. For instance, L2 facts can be decomposed into sub-facts (L2.1, L2.2, ...), and L1 entities can be expanded into entity attributes. This recursive topology mirrors the self-similar structure of natural language semantics, where meaning emerges at multiple scales.

In the current implementation, we focus on the L1-L2 interaction, as this captures the most critical reasoning patterns for multi-hop question answering. The extension to deeper recursion (L2.x, L3.x) is left for future work.

## 3.4 Top-Down Recursive Extraction

### 3.4.1 Extraction Pipeline

KFLG is constructed through a **top-down recursive extraction** process that progressively refines the context into structured layers. The pipeline consists of three stages:

**Stage 1: Entity Extraction (L1 Construction)**
Given a context document D, we first extract all named entities and key concepts using the LLM:

```
E = ExtractEntities(D) = {e_1, e_2, ..., e_n}
```

Each entity is assigned a type (Person, Organization, Location, Concept, etc.) and embedded using a pre-trained encoder. Co-occurring entities within a sliding window are connected by edges, forming the L1 associative bus.

**Stage 2: Fact Extraction (L2 Construction)**
For each entity pair (e_i, e_j) connected in L1, we prompt the LLM to extract causal relationships:

```
F_ij = ExtractFacts(D, e_i, e_j, RelationSet)
```

where RelationSet = {caused_by, leads_to, conflicts_with, supports, precedes, ...} is the bootstrap relation set. The LLM is instructed to:
1. Identify atomic propositions involving both entities
2. Classify the relationship type
3. Assign a confidence score based on textual evidence

**Stage 3: Bayesian Refinement**
To reduce false positives, we apply Bayesian refinement to each extracted fact:

```
confidence_refined = α × confidence_textual + β × P_LLM(relation | e_i, e_j)
```

where confidence_textual is the initial confidence from Stage 2, and P_LLM is the prior probability estimated by the LLM. Facts with confidence_refined below a threshold τ are filtered out.

### 3.4.2 Complexity Shifting

A critical advantage of KFLG is **complexity shifting**: the computational cost of reasoning is transferred from query time (runtime) to indexing time (construction). Traditional Vector RAG performs semantic search at every query, with complexity O(N) for N context chunks. In contrast, KFLG pre-computes the logic graph structure, enabling deterministic traversal with complexity O(k × h), where k is the average entity degree and h is the reasoning hop count.

This mechanism ensures that KFLG provides **deterministic System 2 reasoning** without runtime LLM calls for relationship inference, making it suitable for latency-sensitive applications.

## 3.5 Intent-Driven Retrieval

### 3.5.1 Four-Stage Retrieval Pipeline

KFLG employs a **four-stage retrieval pipeline** that activates different manifold dimensions based on query intent. As illustrated in Figure 4, the pipeline consists of:

**Stage 1: Anchoring (Semantic Dimension)**
Given a query Q, we first identify anchor entities by semantic similarity:

```
E_anchor = TopK(Similarity(Embed(Q), Embed(e_i)), k=3)
```

This stage operates on the S_semantic dimension, leveraging dense retrieval to find semantically relevant starting points in the graph.

**Stage 2: Expansion (Logical Dimension)**
From each anchor entity, we expand to connected facts through the L1 associative bus:

```
F_candidate = {f | f.subject ∈ E_anchor OR f.object ∈ E_anchor}
```

This stage activates the L_logical dimension, retrieving facts that have causal relationships with the anchor entities.

**Stage 3: Traversal (Temporal + Logical Dimensions)**
For multi-hop reasoning queries, we perform graph traversal following causal chains:

```
F_reasoning = Traverse(F_candidate, relation_types, max_hops=h)
```

where relation_types are filtered based on query intent (e.g., "why" questions prioritize caused_by edges, "what happens next" prioritizes leads_to edges). This stage jointly activates T_temporal and L_logical dimensions.

**Stage 4: Calibration (Bayesian Refinement)**
Finally, we re-rank the retrieved facts using Bayesian calibration:

```
score_final = λ × score_semantic + μ × confidence_refined + ν × relevance_LLM(f, Q)
```

where relevance_LLM is computed by prompting the LLM to assess the relevance of each fact to the query. This stage ensures high precision by filtering out spurious facts.

### 3.5.2 Dimensional Activation Strategy

A key innovation of KFLG is **intent-driven dimensional activation**: different query types activate different subsets of the manifold dimensions. For example:

- **Factual queries** ("What is X?"): Primarily activate S_semantic
- **Causal queries** ("Why did X happen?"): Activate S_semantic + L_logical (caused_by relations)
- **Temporal queries** ("What happened after X?"): Activate T_temporal + L_logical (precedes, leads_to relations)
- **Multi-hop reasoning** ("If X, then what?"): Activate all dimensions with graph traversal

This selective activation reduces noise and improves retrieval precision by focusing on the most relevant manifold dimensions for each query type.

## 3.6 Complexity Analysis

### 3.6.1 L1 Associative Bus Efficiency

The L1 entity layer serves as a **sparse shortcut system** that dramatically reduces graph traversal complexity. In a naive knowledge graph with N facts, finding all facts related to an entity requires O(N) linear search. With the L1 associative bus, we maintain an inverted index:

```
Index: entity_id → [fact_id_1, fact_id_2, ..., fact_id_k]
```

where k is the average number of facts per entity (typically k << N). This reduces the lookup complexity to O(k), achieving a speedup of N/k.

### 3.6.2 Multi-Hop Reasoning Complexity

For h-hop reasoning queries, the traversal complexity is:

```
Complexity_KFLG = O(k^h)
```

where k is the average entity degree. In contrast, Vector RAG requires re-ranking all N chunks at each hop:

```
Complexity_VectorRAG = O(h × N)
```

For typical scenarios where k ≈ 10 and N ≈ 1000, KFLG achieves significant efficiency gains for h ≤ 3 hops.

## 3.7 Implementation Details

**LLM Backend**: TODO(model_name, version)

**Entity Extraction**: TODO(NER_tool or LLM_prompt)

**Embedding Model**: TODO(embedding_model, dimension)

**Bootstrap Relations**: We define 12 core relation types: caused_by, leads_to, conflicts_with, supports, precedes, follows, part_of, instance_of, similar_to, contradicts, enables, prevents.

**Hyperparameters**: 
- Confidence threshold τ = TODO(value)
- Bayesian weights: α = TODO, β = TODO
- Retrieval weights: λ = TODO, μ = TODO, ν = TODO
- Max hops h = TODO(value)

**Hardware**: TODO(GPU_type, memory)

**Construction Time**: TODO(time_per_document)

