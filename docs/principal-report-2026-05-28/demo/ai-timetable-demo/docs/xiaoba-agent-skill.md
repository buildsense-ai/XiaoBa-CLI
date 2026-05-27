# 小巴助手排课 Skill 封装草案

## 目标

把排课工作台拆成两层：

- 网页：只负责查看课表、查看冲突/缺失信息、导出课表。
- 小巴助手 skill：负责用自然语言调用 CLI，完成查询、校验、追加规则、补充课程信息和手动调整。

当前版本可以先封装 CLI 能力，再让老师通过网页刷新查看结果。

## 时间来源

- 资料包导入模式：以老师 Excel 里的课表时间为准，不再假设每节课都是 45 分钟。
- 演示自动排课模式：小学默认 08:50 开始，初中默认 08:00 开始。

后续正式版需要增加“时间模板维护”能力，让老师可以通过自然语言修改每节课具体起止时间。当前 CLI 还没有独立的时间维护命令。

## 运行方式

工作目录：

```powershell
D:\ai-timetable-demo
```

老师端 skill 调用格式：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli <command>
```

`app.skill_cli` 是给 xiaoba skill 使用的安全入口：

- 自动使用 UTF-8 输出，避免中文乱码。
- 只允许老师端安全命令：`solve`、`show`、`teacher`、`validate`、`rule`、`course`、`move`、`swap`、`import-package`。
- 拒绝 `reset`，避免老师误把正式数据清空回演示数据。
- CLI 输出 JSON 后，如果 `ok=false`，进程退出码也会非 0；skill 必须解析 JSON 的 `ok`、`status`、`message` 和 `next_actions`，不能只看进程退出码。
- 参数拼错时也会尽量返回稳定 JSON；skill 仍应按固定模板构造参数，不要把老师原话直接拼到命令行。

如需指定正式数据文件：

```powershell
$env:TIMETABLE_DATA_PATH = "D:\ai-timetable-demo\data\timetable.json"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
```

CLI 输出都是 JSON。skill 必须解析 JSON，不要靠肉眼读取终端文本。

稳定字段至少包括：`ok`、`status`、`message`、`conflicts`、`missing_information`、`warnings`、`next_actions`。

## 命令映射

### 导入老师资料包

适用自然语言：

- “把老师给的资料包导进去”
- “用这个最新资料包作为当前课表”
- “先按老师发来的 Excel 课表查看”

CLI：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli import-package --path "D:\xwechat_files\...\0排课资料包.zip" --scope 全部
```

处理原则：

- `import-package` 会把当前状态切换到资料包里的课表；只有老师明确要求导入、且路径可信时才调用。
- 当前导入的是“已有课表事实”，不是重新优化生成的新课表。
- 导入后立刻运行 `validate`，把缺失信息、硬冲突、疑似合班/分组/活动课待确认项反馈给老师。
- 若只导入小学或初中，可把 `--scope` 设为 `小学` 或 `初中`。

### 重新排课

适用自然语言：

- “重新排一下初中的课表”
- “刷新小学课表”
- “现在按已有条件重新生成课表”

CLI：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli solve --scope 初中
.\.venv\Scripts\python.exe -m app.skill_cli solve --scope 小学
```

返回重点：

- `ok`
- `status`
- `class_count`
- `conflict_count`
- `missing_information`
- `next_actions`

### 从资料包反推条件并重新生成课表

适用自然语言：

- “按老师资料重新排一版初中课表”
- “不要只看原课表，先根据资料包反推出条件再重新生成”
- “用真实资料跑一版新的七年级课表”

CLI：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli resolve-imported --scope 初中
```

处理原则：

- 这个命令会读取已经导入的资料包课表，反推班级、课程、教师、课时、时间段和固定/待确认活动，再调用 solver 生成新课表。
- 成功后会把新课表保存成当前课表；后续 `show`、`teacher`、`validate` 和网页刷新都会看到新生成版本。
- `source_mode=derived_solver` 表示当前不是原始导入课表，而是资料包反推后重新生成的课表。
- `derivation_summary` 说明反推出多少普通课、固定活动和待确认活动。
- `comparison_summary` 说明新课表与老师原课表相比，多少节保留在原位置、多少节发生调整。
- 如果 `conflicts` 里只有 `severity=review`，应告诉老师“这是待确认的合班/分组/活动课并行项”，不要说成硬冲突。

### 查询某个班课表

适用自然语言：

- “看一下七年级(1)的课表”
- “一年级(3)周三下午有什么课”
- “七年级(1)第一节是什么课”

CLI：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli show --scope 初中 --class "七年级(1)"
.\.venv\Scripts\python.exe -m app.skill_cli show --scope 小学 --class "一年级(3)"
```

返回重点：

- `week`
- `missing_information`
- `conflicts`
- `next_actions`

skill 可以在 `week` 里二次筛选某一天、某一节、上午或下午。

### 查询教师课表

适用自然语言：

- “查一下王老师本周有哪些课”
- “王老师周三有没有课”
- “哪个时间王老师已经被占用了”

CLI：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli teacher --scope 初中 --name "王老师"
```

返回重点：

- `lessons`
- `conflicts`
- `missing_information`

### 校验冲突和缺失信息

适用自然语言：

- “检查一下现在还有没有冲突”
- “还有哪些资料没填”
- “排课前先帮我检查数据”

CLI：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli validate --scope 初中
.\.venv\Scripts\python.exe -m app.skill_cli validate --scope 小学
```

处理原则：

- 如果有 `missing_information`，先提示老师补充，不要自己编造教师、教室或课程资料。
- 如果有 `conflicts`，先解释冲突位置和建议，再决定是否调用手动调整。

### 追加自然语言规则

适用自然语言：

- “九年级不要第一节体育课”
- “王老师周三下午不能上课”
- “七年级数学安排连续两节用于考试”

CLI：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli rule add "九年级不要第一节体育课" --scope 初中
```

处理原则：

- 添加规则后必须查看返回的 `conflict_count`、`missing_information`、`next_actions`。
- 如果当前是资料包导入模式，`rule add` 只表示规则已记录；它不会自动把已导入课表重排。必须把 `message` 或 `ignored_rules` 里的说明告诉老师。
- 如果规则无法自动理解或需要人工确认，要向老师说明“这条先作为备注/待确认条件保存”。

### 补充或修改课程资料

适用自然语言：

- “七年级新增心理课，每周 1 节，张老师上，本班教室”
- “把七年级心理课老师补成张老师”
- “信息科技课在机房A”

CLI：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli course set --scope 初中 --grade 七年级 --subject 心理 --hours 1 --teacher 张老师 --room 本班教室
```

如果老师明确说“暂时不知道老师/教室”，可以留空：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli course set --scope 初中 --grade 七年级 --subject 心理 --hours 1 --teacher --room
```

留空后应立刻运行 `validate`，把缺失信息反馈给老师。

### 手动移动课程

适用自然语言：

- “把七年级(1)周二第3节调到周五第8节”
- “这节课虽然不符合原规则，但先手动放到周五第8节”
- “超过规则也要先这么排”

CLI：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli move --scope 初中 --class "七年级(1)" --from 周二:3 --to 周五:8
```

如果老师明确说“强制”“先这么排”“超过规则也要排”，才加：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli move --scope 初中 --class "七年级(1)" --from 周二:3 --to 周五:8 --force
```

处理原则：

- 移动前先调用 `show`，确认原节次不是升旗、班会、固定教研等固定活动，目标节次也不是固定活动。
- `--force` 只表示允许覆盖普通课程，不表示允许覆盖固定活动。
- 不带 `--force` 时，如果目标节次已有课程，命令会失败；只有老师明确同意覆盖目标课程时才允许加 `--force`。
- 使用 `--force` 后必须把返回的 `warnings` 原样转述给老师，尤其是“目标节次原课程已被覆盖”。
- 调整后必须运行 `validate`。
- 如果出现冲突，要告诉老师冲突原因和可选调整方案。

### 交换两节课

适用自然语言：

- “把七年级(1)周二第3节和周四第7节对调”
- “这两节互换一下”

CLI：

```powershell
.\.venv\Scripts\python.exe -m app.skill_cli swap --scope 初中 --left "七年级(1):周二:3" --right "七年级(1):周四:7"
```

处理原则：

- 交换后必须运行 `validate`。
- 如果交换跨班级，必须确认老师确实想跨班级交换。

## skill 决策流程

1. 判断学段：小学、初中、全部。老师没说时，先从上下文推断；推不出来再问一句。
2. 判断意图：查询、校验、追加规则、补资料、移动、交换、重新排课。
3. 调用 CLI。
4. 解析 JSON。
5. 如果有缺失信息，优先提示补资料。
6. 如果有冲突，先区分 `severity=hard` 的硬冲突和 `severity=review` 的疑似合班/分组/活动课待确认项，再给出位置和建议。
7. 如果是修改类操作，提醒老师刷新网页查看最新课表。

## 自然语言调用模板

### 查询模板

用户：

```text
看一下七年级(1)周三下午的课。
```

skill 行为：

1. 调用 `show --scope 初中 --class "七年级(1)"`。
2. 从 `week.周三` 里筛选下午节次。
3. 用老师能懂的话回答课程、老师、教室。

### 冲突检查模板

用户：

```text
现在还有没有冲突？
```

skill 行为：

1. 调用 `validate`。
2. 如果没有冲突和缺失，回答“当前没有发现教师、教室硬冲突，也没有必填资料缺失”。
3. 如果有问题，按“缺失信息优先、冲突其次”反馈。

### 加规则模板

用户：

```text
九年级不要第一节体育课。
```

skill 行为：

1. 调用 `rule add "九年级不要第一节体育课" --scope 初中`。
2. 读取 `applied_rules`、`conflict_count`、`next_actions`。
3. 告诉老师规则是否已参与排课。
4. 提醒刷新网页查看。

### 手动调整模板

用户：

```text
把七年级(1)周二第3节调到周五第8节，先这样排。
```

skill 行为：

1. 先调用 `show --scope 初中 --class "七年级(1)"`。
2. 检查周二第 3 节和周五第 8 节是否为固定活动。
3. 因为用户说“先这样排”，如果目标不是固定活动，可以使用 `--force`。
4. 调用 `move`。
5. 调用 `validate`。
6. 如果没有冲突，说明已调整并提醒刷新网页。
7. 如果有冲突，列出冲突和建议。

### 缺失信息模板

用户：

```text
七年级新增心理课，每周一节，但是老师还没定。
```

skill 行为：

1. 调用 `course set --teacher --room` 或只留空老师。
2. 调用 `validate`。
3. 告诉老师“心理课还缺任课老师/上课地点”，请后续补充。

## 当前不建议封装成老师直接使用的能力

- `reset`：会重置演示数据，`app.skill_cli` 已拒绝该命令；正式使用时只能走管理员专用入口。
- 网页旧编辑入口：当前已隐藏，后续不作为老师主入口。
- 时间模板修改：当前还没有专门 CLI 命令，后续要单独做。
- 图片识别条件：当前不作为稳定能力，后续可接 OCR 或多模态识别后再进入规则确认流程。

## 下一步封装建议

1. 先把本文件转成 xiaoba agent 的 skill 说明。
2. skill 只通过 CLI 读写数据，不直接改 JSON。
3. 所有修改类操作后自动调用 `validate`。
4. 网页只提示老师刷新查看结果，不承担数据编辑。
5. 下一轮开发补 `time set` 或 `time template` CLI 命令，让老师可以自然语言修改时间表。
