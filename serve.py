# -*- coding: utf-8 -*-
"""
J51NG OTA 上位机 —— 带 API 的静态服务器（替换 python -m http.server 8787）

页面完全不变，额外提供：
  GET  /api/status            当前任务状态
  GET  /api/log?since=N       增量日志
  POST /api/ota?target=S&file=...   启动一轮完整闭环
  POST /api/reset             清空日志

闭环流程（普通任务全程只走 BLE，不碰 SWD）：
  1. ota_ble_s.py 只用只读查询（0x0610）判断设备在 APP 还是 Boot
  2. 目标 S 且设备在 APP：一次握手交班 -> 等复位 -> 重连确认 Boot -> 参数/数据/校验/完成
  3. 目标 M/R：留在 S APP 透传，蓝牙板不复位
  4. 结果判定只认设备自己的应答：S 复位后再只读比对运行镜像 size/payload_crc

调试用的 step_verify() 仍保留（pyocd 读 pc），但普通 /api/ota 不再调用它。
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

# Windows 控制台默认 GBK，日志里的 ✅/⚠ 等字符会让 print 抛 UnicodeEncodeError，
# 进而把已经成功的任务判成"异常"。改成不可编码字符替换，日志永不打断流程。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:
        pass

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

def wait_advertising(max_s=25):
    """每秒扫 1 s，直到看到 AIMTECH 广播或超时。"""
    import asyncio
    from bleak import BleakScanner

    async def go():
        for i in range(1, max_s + 1):
            await asyncio.sleep(1.0)
            try:
                devs = await BleakScanner.discover(timeout=1.0, return_adv=True)
                hit = [a for a, (d, adv) in devs.items()
                       if (d.name or adv.local_name or "").upper().startswith("AIMTECH")]
                if hit:
                    log(f"[1/4] 第 {i} s 看到广播（{hit[0]}）")
                    return True
                if i % 5 == 0:
                    log(f"[1/4] 第 {i} s 未见广播，继续等…")
            except Exception:
                pass
        log("[1/4] 25 s 内没等到广播，仍尝试继续", "err")
        return False
    return asyncio.run(go())

def step_enter_boot(target="S"):
    """新版固件没有 53 A2 进 Boot 约定：旧协议帧只回成功、不动作。

    而且对目标 S，APP 收到 0x0101 握手本身就会交班复位，
    **任何"先探一下模式"的握手都是破坏性的**，所以这里什么都不做：
    设备在 APP → ota_ble_s.py 握手后自动交班（等断链 → 重连 → 确认
    ff.ff.ff.ff → 从 0x0201 继续）；设备在 Boot → 直接进参数阶段。
    """
    log("[1/4] 直连升级（交班/重连由 ota_ble_s.py 处理，不发 53 A2、不预探测）")
    return True

def step_ota(target, fw):
    env = dict(os.environ, PYTHONPATH=str(TOOLS), PYTHONUNBUFFERED="1")
    p = subprocess.Popen(
        [sys.executable, "ota_ble_s.py", "--target", target, "--file", str(fw),
         "--pkt", "128", "--window", "8", "--gap", "4", "--go"],
        cwd=str(ART), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    t0 = time.time()
    for raw in p.stdout:
        try:
            line = raw.decode("utf-8").rstrip()      # ota_ble_s.py 输出 UTF-8
        except UnicodeDecodeError:
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
    """【手动调试用，普通 /api/ota 不再调用】复位后轮询 SWD 看 pc 落点。"""
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
    """普通升级任务：全程只走 BLE。

    这里刻意不做任何 SWD 动作（halt / 写 RAM / 复位 / 读 PC）：
    那些是调试手段，不是产品流程；而且会与占用链路、掩盖真实结果。
    结果判定只认客户端按目标给出的证据（S：复位后只读确认运行镜像）。
    """
    _state["t0"] = time.time()
    try:
        set_stage("OTA")
        log("[1/3] 交给客户端：交班/重连/结果确认都由 ota_ble_s.py 负责"
            "（本进程不碰 SWD、不复位、不写 RAM）")

        ok = step_ota(target, fw)
        if not ok:
            log("[2/3] OTA 未成功（失败原因见客户端日志）", "err")
            set_stage("失败:OTA", False)
            return

        set_stage("完成")
        log("[3/3] ✅ 客户端已判定成功（S：复位后已只读确认运行镜像）", "ok")
        set_stage("通过", True)
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
            _p = Path(fw)
            if not _p.is_absolute():          # 允许页面直接传 firmware/xxx.hex
                _p = (WEB / fw).resolve()
            fw = str(_p)
            with _lock:
                _lines.clear()
            _state.update(running=True, stage="启动", ok=None, t0=time.time())
            threading.Thread(target=job, args=(target, fw), daemon=True).start()
            return self._json({"ok": True, "target": target, "file": fw})
        if u.path == "/api/abort":
            # 释放 BLE：杀掉可能还挂着的 ota_ble_s 子进程
            import subprocess as _sp
            killed = 0
            try:
                out = _sp.run(["wmic","process","where",
                               "name='python.exe' and commandline like '%ota_ble_s%'",
                               "get","processid"], capture_output=True, text=True)
                for tok in out.stdout.split():
                    if tok.isdigit():
                        _sp.run(["taskkill","/F","/PID",tok], capture_output=True); killed += 1
            except Exception:
                pass
            _state["running"] = False
            log(f"[abort] 已中止任务并释放 BLE（结束 {killed} 个进程）", "err")
            return self._json({"ok": True, "killed": killed})
        if u.path == "/api/reset":
            with _lock:
                _lines.clear()
            return self._json({"ok": True})
        return self._json({"ok": False, "err": "unknown"}, 404)

if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", 8787), Handler)
    print("serving", WEB, "on http://127.0.0.1:8787", flush=True)
    srv.serve_forever()
