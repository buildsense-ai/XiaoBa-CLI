# Writing Blueprint

## Meta
- project: Context on Manifolds - Deterministic Reasoning Memory Architecture
- target_venue: TODO (请告知目标期刊/会议，如 NeurIPS, ICML, ACL 等)
- language: en
- status: ready
- last_updated: 2024-01-XX (蓝图已就绪，开始撰写 Methods)

## Research Context

### Topic (1 sentence)
A deterministic reasoning memory architecture for LLM agents that models memory space as a hybrid manifold with semantic, temporal, logical, and scale dimensions, enabling System 2 reasoning through recursive logic graphs.

### Claimed Contributions
1. **Theoretical Framework**: Propose the "Hybrid Context Manifold" theory that unifies semantic retrieval (Vector RAG) and logical reasoning (Knowledge Graph) by modeling memory as a high-dimensional manifold with four orthogonal dimensions (semantic, temporal, logical, scale).
2. **System Architecture**: Design Key Fact Logic Graph (KFLG) as a discrete approximation operator of the manifold, featuring top-down recursive extraction and L1 entity associative bus.
3. **Complexity Shifting**: Successfully transfer runtime reasoning computation to indexing-time construction cost, providing deterministic System 2 reasoning capability for agents.
4. **Empirical Validation**: Demonstrate KFLG's advantages over Vector RAG in logical reasoning precision, context signal-to-noise ratio, and complexity shifting efficiency.

### Method
- name: Key Fact Logic Graph (KFLG)
- core_idea: Model memory as a hybrid manifold (M = S_semantic × T_temporal × L_logical × Z_scale) and build a recursive logic graph as its discrete approximation. Use top-down extraction to construct L1 (Entity), L2 (Fact), L3 (Narrative) layers, with L1 serving as an associative bus for efficient retrieval.
- key_novelty: 
  * Unified theoretical framework combining manifold hypothesis, MDL principle, and Bayesian inference
  * Recursive fractal topology (L1 to Ln) with current focus on L2 Key Fact layer
  * L1 as sparse shortcut system reducing complexity from O(N²) to O(k)
  * Intent-driven dimensional activation for retrieval
- assumptions:
  * Meaningful information is embedded in a low-dimensional intrinsic manifold constrained by physical laws and logical causality
  * Causal relationships can be captured by predefined bootstrap relation set (caused_by, leads_to, conflicts_with, etc.)
  * LLM can serve as universal logical prior for Bayesian refinement

### Experimental Setup (facts only)
- datasets: LoCoMo (Long Context Modeling benchmark) - 与 MemoryOS 论文一致
- splits: TODO (训练/验证/测试集划分)
- metrics: 
  * Logical Reasoning: Hop Accuracy (2-hop, 3-hop), Hallucination Rate
  * Context Quality: Evidence Retention, Noise Reduction
  * Efficiency: Indexing Latency, Query Latency (TTFT), Token Cost
- baselines: TODO (对比方法，如 Vector RAG, GraphRAG, MemoryBank 等)
- training_details: TODO (是否需要训练？如果有，提供超参数)

### Results (facts only)
- main_results: TODO (主要实验结果的数值)
- ablations: TODO (消融实验结果)
- qualitative: TODO (案例分析、可视化等)

## Reference Papers

### Primary: MemoryOS
- analysis_path: docs/analysis/2506.06326v1
- role: 主要参考 - 同样关注 LLM 记忆管理，学习其系统架构描述、模块化组织方式和实验设计

### Supplementary
- None (用户未提供其他参考论文)

## Writing Patterns (from references)

### Structural Patterns (from MemoryOS)
- **Methods章节结构**: 总体定位(1段) → 架构概述(1小节) → 各模块详解(多小节，按数据流向组织)
- **模块化组织**: 将复杂系统拆解为独立模块，每个模块用独立小节详细展开
- **层次化展开**: 在每个模块内部，按"概述→细节→机制"的层次递进
- **Introduction结构**: 问题-现状-方案-贡献（4段式）
- **Abstract结构**: 问题-方案-方法-结果（经典4句式）

### Rhetorical Patterns (from MemoryOS)
- **跨领域类比**: 借鉴成熟领域的原理建立理论基础（MemoryOS借鉴OS原理）
- **设计理由说明**: 不仅描述"是什么"，还解释"为什么这样设计"
- **公式与文字配合**: 先用文字描述概念，再用公式精确定义，最后解释公式中各项的含义
- **对比分析**: 展示自己的结果时，详细分析基线方法的局限性
- **首创性强调**: 多次使用"pioneer""first""pioneering"强调创新

### Sentence Patterns (from MemoryOS)
- **模块定义**: "[模块名]: This module is responsible for [功能], [具体实现方式], ensuring [目标]"
- **数据结构定义**: "[结构名] is defined as: [公式], where [各项解释]"
- **更新策略**: "We employ a [策略名] strategy for [目标]. [触发条件], [执行动作]"
- **检索策略**: "[层级] retrieval: [策略描述], employing a [方法] to [目标]"
- **设计理由**: "This mechanism ensures that [效果], [具体好处]"

## Chapter Plans

### Methods
- moves:
  * Move 1 (总体定位, 1段): 开篇概括 KFLG 的核心功能和设计理念
  * Move 2 (理论框架, 1小节, 3-4段): 介绍 Hybrid Context Manifold 理论，定义四个维度（semantic/temporal/logical/scale），建立理论基础
  * Move 3 (架构概述, 1小节, 2-3段): 概述 KFLG 的整体架构（L1/L2/L3层级结构），引用 Figure 2
  * Move 4 (构建模块, 1小节, 5-6段): 详细描述 Top-Down Recursive Extraction 过程（L1 Entity → L2 Key Fact → L3 Narrative），配公式和算法
  * Move 5 (检索模块, 1小节, 4-5段): 描述四阶段检索流程（Anchoring → Expansion → Traversal → Calibration），引用 Figure 4
  * Move 6 (复杂度分析, 1小节, 2-3段): 分析 L1 associative bus 如何将复杂度从 O(N²) 降至 O(k)
- figures_needed: 
  * Figure 1: Hybrid Manifold Visualization (4 dimensions)
  * Figure 2: KFLG Architecture (L1/L2/L3 layers)
  * Figure 3: Top-Down Recursive Extraction Process
  * Figure 4: Retrieval Flow (Anchoring → Expansion → Traversal → Calibration)
- refs_needed: [REF_TODO: Manifold hypothesis, MDL principle, Bayesian inference, Graph-based reasoning]
- status: drafted

### Results
- moves: TODO (待规划)
- figures_needed:
  * Table 1: Main Results (Hop Accuracy, Hallucination Rate)
  * Table 2: Context Quality Metrics
  * Table 3: Efficiency Comparison
  * Figure 5: Ablation Study Visualization
- refs_needed: TODO
- status: todo

### Discussion
- moves: TODO (待规划)
- figures_needed: TODO
- refs_needed: TODO
- status: todo

### Introduction
- moves:
  * Move 1 (问题建立, 1-2段): 开篇指出 LLM agents 在长期交互中面临的记忆管理挑战（上下文窗口限制、检索精度低、逻辑推理能力弱）
  * Move 2 (现状综述与 Gap, 2-3段): 综述现有方法（Vector RAG、Knowledge Graph、混合方法），指出它们的局限性（语义漂移、图构建成本高、缺乏统一理论框架）
  * Move 3 (解决方案引入, 2段): 引入 Hybrid Context Manifold 理论和 KFLG 架构，强调理论创新和系统设计
  * Move 4 (贡献列表, 1段): 列出 4 条主要贡献（理论框架、系统架构、复杂度转移、实验验证）
  * Move 5 (文章结构, 1段, 可选): 简要说明论文组织结构
- figures_needed: 
  * Figure 1: KFLG Architecture Overview (在 Move 3 中引用)
- refs_needed: [REF_TODO: Vector RAG, Knowledge Graph, RAG limitations, Multi-hop reasoning]
- status: drafting

### Related Work
- moves: TODO (待规划)
- refs_needed: TODO
- status: todo

### Conclusion
- moves: TODO (待规划)
- status: todo

### Abstract
- status: todo

## Open TODOs

### Critical (必须补充才能开始写作)
- [ ] **目标期刊/会议**: 请告知投稿目标，这会影响写作风格和篇幅
- [ ] **MemoryOS 分析路径**: 请提供完整的 paper-analysis 输出目录路径
- [ ] **实验数据集**: 使用了哪些数据集？规模多大？
- [ ] **对比基线**: 与哪些方法对比？
- [ ] **实验结果**: 主要指标的具体数值

### Important (影响写作质量)
- [ ] **消融实验**: 做了哪些消融？结果如何？
- [ ] **案例分析**: 是否有具体的推理案例展示？
- [ ] **其他参考论文**: 是否还有其他想参考的论文？

### Nice-to-have (可后续补充)
- [ ] **训练细节**: 如果涉及模型训练，提供超参数
- [ ] **可视化素材**: 是否已有图表草稿？
- [ ] **引用文献**: BibTeX 或论文列表

---

## 下一步行动

请您提供以下信息，我会逐步完善蓝图：

1. **目标期刊/会议**（如 NeurIPS, ICML, ACL, AAAI 等）
2. **MemoryOS 论文分析的完整路径**（例如：`docs/analysis/memoryos`）
3. **实验相关信息**：
   - 使用的数据集
   - 对比的基线方法
   - 主要实验结果（即使是初步的）

有了这些信息后，我会：
- 从 MemoryOS 分析中提炼写作模式
- 规划各章节的 moves
- 开始逐章撰写初稿
