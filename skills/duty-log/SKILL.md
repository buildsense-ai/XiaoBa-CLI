---
name: duty-log
description: 值班日志图片自动归档。轮询云服务器获取新值班图片，OCR识别时间/日期/校区，插入对应Word文档的正确时间段。
category: 工具
invocable: both
argument-hint: "[--base-dir <值班记录根目录>]"
---

# 值班日志自动归档

将企业微信群中收集的值班照片，自动识别并归档到正确的 Word 文档时间段。

## 配置

使用前需设置以下环境变量或 XiaoBa config：

**云服务器：**
- `DUTY_LOG_API_BASE`：云服务器地址，默认 `http://118.145.116.152:8899`
- `DUTY_LOG_API_TOKEN`：API 认证 token

**文档路径：**
- `DUTY_LOG_BASE_DIR`：值班记录根目录（内含 `东校区/` 和 `西校区/` 子目录）

**OCR 视觉模型（用于识别图片中的时间/日期/校区）：**
- `DUTY_LOG_OCR_API_KEY`：API key（未设置时回退到 `GAUZ_LLM_API_KEY`）
- `DUTY_LOG_OCR_API_BASE`：API 地址，自动检测格式：
  - 含 `anthropic`/`claude` → Anthropic Messages API
  - 其他（百炼/OpenAI 等）→ OpenAI Chat Completions API
- `DUTY_LOG_OCR_MODEL`：模型名

**推荐配置：**

| 平台 | API_BASE | MODEL |
|------|----------|-------|
| 阿里百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-plus` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Anthropic | `https://api.anthropic.com` | `claude-haiku-4-5-20251001` |

⚠️ MiniMax / DeepSeek 不支持 vision，不能用于 OCR

## 执行流程

### 1. 轮询新图片

```bash
python scripts/poll_and_fetch.py \
  --api-base "${DUTY_LOG_API_BASE:-http://118.145.116.152:8899}" \
  --api-token "${DUTY_LOG_API_TOKEN}" \
  --dest-dir "${TEMP_DIR}" \
  --output-json "${TEMP_DIR}/new_images.json"
```

返回：`{"downloaded": N}`。无新图时 `N=0`，流程结束。

### 2. OCR 识别每张新图片

```bash
python scripts/ocr_image.py --image "<图片本地路径>"
```

返回 JSON：
```json
{"hhmm": "06:58", "date": "2026.05.08", "campus": "西校区", "_missing": []}
```

使用 Claude Vision API（通过 `DUTY_LOG_OCR_API_KEY` 配置）分析图片，提取三个字段：

| 字段 | 图片中的位置 | 示例 |
|------|------------|------|
| 时间 (HH:MM) | 照片中下方白色大字 | `06:58` |
| 日期 | 底部水印文字 | `2026.05.08` |
| 校区 | 底部水印学校名末尾 | `东校区` 或 `西校区` |

水印可能在左下角、右下角或正下方——视觉模型全图分析，不依赖固定位置。

任一字段缺失则跳过该图片，记录异常。

### 3. 匹配时间段并插入 Word

```bash
python scripts/match_and_insert.py \
  --image "<图片本地路径>" \
  --hhmm "06:58" \
  --date "2026.05.08" \
  --campus "西校区" \
  --base-dir "${DUTY_LOG_BASE_DIR}"
```

脚本自动完成：
1. 时间匹配时间段（区间匹配 + 点时间容差 ±10 分钟）
2. 文档定位：`{base-dir}/{校区}/{校区}{日期}教师值班记录.docx`
3. 图片插入表格对应行的"情况记录"列
4. 保存文档

### 4. 异常处理

| 异常 | 处理 |
|------|------|
| 网络错误 | 重试最多 3 次，间隔 10 秒 |
| 文档不存在 | 记录错误：`{校区}{日期} 的文档不存在，请确认文件已创建` |
| 时间段无法匹配 | 记录错误：`时间 {HH:MM} 无法匹配任何时间段` |
| OCR 字段缺失 | 记录错误：`图片 {filename} 缺少字段: {fields}`，跳过该图 |
| 云服务器不可达 | 记录错误，下轮重试 |

### 5. 清理

```bash
python scripts/cleanup.py --temp-dir "${TEMP_DIR}" --max-age-hours 24
```

### 6. 一键执行（推荐）

```bash
python scripts/run.py --base-dir "${DUTY_LOG_BASE_DIR}" --dry-run   # 预览
python scripts/run.py --base-dir "${DUTY_LOG_BASE_DIR}"              # 正式运行
```

`run.py` 自动串联以上 5 步，输出 JSON 摘要（含每张图片的处理结果和错误详情）。支持 `--dry-run` 预览模式。

## 硬规则

- 图片只能插入 Word 文档，绝不删除或覆盖已有内容
- 同一张图片不要重复插入（通过 poll_state 的 last_poll 时间戳防止）
- 插入前验证文档存在，不存在则报错不创建
- 操作 Word 前先确认表格结构符合预期（有"时间"和"情况记录"列）
- 所有操作记录日志，便于排查问题
