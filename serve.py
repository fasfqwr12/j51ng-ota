# -*- coding: utf-8 -*-
"""
J51NG OTA 上位机 —— 带 API 的静态服务器（替换 python -m http.server 8787）

页面完全不变，额外提供：
  GET  /api/status            当前任务状态
  GET  /api/log?since=N       增量日志
  POST /api/ota?target=S&file=...   启动一轮完整闭环
  POST /api/connect|probe|disconnect  连接、只读查询、断开（不会发送升级握手）
  POST /api/abort?job_id=...    取消当前升级并释放连接
  POST /api/reset             清空日志

闭环流程（普通任务全程只走 BLE，不碰 SWD）：
  1. ota_ble_s.py 只用只读查询（0x0610）判断设备在 APP 还是 Boot
  2. 目标 S 且设备在 APP：一次握手交班 -> 等复位 -> 重连确认 Boot -> 参数/数据/校验/完成
  3. 目标 M/R：留在 S APP 透传，蓝牙板不复位
  4. 结果判定只认设备自己的应答：S 复位后再只读比对运行镜像 size/payload_crc

调试用的 step_verify() 仍保留（pyocd 读 pc），但普通 /api/ota 不再调用它。
"""
import concurrent.futures
import json, os, queue, re, subprocess, sys, tempfile, threading, time, traceback, uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

WEB   = Path(r"E:\tof\xuRxuG\04_host\ota_web")
ART   = Path(r"E:\tof\xuRxuG\04_host\ota_tool\artifacts")
TOOLS = Path(r"E:\tof\xuRxuG\03_firmware\m_app\tools")
PACK  = r"E:\tof\xuRxuG\05_scripts\tools\pyocd-packs\Nationstech.N32WB03x_DFP.1.0.0.pack"

sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(ART))
sys.path.insert(0, str(WEB))

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
_state = {"running": False, "stage": "-", "ok": None, "t0": None,
          "job_id": None, "progress": None}
_task = None
OTA_TIMEOUT_S = 300
UPLOAD_MAX = 0x40000
_native = None
_native_lock = threading.Lock()
_link_busy = False


def native_session():
    global _native
    with _native_lock:
        if _native is None:
            from ble_session import NativeBleSession
            _native = NativeBleSession(native_log)
        return _native


def native_snapshot():
    return _native.snapshot() if _native is not None else {
        "connected": False, "name": "", "address": "", "status": None,
        "busy": False, "operation": None}


def native_log(line):
    log(line)
    m = re.search(r"(\d+)/(\d+)\s+(\d+) B\s+([\d.]+) s\s+([\d.]+) B/s.*?重传 (\d+)", line)
    if m:
        done, total, size, elapsed, speed, retry = m.groups()
        with _lock:
            _state["progress"] = dict(done=int(done), total=int(total), size=int(size),
                elapsed=float(elapsed), speed=float(speed), retry=int(retry))


def resolve_firmware(value):
    p = Path(value)
    if not p.is_absolute():
        p = WEB / p
    p = p.resolve()
    p.relative_to((WEB / "firmware").resolve())
    if not p.is_file() or p.suffix.lower() not in (".bin", ".hex"):
        raise ValueError("固件不存在或格式不支持")
    return p


def request_abort(job_id=None):
    with _lock:
        task = _task
        if not _state["running"] or task is None:
            return False
        if job_id and job_id != task["id"]:
            raise ValueError("任务已切换，请刷新状态")
        task["cancel"].set()
        _state["stage"] = "正在中止"
        future = task.get("future")
    if future is not None:
        native_session().cancel(future)
    return True

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

def step_ota(target, fw, task):
    session = native_session()
    future = session.start("ota", target=target, firmware=fw)
    with _lock:
        task["future"] = future
    deadline = time.monotonic() + OTA_TIMEOUT_S
    try:
        while True:
            if task["cancel"].is_set():
                session.cancel(future)
                return False
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                session.cancel(future)
                log(f"OTA 超时 {OTA_TIMEOUT_S} s，正在释放连接", "err")
                return False
            try:
                return bool(future.result(timeout=min(0.2, remaining)))
            except concurrent.futures.TimeoutError:
                if future.done():
                    raise  # The operation itself timed out, rather than this wait.
            except concurrent.futures.CancelledError:
                return False
    finally:
        session.wait_idle(timeout=12)
        with _lock:
            task["future"] = None

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

def job(target, fw, task, temporary=False):
    try:
        set_stage("OTA")
        log(f"目标 {target} · pkt=128 / window=8 / gap=4 ms")
        ok = step_ota(target, fw, task)
        if task["cancel"].is_set():
            set_stage("已中止", False)
        elif ok:
            log("客户端已确认升级结果", "ok")
            set_stage("通过", True)
        else:
            set_stage("失败:OTA", False)
    except Exception:
        if task["cancel"].is_set():
            set_stage("已中止", False)
        else:
            log("异常：\n" + traceback.format_exc(), "err")
            set_stage("异常", False)
    finally:
        if temporary:
            Path(fw).unlink(missing_ok=True)
        with _lock:
            _state["finished"] = time.time()
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
            ble = native_snapshot()
            with _lock:
                return self._json({**_state, "transport": "native-ble-v1", "ble": ble,
                                   "elapsed": round((_state.get("finished") or time.time()) - _state["t0"], 1) if _state["t0"] else 0,
                                   "lines": len(_lines)})
        if u.path == "/api/log":
            since = int(parse_qs(u.query).get("since", ["0"])[0])
            with _lock:
                return self._json({"total": len(_lines), "lines": _lines[since:]})
        return super().do_GET()

    def do_POST(self):
        global _task, _link_busy
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/api/connect", "/api/disconnect", "/api/probe"):
            with _lock:
                if _state["running"] or _link_busy:
                    return self._json({"ok": False, "err": "蓝牙正在处理其它操作"}, 409)
                _link_busy = True
            try:
                operation = u.path.rsplit("/", 1)[1]
                ble = native_session().call(operation, timeout=40)
                return self._json({"ok": True, "ble": ble})
            except Exception as exc:
                log(str(exc), "err")
                return self._json({"ok": False, "err": str(exc),
                                   "ble": native_snapshot()}, 503)
            finally:
                with _lock:
                    _link_busy = False
        if u.path == "/api/ota":
            temporary = False
            fw = None
            try:
                target = q.get("target", ["S"])[0]
                if target not in ("M", "S"):
                    raise ValueError("仅支持 M、S 目标")
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > UPLOAD_MAX:
                    raise ValueError("固件大小超限")
                if length:
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise ValueError("固件上传不完整")
                    # The page uploads its parsed bytes; never reuse an older library pick.
                    with tempfile.NamedTemporaryFile(suffix=".bin", prefix="j51ng_ota_", delete=False) as out:
                        out.write(raw)
                        fw = Path(out.name)
                    temporary = True
                else:
                    fw = resolve_firmware(q.get("file", ["firmware/S_app_latest.bin"])[0])
                with _lock:
                    if _state["running"] or _link_busy:
                        if temporary:
                            fw.unlink(missing_ok=True)
                        return self._json({"ok": False, "err": "已有任务在跑"}, 409)
                    task = {"id": uuid.uuid4().hex, "cancel": threading.Event(), "future": None}
                    _task = task
                    _lines.clear()
                    _state.update(running=True, stage="启动", ok=None, t0=time.time(),
                                  finished=None, job_id=task["id"], target=target, progress=None)
                threading.Thread(target=job, args=(target, fw, task, temporary), daemon=True).start()
                return self._json({"ok": True, "job_id": task["id"], "target": target})
            except (ValueError, OSError) as exc:
                if temporary and fw:
                    fw.unlink(missing_ok=True)
                return self._json({"ok": False, "err": str(exc)}, 400)
        if u.path == "/api/abort":
            try:
                requested = request_abort(q.get("job_id", [None])[0])
                return self._json({"ok": True, "requested": requested})
            except ValueError as exc:
                return self._json({"ok": False, "err": str(exc)}, 409)
        if u.path == "/api/reset":
            with _lock:
                if _state["running"]:
                    return self._json({"ok": False, "err": "升级中不能清空任务日志"}, 409)
                _lines.clear()
            return self._json({"ok": True})
        return self._json({"ok": False, "err": "unknown"}, 404)

if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", 8787), Handler)
    print("serving", WEB, "on http://127.0.0.1:8787", flush=True)
    srv.serve_forever()
