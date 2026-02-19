# Self-Evolving Research Agent: 顶会论文研究规划

> 基于 XiaoBa 的 Self-Evolution 能力，瞄准 AI Agent 顶会（如 ICLR / NeurIPS / ACL）

## 一、核心故事线

### 1.1 研究问题

现有的 AI Research Agent（如 AI Scientist、MLAgentBench、Diagram Agent）都是**固定能力集**——开发者预定义了 agent 能做什么，agent 就只能做什么。当用户提出超出预设能力范围的需求时，agent 要么拒绝，要么硬凑，质量不可控。

**核心问题：能否让 Agent 像人一样，在使用过程中自主习得新技能，越用越强？**

### 1.2 我们的方案

XiaoBa：一个具备 Self-Evolution 能力的科研智能体。

- 当遇到已有 skill 无法覆盖的新需求时，自动触发 skill 创建流程
- 新 skill 被持久化存储，后续遇到类似需求可直接复用
- 通过长期记忆系统追踪用户需求模式，主动发现能力缺口

### 1.3 论文标题候选

- "Self-Evolving Agents: Learning New Skills Through Real-World Interaction"
- "XiaoBa: A Self-Evolving Research Copilot with Autonomous Skill Acquisition"
- "Beyond Fixed Capabilities: Enabling Autonomous Skill Growth in LLM-based Agents"

## 二、技术贡献（预期 3-4 个）

### 贡献 1：Self-Evolution 框架

将 agent 的技能获取过程形式化：

- **能力缺口检测**（Gap Detection）：识别当前 skill 集合无法满足的用户需求
- **技能合成**（Skill Synthesis）：基于需求描述 + 已有 skill 模式，自动生成新 skill 的定义（SKILL.md）和工具代码
- **技能验证**（Skill Validation）：新 skill 创建后，通过测试用例验证其功能正确性
- **技能注册**（Skill Registration）：验证通过后，将新 skill 注册到 agent 的能力集合中

需要用公式形式化描述这个过程（类比 AutoFigure 的 Designer-Critic 公式）。

### 贡献 2：交互日志驱动的 Benchmark

从真实使用日志中构建 **SkillBench**——首个评估 agent 技能获取能力的基准：

- 数据来源：XiaoBa 的真实交互日志（1-2 个月高频使用）
- 样本类型：每个样本是一个"技能获取轨迹"（从不会→学会→复用）
- 目标规模：50-100 个高质量案例，覆盖不同难度和领域

### 贡献 3：长期记忆系统

支撑 self-evolution 的记忆架构：

- 短期记忆：当前会话上下文
- 长期记忆：跨会话的结构化知识（用户需求模式、skill 使用频率、失败案例）
- 记忆触发进化：当某类需求反复出现但无对应 skill 时，主动触发 skill 创建

### 贡献 4：Skill Composition（可选，视实验结果）

已有 skill 的组合编排能力——不只是创建单个 skill，还能将多个 skill 串联成复杂工作流（如 research-orchestrator 编排 literature-review → paper-analysis → sci-paper-writing）。

## 三、实验设计

### 3.1 对比方法（Baselines）

| 方法 | 描述 |
|------|------|
| Static Agent | 固定 skill 集合，遇到新任务只能用已有 skill 硬凑 |
| Manual Evolution | 人工给 agent 编写新 skill（模拟传统开发模式） |
| Prompt-Only | 不创建 skill，每次都在 prompt 里临时描述任务做法 |
| XiaoBa (Self-Evolving) | 自动检测能力缺口 → 自动创建 skill → 持久化复用 |

### 3.2 评估维度

**维度 1：功能正确性（Skill Correctness）**
- 新创建的 skill 能否正确完成目标任务
- 评估方式：人工评分（1-5 Likert）+ 自动化测试通过率

**维度 2：学习效率（Learning Efficiency）**
- 从遇到新需求到 skill 可用，需要几轮交互
- 评估方式：统计交互轮数、token 消耗、时间成本

**维度 3：知识留存率（Knowledge Retention）**
- 下次遇到类似需求，能否直接调用已学 skill 而不是重新创建
- 评估方式：在 benchmark 中设置"复现任务"，测试 skill 复用率

**维度 4：任务完成质量（Task Quality）**
- 使用自动创建的 skill 完成任务的最终质量
- 评估方式：对比 Static Agent / Manual Evolution / Self-Evolving 三组的任务产出质量

### 3.3 实验层次（三层递进，参考 AutoFigure）

**Layer 1：自动评估**
- 在 SkillBench 上跑全部 baseline，统计上述四个维度的量化指标

**Layer 2：人类专家评估**
- 邀请 5-10 位科研工作者使用 XiaoBa 完成真实科研任务
- 评估维度：任务完成度、产出质量、使用体验
- 对比：有 self-evolution vs 无 self-evolution

**Layer 3：消融实验**
- 去掉记忆系统 → self-evolution 效果下降多少？
- 去掉 skill 验证步骤 → 创建的 skill 质量下降多少？
- 去掉 gap detection → 改为用户手动触发 evolution → 效率差多少？
- 不同 backbone LLM（GPT-4 / Claude / DeepSeek）的 skill 创建质量对比

## 四、Benchmark 构建方案（SkillBench）

### 4.1 数据收集

**日志系统需要记录的字段：**

```json
{
  "session_id": "会话ID",
  "timestamp": "时间戳",
  "user_request": "用户原始请求",
  "intent_category": "需求类别（科研/写作/绘图/数据分析/...）",
  "matched_skill": "匹配到的已有skill（null表示没匹配到）",
  "skill_chain": ["实际调用的skill序列"],
  "tool_calls": ["调用的工具序列"],
  "evolution_triggered": true/false,
  "new_skill_created": {
    "name": "新skill名称",
    "description": "描述",
    "creation_turns": "创建耗费的交互轮数",
    "validation_passed": true/false
  },
  "task_outcome": "success / partial / failed",
  "user_satisfaction": "用户反馈（1-5 或 自然语言）",
  "total_turns": "总交互轮数",
  "total_tokens": "总token消耗"
}
```

### 4.2 样本筛选标准

从日志中筛选高质量样本，需满足：

- 有明确的用户需求和可判断的完成标准
- 涉及 skill 创建或 skill 复用（正样本）或 skill 缺失导致失败（负样本）
- 用户有明确的满意度反馈

### 4.3 Benchmark 结构

```
SkillBench/
├── tasks/                    # 任务定义
│   ├── easy/                 # 简单任务（已有skill可覆盖）
│   ├── medium/               # 中等任务（需组合已有skill）
│   └── hard/                 # 困难任务（需创建新skill）
├── trajectories/             # 真实交互轨迹（参考答案）
├── evaluation/               # 评估脚本
│   ├── correctness.py        # 功能正确性评估
│   ├── efficiency.py         # 学习效率评估
│   └── retention.py          # 知识留存评估
└── README.md                 # 数据集说明
```

### 4.4 目标规模

- Easy: 30 个任务（验证 baseline 能力）
- Medium: 30 个任务（验证 skill composition）
- Hard: 40 个任务（验证 self-evolution 核心能力）
- 总计: 100 个任务

## 五、记忆系统设计

### 5.1 数据结构

```json
{
  "user_profile": {
    "research_field": "用户研究领域",
    "frequent_tasks": ["高频任务类型"],
    "preferred_style": "偏好的交互风格"
  },
  "skill_registry": {
    "skill_name": {
      "created_at": "创建时间",
      "trigger_count": "被调用次数",
      "success_rate": "成功率",
      "avg_satisfaction": "平均满意度",
      "origin": "manual / self-evolved"
    }
  },
  "gap_log": [
    {
      "timestamp": "时间",
      "user_request": "用户请求",
      "gap_type": "no_skill / skill_insufficient / skill_failed",
      "resolved": true/false,
      "resolution": "创建了什么skill / 怎么解决的"
    }
  ],
  "pattern_summary": {
    "unmet_needs": ["反复出现但未被满足的需求模式"],
    "evolution_candidates": ["建议创建的skill"]
  }
}
```

### 5.2 记忆更新策略

- 每次会话结束后自动更新 skill_registry 的调用统计
- 每次 gap 出现时追加 gap_log
- 每周自动分析 gap_log，更新 pattern_summary
- pattern_summary 中的 evolution_candidates 达到阈值时，主动建议用户触发 self-evolution

## 六、执行路线图

### Phase 1：基础设施（2-3 周）

- [ ] 给 XiaoBa 加交互日志系统（按 4.1 的字段记录）
- [ ] 实现长期记忆系统的基础版本（按 5.1 的结构）
- [ ] 完善 self-evolution skill，增加 gap detection 和 skill validation 环节

### Phase 2：数据积累（1-2 个月）

- [ ] 高频使用 XiaoBa 完成日常科研任务
- [ ] 有意识地触发多样化的新需求，积累 self-evolution 案例
- [ ] 定期检查日志质量，确保关键字段完整
- [ ] 记录每次 self-evolution 的过程和结果

### Phase 3：Benchmark 构建（2-3 周）

- [ ] 从日志中筛选、标注高质量样本
- [ ] 构建 SkillBench 的任务集和评估脚本
- [ ] 编写 benchmark 的 README 和使用文档

### Phase 4：实验与论文（1-1.5 个月）

- [ ] 跑全部 baseline 对比实验
- [ ] 招募科研工作者做人类评估
- [ ] 跑消融实验
- [ ] 撰写论文（可用 XiaoBa 的 sci-paper-writing skill 辅助）

### 总周期预估：3-4 个月

## 七、目标会议与时间线

| 会议 | 截稿日期（2026） | 是否可行 |
|------|-----------------|---------|
| NeurIPS 2026 | ~5月中旬 | 紧张但可冲 |
| EMNLP 2026 | ~6月 | 较充裕 |
| AAAI 2027 | ~8月 | 充裕 |
| ICLR 2027 | ~10月 | 非常充裕 |

建议：先瞄准 EMNLP 2026 或 NeurIPS 2026，倒推时间节点。

## 八、风险与应对

| 风险 | 应对策略 |
|------|---------|
| 日志数据量不够 | 邀请 2-3 位同学同时使用 XiaoBa，扩大数据来源 |
| Self-evolution 创建的 skill 质量不稳定 | 加入 skill validation 环节 + 人工审核兜底 |
| 审稿人质疑"只是 prompt engineering" | 用形式化框架 + 消融实验证明每个模块的必要性 |
| 审稿人质疑 benchmark 规模太小 | 强调"真实场景"的价值，补充合成数据扩充 |
| 闭源模型依赖 | 同时在开源模型（DeepSeek、Qwen）上跑实验 |

## 九、与 AutoFigure 的对标分析

| 维度 | AutoFigure | XiaoBa (目标) |
|------|-----------|--------------|
| 新任务定义 | Long-context Scientific Illustration | Autonomous Skill Acquisition for Agents |
| Benchmark | FigureBench (3300对) | SkillBench (100个技能获取轨迹) |
| 核心技术 | Reasoned Rendering + Designer-Critic | Self-Evolution + Memory-Driven Gap Detection |
| 形式化 | Critic反馈函数、候选生成函数 | Gap Detection函数、Skill Synthesis函数 |
| 实验设计 | 自动评估+人类专家+消融 | 自动评估+人类专家+消融（同样三层） |
| 杀手数据 | 66.7%出版意愿 | 待定（如"skill复用率90%"或"任务完成率提升X%"） |
