#!/usr/bin/env python3
"""Cats Company API docs server — renders API.md as styled HTML."""
import http.server
import os
import re

PORT = 9090
DOCS_DIR = os.path.dirname(os.path.abspath(__file__))
MD_FILE = os.path.join(DOCS_DIR, "API.md")

HTML_HEAD = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cats Company API</title>
<style>
:root{--bg:#0d1117;--fg:#c9d1d9;--border:#30363d;--accent:#58a6ff;--code-bg:#161b22;--heading:#f0f6fc;--muted:#8b949e}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);line-height:1.7}
.wrap{max-width:880px;margin:0 auto;padding:40px 24px}
h1{color:var(--heading);font-size:2em;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:8px}
h2{color:var(--heading);font-size:1.5em;margin:48px 0 16px;border-bottom:1px solid var(--border);padding-bottom:8px}
h3{color:var(--heading);font-size:1.25em;margin:32px 0 12px}
h4{color:var(--accent);font-size:1em;margin:24px 0 8px;font-family:'SF Mono',Monaco,monospace}
p{margin:8px 0}
blockquote{border-left:3px solid var(--accent);padding:4px 16px;color:var(--muted);margin:8px 0}
code{background:var(--code-bg);padding:2px 6px;border-radius:4px;font-family:'SF Mono',Monaco,monospace;font-size:.9em}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:16px;overflow-x:auto;margin:12px 0}
pre code{background:none;padding:0;font-size:.85em;line-height:1.5}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:.9em}
th,td{border:1px solid var(--border);padding:8px 12px;text-align:left}
th{background:var(--code-bg);color:var(--heading);font-weight:600}
ul,ol{padding-left:24px;margin:8px 0}
li{margin:4px 0}
hr{border:none;border-top:1px solid var(--border);margin:32px 0}
a{color:var(--accent);text-decoration:none}
</style>
</head>
<body><div class="wrap">
"""

HTML_TAIL = "</div></body></html>"


def md_to_html(md: str) -> str:
    """Minimal markdown to HTML converter — good enough for API docs."""
    lines = md.split("\n")
    html_parts = []
    in_code = False
    in_table = False
    in_ul = False

    for line in lines:
        # fenced code blocks
        if line.startswith("```"):
            if in_code:
                html_parts.append("</code></pre>")
                in_code = False
            else:
                lang = line[3:].strip()
                html_parts.append(f'<pre><code class="{lang}">')
                in_code = True
            continue
        if in_code:
            html_parts.append(esc(line))
            continue

        # close lists/tables if needed
        stripped = line.strip()
        if in_table and not stripped.startswith("|"):
            html_parts.append("</tbody></table>")
            in_table = False
        if in_ul and not stripped.startswith("- "):
            html_parts.append("</ul>")
            in_ul = False

        # blank line
        if not stripped:
            html_parts.append("")
            continue

        # headings
        m = re.match(r"^(#{1,4})\s+(.*)", line)
        if m:
            lvl = len(m.group(1))
            html_parts.append(f"<h{lvl}>{inline(m.group(2))}</h{lvl}>")
            continue

        # hr
        if stripped == "---":
            html_parts.append("<hr>")
            continue

        # blockquote
        if stripped.startswith("> "):
            html_parts.append(f"<blockquote>{inline(stripped[2:])}</blockquote>")
            continue

        # table
        if stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if all(re.match(r"^[-:]+$", c) for c in cells):
                continue  # separator row
            if not in_table:
                html_parts.append("<table><thead><tr>")
                for c in cells:
                    html_parts.append(f"<th>{inline(c)}</th>")
                html_parts.append("</tr></thead><tbody>")
                in_table = True
            else:
                html_parts.append("<tr>")
                for c in cells:
                    html_parts.append(f"<td>{inline(c)}</td>")
                html_parts.append("</tr>")
            continue

        # unordered list
        if stripped.startswith("- "):
            if not in_ul:
                html_parts.append("<ul>")
                in_ul = True
            html_parts.append(f"<li>{inline(stripped[2:])}</li>")
            continue

        # paragraph
        html_parts.append(f"<p>{inline(stripped)}</p>")

    if in_table:
        html_parts.append("</tbody></table>")
    if in_ul:
        html_parts.append("</ul>")

    return "\n".join(html_parts)


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(s: str) -> str:
    s = esc(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", s)
    return s


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/", "/docs", "/docs/"):
            self.send_error(404)
            return
        try:
            with open(MD_FILE, "r", encoding="utf-8") as f:
                md = f.read()
        except FileNotFoundError:
            self.send_error(500, "API.md not found")
            return
        body = (HTML_HEAD + md_to_html(md) + HTML_TAIL).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # quiet


if __name__ == "__main__":
    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Docs server running on http://0.0.0.0:{PORT}/docs")
    server.serve_forever()
