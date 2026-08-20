import struct
import sys
import unittest
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import mf885_firmware_inspect as inspector  # noqa: E402
import mf885_webi_builder as builder  # noqa: E402


def cafe_payload(path: str, data: bytes, size: int = 4096) -> bytes:
    value = bytearray(20)
    struct.pack_into("<I", value, 0, 0xCAFECAFE)
    struct.pack_into("<I", value, 8, 0x00001019)
    header = bytearray(inspector.CAFE_RECORD_HEADER_SIZE)
    struct.pack_into("<I", header, 0, 0xCAFE1000)
    struct.pack_into("<I", header, 4, 0x03000000 | len(data))
    encoded = path.encode("ascii")
    header[8 : 8 + len(encoded)] = encoded
    value.extend(header)
    value.extend(data)
    sentinel = len(value)
    value.extend(struct.pack("<I", 0xDADADADA))
    value.extend(b"\xFF" * (size - len(value)))
    struct.pack_into("<I", value, 4, zlib.adler32(value[8:sentinel]) & 0xFFFFFFFF)
    return bytes(value)


class WebiBuilderTests(unittest.TestCase):
    def test_logs_canary_is_known_but_not_restorable(self):
        artifact = inspector.KNOWN_ARTIFACTS[
            "65e5f5b507b9fcf49609a6fd1f010daa6f18111dc6a829d5655fa6bd30553517"
        ]
        self.assertEqual(artifact["id"], "mf885-community-0.0-canary-logs-r1")
        self.assertEqual(artifact["structural_status"], "verified-not-flash-qualified")
        self.assertFalse(artifact["restorable"])
        self.assertFalse(inspector.known_is_quarantined({"known_artifact": artifact}))

        old_canary = inspector.KNOWN_ARTIFACTS[
            "f2ee088574634d822d5feed8210578a62788c8837fabc80129c6ce51ddfb429c"
        ]
        self.assertTrue(inspector.known_is_quarantined({"known_artifact": old_canary}))

    def test_fixed_size_loader_uses_reviewed_pre_body_slot(self):
        stock = b"<html><body>stock" + (b" " * len(builder.INDEX_LOADER)) + b"</body></html>\xff\xff\xff"
        patched = builder.patch_index_loader(stock)
        self.assertEqual(len(patched), len(stock))
        self.assertIn(builder.INDEX_LOADER, patched)
        self.assertEqual(patched[-3:], b"\xff\xff\xff")

    def test_rebuild_preserves_record_and_appends_script_in_padding(self):
        stock_index = b"<html><body>stock" + (b" " * len(builder.INDEX_LOADER)) + b"</body></html>"
        payload = cafe_payload(builder.INDEX_PATH, stock_index)
        patched_index = builder.patch_index_loader(stock_index)
        script = b"window.marker='MF885 Community Canary Logs 0.0-logs-r1';"
        first, report = builder.rebuild_cafe(
            payload,
            {builder.INDEX_PATH: patched_index},
            {builder.SCRIPT_PATH: script},
        )
        second, _ = builder.rebuild_cafe(
            payload,
            {builder.INDEX_PATH: patched_index},
            {builder.SCRIPT_PATH: script},
        )
        parsed, records = inspector.parse_cafe(first, include_records=True)
        self.assertEqual(first, second)
        self.assertTrue(parsed["adler32_valid"])
        self.assertTrue(parsed["padding_all_ff"])
        self.assertEqual([record.path for record in records], [builder.INDEX_PATH, builder.SCRIPT_PATH])
        self.assertEqual(report["changes"][0]["size_before"], report["changes"][0]["size_after"])
        self.assertEqual(report["additions"][0]["path"], builder.SCRIPT_PATH)

    def test_builder_rejects_duplicate_or_oversized_additions(self):
        stock_index = b"<html><body>stock" + (b" " * len(builder.INDEX_LOADER)) + b"</body></html>"
        payload = cafe_payload(builder.INDEX_PATH, stock_index, size=1024)
        with self.assertRaises(builder.BuildError):
            builder.rebuild_cafe(payload, {}, {builder.INDEX_PATH: b"duplicate"})
        with self.assertRaises(builder.BuildError):
            builder.rebuild_cafe(payload, {}, {builder.SCRIPT_PATH: b"x" * 2000})


if __name__ == "__main__":
    unittest.main()
