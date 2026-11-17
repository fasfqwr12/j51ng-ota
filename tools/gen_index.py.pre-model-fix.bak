#!/usr/bin/env python3
"""扫描 firmware/ 生成 index.json（手机端在线固件库读取）。

用法：python tools/gen_index.py
新增固件后跑一次，然后 git push。
"""
import hashlib
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FW = os.path.join(ROOT, "firmware")

TARGET_NAME = {"M": "主控 M", "S": "蓝牙板 S", "R": "雷达 R"}


def hex_image_size(path):
    """解析 Intel HEX，返回实际镜像字节数。"""
    lo = hi = None
    total = set()
    base = 0
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                s = line.strip()
                if not s.startswith(":"):
                    continue
                n = int(s[1:3], 16)
                addr = int(s[3:7], 16)
                ty = int(s[7:9], 16)
                if ty == 0:
                    a = base + addr
                    for i in range(n):
                        total.add(a + i)
                    lo = a if lo is None else min(lo, a)
                    hi = a + n if hi is None else max(hi, a + n)
                elif ty == 4:
                    base = int(s[9:13], 16) << 16
                elif ty == 2:
                    base = int(s[9:13], 16) << 4
    except Exception:
        return None
    return (hi - lo) if (lo is not None and hi is not None) else None


def main():
    items = []
    for fn in sorted(os.listdir(FW)):
        if not fn.lower().endswith((".hex", ".bin")):
            continue
        path = os.path.join(FW, fn)
        target = "M"
        if fn.upper().startswith("S_"):
            target = "S"
        elif fn.upper().startswith("R_"):
            target = "R"
        raw = open(path, "rb").read()
        sha = hashlib.sha256(raw).hexdigest()
        img = hex_image_size(path) if fn.lower().endswith(".hex") else len(raw)
        m = re.search(r"v(\d+)", fn)
        role = "boot" if "boot" in fn.lower() else "app"
        items.append({
            "file": fn,
            "role": role,
            "target": target,
            "targetName": TARGET_NAME.get(target, target),
            "title": os.path.splitext(fn)[0],
            "size": img or len(raw),
            "fileSize": len(raw),
            "sha256": sha,
            "version": ("v" + m.group(1)) if m else "",
            "mtime": os.path.getmtime(path),
        })
    items.sort(key=lambda x: (x["target"], x["title"]))
    out = os.path.join(FW, "index.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"updated": int(max((i["mtime"] for i in items), default=0)), "items": items},
                  f, ensure_ascii=False, indent=2)
    print("生成", out, "共", len(items), "项")
    for i in items:
        print("  %-28s %-6s %8d B  %s" % (i["file"], i["targetName"], i["size"], i["sha256"][:16]))


if __name__ == "__main__":
    main()
