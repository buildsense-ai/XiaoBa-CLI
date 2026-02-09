# Related Work 写作参考（输出 `06_related_work.md`）

在撰写 Related Work 前再加载本文件。建议在你已经明确“自己贡献是什么”之后再写（否则定位会漂）。

## 写作前置条件

- 至少有一个“主题分组”方案（2-4 组）
- 每组至少 3-5 篇真实文献（BibTeX/DOI/URL/标题列表）

硬规则：没有真实文献就不要写作者/年份；统一用 `REF_TODO` 占位并请求用户补齐。

## 目标文件结构（建议）

写入：`docs/writing/[project]/06_related_work.md`

```markdown
# Related Work

## 2.1 Theme A

## 2.2 Theme B

## 2.3 Theme C (optional)

## 2.4 Summary and Positioning
```

## 修辞步骤框架（Moves）

### Move 1：领域分割（Field Segmentation）— 开头 1 段

目的：告诉读者“我将相关工作按哪些主题组织”，建立阅读路线。

句式模板：

- `We review related work from {N} perspectives: A, B, and C.`
- `Our work is related to several lines of research, including ...`

### Move 2：逐主题综述（Per-Topic Review）— 每主题 2-3 段

目的：每组讲清楚“代表作做了什么 → 演进脉络 → 共同局限 → 与本文差异”。

写法建议：

- 每篇工作 1-2 句：问题、方法、关键特点
- 段落末尾一定要落到“与本文关系”（避免纯罗列）

句式模板（占位版）：

- `{Author} et al. [REF_TODO] propose ..., which ...`
- `Building upon this, ...`
- `While these methods ..., they often ...`
- `Different from the above approaches, our method ...`

### Move 3：定位总结（Positioning Summary）— 结尾 1 段

目的：总结本文的独特定位与贡献，过渡到 Methods。

句式模板：

- `In summary, our work differs from prior approaches in ...`
- `To the best of our knowledge, this is the first work to ...`（谨慎使用，除非你真的确认）

## 真实性自检（必须做）

- 是否出现“看起来真实但并不存在”的作者/会议？删掉或改 `REF_TODO`。
- 是否有过度断言（first/novel/unique）？除非你有把握，否则用弱表达替代。

