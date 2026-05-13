"""
从企微审批 API 获取请假申请数据，转换为标准化 JSON。

在企微应用配置完成之前，支持 "--mock" 模式从本地 JSON 读取。

用法：
  python fetch_approvals.py --mock mock_data.json                    # 本地 mock
  python fetch_approvals.py --start 2024-09-01 --end 2025-06-30     # API 模式（待企微就绪）
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

try:
    import requests
except ImportError:
    pass  # mock 模式不需要

# ── 配置（企微应用就绪后填入 .env）─────────────────────────────
WECOM_CORP_ID = os.environ.get("WECOM_CORP_ID", "")
WECOM_SECRET = os.environ.get("WECOM_SECRET", "")
WECOM_BASE = "https://qyapi.weixin.qq.com/cgi-bin"

# 审批模板 ID（请假模板，需要在企微后台确认）
LEAVE_TEMPLATE_ID = os.environ.get("LEAVE_TEMPLATE_ID", "")

# 已处理审批单号缓存（防重）
PROCESSED_CACHE = Path.home() / ".config" / "xiaoba" / "leave_record_processed.json"


def load_processed() -> set:
    """加载已处理的审批单号集合。"""
    if not PROCESSED_CACHE.exists():
        return set()
    try:
        data = json.loads(PROCESSED_CACHE.read_text(encoding="utf-8"))
        return set(data.get("processed", []))
    except (json.JSONDecodeError, KeyError):
        return set()


def save_processed(sp_nos: set):
    """保存已处理的审批单号。"""
    PROCESSED_CACHE.parent.mkdir(parents=True, exist_ok=True)
    data = {"processed": list(sp_nos), "updated_at": datetime.now().isoformat()}
    PROCESSED_CACHE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def get_access_token() -> str:
    """获取企微应用 access_token。"""
    # TODO: 企微应用就绪后取消注释
    # resp = requests.get(
    #     f"{WECOM_BASE}/gettoken",
    #     params={"corpid": WECOM_CORP_ID, "corpsecret": WECOM_SECRET},
    #     timeout=10,
    # )
    # resp.raise_for_status()
    # data = resp.json()
    # if data.get("errcode", 0) != 0:
    #     print(f"获取 access_token 失败：{data.get('errmsg')}", file=sys.stderr)
    #     sys.exit(1)
    # return data["access_token"]
    return ""


def fetch_approval_list(access_token: str, template_id: str, start_time: int, end_time: int) -> list:
    """拉取指定时间范围内的审批单号列表。

    TODO: 企微应用就绪后取消注释。接口路径和参数需与企微文档对齐。
    """
    # url = f"{WECOM_BASE}/oa/getapprovalinfo"
    # all_sp_nos = []
    # cursor = 0
    # while True:
    #     resp = requests.post(
    #         url,
    #         json={
    #             "starttime": start_time,
    #             "endtime": end_time,
    #             "cursor": cursor,
    #             "size": 100,
    #             "filters": [{"key": "sp_status", "value": "2"}],  # 2 = 已通过
    #             "template_id": template_id,
    #         },
    #         params={"access_token": access_token},
    #         timeout=15,
    #     )
    #     resp.raise_for_status()
    #     data = resp.json()
    #     if data.get("errcode", 0) != 0:
    #         print(f"获取审批列表失败：{data.get('errmsg')}", file=sys.stderr)
    #         break
    #     all_sp_nos.extend(data.get("sp_no_list", []))
    #     cursor = data.get("next_cursor", 0)
    #     if cursor == 0:
    #         break
    # return all_sp_nos
    return []


def fetch_approval_detail(access_token: str, sp_no: str) -> dict:
    """获取单条审批详情。

    TODO: 企微应用就绪后取消注释。
    """
    # url = f"{WECOM_BASE}/oa/getapprovaldetail"
    # resp = requests.post(
    #     url,
    #     json={"sp_no": sp_no},
    #     params={"access_token": access_token},
    #     timeout=15,
    # )
    # resp.raise_for_status()
    # data = resp.json()
    # if data.get("errcode", 0) != 0:
    #     print(f"获取审批详情失败 {sp_no}：{data.get('errmsg')}", file=sys.stderr)
    #     return {}
    # return data.get("info", {})
    return {}


def parse_approval_detail(detail: dict) -> dict:
    """解析企微审批详情为标准化 JSON。

    TODO: 企微应用就绪后，根据实际 API 返回的数据结构完成字段映射。
    当前为占位逻辑，需要根据实际返回的 apply_data 结构调整。
    """
    # 企微审批详情中，表单数据在 apply_data.contents 中
    # 每个字段有 control 和 value
    # apply_data = detail.get("apply_data", {})
    # contents = apply_data.get("contents", [])
    #
    # fields = {}
    # for item in contents:
    #     control = item.get("control", "")
    #     value = item.get("value", {})
    #     if control == "LeaveType":
    #         fields["leave_type"] = value.get("text", "")
    #     elif control in ("StartTime", "start_time", "leave_start"):
    #         fields["start_time"] = parse_time_value(value)
    #     # ... 更多字段映射
    # return fields
    return {}


def parse_time_value(value: dict) -> str:
    """解析企微时间字段为 YYYY-MM-DD HH:MM 格式。"""
    # timestamp = value.get("timestamp", 0)
    # if timestamp:
    #     return datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M")
    return str(value)


# ── Mock 模式 ─────────────────────────────────────────────────

def run_mock(mock_path: str, start: str = None, end: str = None):
    """从本地 JSON 文件读取并输出标准化审批数据。"""
    if not os.path.exists(mock_path):
        print(f"错误：mock 文件不存在 - {mock_path}", file=sys.stderr)
        sys.exit(1)

    with open(mock_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # mock 数据可以直接是审批列表，也可以是带元信息的结构
    if isinstance(data, list):
        approvals = data
    elif isinstance(data, dict) and "approvals" in data:
        approvals = data["approvals"]
    else:
        print("错误：mock 文件格式不正确，期望 JSON 数组或含 approvals 字段的对象", file=sys.stderr)
        sys.exit(1)

    # 时间过滤
    if start:
        start_dt = datetime.strptime(start, "%Y-%m-%d")
        approvals = [a for a in approvals if datetime.strptime(a["start_time"], "%Y-%m-%d %H:%M") >= start_dt]
    if end:
        end_dt = datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)
        approvals = [a for a in approvals if datetime.strptime(a["start_time"], "%Y-%m-%d %H:%M") < end_dt]

    return approvals


def main():
    parser = argparse.ArgumentParser(description="从企微获取请假审批数据")
    parser.add_argument("--mock", help="Mock 模式：从本地 JSON 文件读取")
    parser.add_argument("--start", default=None, help="起始日期 YYYY-MM-DD")
    parser.add_argument("--end", default=None, help="结束日期 YYYY-MM-DD")
    parser.add_argument("--output", "-o", default=None, help="输出 JSON 文件路径（默认 stdout）")
    args = parser.parse_args()

    approvals = []

    if args.mock:
        approvals = run_mock(args.mock, args.start, args.end)
    else:
        # TODO: 企微应用就绪后取消注释
        print("API 模式暂未就绪，请使用 --mock 模式测试", file=sys.stderr)
        sys.exit(1)

    # 去重
    processed = load_processed()
    new_approvals = [a for a in approvals if a.get("approval_no") not in processed]

    # 输出
    output = json.dumps(new_approvals, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"已输出 {len(new_approvals)} 条到 {args.output}")

        # 标记为已处理
        for a in new_approvals:
            processed.add(a.get("approval_no", ""))
        save_processed(processed)
    else:
        print(output)


if __name__ == "__main__":
    main()
