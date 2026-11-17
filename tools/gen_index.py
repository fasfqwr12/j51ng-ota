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


# ---------- 镜像元数据块（与 app.js metaAt / image_header.h v2 一致） ----------
META_MAGIC, META_END, META_MIN, META_MAX, META_FMT, META_CRC_SPAN = (
    0x4154454D, 0x4D455441, 0x34, 0x100, 2, 0x2C)  # 与 app.js 常量一致：块首字节"MET A"、末4字节"ATEM"按小端读
_CRC_TAB = None

def _crc32(data):
    global _CRC_TAB
    if _CRC_TAB is None:
        _CRC_TAB = []
        for n in range(256):
            c = n
            for _ in range(8):
                c = (0xEDB88320 ^ (c >> 1)) if (c & 1) else (c >> 1)
            _CRC_TAB.append(c & 0xFFFFFFFF)
    crc = 0xFFFFFFFF
    for b in data:
        crc = _CRC_TAB[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF

def scan_meta(raw):
    """扫描 META…ATEM 块；找不到返回 None（旧格式镜像）。"""
    data = raw if isinstance(raw, (bytes, bytearray)) else bytes(raw)
    off = 0
    while off + META_MIN <= len(data):
        i = data.find(b"\x4d\x45\x54\x41", off)
        if i < 0:
            return None
        off = i
        if len(data) < i + META_MIN:
            return None
        size = int.from_bytes(data[i+4:i+6], "little")
        fmt = int.from_bytes(data[i+6:i+8], "little")
        end_magic = int.from_bytes(data[i+0x30:i+0x34], "little")
        blk_crc = int.from_bytes(data[i+0x2C:i+0x30], "little")
        if not (META_MIN <= size <= META_MAX):
            off = i + 4
            continue
        if fmt != META_FMT or end_magic != META_END or _crc32(data[i:i+META_CRC_SPAN]) != blk_crc:
            off = i + 4
            continue
        model = data[i+8:i+20].split(b"\x00", 1)[0].decode("ascii", "replace")
        fw = int.from_bytes(data[i+0x20:i+0x22], "little")
        return {
            "model": model,
            "imageType": data[i+0x26],
            "target": data[i+0x27],
            "fwVer": fw,
            "verText": "v%d.%d" % ((fw >> 8) & 0xFF, fw & 0xFF),
            "codeSize": int.from_bytes(data[i+0x18:i+0x1C], "little"),
            "appCrc": int.from_bytes(data[i+0x14:i+0x18], "little"),
            "vtOff": int.from_bytes(data[i+0x24:i+0x26], "little"),
        }
    return None

def meta_of_file(path, fn):
    """bin 直接扫；hex 解析成整段镜像再扫（同 hex_image_size 的基址逻辑）。"""
    raw = open(path, "rb").read()
    if fn.lower().endswith(".bin"):
        return scan_meta(raw)
    lo = hi = None
    mem = {}
    base = 0
    try:
        for line in raw.decode("utf-8", "ignore").splitlines():
            s = line.strip()
            if not s.startswith(":"):
                continue
            n = int(s[1:3], 16)
            addr = int(s[3:7], 16)
            ty = int(s[7:9], 16)
            d = bytes.fromhex(s[9:9+2*n])
            if ty == 0:
                a = base + addr
                for k, b in enumerate(d):
                    mem[a+k] = b
                lo = a if lo is None else min(lo, a)
                hi = a + n if hi is None else max(hi, a + n)
            elif ty == 4:
                base = int(s[9:13], 16) << 16
            elif ty == 2:
                base = int(s[9:13], 16) << 4
    except Exception:
        return None
    if lo is None:
        return None
    return scan_meta(bytes(mem.get(x, 0xFF) for x in range(lo, hi)))

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
        meta = meta_of_file(path, fn)
        model = meta["model"] if meta else ""
        # 型号是权威自描述字段（上位机不关心 target 数值约定）：N2SE_M→M，N2SE_S→S
        if model.upper().endswith("_M"):
            target = "M"
        elif model.upper().endswith("_S"):
            target = "S"
        title = os.path.splitext(fn)[0]
        if model:
            title = "%s %s" % (model, "APP" if role == "app" else "BOOT")
            if meta:
                title += " %s" % meta["verText"]
                title += " crc=%s" % meta["appCrc"]
        items.append({
            "file": fn,
            "role": role,
            "target": target,
            "targetName": TARGET_NAME.get(target, target),
            "title": title,
            "size": img or len(raw),
            "fileSize": len(raw),
            "sha256": sha,
            "version": (meta["verText"] if meta else ("v" + m.group(1)) if m else ""),
            "model": model,
            "appCrc": ("0x%08X" % meta["appCrc"]) if meta else "",
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
