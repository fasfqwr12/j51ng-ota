"""Native owner and HTTP API tests with fake BLE; no radio access."""
import asyncio
import concurrent.futures
import json
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import ble_session
import ota_ble
import ota_ble_s
import serve


class FakeHost:
    instances = []
    def __init__(self, *args, **kwargs):
        self.client = SimpleNamespace(is_connected=False)
        self._dev = SimpleNamespace(address='FAKE-DEVICE')
        self.device_name = 'AIMTECH TEST'
        self.asm = SimpleNamespace(buf=bytearray())
        self.inbox = []
        self.raw_log = bytearray()
        self.closes = 0
        self.connections = 0
        self.__class__.instances.append(self)

    async def connect(self, timeout=6):
        if not self.client.is_connected:
            self.connections += 1
            self.client.is_connected = True

    async def close(self):
        self.closes += 1
        self.client.is_connected = False


STATUS = dict(mode='app', meta_valid=True, hcrc_ok=True, size=42120,
              payload_crc=0xF6DDC8B4, fw_version=0x0606, capacity=102400)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.host_patch = patch.object(ota_ble, 'BleHost', FakeHost)
        self.host_patch.start()
        self.query_patch = patch.object(ota_ble_s.BootS, 'query_status',
                                       AsyncMock(return_value=dict(STATUS)))
        self.query_patch.start()
        self.logs = []
        self.session = ble_session.NativeBleSession(self.logs.append)

    def tearDown(self):
        self.session.shutdown()
        self.query_patch.stop()
        self.host_patch.stop()

    def test_connect_probe_ota_reuse_one_host(self):
        state = self.session.call('connect')
        host = self.session.host
        self.assertTrue(state['connected'])
        self.assertFalse(state['busy'])
        self.assertEqual(state['status']['size'],42120)
        self.session.call('probe')
        seen=[]
        async def ota(args, host=None, keep_connected=False):
            seen.append((host, keep_connected, args.pkt, args.window, args.gap))
            await host.connect()
            return True
        with patch.object(ota_ble_s, 'run', ota):
            self.assertTrue(self.session.call('ota',target='M',firmware='unused.bin'))
        self.assertEqual(seen,[(host,True,128,8,4.0)])
        self.assertEqual(host.connections,1)
        self.assertEqual(host.closes,0)
        state=self.session.call('disconnect')
        self.assertFalse(state['connected'])

    def test_serialization_and_abort_cleanup(self):
        self.session.call('connect')
        started=threading.Event()
        async def ota(*args, **kwargs):
            started.set()
            await asyncio.Event().wait()
        with patch.object(ota_ble_s,'run',ota):
            future=self.session.start('ota',target='M',firmware='unused.bin')
            self.assertTrue(started.wait(1))
            with self.assertRaises(RuntimeError):
                self.session.start('probe')
            self.assertFalse(self.session.cancel(concurrent.futures.Future()))
            self.assertTrue(self.session.cancel(future))
            state=self.session.wait_idle()
            self.assertFalse(state['connected'])
            self.assertFalse(state['busy'])
            self.assertTrue(self.session.call('connect')['connected'])

    def test_cancel_before_first_instruction_releases_busy(self):
        self.session.call('connect')
        entered, release = threading.Event(), threading.Event()
        def hold_loop():
            entered.set()
            release.wait(1)
        self.session.loop.call_soon_threadsafe(hold_loop)
        self.assertTrue(entered.wait(1))
        try:
            future=self.session.start('probe')
            self.assertTrue(self.session.cancel(future))
        finally:
            release.set()
        state=self.session.wait_idle()
        self.assertFalse(state['busy'])
        self.assertFalse(state['connected'])
        with self.assertRaises(concurrent.futures.CancelledError):
            future.result(1)
        self.assertTrue(self.session.call('connect')['connected'])

    def test_repeated_abort_does_not_cancel_disconnect_cleanup(self):
        self.session.call('connect')
        started, closing = threading.Event(), threading.Event()
        allow_close=asyncio.Event()
        host=self.session.host
        original_close=host.close
        async def slow_close():
            closing.set()
            await allow_close.wait()
            await original_close()
        async def ota(*args,**kwargs):
            started.set()
            await asyncio.Event().wait()
        with patch.object(host,'close',slow_close),patch.object(ota_ble_s,'run',ota):
            future=self.session.start('ota',target='M',firmware='unused.bin')
            self.assertTrue(started.wait(1))
            self.assertTrue(self.session.cancel(future))
            self.assertTrue(closing.wait(1))
            self.assertTrue(self.session.cancel(future))
            self.session.loop.call_soon_threadsafe(allow_close.set)
            state=self.session.wait_idle()
            self.assertFalse(state['connected'])
            self.assertFalse(state['busy'])

    def test_silent_ota_timeout_releases_link(self):
        self.session.call('connect')
        async def ota(*args,**kwargs):
            await asyncio.Event().wait()
        task=dict(id='test',cancel=threading.Event(),future=None)
        with patch.object(serve,'_native',self.session), patch.object(serve,'OTA_TIMEOUT_S',0.05), \
             patch.object(ota_ble_s,'run',ota):
            self.assertFalse(serve.step_ota('M','unused.bin',task))
        self.assertFalse(self.session.snapshot()['connected'])
        self.assertIsNone(task['future'])

    def test_failed_ota_disconnects(self):
        self.session.call('connect')
        with patch.object(ota_ble_s,'run',AsyncMock(return_value=False)):
            self.assertFalse(self.session.call('ota',target='M',firmware='unused.bin'))
        self.assertFalse(self.session.snapshot()['connected'])

    def test_unexpected_disconnect_updates_snapshot(self):
        self.session.call('connect')
        self.session.host.client.is_connected=False
        end=time.monotonic()+1.5
        while self.session.snapshot()['connected'] and time.monotonic()<end:
            time.sleep(0.01)
        self.assertFalse(self.session.snapshot()['connected'])
        self.assertIsNone(self.session.snapshot()['status'])

    def test_http_connect_upload_admission_abort(self):
        serve._state.update(running=False,stage='-',job_id=None,t0=None,progress=None,ok=None)
        serve._link_busy=False
        server=serve.ThreadingHTTPServer(('127.0.0.1',0),serve.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start(); base='http://127.0.0.1:'+str(server.server_port)
        def call(path,body=None):
            try:
                with urlopen(Request(base+path,data=body),timeout=3) as response:
                    return response.status,json.load(response)
            except HTTPError as exc:
                return exc.code,json.load(exc)
        started=threading.Event(); seen=[]
        async def ota(args,host=None,keep_connected=False):
            seen.append((args.target,Path(args.file),Path(args.file).read_bytes(),host))
            started.set()
            await asyncio.Event().wait()
        try:
            with patch.object(serve,'_native',self.session),patch.object(ota_ble_s,'run',ota):
                code,state=call('/api/connect',b'')
                self.assertEqual(code,200);self.assertTrue(state['ble']['connected'])
                self.assertEqual(call('/api/status')[1]['transport'],'native-ble-v1')
                code,job=call('/api/ota?target=M',b'actual selected firmware')
                self.assertEqual(code,200);self.assertTrue(started.wait(1))
                self.assertEqual(call('/api/ota?target=M',b'other')[0],409)
                self.assertEqual(call('/api/probe',b'')[0],409)
                self.assertEqual(call('/api/abort?job_id=stale',b'')[0],409)
                self.assertEqual(call('/api/abort?job_id='+job['job_id'],b'')[0],200)
                end=time.monotonic()+2
                while serve._state['running'] and time.monotonic()<end:time.sleep(0.01)
                self.assertFalse(serve._state['running'])
                self.assertEqual(serve._state['stage'],'已中止')
                self.assertEqual(seen[0][2],b'actual selected firmware')
                self.assertIs(seen[0][3],self.session.host)
                self.assertFalse(seen[0][1].exists())
        finally:
            server.shutdown();server.server_close();thread.join(2)


if __name__=='__main__':
    unittest.main(verbosity=2)
