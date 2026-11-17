"""One native BLE owner for the local page. Imports do not scan or connect."""
import asyncio
import concurrent.futures
from pathlib import Path
import sys
import threading
from types import SimpleNamespace

ART = Path(__file__).resolve().parent.parent / "ota_tool" / "artifacts"
if str(ART) not in sys.path:
    sys.path.insert(0, str(ART))


class NativeBleSession:
    def __init__(self, log):
        self.log = log
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True,
                                       name="j51ng-native-ble")
        self.host = None
        self._active = None
        self._guard = threading.Lock()
        self._snapshot = {"connected": False, "name": "", "address": "",
                          "status": None, "busy": False, "operation": None}
        self.thread.start()
        self._monitor_future = asyncio.run_coroutine_threadsafe(self._monitor(), self.loop)

    async def _monitor(self):
        while True:
            await asyncio.sleep(0.5)
            if not self.snapshot()["busy"]:
                self._publish()
                if self.host is not None:
                    # Unsolicited beacons must not grow idle queues indefinitely.
                    self.host.inbox.clear()
                    if len(self.host.raw_log) > 4096:
                        del self.host.raw_log[:-4096]

    def snapshot(self):
        with self._guard:
            return dict(self._snapshot)

    def _publish(self, status=None, clear_status=False):
        host = self.host
        connected = bool(host and host.client and host.client.is_connected)
        address = getattr(getattr(host, "_dev", None), "address", "")
        with self._guard:
            self._snapshot.update(connected=connected,
                                  name=getattr(host, "device_name", ""), address=address)
            if clear_status or not connected:
                self._snapshot["status"] = None
            elif status is not None:
                self._snapshot["status"] = status
        return self.snapshot()

    def _host(self):
        if self.host is None:
            import ota_ble
            import ota_ble_s
            # Use the same connection, CRC parser and OTA code as the proven CLI.
            ota_ble.log = self.log
            ota_ble_s.log = self.log
            self.host = ota_ble.BleHost(ota_ble_s.NAME_PREFIX, None, None, None, chunk=241)
            self.host.asm = ota_ble_s.CrcFrameAssembler()
        return self.host

    async def _query(self):
        import ota_ble_s
        host = self._host()
        if not host.client or not host.client.is_connected:
            raise ConnectionError("蓝牙未连接，请先连接设备")
        host.inbox.clear()
        status = await ota_ble_s.BootS(host).query_status(timeout=1.5, retry=1)
        if status is None:
            raise TimeoutError("设备只读状态无应答；未发送升级握手")
        return self._publish(status)

    async def _execute(self, operation, *, target=None, firmware=None):
        host = self._host()
        if operation == "disconnect":
            await host.close()
            return self._publish(clear_status=True)
        if operation == "connect":
            await host.connect(timeout=6.0)
            # Old firmware may lack status; a subscribed GATT link is still connected.
            try:
                return await self._query()
            except TimeoutError as exc:
                self.log(str(exc))
                return self._publish(clear_status=True)
        if operation == "probe":
            try:
                return await self._query()
            except TimeoutError as exc:
                # A read-only status miss must not discard an otherwise-live GATT owner.
                self.log(str(exc))
                return self._publish(clear_status=True)
        if operation == "fault":
            import ota_ble_s
            if not host.client or not host.client.is_connected:
                raise ConnectionError("蓝牙未连接，请先连接设备")
            payload = await ota_ble_s.BootS(host).request(0x0614, b"", 0x0615, 2.0)
            if payload is None or len(payload) < 16:
                raise TimeoutError("故障快照无应答（设备可能未运行带快照的固件）")
            return {"last_fail": payload[0], "phase": payload[1], "target": payload[2],
                    "m_state": payload[3], "uart_err": payload[4], "m_fwd": payload[5],
                    "seq": (payload[6] << 8) | payload[7],
                    "m_ack": (payload[8] << 24) | (payload[9] << 16) | (payload[10] << 8) | payload[11],
                    "tx_queued": payload[12], "tx_sent": payload[13],
                    "tx_cfm_err": payload[14], "tx_drop": payload[15]}
        if operation == "ota":
            import ota_ble_s
            host.inbox.clear()
            host.asm.buf.clear()
            args = SimpleNamespace(dry_run=False, probe=False, done_only=False,
                target=target, file=str(firmware), go=True, svc=None, wr=None, nf=None,
                chunk=241, pkt=128, window=8, gap=4.0, scan_timeout=6.0,
                hs_timeout=5.0, pm_timeout=10.0, ack_timeout=8.0,
                sha_timeout=90.0, done_timeout=3.0)
            ok = await ota_ble_s.run(args, host=host, keep_connected=True)
            if not ok:
                await host.close()
            self._publish(clear_status=True)
            return ok
        raise ValueError("不支持的蓝牙操作")

    def start(self, operation, **kwargs):
        started = threading.Event()
        cancelled = threading.Event()
        async def execute():
            try:
                started.set()
                if cancelled.is_set():
                    raise asyncio.CancelledError()
                return await self._execute(operation, **kwargs)
            except BaseException:
                if self.host is not None:
                    await self.host.close()
                self._publish(clear_status=True)
                raise
            finally:
                with self._guard:
                    self._snapshot.update(busy=False, operation=None)
        with self._guard:
            if self._snapshot["busy"]:
                raise RuntimeError("蓝牙正在处理其它操作")
            self._snapshot.update(busy=True, operation=operation)
            future = asyncio.run_coroutine_threadsafe(execute(), self.loop)
            self._active = future
            self._started = started
            self._cancelled = cancelled
        return future

    def cancel(self, future):
        with self._guard:
            if future is not self._active or not self._snapshot["busy"]:
                return False
            if self._cancelled.is_set():
                return True  # Never cancel the cleanup a second time.
            self._cancelled.set()
            started = self._started.is_set()
        # A task cancelled before its first instruction skips its finally block.
        # In that case execute() observes the flag and releases the link itself.
        if started:
            future.cancel()
        return True

    def wait_idle(self, timeout=10):
        async def drain():
            while self.snapshot()["busy"]:
                await asyncio.sleep(0.01)
            return self.snapshot()
        return asyncio.run_coroutine_threadsafe(drain(), self.loop).result(timeout)

    def call(self, operation, timeout=40, **kwargs):
        future = self.start(operation, **kwargs)
        try:
            result = future.result(timeout)
            # Link operations answer with the session snapshot; queries keep their own payload.
            if operation in ("connect", "probe", "disconnect"):
                return self.snapshot()
            return result
        except concurrent.futures.TimeoutError:
            if future.done():
                raise
            self.cancel(future)
            self.wait_idle()
            raise TimeoutError("蓝牙操作超时，连接已释放")

    def shutdown(self):
        with self._guard:
            active = self._active
        if active and not active.done():
            self.cancel(active)
        if self.snapshot()["busy"]:
            self.wait_idle()
        self._monitor_future.cancel()
        if self.host is not None:
            asyncio.run_coroutine_threadsafe(self.host.close(), self.loop).result(10)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(3)
        self.loop.close()
