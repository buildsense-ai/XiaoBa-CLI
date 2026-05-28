#!/usr/bin/env python3
"""
Memory Search - 跨Session记忆搜索工具

支持多种搜索维度：
- 时间范围、Session过滤、消息类型
- 关键词搜索、工具名过滤
- 长结果截断、嵌套搜索（通过临时文件）

用法:
  python3 memory-search.py [options]          # 搜索
  python3 memory-search.py --inspect <idx>    # 查看上次结果的完整信息
  python3 memory-search.py --tools <idx>      # 查看上次结果的tool详情
  python3 memory-search.py -i                 # 交互模式
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any

# 默认配置
DEFAULT_LOG_DIR = Path("/Users/zhuhanyuan/Documents/xiaoba/logs/sessions/catscompany")
DEFAULT_TRUNCATE = 150
CACHE_FILE = Path("/tmp/memory-search-last-results.jsonl")


class MemorySearch:
    def __init__(self, log_dir: str = None):
        self.log_dir = Path(log_dir or DEFAULT_LOG_DIR)
        self.truncate = DEFAULT_TRUNCATE
        self.last_results = self._load_cache()
        
    def _load_cache(self) -> List[Dict]:
        """加载上次搜索结果"""
        if CACHE_FILE.exists():
            try:
                with open(CACHE_FILE) as f:
                    return [json.loads(line) for line in f if line.strip()]
            except:
                return []
        return []
        
    def _save_cache(self, results: List[Dict]):
        """保存搜索结果到缓存"""
        self.last_results = results
        with open(CACHE_FILE, 'w') as f:
            for r in results:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
                
    def find_sessions(self, date: str = None, session_id: str = None) -> List[Path]:
        """找到匹配的session文件"""
        sessions = []
        
        if date and date != "today":
            search_dir = self.log_dir / date
        else:
            today = datetime.now().strftime("%Y-%m-%d")
            search_dir = self.log_dir / today
            
        if not search_dir.exists():
            print(f"❌ 目录不存在: {search_dir}")
            return []
            
        for f in sorted(search_dir.glob("*.jsonl")):
            if session_id:
                # 同时匹配文件名和session_id
                if session_id in f.stem or session_id in f.name:
                    sessions.append(f)
            else:
                sessions.append(f)
                
        return sessions
    
    def load_session(self, session_path: Path) -> List[Dict]:
        """加载session所有记录"""
        records = []
        with open(session_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        records.append(json.loads(line))
                    except:
                        continue
        return records
    
    def filter_records(self, records: List[Dict], 
                       msg_type: str = None,
                       keyword: str = None,
                       tool_name: str = None,
                       turns: List[int] = None,
                       session: str = None) -> List[Dict]:
        """过滤记录"""
        results = []
        
        for record in records:
            # Session过滤
            if session and session not in record.get("session_id", ""):
                continue
                
            # 类型过滤
            if msg_type:
                if msg_type == "user" and not record.get("user", {}).get("text"):
                    continue
                elif msg_type == "assistant" and not record.get("assistant", {}).get("text"):
                    continue
                elif msg_type == "tool":
                    assistant = record.get("assistant", {})
                    if not isinstance(assistant, dict) or not assistant.get("tool_calls"):
                        continue
                elif msg_type == "error" and not self._is_error_record(record):
                    continue
                    
            # 关键词过滤
            if keyword:
                text = json.dumps(record, ensure_ascii=False)
                if keyword.lower() not in text.lower():
                    continue
                    
            # 工具名过滤
            if tool_name:
                assistant = record.get("assistant", {})
                tool_calls = assistant.get("tool_calls", []) if isinstance(assistant, dict) else []
                if not any(tc.get("name") == tool_name for tc in tool_calls):
                    continue
                    
            # Turn过滤
            if turns:
                if record.get("turn") not in turns:
                    continue
                    
            results.append(record)
            
        return results
    
    def _is_error_record(self, record: Dict) -> bool:
        """判断是否为错误记录"""
        user_text = record.get("user", {}).get("text", "").lower()
        if "error" in user_text or "报错" in user_text or "失败" in user_text or "问题" in user_text:
            return True
            
        assistant = record.get("assistant", {})
        assistant_text = assistant.get("text", "") if isinstance(assistant, dict) else ""
        if "error" in assistant_text.lower() or "✗" in assistant_text or "失败" in assistant_text:
            return True
            
        for tc in assistant.get("tool_calls", []) if isinstance(assistant, dict) else []:
            result = tc.get("result", "")
            if isinstance(result, str):
                if any(x in result.lower() for x in ["error", "✗", "not found", "失败", "不存在"]):
                    return True
                    
        return False
    
    def format_record(self, record: Dict, show_tools: bool = True, 
                     truncate: int = None, full_tools: bool = False) -> str:
        """格式化单条记录"""
        truncate = truncate or self.truncate
        session = record.get("session_id", "unknown")
        turn = record.get("turn", "?")
        timestamp = record.get("timestamp", "")[11:16]
        
        lines = [f"\n{'='*60}"]
        lines.append(f"[{session} | Turn {turn} | {timestamp}]")
        lines.append("=" * 60)
        
        # User message
        user_text = record.get("user", {}).get("text", "")
        if user_text:
            text = user_text[:truncate] + "..." if len(user_text) > truncate else user_text
            lines.append(f"\n👤 User:\n{text}")
            
        # Assistant response
        assistant = record.get("assistant", {})
        if isinstance(assistant, dict):
            assistant_text = assistant.get("text", "")
            if assistant_text:
                text = assistant_text[:truncate] + "..." if len(assistant_text) > truncate else assistant_text
                lines.append(f"\n🤖 Assistant:\n{text}")
                
            # Tool calls
            if show_tools:
                tool_calls = assistant.get("tool_calls", [])
                if tool_calls:
                    lines.append(f"\n🔧 Tools ({len(tool_calls)}):")
                    for i, tc in enumerate(tool_calls):
                        name = tc.get("name", "unknown")
                        args = tc.get("arguments", "")
                        result = tc.get("result", "") if full_tools else ""
                        
                        # 解析args
                        if isinstance(args, str):
                            try:
                                parsed = json.loads(args)
                                args_str = parsed.get("command", parsed.get("file_path", str(parsed)))[:60]
                            except:
                                args_str = args[:60]
                        elif isinstance(args, dict):
                            args_str = args.get("command", args.get("file_path", str(args)))[:60]
                        else:
                            args_str = str(args)[:60]
                            
                        if full_tools:
                            lines.append(f"  {i+1}. {name}")
                            lines.append(f"     Args: {args_str}")
                            # Result
                            if result:
                                res_str = str(result)[:200]
                                lines.append(f"     Result: {res_str}{'...' if len(str(result)) > 200 else ''}")
                        else:
                            lines.append(f"  {i+1}. {name}: {args_str}...")
                            
        return "\n".join(lines)
    
    def search(self, 
               date: str = None,
               session: str = None,
               type: str = None,
               keyword: str = None,
               tool: str = None,
               turns: str = None,
               limit: int = 10,
               truncate: int = None,
               show_tools: bool = True,
               full: bool = False,
               context: int = 0) -> List[Dict]:
        """执行搜索"""
        truncate = 0 if full else (truncate or self.truncate)
        
        sessions = self.find_sessions(date, session)
        if not sessions:
            return []
            
        all_results = []
        
        for session_path in sessions:
            records = self.load_session(session_path)
            
            # Turn范围解析
            turn_list = None
            if turns:
                if "-" in turns:
                    start, end = turns.split("-")
                    turn_list = list(range(int(start), int(end) + 1))
                else:
                    turn_list = [int(turns)]
                    
            filtered = self.filter_records(
                records,
                msg_type=type,
                keyword=keyword,
                tool_name=tool,
                turns=turn_list,
                session=session
            )
            
            # 上下文
            if context > 0:
                filtered = self._add_context(filtered, records, context)
                
            filtered = filtered[:limit]
            all_results.extend(filtered)
            
            if limit and len(all_results) >= limit:
                all_results = all_results[:limit]
                break
                
        self._save_cache(all_results)
        return all_results
    
    def _add_context(self, filtered: List[Dict], all_records: List[Dict], 
                     context_size: int) -> List[Dict]:
        """添加周围上下文"""
        if not filtered:
            return filtered
            
        filtered_turns = set(r.get("turn") for r in filtered)
        context_turns = set()
        
        for turn in filtered_turns:
            for t in range(max(1, turn - context_size), turn + context_size + 1):
                context_turns.add(t)
                
        return [r for r in all_records if r.get("turn") in context_turns]
    
    def inspect(self, index: int, show_tools: bool = True, full: bool = True) -> str:
        """查看完整记录"""
        if not self.last_results or index >= len(self.last_results):
            return f"❌ 无效索引，有效范围: 0-{len(self.last_results)-1}\n💡 请先运行搜索"
            
        record = self.last_results[index]
        return self.format_record(record, show_tools=show_tools, 
                                 truncate=0 if full else self.truncate,
                                 full_tools=full)
    
    def show_tools_for_record(self, index: int) -> str:
        """显示tool详情"""
        if not self.last_results or index >= len(self.last_results):
            return f"❌ 无效索引\n💡 请先运行搜索"
            
        record = self.last_results[index]
        assistant = record.get("assistant", {})
        tool_calls = assistant.get("tool_calls", []) if isinstance(assistant, dict) else []
        
        if not tool_calls:
            return "该记录没有tool调用"
            
        lines = [f"\n{'='*60}"]
        lines.append(f"[Turn {record.get('turn')} | Tool详情]")
        lines.append("=" * 60)
        
        for i, tc in enumerate(tool_calls):
            name = tc.get("name", "unknown")
            args = tc.get("arguments", "")
            result = tc.get("result", "")
            
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except:
                    pass
                    
            lines.append(f"\n--- Tool {i+1}: {name} ---")
            lines.append(f"ID: {tc.get('id', 'N/A')}")
            lines.append(f"Arguments: {json.dumps(args, indent=2, ensure_ascii=False)[:800]}")
            lines.append(f"Result: {str(result)[:500]}{'...' if len(str(result)) > 500 else ''}")
            
        return "\n".join(lines)
    
    def list_tools(self) -> str:
        """列出上次结果中的工具使用情况"""
        if not self.last_results:
            return "❌ 无搜索结果"
            
        tool_counts = {}
        for r in self.last_results:
            assistant = r.get("assistant", {})
            if isinstance(assistant, dict):
                for tc in assistant.get("tool_calls", []):
                    name = tc.get("name", "unknown")
                    tool_counts[name] = tool_counts.get(name, 0) + 1
                    
        if not tool_counts:
            return "没有tool调用记录"
            
        lines = ["\n🔧 工具使用统计:"]
        for name, count in sorted(tool_counts.items(), key=lambda x: -x[1]):
            lines.append(f"  {name}: {count}次")
            
        return "\n".join(lines)
    
    def stats(self) -> str:
        """显示会话统计"""
        sessions = self.find_sessions()
        if not sessions:
            return "❌ 没有找到会话"
            
        lines = [f"\n📊 今日会话统计 ({len(sessions)}个)"]
        lines.append("=" * 40)
        
        for f in sessions:
            records = self.load_session(f)
            session_id = f.stem
            
            if records:
                start = records[0].get("timestamp", "")[11:16]
                end = records[-1].get("timestamp", "")[11:16]
                count = len(records)
                
                # 统计工具
                tool_counts = {}
                for r in records:
                    assistant = r.get("assistant", {})
                    if isinstance(assistant, dict):
                        for tc in assistant.get("tool_calls", []):
                            name = tc.get("name", "unknown")
                            tool_counts[name] = tool_counts.get(name, 0) + 1
                            
                top_tools = sorted(tool_counts.items(), key=lambda x: -x[1])[:3]
                tools_str = ", ".join([f"{n}({c})" for n, c in top_tools]) if top_tools else ""
                
                lines.append(f"\n{session_id}")
                lines.append(f"  {start} - {end} | {count}条 | {tools_str}")
                
        return "\n".join(lines)
    
    def interactive(self):
        """交互模式"""
        print("""
🔍 Memory Search - 交互模式
============================
命令:
  search <选项>        搜索 (同命令缩写 s)
  inspect <idx>         查看完整记录 (i)
  tools <idx>          查看tool详情 (t)
  last                  显示上次结果摘要
  stats                 会话统计
  help                  显示帮助
  exit                  退出
""")
        
        while True:
            try:
                cmd = input("\n> ").strip()
                if not cmd:
                    continue
                    
                parts = cmd.split()
                action = parts[0].lower()
                
                if action == "exit":
                    break
                elif action in ("help", "h", "?"):
                    print("""
参数:
  --date YYYY-MM-DD    日期 (默认今天)
  --session <id>       session ID
  --type user|assistant|tool|error
  --keyword <词>       关键词
  --tool <名>          工具名
  --turns <n-m>        turn范围
  --limit <n>          结果数 (默认10)
  --truncate <n>       截断长度
  --full               显示完整
  --context <n>        周围上下文数

示例:
  s --keyword backlog --limit 5
  i 0
  t 0
  s --type error --limit 3
  s --tool execute_shell --limit 5
                    """)
                elif action in ("search", "s"):
                    kwargs = self._parse_args(parts[1:])
                    results = self.search(**kwargs)
                    self._print_results(results)
                elif action in ("inspect", "i"):
                    if len(parts) > 1:
                        print(self.inspect(int(parts[1])))
                    else:
                        print("用法: i <索引>")
                elif action in ("tools", "t"):
                    if len(parts) > 1:
                        print(self.show_tools_for_record(int(parts[1])))
                    else:
                        print("用法: t <索引>")
                elif action == "last" or action == "l":
                    self._print_results(self.last_results[:5])
                elif action == "stats":
                    print(self.stats())
                elif action == "tools":
                    print(self.list_tools())
                    
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(f"❌ 错误: {e}")
                
    def _parse_args(self, parts: List[str]) -> Dict:
        """参数解析"""
        kwargs = {}
        i = 0
        while i < len(parts):
            p = parts[i]
            if p.startswith("--"):
                key = p[2:].replace("-", "_")
                if i + 1 < len(parts) and not parts[i+1].startswith("--"):
                    val = parts[i + 1]
                    # 类型转换
                    if val.isdigit():
                        val = int(val)
                    kwargs[key] = val
                    i += 2
                else:
                    kwargs[key] = True
                    i += 1
            elif not p.startswith("-"):
                i += 1
            else:
                i += 1
        return kwargs
    
    def _print_results(self, results: List[Dict]):
        """打印结果摘要"""
        if not results:
            print("❌ 无结果")
            return
            
        print(f"\n📊 找到 {len(results)} 条记录")
        for i, r in enumerate(results):
            session = r.get("session_id", "?")
            turn = r.get("turn", "?")
            time = r.get("timestamp", "")[11:16]
            user = r.get("user", {}).get("text", "")[:55] or "(无用户消息)"
            tools = len(r.get("assistant", {}).get("tool_calls", []))
            
            print(f"\n[{i}] {session} | T{turn} | {time}")
            print(f"    {user}...")
            if tools > 0:
                print(f"    🔧 {tools} tools")
                
        print(f"\n💡 i <idx> 查看完整 | t <idx> 查看tool | stats 显示统计")


def main():
    parser = argparse.ArgumentParser(
        description="Memory Search - 跨Session记忆搜索",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python3 memory-search.py --keyword "backlog" --limit 5
  python3 memory-search.py --tool execute_shell --limit 3
  python3 memory-search.py --type error --limit 5
  python3 memory-search.py --inspect 0 --full
  python3 memory-search.py --tools 0
  python3 memory-search.py -i
        """
    )
    parser.add_argument("--date", "-d", help="日期 (YYYY-MM-DD, 默认今天)")
    parser.add_argument("--session", "-s", help="session ID或前缀")
    parser.add_argument("--type", "-t", choices=["user", "assistant", "tool", "error"],
                       help="消息类型")
    parser.add_argument("--keyword", "-k", help="关键词")
    parser.add_argument("--tool", help="工具名 (execute_shell, edit_file, etc.)")
    parser.add_argument("--turns", help="turn范围，如 10-15")
    parser.add_argument("--limit", "-n", type=int, default=10, help="结果数量")
    parser.add_argument("--truncate", type=int, help="截断长度")
    parser.add_argument("--full", action="store_true", help="显示完整结果")
    parser.add_argument("--context", "-c", type=int, default=0, help="周围上下文数")
    
    # 快速查看命令
    parser.add_argument("--inspect", type=int, metavar="IDX", help="查看完整记录")
    parser.add_argument("--tools", type=int, metavar="IDX", help="查看tool详情")
    parser.add_argument("--stats", action="store_true", help="会话统计")
    
    parser.add_argument("-i", "--interactive", action="store_true", help="交互模式")
    
    args = parser.parse_args()
    
    searcher = MemorySearch()
    
    if args.interactive:
        searcher.interactive()
        return
        
    if args.inspect is not None:
        print(searcher.inspect(args.inspect, full=args.full))
        return
        
    if args.tools is not None:
        print(searcher.show_tools_for_record(args.tools))
        return
        
    if args.stats:
        print(searcher.stats())
        return
        
    results = searcher.search(
        date=args.date,
        session=args.session,
        type=args.type,
        keyword=args.keyword,
        tool=args.tool,
        turns=args.turns,
        limit=args.limit,
        truncate=args.truncate,
        full=args.full,
        context=args.context
    )
    
    searcher._print_results(results)


if __name__ == "__main__":
    main()
