# AutoFigure PPT 大纲

## 主题：academic | 总页数：16页

### Page 1 — 封面 [title]
- 标题：AutoFigure: Generating and Refining Publication-Ready Scientific Illustrations
- 副标题：Minjun Zhu*, Zhen Lin*, Yixuan Weng* et al. | Westlake University

### Page 2 — 研究背景与动机 [content]
- 科研插图是科学传播的关键媒介，但制作耗时数天
- 需要同时具备领域知识和专业设计技能
- 核心问题：能否从长文本自动生成出版级科研插图？

### Page 3 — 现有方法的三大局限 [content]
- Gap 1：现有数据集仅基于短文本/caption，不涉及长文本理解
- Gap 2：PosterAgent/PPTAgent 只做内容重排，非原创生成
- Gap 3：端到端 T2I 模型美观但结构不保真
- → 无法从长文本生成结构保真的科研插图

### Page 4 — 核心贡献总览 [content]
- 定义新任务：Long-context Scientific Illustration Design（输入 >10K tokens）
- FigureBench：首个大规模基准，3300对文本-插图对
- AutoFigure：首个基于 Reasoned Rendering 范式的生成框架
- 66.7% 生成结果被第一作者专家认为达到出版标准

### Page 5 — FigureBench 数据集 [section_header]
- 副标题：首个面向长文本科研插图生成的大规模基准

### Page 6 — FigureBench 数据集组成 [image_text]
- 图片：Figure 1（四类来源的插图风格差异）
- 要点：覆盖 Paper/Survey/Blog/Textbook 四类来源
- 300 测试对 + 3000 开发对 = 3300 对
- Paper 类平均 12732 tokens，远超现有数据集

### Page 7 — FigureBench 构建与评估 [two_column]
- 左栏（数据构建）：400篇→GPT-5选图→双人标注→IRR=0.91→200对+100对补充
- 右栏（评估协议）：VLM-as-a-judge（参考评分 8 子指标 + 盲评对比）+ 人类专家评估

### Page 8 — AutoFigure 方法论 [section_header]
- 副标题：Reasoned Rendering — 先推理布局，再渲染图像

### Page 9 — AutoFigure 系统架构 [image_text]
- 图片：Figure 2（三阶段解耦架构图）
- 要点：Stage I 概念提取 + Designer-Critic 迭代精炼
- Stage II 风格引导渲染 + Erase-and-Correct 文本修正
- 此图本身也是 AutoFigure 生成的

### Page 10 — Stage I：概念提取与布局生成 [content]
- Concept-Extraction Agent：从长文本提取方法论摘要 + 实体关系
- 序列化为 SVG/HTML 符号布局 S₀ 和风格描述 A₀
- Designer-Critic 对话式自我精炼循环
- Critic 从对齐/重叠/平衡三维度评审，迭代直到收敛

### Page 11 — Stage II：渲染与文本修正 [content]
- 风格引导渲染：将优化布局转为 T2I prompt + 结构图 → 多模态生成模型
- Erase-and-Correct 四步流程：擦除文本像素 → OCR 提取 → 多模态验证器对齐 → 矢量文本叠加
- 支持按类别条件化风格，默认 Morandi 色调

### Page 12 — AutoFigure 生成示例 [image_text]
- 图片：Figure 3（6个不同学术文本的生成结果）
- 要点：涵盖神经辐射场、认知机制、时间序列等多主题
- 统一 Morandi 色调卡通风格，展示框架通用性
- 用户可自由指定任意风格

### Page 13 — 实验结果 [section_header]
- 副标题：自动评估 + 人类专家评估 + 消融实验

### Page 14 — 自动评估：全面领先 [image_text]
- 图片：Table 2（四类任务综合评估表）
- 要点：Overall 四类全面最高（Blog 7.60, Survey 6.99, Textbook 8.00, Paper 7.03）
- Win-Rate: Textbook 97.5%, Survey 78.1%, Blog 75.0%, Paper 53.0%
- Visual Design 维度碾压所有基线

### Page 15 — 人类专家评估 [image_text]
- 图片：Figure 4（10位第一作者专家评估结果）
- 要点：Win rate 83.3%，仅次于人工参考 96.8%
- 66.7% 专家愿意用 AutoFigure 的图发论文
- Likert 评分：Accuracy 4.00, Clarity 4.14, Aesthetics 4.24

### Page 16 — 消融实验 [image_text]
- 图片：Figure 5（四子图消融实验）
- 要点：渲染阶段显著提升 Visual Design（Overall 6.38→7.48）
- 迭代 scaling：0→5 次迭代，Overall 6.28→7.14
- 中间格式：SVG(8.98) > HTML(8.85) >> PPT(6.12)

### Page 17 — 定性对比案例 [image_text]
- 图片：Figure 6（InstructGPT 插图对比）
- 要点：Diagram Agent 生成纯文本流程图，信息严重缺失
- GPT-Image 布局混乱，结构不保真
- AutoFigure 在结构、信息、视觉三方面最接近原图

### Page 18 — 结论与展望 [content]
- 定位为长文本科研插图生成领域的奠基性工作
- FigureBench + AutoFigure 为 AI 驱动的科学视觉表达奠定基础
- 局限：依赖闭源商业模型，成本和可复现性存疑
- 未来方向：开源替代、交互式生成、动态插图、与 AI Scientist 集成
