# duty-log 值班日志自动归档

## 前置条件

1. 企业微信管理后台已创建自建应用，回调 URL 已配置
2. 云服务器 `118.145.116.152:8899` 已部署 wecom-receiver 服务
3. 本机已安装 Python 3.8+ 和 XiaoBa CLI

## 本机部署步骤

### 1. 安装 Python 依赖

```bash
cd skills/duty-log
pip install -r scripts/requirements.txt
```

### 2. 配置

在系统环境变量或 XiaoBa config 中设置：

**云服务器：**
- `DUTY_LOG_API_BASE` = `http://118.145.116.152:8899`
- `DUTY_LOG_API_TOKEN` = `<与云服务器一致的共享密钥>`

**文档路径：**
- `DUTY_LOG_BASE_DIR` = 值班记录根目录（内含 `东校区/` 和 `西校区/` 子目录）

**OCR 视觉模型（需 vision-capable 模型，推荐阿里百炼）：**
- `DUTY_LOG_OCR_API_KEY` = `<你的百炼 API key>`（未设置时回退到 `GAUZ_LLM_API_KEY`）
- `DUTY_LOG_OCR_API_BASE` = `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `DUTY_LOG_OCR_MODEL` = `qwen3-vl-plus`

> 也支持 OpenAI (`gpt-4o-mini`) 和 Anthropic (`claude-haiku-4-5-20251001`)。
> ⚠️ MiniMax / DeepSeek 不支持 vision。

### 3. 验证连接

```bash
python scripts/poll_and_fetch.py \
  --api-base http://118.145.116.152:8899 \
  --api-token <token> \
  --dest-dir ./test_images
```

### 4. 测试 OCR

```bash
python scripts/ocr_image.py --image test.jpg
```

### 5. 测试时间段匹配

```bash
python scripts/match_and_insert.py \
  --image test.jpg \
  --hhmm "06:58" \
  --date "2026.05.08" \
  --campus "西校区" \
  --base-dir "D:/值班记录" \
  --dry-run
```

### 6. 端到端预览

```bash
python scripts/run.py --base-dir "D:/值班记录" --dry-run
```

### 7. 在 XiaoBa 中激活

```
/duty-log
```

## 目录结构

```
skills/duty-log/
├── SKILL.md                 # 技能提示词
├── README.md                # 本文档
├── .poll_state.json         # 轮询状态（自动生成）
├── scripts/
│   ├── timeslots.json       # 时间段定义
│   ├── run.py               # 主编排脚本（一键执行全流程）
│   ├── ocr_image.py         # OCR 识别（Claude Vision 提取时间/日期/校区）
│   ├── match_and_insert.py  # 时间段匹配 + Word 插入
│   ├── poll_and_fetch.py    # 轮询云服务器下载图片
│   ├── cleanup.py           # 清理过期临时图片
│   └── requirements.txt     # Python 依赖
└── tests/
    └── test_e2e.py          # 端到端测试
```

## 云服务器部署

wecom-receiver 部署在 `118.145.116.152:/opt/wecom-receiver/`，通过 tmux 管理：

```bash
ssh xiaoba
tmux attach -t wecom
```
