"""
Protocol module for optical QR data transmission.
Handles file compression (zlib), chunking, header packaging, and reassembly.
"""
import base64
import hashlib
import os
import zlib
from typing import List, Dict, Any, Optional

MAGIC_PREFIX = "QRF1"

class PacketProtocol:
    @staticmethod
    def prepare_file(file_path: str, chunk_size: int = 500) -> Dict[str, Any]:
        """
        Reads a file, compresses with zlib level 9, calculates SHA-256,
        and slices into chunks ready for QR transmission.
        """
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        file_name = os.path.basename(file_path)
        with open(file_path, "rb") as f:
            raw_data = f.read()

        orig_size = len(raw_data)
        orig_md5 = hashlib.md5(raw_data).hexdigest()
        orig_sha256 = hashlib.sha256(raw_data).hexdigest()
        file_id = orig_md5[:8]  # Short 8-char hex identifier

        # Compress data using zlib maximum compression
        compressed_data = zlib.compress(raw_data, level=9)
        compressed_size = len(compressed_data)

        # Slice compressed data into chunks
        total_chunks = (compressed_size + chunk_size - 1) // chunk_size
        if total_chunks == 0:
            total_chunks = 1
            chunks_raw = [b""]
        else:
            chunks_raw = [
                compressed_data[i * chunk_size : (i + 1) * chunk_size]
                for i in range(total_chunks)
            ]

        file_name_b64 = base64.b64encode(file_name.encode("utf-8")).decode("ascii")

        formatted_packets = []
        for idx, chunk in enumerate(chunks_raw):
            payload_b64 = base64.b64encode(chunk).decode("ascii")
            # Format: QRF1|<file_id>|<total_chunks>|<chunk_idx>|<orig_size>|<md5>|<file_name_b64>|<payload_b64>
            packet_str = f"{MAGIC_PREFIX}|{file_id}|{total_chunks}|{idx}|{orig_size}|{orig_md5}|{file_name_b64}|{payload_b64}"
            formatted_packets.append(packet_str)

        return {
            "file_name": file_name,
            "orig_size": orig_size,
            "compressed_size": compressed_size,
            "orig_md5": orig_md5,
            "orig_sha256": orig_sha256,
            "file_id": file_id,
            "total_chunks": total_chunks,
            "chunk_size": chunk_size,
            "packets": formatted_packets
        }

    @staticmethod
    def parse_packet(packet_str: str) -> Optional[Dict[str, Any]]:
        """Parses a QRF1 packet string."""
        if not packet_str.startswith(f"{MAGIC_PREFIX}|"):
            return None
        parts = packet_str.split("|")
        if len(parts) != 8:
            return None
        try:
            return {
                "magic": parts[0],
                "file_id": parts[1],
                "total_chunks": int(parts[2]),
                "chunk_idx": int(parts[3]),
                "orig_size": int(parts[4]),
                "md5": parts[5],
                "file_name": base64.b64decode(parts[6].encode("ascii")).decode("utf-8"),
                "payload_bytes": base64.b64decode(parts[7].encode("ascii")),
            }
        except Exception:
            return None
