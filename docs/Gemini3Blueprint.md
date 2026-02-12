XiaoBa 2.0 技术蓝图：对齐 MIT 研究生级科研智能体

1. 愿景与核心哲学

1.1 升级目标

将 XiaoBa 从“被动执行的工程助手”升级为“具备自主科研直觉与极度严谨纪律的研究型 Agent”。在特定垂直领域（如文献综述、实验设计、数据分析），产出质量、抗辩能力和复现稳定性达到或超越顶级高校（如 MIT）研究生的基线水平。

1.2 核心哲学：双脑架构 (Dual-Process Architecture) & 双螺旋开发路线

真正的顶级研究能力是 “灵性（Intuition）” 与 “纪律（Discipline）” 的结合。

System 1（认知与灵魂）： 快速筛选论文、提出大胆假设、构建叙事、进行苏格拉底式对话（提供上限）。

System 2（架构与纪律）： 强制证据溯源、统计检验、反事实推理、可复现性检查（保证下限）。

开发原则：禁止单边突进。 必须将“认知拓展（踩油门）”与“架构约束（踩刹车）”成对开发，防止系统变成“死板的填表机器”或“极度自信的学术骗子”。

2. 核心数据状态机 (State Management)

这是连接“对话智能”与“工程严谨性”的底层数据结构。XiaoBa 的每次思考和输出都必须基于这两个文件。

2.1 The Research Journal（动态研究日志 - 认知基座）

解决痛点：系统没有跨对话的长期上下文，无法形成“假设-验证-修正”的研究惯性。

作用： 维护工作记忆、研究直觉、以及被推翻的历史。

数据结构示例：

{
  "topic": "Transformer在长时序预测中的必要性",
  "current_phase": "hypothesis_refinement",
  "mental_context": {
    "current_intuition": "怀疑之前论文的提升主要来自归一化技巧，而非注意力机制",
    "open_questions": ["在极端噪声下，线性模型是否更鲁棒？"]
  },
  "hypothesis_chain": [
    {
      "id": "H1",
      "statement": "注意力机制是性能提升的核心",
      "status": "refuted",
      "reason": "EXP-03(消融实验)显示去除非线性层后性能未显著下降"
    }
  ]
}


2.2 The Evidence Ledger（证据账本 - 纪律基座）

解决痛点：大模型容易产生事实幻觉，导致结论不可靠。

作用： 强约束型数据库。写入报告的每一句结论（Claim），都必须在此账本中有对应的物理来源（论文ID或实验日志Hash）。

数据结构示例：

{
  "claims": {
    "C-2026-001": {
      "text": "去除Instance Norm后，模型在ETTh1数据集上MSE激增45%",
      "source_type": "experiment",
      "source_id": "EXP-20260212-Ablation",
      "artifact_path": "./results/exp_ablation.csv",
      "confidence_level": 0.95,
      "verification": "passed"
    }
  }
}


3. 核心能力模块 (Key Skills & Engines)

我们将按“认知（油门）”与“约束（刹车）”配对的方式设计核心模块。

模块对 1：信息摄入层 (Information Intake)

[认知层] Paper-Triage (论文快筛/分诊)：

行为： 获取论文后，仅读取 Title, Abstract, Figure Captions, Conclusion。在 30 秒内给出 Must-Read / Skim / Skip 判断，并附带判断理由（例如：“Baseline 太旧，判为 Skip”）。

价值： 建立文献品味，极大节省系统算力与上下文窗口。

[约束层] Citation-Consistency-Checker (引用一致性检查)：

行为： 当 XiaoBa 决定采纳某篇文献的结论时，强制提取该文献的原句进行语义比对，防止张冠李戴或过度外推。

模块对 2：研究循环层 (Research Loop)

[认知层] Devils-Advocate (魔鬼辩护人)：

行为： 当用户提出研究思路时，主动切换人设进行挑战（“你认为 X 有效，但有没有可能是 Y 导致的数据泄露？”），并自动检索反面证据。

价值： 从“被动服从”变为“学术对打”，提升研究的新颖度（Novelty）。

[约束层] Hypothesis-Engine (标准化假设引擎)：

行为： 将辩论中产生的直觉，强制转化为可证伪的格式：Hypothesis -> Falsifiable Prediction -> Minimal Experiment -> Kill Criteria。

价值： 确保所有的“聪明想法”都有严格的落地验证路径。

模块对 3：产出验证层 (Output & Validation)

[认知层] Knowledge-Extractor (知识图谱提取)：

行为： 自动从完成的论文阅读和实验分析中，提取“方法谱系”、“共识”、“争议点”，写入全局知识库，让 XiaoBa 越用越聪明。

[约束层] Reviewer-Arena (审稿人竞技场)：

行为： 在输出最终报告前，启动 3 个虚拟审稿人（Method, Experiment, Writing）对草稿进行交叉火力攻击。

硬规则： 若草稿中存在未绑定 Evidence Ledger 的强结论，直接打回重写（Major Revision）。

4. 三阶段实施路线图 (90-Day Plan)

遵循“螺旋上升”策略，每一阶段都必须包含“灵性扩展”与“纪律约束”。

Phase 1: 诚实的初级助研 (Day 1 - 30)

目标：能够快速筛选信息，且绝不说谎（消灭幻觉）。

开发任务：

上线 Paper-Triage (只读摘要，给出粗筛判断)。

上线 Evidence-Ledger Lite (系统必须在结论后标注 [Source: ID] 才能输出)。

里程碑指标： 报告结论溯源率达到 100%；无用文献阅读时间减少 80%。

Phase 2: 思考型研究伙伴 (Day 31 - 60)

目标：具备研究上下文记忆，并能提出严谨的验证步骤。

开发任务：

上线 Research-Journal (构建跨对话的状态机)。

上线 Hypothesis-Engine (规范化实验设计)。

引入基础的 Devils-Advocate 提示词流（主动提问能力）。

里程碑指标： 能够主动纠正用户的明显逻辑漏洞；输出标准化的可证伪实验方案。

Phase 3: 具备抗辩能力的专家 (Day 61 - 90)

目标：闭环自我纠错，模拟学术评审对抗。

开发任务：

上线 Reviewer-Arena (内部对抗机制)。

结合 Knowledge-Extractor 形成长效记忆。

(可选) 上线 Repro-Packager 自动生成可复现代码清单。

里程碑指标： 模拟 Peer Review 的 Major Issues 数量在内部迭代中收敛；具备“因为实验结果 X，所以主动推翻假设 Y”的自主决策能力。

5. 核心验收标准（MIT Level 门槛）

零无根之木（Zero Orphan Claims）： 任何进入最终报告的强主张（Strong Claim），必须能够通过 Evidence Ledger 追溯到至少一篇被精读的文献或一次成功的实验日志。

反证覆盖率（Counter-evidence Coverage）： 每个核心结论至少包含 1 个负对照分析或对反面文献的正面回应。

快筛准确率（Triage Accuracy）： 与资深研究员对比，Paper-Triage 判断为 Trash 的文献，专家同意率 >= 90%。

自主推进力（Agency Metric）： 在没有用户微观指令干预的情况下，系统能够自主完成 发现矛盾 -> 建立假设 -> 设计验证 -> 得出结论 的完整循环次数。