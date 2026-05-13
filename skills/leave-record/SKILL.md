---
name: leave-record
description: 教师请假记录自动归档。从企微审批 API 拉取已通过的请假申请，匹配教师姓名自动写入考勤登记表（.xlsx），含月份定位、类型归类、天数换算、批注追加、合计更新。
category: 工具
invocable: both
argument-hint: "[--start YYYY-MM-DD --end YYYY-MM-DD]"
---

# Leave Record - 教师请假记录自动归档

从企微审批中拉取请假数据，自动写入学校考勤登记表。

## 配置

使用前需设置以下环境变量（企微应用就绪后）：

- `WECOM_CORP_ID`：企业微信 CorpID
- `WECOM_SECRET`：自建应用 Secret
- `LEAVE_TEMPLATE_ID`：请假审批模板 ID

考勤表路径通过**首次运行交互式配置**自动记录，无需手动设置。

## 交互流程（必须严格遵循）

### 阶段 0：确认考勤表位置

考勤表路径存储在 `~/.config/xiaoba/leave_record_config.json`：

```json
{"excel_path": "C:/Users/xxx/Desktop/考勤表.xlsx", "sheet_name": "2024", "updated_at": "2026-05-12"}
```

执行前**必须先检查**：

1. **读取配置文件** → 如果存在且 `excel_path` 指向的文件确实存在 → 直接使用
2. **配置文件不存在，或文件已不存在** → 主动询问用户：

> "请告诉我考勤表 Excel 文件的位置（可以是完整路径，也可以把文件拖到这里）："

3. 用户提供路径后，**验证文件存在**：
   ```bash
   python -c "import os; print('OK' if os.path.exists('<路径>') else 'MISSING')"
   ```
   - 如果 `MISSING` → 请用户重新提供
   - 如果 `OK` → 保存到配置文件

4. **自动探测工作表名**：读取 Excel 的工作表列表，如果有多个含"考勤"的工作表，选年份匹配的那个（优先选择与当前学年对应的）。如果只有一个，直接用那个。

5. **配置文件不存在时**也自动探测并保存 `sheet_name`。

保存配置文件：
```bash
python skills/leave-record/scripts/save_config.py --excel "<路径>" --sheet "<工作表名>"
```

### 阶段 1：获取请假数据

```bash
python skills/leave-record/scripts/fetch_approvals.py \
  --mock skills/leave-record/scripts/mock_data.json \
  --start 2024-09-01 --end 2025-06-30 \
  -o approvals.json
```

企微 API 就绪前用 `--mock` 模式测试。就绪后去掉 `--mock` 参数即可对接真实 API。

### 阶段 2：预览确认

```bash
python skills/leave-record/scripts/insert_to_excel.py approvals.json <excel_path> --sheet "<sheet_name>" --dry-run
```

将预览结果（每条记录的目标行、列、天数、类型）展示给用户，**获得用户确认后再正式写入**。

### 阶段 3：正式写入

```bash
python skills/leave-record/scripts/insert_to_excel.py approvals.json <excel_path> --sheet "<sheet_name>" -o "<excel_path_with_更新>"
```

### 阶段 4：验证

写入完成后：
- 确认输出文件已生成
- 简要说明更新了几位老师的记录

## 标准化 JSON 格式

fetch_approvals.py 输出（insert_to_excel.py 输入）：

```json
[
  {
    "teacher_name": "张三",
    "leave_type": "病假",
    "start_time": "2024-09-14 08:00",
    "end_time": "2024-09-14 12:00",
    "hours": 4,
    "reason": "发烧就诊",
    "approval_no": "202605120003"
  }
]
```

## 核心规则

| 规则 | 说明 |
|------|------|
| **姓名匹配** | 全名精确匹配考勤表 B 列 |
| **类型归类** | 事假→P列合计 / 病假→Q列合计 / 其他类型→O列合计 |
| **小时→天** | ≤4h = 0.5天，>4h = hours/8 按 0.5 天步进取整 |
| **月份定位** | 按开始时间的月份，跨月也按开始月份归入 |
| **文本追加** | 已有内容用"；"分隔，不覆盖已有记录 |
| **批注追加** | 格式：`{日}号{上午/下午}{请假类型}（{原因}）` |
| **合计更新** | 自动重算 O/P/Q 列累计天数 |
| **去重** | 通过 approval_no 标记已处理，防止重复写入 |

## 工作表自动探测

当配置文件不存在时，自动探测 Excel 中的工作表：

```bash
python -c "import openpyxl; wb=openpyxl.load_workbook('<路径>'); [print(n) for n in wb.sheetnames]"
```

选择规则：优先选名称含"2024"且含"考勤"的工作表；如无，选含"考勤"的第一个；如无，选第二个工作表。

## 硬规则

- 绝不清除单元格已有内容，只追加
- 姓名查无此人时报错跳过，不写入
- 天数计算为 0 时跳过该记录
- 所有操作生成新的输出文件（`_更新.xlsx`），不改原文件
- 考勤表路径首次问清楚后持久化到配置文件，后续自动读取
- 如果配置文件中的路径找不到文件，主动询问用户更新路径
