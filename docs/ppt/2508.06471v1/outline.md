# GLM-4.5 论文精读 PPT 大纲

## 主题：academic

## 页面规划（共14页）

1. **封面** (title) — 论文标题、作者团队、发表信息
2. **研究背景与动机** (content) — LLM 演进趋势、ARC 三能力框架、开源 gap
3. **模型概览与定位** (content) — GLM-4.5/Air 参数规模、综合排名、参数效率
4. **MoE 架构设计** (two_column) — "减宽增深"设计哲学、GLM-4.5 vs GLM-4.5-Air 架构对比
5. **多阶段预训练** (content) — 5 阶段训练流程、数据组成、序列长度扩展
6. **章节分隔：Post-Training** (section_header) — 专家训练→统一蒸馏
7. **SFT 与混合推理模式** (content) — Cold Start SFT、Overall SFT、混合推理、Function Call 模板
8. **Reasoning RL** (content) — 难度课程学习、单阶段 64K、动态温度、Code/Science RL
9. **Agentic RL** (content) — 迭代自蒸馏、交互轮次 scaling、outcome supervision
10. **General RL 与 Slime 框架** (two_column) — 多源反馈系统 vs RL 基础设施
11. **章节分隔：Evaluation** (section_header) — 12 ARC Benchmarks + 人工评测
12. **ARC Benchmark 结果** (content) — Agentic/Reasoning/Coding 三维度核心数据
13. **人工评测与翻译** (content) — General Chat、CC-Bench、翻译专项
14. **总结与评价** (content) — 核心贡献、局限性、延伸思考
