# 排课演示 Runbook

## 演示目录

```bash
/Users/zhuhanyuan/Documents/XiaoBa-CLI/docs/principal-report-2026-05-28/demo/ai-timetable-demo
```

已处理：

- 已从桌面 `排课可视化打包.zip` 解出独立演示目录。
- 已排除原包里的 Windows 风格 `.venv`、测试缓存和无关结果文件。
- 已在演示目录创建 `.venv-macos`，并安装 `fastapi`、`uvicorn`、`ortools`、`openpyxl`、`reportlab` 等依赖。
- 已验证 Web 页面和核心 skill 命令可运行。

## 启动 Web 演示

```bash
cd /Users/zhuhanyuan/Documents/XiaoBa-CLI/docs/principal-report-2026-05-28/demo/ai-timetable-demo
.venv-macos/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8018
```

浏览器打开：

```text
http://127.0.0.1:8018/
```

## 演示顺序

1. 打开 Web 工作台，先展示“初中 6 个班”的课表视图。
2. 说明这不是普通表格生成，而是从资料包反推课程、教师、课时和固定活动后生成的课表。
3. 展示左侧状态：
   - 当前没有教师、班级、教室硬冲突。
   - 当前没有必填信息缺失。
   - 支持导出 Excel。
4. 点击或说明“刷新课表”，表示后台/CLI 调整后前端可刷新查看最新结果。
5. 切换班级，展示不同班级课表。
6. 结合命令行说明：老师可以通过 AI 助手自然语言触发查询、校验、加规则、手动调整和导出。

## 可现场运行的 smoke 命令

```bash
cd /Users/zhuhanyuan/Documents/XiaoBa-CLI/docs/principal-report-2026-05-28/demo/ai-timetable-demo
```

校验当前课表：

```bash
.venv-macos/bin/python -m app.skill_cli validate --scope 初中
```

重新生成初中课表：

```bash
.venv-macos/bin/python -m app.skill_cli solve --scope 初中
```

查看七年级(1)课表：

```bash
.venv-macos/bin/python -m app.skill_cli show --scope 初中 --class '七年级(1)'
```

查询教师课表示例：

```bash
.venv-macos/bin/python -m app.skill_cli teacher --scope 初中 --name '李晓丽'
```

## 已生成截图

```text
/Users/zhuhanyuan/Documents/XiaoBa-CLI/docs/principal-report-2026-05-28/assets/timetable-demo-home.png
/Users/zhuhanyuan/Documents/XiaoBa-CLI/docs/principal-report-2026-05-28/assets/timetable-demo-live-home.png
/Users/zhuhanyuan/Documents/XiaoBa-CLI/docs/principal-report-2026-05-28/assets/timetable-demo-switch-class.png
/Users/zhuhanyuan/Documents/XiaoBa-CLI/docs/principal-report-2026-05-28/assets/timetable-demo-after-action.png
```

这张图可直接放入 PPT 第 4 页，替换当前的“截图占位”。

## 已生成兜底录屏

```text
/Users/zhuhanyuan/Documents/XiaoBa-CLI/docs/principal-report-2026-05-28/assets/timetable-demo-walkthrough-v02.webm
```

如果现场 Web 服务异常，可以直接播放录屏，再打开截图说明“真实材料、冲突检查、班级切换和导出入口”。

## 现场话术

> 排课是一个典型的学校级复杂场景。它不是让 AI 写一段文字，而是要读取真实材料，理解班级、教师、课程、时间、固定活动和各种约束，然后生成可检查、可调整、可导出的结果。  
>   
> 这个演示的重点不是界面，而是说明 AI 助手可以沉淀成学校级 skill。以后老师不需要理解底层算法，只需要告诉助手“检查冲突”“按这个条件调整”“导出某个班课表”，助手就可以调用这套能力完成工作。

## 注意事项

- 现场不要重新从 zip 解压。
- 不建议现场跑完整 `pytest`。当前测试包里有历史测试写死了 Windows 路径 `D:\ai-timetable-demo`，在 Mac 演示目录下会失败；这不影响 Web 页面和 skill smoke。
- 如果现场网络不稳定，不影响本地 Web 演示；依赖已经安装在 `.venv-macos`。
- 如果 Web 服务端口 8018 被占用，可以改用 8020：

```bash
.venv-macos/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8020
```
