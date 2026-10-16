"""
Protocol v2 for optical QR data transmission (fountain-style, order-independent).

Why this design:
  * Base45 payload -> QR "alphanumeric" mode (~23% denser than Base64 in byte mode).
  * Compact header; file metadata (md5/sha/name/size) lives in separate META frames
    that are repeated, so data frames stay small.
  * Systematic frames (block i) followed by repair frames (random XOR of blocks).
    Receiver solves a GF(2) linear system, so ANY k (+~2) independent frames
    are enough - a dropped frame never forces waiting for a full carousel loop.

Frame formats (all upper-case so QR stays in alphanumeric mode):
  META: Q2M:<id>:<k>:<len>:<orig>:<z>:<md5>:<sha32>:<name45>
  DATA: Q2:<id>:<k>:<idx>:<payload45>
  numbers are upper-case hex; idx < k is block idx itself, idx >= k is a repair
  frame whose block-mask is derived from mulberry32(seed(idx, k)).
"""
import hashlib
import os
import zlib
from typing import Any, Dict, List

B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"
M32 = 0xFFFFFFFF
META_EVERY = 25


def b45encode(data: bytes) -> str:
    out = []
    n = len(data)
    i = 0
    while i + 1 < n:
        v = data[i] * 256 + data[i + 1]
        c, v = v % 45, v // 45
        d, e = v % 45, v // 45
        out.append(B45[c] + B45[d] + B45[e])
        i += 2
    if i < n:
        v = data[i]
        out.append(B45[v % 45] + B45[v // 45])
    return "".join(out)


def b45decode(text: str) -> bytes:
    vals = [B45.index(ch) for ch in text]
    out = bytearray()
    i = 0
    n = len(vals)
    while i + 2 < n:
        v = vals[i] + vals[i + 1] * 45 + vals[i + 2] * 2025
        out += bytes((v >> 8, v & 255))
        i += 3
    if i + 1 < n:
        out.append(vals[i] + vals[i + 1] * 45)
    return bytes(out)


def mulberry32(seed: int):
    a = seed & M32

    def nxt() -> int:
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = ((a ^ (a >> 15)) * (1 | a)) & M32
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & M32)) & M32) ^ t
        return (t ^ (t >> 14)) & M32

    return nxt


def get_lt_degree(rng, k: int) -> int:
    """Robust Soliton degree distribution for Luby Transform."""
    if k <= 2:
        return 1
    p = rng() / 4294967296.0
    if p < 0.15:
        return 1
    elif p < 0.55:
        return 2
    elif p < 0.75:
        return 3
    elif p < 0.85:
        return 4
    elif p < 0.92:
        return 5
    elif p < 0.97:
        return min(k, max(2, int(k * 0.2)))
    else:
        return min(k, max(2, int(k * 0.5)))


def repair_mask(idx: int, k: int) -> List[int]:
    """Indices of source blocks XORed into repair frame `idx` (idx >= k) using LT codes."""
    if k <= 1:
        return [0]
    rng = mulberry32((idx * 0x9E3779B1 + k) & M32)
    deg = get_lt_degree(rng, k)
    sel = set()
    while len(sel) < deg:
        sel.add(rng() % k)
    return sorted(list(sel))


def _xor_blocks(blocks: List[bytes], sel: List[int], size: int) -> bytes:
    acc = 0
    for j in sel:
        acc ^= int.from_bytes(blocks[j], "big")
    return acc.to_bytes(size, "big")


def make_droplet_packet(file_id: str, blocks: List[bytes], k: int, size: int, idx: int) -> str:
    """Generates an arbitrary droplet packet (systematic for idx < k, LT repair for idx >= k)."""
    if idx < k:
        payload = blocks[idx]
    else:
        payload = _xor_blocks(blocks, repair_mask(idx, k), size)
    return f"Q2:{file_id}:{k:X}:{idx:X}:{b45encode(payload)}"


class PacketProtocol:
    @staticmethod
    def prepare_file(file_path: str, chunk_size: int = 800) -> Dict[str, Any]:
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        file_name = os.path.basename(file_path)
        with open(file_path, "rb") as f:
            raw = f.read()

        orig_size = len(raw)
        orig_md5 = hashlib.md5(raw).hexdigest().upper()
        orig_sha256 = hashlib.sha256(raw).hexdigest().upper()
        file_id = orig_md5[:8]

        # Deflate-raw (RFC 1951 without zlib header) for native DecompressionStream compatibility
        compressor = zlib.compressobj(level=9, method=zlib.DEFLATED, wbits=-15)
        comp = compressor.compress(raw) + compressor.flush()
        if len(comp) < len(raw) * 0.98:
            payload, z = comp, 1
        else:
            payload, z = raw, 0
        payload_len = len(payload)

        size = max(64, int(chunk_size))
        k = max(1, (payload_len + size - 1) // size)
        pad_len = k * size - payload_len
        pad_bytes = bytes((i * 37 + 13) % 255 + 1 for i in range(pad_len))
        padded = payload + pad_bytes
        blocks = [padded[i * size:(i + 1) * size] for i in range(k)]

        repair = max(40, k)
        data_frames: List[str] = []
        for idx in range(k + repair):
            data_frames.append(make_droplet_packet(file_id, blocks, k, size, idx))

        meta = (
            f"Q2M:{file_id}:{k:X}:{payload_len:X}:{orig_size:X}:{z}:"
            f"{orig_md5}:{orig_sha256[:32]}:{b45encode(file_name.encode('utf-8'))}"
        )

        packets: List[str] = []
        for i, fr in enumerate(data_frames):
            if i % META_EVERY == 0:
                packets.append(meta)
            packets.append(fr)

        return {
            "file_name": file_name,
            "orig_size": orig_size,
            "compressed_size": payload_len,
            "compressed": bool(z),
            "orig_md5": orig_md5,
            "orig_sha256": orig_sha256,
            "file_id": file_id,
            "total_chunks": k,
            "chunk_size": size,
            "packets": packets,
            "blocks": blocks,
            "meta_packet": meta,
        }


class FountainDecoder:
    """Reference decoder (mirrors the JS one); used for self-tests."""

    def __init__(self, k: int):
        self.k = k
        self.pivots: Dict[int, List[Any]] = {}

    def add(self, idx: int, block: bytes) -> bool:
        k = self.k
        mask = 1 << idx if idx < k else sum(1 << j for j in repair_mask(idx, k))
        val = int.from_bytes(block, "big")
        while mask:
            low = (mask & -mask).bit_length() - 1
            p = self.pivots.get(low)
            if p is None:
                self.pivots[low] = [mask, val]
                return True
            mask ^= p[0]
            val ^= p[1]
        return False

    def complete(self) -> bool:
        return len(self.pivots) == self.k

    def solve(self, size: int) -> bytes:
        sol: Dict[int, int] = {}
        for c in range(self.k - 1, -1, -1):
            mask, val = self.pivots[c]
            m = mask >> (c + 1)
            d = c + 1
            while m:
                if m & 1:
                    val ^= sol[d]
                m >>= 1
                d += 1
            sol[c] = val
        return b"".join(sol[c].to_bytes(size, "big") for c in range(self.k))
