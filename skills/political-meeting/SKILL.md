---
name: political-meeting
description: 政治学习会议材料整理。收到文件名含"第X周""政治学习""签到表""会议照片"的附件，或询问"第X周还差什么""总表进度"时触发。严禁read_file读docx/doc，用insert_material.py和check_status.py脚本。
category: 工具
invocable: both
argument-hint: "<第X周> <材料类型> [文件路径]"
---

# 政治学习会议材料整理

## 🛑 禁止

**禁止 read_file 读 .docx / .doc。禁止 glob 搜 .docx。禁止自己写 python -c 分析文件。**

所有文件操作交给 `insert_material.py` 和 `check_status.py`。脚本内部会用 OfficeCLI 处理。

## 流程

```
老师发文件
  → 解析文件名提取 周次+类型
  → 回复："收到第X周XX，还有吗？"
  → 老师说"还有" → 继续收集
  → 老师说"没了" → 执行脚本
```

## 收到"没了"之后（必须执行）

**先确认路径：** 读 `skills/political-meeting/config.json`，如果 `总表路径` 为空 → 问老师。

**路径有值 → 逐文件执行：**
```bash
python skills/political-meeting/scripts/insert_material.py --week-title "2025学年第二学期第九、十周政治学习" --type "学习内容" --file "文件路径"
```

连续周次（9+10）合并为"第九、十周"。

**全部执行完 → 汇总：**
```bash
python skills/political-meeting/scripts/check_status.py --week-title "第九、十周政治学习"
```

输出发给老师。**不要自己编"已完成/已归档"，必须等脚本输出。**

## 文件名解析

| 文件名含 | → 周次 | → 类型 |
|---------|--------|--------|
| `第X周` | X | — |
| `学习内容`、`政治学习` | — | 学习内容 |
| `签到表`、`签到` | — | 签到表 |
| `照片`、`会议照片` | — | 会议照片 |
| `.doc`、`.docx` | — | 大概率学习内容 |
| `.jpg`、`.png` | — | 需追问（签到表/照片？） |

## 查询

老师问"还差什么"/"进度" → 直接执行：
```bash
python skills/political-meeting/scripts/check_status.py --week-title "XX周政治学习"
```
