# -*- coding: utf-8 -*-
"""
J51NG OTA 上位机 —— 带 API 的静态服务器（替换 python -m http.server 8787）

页面完全不变，额外提供：
  GET  /api/status            当前任务状态
  GET  /api/log?since=N       增量日志
  POST /api/ota?target=S&file=...   启动一轮完整闭环（进Boot -> OTA -> 复位 -> 回读）
  POST /api/reset             清空日志

闭环流程（全部在服务端跑，不需要浏览器点任何东西）：
  1. ota_ble.BleHost 连接 -> 发 53 A2 0xFE 命令进 Boot
  2. ota_ble_s.py --go 跑完整 OTA（握手/参数/数据/SHA/0x0501）
  3. 等 20 s 让设备复位
  4. pyocd 读 pc + TRACE[1]/TRACE[7] 判定最终落在 boot 还是 app
"""
import json, os, queue, subprocess, sys, threading, time, traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

WEB   = Path(r"E:\tof\xuRxuG\04_host\ota_web")
ART   = Path(r"E:\tof\xuRxuG\04_host\ota_tool\artifacts")
TOOLS = Path(r"E:\tof\xuRxuG\03_firmware\m_app\tools")
PACK  = r"E:\tof\xuRxuG\05_scripts\tools\pyocd-packs\Nationstech.N32WB03x_DFP.1.0.0.pack"

sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(ART))

SVC = "00002760-08c2-11e1-9073-0e8ac72e1001"
WR  = "00002760-08c2-11e1-9073-0e8ac72e0001"
NF  = "00002760-08c2-11e1-9073-0e8ac72e0002"
ENTER = bytes([0x53, 0xA2, 0x04, 0x00, 0xFF, 0x01, 0xF9, 0x01])
ACK   = bytes([0x54, 0xA1, 0x04, 0x00, 0xFF, 0x00])

_lock  = threading.Lock()
_lines = []          # ["17:40:01  ...", ...]
_state = {"running": False, "stage": "-", "ok": None, "t0": None}

def log(msg, tag=""):
    ts = time.strftime("%H:%M:%S")
    line = f"{ts}  {msg}" + (f"  [{tag}]" if tag else "")
    with _lock:
        _lines.append(line)
        if len(_lines) > 4000:
            del _lines[:1000]
    print(line, flush=True)

def set_stage(s, ok=None):
    _state["stage"] = s
    if ok is not None:
        _state["ok"] = ok

# ---------------- 闭环步骤 ----------------

def step_enter_boot():
    import asyncio
    from ota_ble import BleHost

    async def go():
        for n in range(1, 7):
            try:
                h = BleHost("AIMTECH", SVC, WR, NF)
                await h.connect()
                h.raw_log.clear()
                await h.write_bytes(ENTER)
                await asyncio.sleep(1.5)
                raw = bytes(h.raw_log)
                try: await h.close()
                except Exception: pass
                if raw.find(ACK) >= 0:
                    log(f"[1/4] 进 Boot 第{n}次：APP 已接受 53A2，ACK=OK")
                    return True
                if raw.find(b"\xeb\x90") >= 0:
                    # 收到 EB90 帧 = 设备本来就在 Boot，无需再进
                    log(f"[1/4] 设备已在 Boot（收到 EB90 帧），跳过进 Boot")
                    return True
                log(f"[1/4] 进 Boot 第{n}次无应答  raw={raw[:20].hex(' ')}")
            except Exception as e:
                log(f"[1/4] 进 Boot 第{n}次异常 {type(e).__name__}: {e}")
                await asyncio.sleep(1.5)
        return False
    return asyncio.run(go())

def step_ota(target, fw):
    env = dict(os.environ, PYTHONPATH=str(TOOLS), PYTHONUNBUFFERED="1")
    p = subprocess.Popen(
        [sys.executable, "ota_ble_s.py", "--target", target, "--file", str(fw),
         "--pkt", "128", "--window", "8", "--gap", "4", "--go"],
        cwd=str(ART), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    t0 = time.time()
    for raw in p.stdout:
        line = raw.decode("gb18030", errors="replace").rstrip()
        if line:
            log("[2/4] " + line)
        if time.time() - t0 > 300:
            log("[2/4] 超时 300 s，终止", "err")
            p.kill()
            break
    p.wait()
    log(f"[2/4] ota_ble_s.py 退出码 {p.returncode}")
    return p.returncode == 0

def step_verify(max_s=120):
    """复位后轮询 SWD，直到 pc 落在 APP 或超时。返回 (zone, pc, 第几秒)"""
    def pycmd(*args):
        r = subprocess.run([sys.executable, "-m", "pyocd", "commander",
                            "-t", "n32wb031", "--pack", PACK, "-O", "connect_mode=attach",
                            *args, "-c", "go", "-c", "exit"],
                           capture_output=True)
        return (r.stdout + r.stderr).decode("utf-8", errors="replace")

    t0 = time.time()
    last = None
    while time.time() - t0 < max_s:
        out = pycmd("-c", "halt", "-c", "reg pc",
                    "-c", "read32 0x2000BD04", "-c", "read32 0x2000BD1C",
                    "-c", "read32 0x2000BD38", "-c", "read32 0x2000BD74", "-c", "read32 0x2000BD78")
        pc = None
        for line in out.splitlines():
            if line.startswith("pc ="):
                pc = int(line.split("=")[1].strip(), 16)
            for key in ("2000bd04:", "2000bd1c:", "2000bd38:", "2000bd74:", "2000bd78:"):
                if line.startswith(key):
                    log(f"[3/4] t+{int(time.time()-t0):02d}s {key[:-1]} = {line.split(':')[1].strip()}")
        if pc is None:
            time.sleep(3); continue
        zone = "APP" if 0x01010000 <= pc < 0x01030000 else ("BOOT" if 0x01000000 <= pc < 0x01010000 else "其他")
        if zone != last:
            log(f"[3/4] t+{int(time.time()-t0):02d}s pc=0x{pc:08X} -> {zone}")
            last = zone
        if zone == "APP":
            return zone, pc, int(time.time() - t0)
        time.sleep(3)
    return last or "未知", None, int(time.time() - t0)

def job(target, fw):
    _state["t0"] = time.time()
    try:
        set_stage("进 Boot")
        if not step_enter_boot():
            log("[1/4] 进 Boot 失败，终止", "err"); set_stage("失败:进Boot", False); return
        log("[1/4] 已请求进 Boot，等 9 s 让设备复位并广播…")
        time.sleep(9)

        set_stage("OTA")
        ok = step_ota(target, fw)
        if not ok:
            log("[2/4] OTA 未成功", "err"); set_stage("失败:OTA", False); return

        set_stage("验证")
        zone, pc, secs = step_verify(120)
        if zone == "APP":
            log(f"[4/4] ✅ 闭环通过：设备已回到 APP（复位后 {secs} s）", "ok"); set_stage("通过", True)
        elif zone == "BOOT":
            log("[4/4] ❌ 设备停在 Boot（升级成功但没跳 APP）", "err"); set_stage("失败:停在Boot", False)
        else:
            log(f"[4/4] ⚠ 设备状态未知：{zone}", "err"); set_stage("未知", False)
    except Exception:
        log("异常：\n" + traceback.format_exc(), "err"); set_stage("异常", False)
    finally:
        _state["running"] = False

# ---------------- HTTP ----------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/status":
            with _lock:
                return self._json({**_state,
                                   "elapsed": round(time.time() - _state["t0"], 1) if _state["t0"] else 0,
                                   "lines": len(_lines)})
        if u.path == "/api/log":
            since = int(parse_qs(u.query).get("since", ["0"])[0])
            with _lock:
                return self._json({"total": len(_lines), "lines": _lines[since:]})
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/ota":
            if _state["running"]:
                return self._json({"ok": False, "err": "已有任务在跑"}, 409)
            target = q.get("target", ["S"])[0]
            fw = q.get("file", [str(WEB / "firmware" / "S_app_latest.bin")])[0]
            with _lock:
                _lines.clear()
            _state.update(running=True, stage="启动", ok=None, t0=time.time())
            threading.Thread(target=job, args=(target, fw), daemon=True).start()
            return self._json({"ok": True, "target": target, "file": fw})
        if u.path == "/api/reset":
            with _lock:
                _lines.clear()
            return self._json({"ok": True})
        return self._json({"ok": False, "err": "unknown"}, 404)

if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", 8787), Handler)
    print("serving", WEB, "on http://127.0.0.1:8787", flush=True)
    srv.serve_forever()
