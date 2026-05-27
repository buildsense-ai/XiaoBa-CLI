# 现场演示准备清单

## 演示目标

现场演示不是为了展示一个漂亮界面，而是证明：

**AI 助手已经可以处理学校真实、复杂、规则多、需要反复调整的工作流程。**

排课是最适合展示的 signature case。

## 排课演示核心话术

> 排课不是普通文本生成。它需要读取学校真实材料，理解班级、教师、课程、时间、禁排、连堂、校区等规则，再生成可检查、可修改、可导出的结果。这个场景能说明我们的 AI 助手可以沉淀为学校级 skill，而不是一次性聊天工具。

## 必备演示内容

1. 学校真实材料导入。
2. AI 识别约束和基础数据。
3. 生成课表。
4. 展示冲突检查。
5. 展示局部调整。
6. 展示导出结果。
7. 展示这是可复用 skill，不是一次性脚本。

## 兜底材料

必须准备：

1. 关键界面截图。
2. 生成结果截图。
3. 冲突检查截图。
4. 导出的 Excel / JSON / HTML 结果。
5. 1-2 分钟录屏。
6. 一份已经跑通的离线演示目录。

## 桌面排课包初步检查

源文件：

`/Users/zhuhanyuan/Desktop/排课可视化打包.zip`

初步看到的内容：

- `ai-timetable-demo/`
  - 后端与 CLI：`app/cli.py`、`app/skill_cli.py`、`app/solver.py`
  - 前端页面：`app/static/index.html`
  - 真实材料分析输出：`teacher_materials/.../_analysis_outputs/`
  - 测试结果：`test-results/`
  - 依赖：`requirements.txt`
- `timetable-scheduling-web/SKILL.md`

注意：

这个 zip 很完整，但也很重，包含 `.venv`、测试缓存、测试结果和大量材料。现场不要临时依赖 zip，需要提前整理成稳定演示目录。

## 下一步整理动作

1. 已解压到本项目 `demo/` 下。
2. 已移除不必要的 Windows `.venv`、缓存和无关测试结果文件。
3. 已创建 `.venv-macos` 并安装依赖。
4. 已验证 Web 页面和核心 skill smoke。
5. 已生成截图：`assets/timetable-demo-home.png`。
6. 已写成现场 runbook：`demo/RUNBOOK.md`。

已补充兜底材料：

1. 兜底录屏：`assets/timetable-demo-walkthrough-v02.webm`。
2. 补充截图：`assets/timetable-demo-fullpage-v02.png`、`assets/timetable-demo-after-refresh-v02.png`。
3. PPT/HTML 第 4 页已使用排课工作台截图。

仍建议明天现场前再做一次：

1. 启动 Web 服务，确认端口 `8018` 可用。
2. 打开浏览器，确认 `http://127.0.0.1:8018/` 页面能加载。
3. 预先打开兜底录屏和截图所在目录，避免现场网络或服务异常。
4. 现场话术只说“可运行排课 skill 原型”，不要说已经完全替代教务排课系统。
