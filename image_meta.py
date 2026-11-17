#!/usr/bin/env python3
r"""Locate and validate the self-describing META block inside a firmware image.

The host never needs to know a load address, a model name or where the block
lives: it scans for the META magic and accepts a hit only when the end marker
and the block CRC agree, so a random 4-byte match cannot be mistaken for one.

Usage:
    meta = scan_image(path)          # dict or None
"""
import binascii
import struct

META_MAGIC = 0x4154454D
META_END = 0x4D455441
META_FMT = 2
META_MIN_SIZE = 0x34
META_MAX_SIZE = 0x100
META_CRC_SPAN = 0x2C

_TARGETS = {0: 'W515', 1: 'N32', 2: 'GD32'}
_TYPES = {0: 'APP', 1: 'BOOT'}


def crc32(b):
    return binascii.crc32(b) & 0xFFFFFFFF


def load_image(path):
    """Return raw bytes for a .bin or .hex file."""
    p = str(path)
    if p.lower().endswith('.hex'):
        data, base = {}, 0
        with open(p, 'r', encoding='utf-8', errors='ignore') as f:
            for line in f:
                s = line.strip()
                if not s.startswith(':'):
                    continue
                n = int(s[1:3], 16)
                addr = int(s[3:7], 16)
                ty = int(s[7:9], 16)
                payload = bytes.fromhex(s[9:9 + n * 2])
                if ty == 0:
                    for i, b in enumerate(payload):
                        data[base + addr + i] = b
                elif ty == 4:
                    base = int(s[9:13], 16) << 16
                elif ty == 2:
                    base = int(s[9:13], 16) << 4
        if not data:
            raise ValueError('HEX contains no data records')
        lo, hi = min(data), max(data) + 1
        buf = bytearray([0xFF]) * (hi - lo)
        for a, b in data.items():
            buf[a - lo] = b
        return bytes(buf), lo
    with open(p, 'rb') as f:
        return f.read(), None


def _valid(buf, off):
    if off + META_MIN_SIZE > len(buf):
        return None
    size = struct.unpack_from('<H', buf, off + 0x04)[0]
    if size < META_MIN_SIZE or size > META_MAX_SIZE or off + size > len(buf):
        return None
    fmt = struct.unpack_from('<H', buf, off + 0x06)[0]
    if fmt != META_FMT:
        return None
    if struct.unpack_from('<I', buf, off + 0x30)[0] != META_END:
        return None
    if crc32(buf[off:off + META_CRC_SPAN]) != struct.unpack_from('<I', buf, off + 0x2C)[0]:
        return None
    model = buf[off + 0x08:off + 0x08 + 12].split(b'\x00')[0].decode('ascii', 'replace')
    return {
        'offset': off,
        'model': model,
        'app_crc': struct.unpack_from('<I', buf, off + 0x14)[0],
        'img_size': struct.unpack_from('<I', buf, off + 0x18)[0],
        'load_addr': struct.unpack_from('<I', buf, off + 0x1C)[0],
        'fw_version': struct.unpack_from('<H', buf, off + 0x20)[0],
        'hw_version': struct.unpack_from('<H', buf, off + 0x22)[0],
        'vector_offset': struct.unpack_from('<H', buf, off + 0x24)[0],
        'image_type': _TYPES.get(buf[off + 0x26], '?'),
        'target': _TARGETS.get(buf[off + 0x27], '?'),
        'build_time': struct.unpack_from('<I', buf, off + 0x28)[0],
        'block_crc': struct.unpack_from('<I', buf, off + 0x2C)[0],
    }


def scan_bytes(buf):
    """First structurally valid META block, or None."""
    if isinstance(buf, bytearray):
        buf = bytes(buf)
    magic = struct.pack('<I', META_MAGIC)
    start = 0
    while True:
        i = buf.find(magic, start)
        if i < 0:
            return None
        m = _valid(buf, i)
        if m is not None:
            return m
        start = i + 1


def scan_image(path):
    """(meta dict or None, image bytes, load address or None)."""
    buf, load = load_image(path)
    return scan_bytes(buf), buf, load


def describe(meta):
    if not meta:
        return 'no META block (legacy or incomplete image)'
    return '%s %s crc=0x%08X %d B load=0x%08X vt=0x%X' % (
        meta['model'], meta['image_type'], meta['app_crc'],
        meta['img_size'], meta['load_addr'], meta['vector_offset'])
