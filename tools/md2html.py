#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docs/*.md -> docs/*.html（零依赖，站内「资料」页直接内嵌显示）
用法: python tools/md2html.py
支持: 标题/段落/表格/围栏代码/有序无序列表/引用/分隔线/粗体/行内代码/站内 .md 链接自动改 .html
"""
import html
import re
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"

PAGES = [
    ("APP_PROTOCOL_SPEC.md", "app-handover.html", "J51NG · App 对接说明书"),
    ("PROTOCOL_FLOW.md", "protocol-flow.html", "J51NG · 协议与流程"),
    ("APP_OPERATION_FLOW.md", "app-operation.html", "J51NG · 操作流程"),
]

CSS = """
:root{--bg:#f2f1e8;--card:#fff;--line:#ddd8c6;--ink:#2b2a25;--muted:#6f6a5c;--accent:#6b7f3a;--code:#f6f5ee}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:18px 16px 80px}
h1{font-size:21px;margin:6px 0 12px}
h2{font-size:17px;margin:24px 0 10px;padding-top:10px;border-top:1px solid var(--line)}
h3{font-size:15px;margin:16px 0 8px}
h4{font-size:14px;margin:12px 0 6px}
p{margin:8px 0}
ul,ol{margin:8px 0 8px 22px}
li{margin:3px 0}
a{color:var(--accent)}
code{background:var(--code);border:1px solid var(--line);border-radius:4px;padding:1px 4px;
     font-size:12.5px;font-family:ui-monospace,Consolas,monospace}
pre{background:#1f2119;color:#e8e6dc;padding:12px 14px;border-radius:10px;overflow-x:auto;
    font-size:12px;line-height:1.45}
pre code{background:none;border:0;color:inherit;padding:0;font-size:12px;white-space:pre}
table{border-collapse:collapse;width:100%;margin:10px 0;background:var(--card);font-size:13px;
      display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top;white-space:nowrap}
th{background:var(--code);font-weight:600}
blockquote{margin:10px 0;padding:9px 12px;border-left:3px solid var(--accent);background:#f7f6ef;
           color:var(--muted);border-radius:0 8px 8px 0}
hr{border:0;border-top:1px solid var(--line);margin:22px 0}
@media (max-width:700px){th,td{white-space:normal;word-break:break-word}table{display:table}}
"""


def inline(s: str) -> str:
    s = html.escape(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)",
               lambda m: '<a href="%s">%s</a>' % (m.group(2).replace(".md", ".html"), m.group(1)), s)
    return s


def convert(text: str) -> str:
    lines = text.split("\n")
    out, code = [], []
    i, in_code = 0, False

    def flush_code():
        if code:
            out.append("<pre><code>" + html.escape("\n".join(code)) + "</code></pre>")
            code.clear()

    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            if in_code:
                flush_code()
                in_code = False
            else:
                in_code = True
            i += 1
            continue
        if in_code:
            code.append(line)
            i += 1
            continue
        if not line.strip():
            i += 1
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            n = len(m.group(1))
            out.append("<h%d>%s</h%d>" % (n, inline(m.group(2)), n))
            i += 1
            continue
        if line.strip() == "---":
            out.append("<hr>")
            i += 1
            continue
        if line.startswith("> "):
            buf = []
            while i < len(lines) and lines[i].startswith("> "):
                buf.append(inline(lines[i][2:]))
                i += 1
            out.append("<blockquote>" + "<br>".join(buf) + "</blockquote>")
            continue
        if line.lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[-: |]+\|\s*$", lines[i + 1]):
            head = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            t = ["<table><thead><tr>" + "".join("<th>%s</th>" % inline(c) for c in head) + "</tr></thead><tbody>"]
            for r in rows:
                t.append("<tr>" + "".join("<td>%s</td>" % inline(c) for c in r) + "</tr>")
            t.append("</tbody></table>")
            out.append("".join(t))
            continue
        if re.match(r"^\s*[-*]\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\s*[-*]\s+", lines[i]):
                items.append("<li>%s</li>" % inline(re.sub(r"^\s*[-*]\s+", "", lines[i])))
                i += 1
            out.append("<ul>" + "".join(items) + "</ul>")
            continue
        if re.match(r"^\s*\d+\.\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\s*\d+\.\s+", lines[i]):
                items.append("<li>%s</li>" % inline(re.sub(r"^\s*\d+\.\s+", "", lines[i])))
                i += 1
            out.append("<ol>" + "".join(items) + "</ol>")
            continue
        buf = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,4}\s|```|\||>\s|-\s|\d+\.\s|---)", lines[i]):
            buf.append(lines[i])
            i += 1
        out.append("<p>%s</p>" % inline(" ".join(x.strip() for x in buf)))
    flush_code()
    return "\n".join(out)


def main() -> int:
    for md_name, out_name, title in PAGES:
        src = DOCS / md_name
        if not src.exists():
            print("跳过（不存在）:", md_name)
            continue
        body = convert(src.read_text(encoding="utf-8"))
        out = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
               '<meta name="viewport" content="width=device-width,initial-scale=1">'
               "<title>%s</title><style>%s</style></head><body><div class=\"wrap\">%s</div></body></html>"
               % (title, CSS, body))
        (DOCS / out_name).write_text(out, encoding="utf-8")
        print("%-26s -> %-22s %6d 字节" % (md_name, out_name, len(out)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
