#!/usr/bin/env python3
"""Build a deterministic WEBI-only MF885 canary from the exact golden image.

The tool never contacts a router. It patches one fixed-size CAFE record, appends
one record inside existing padding, recalculates the
CAFE Adler-32 and both ZIMI additive byte sums, re-encrypts the device-bound
header, and requires the independent inspector to verify the result before the
output is published. The output remains structural-only and is not flash
qualified or added to the Stage 0 restore allowlist.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mf885_firmware_inspect as inspector


GOLDEN_SHA256 = "2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531"
EXPECTED_SIZE = 8_323_644
INDEX_PATH = "www\\index.html"
SCRIPT_PATH = "www\\js\\canary_logs.js"
INDEX_LOADER = b'<script src="js/canary_logs.js"></script>'
CANARY_MARKER = b"MF885 Community Canary Logs 0.0-logs-r1"


class BuildError(Exception):
    pass


@dataclass(frozen=True)
class CafeSourceRecord:
    path: str
    header: bytes
    data: bytes


def require_exact_golden(path: Path) -> bytes:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise BuildError("could not read the golden image") from exc
    if len(data) != EXPECTED_SIZE or inspector.sha256(data) != GOLDEN_SHA256:
        raise BuildError(
            f"golden must be the exact {EXPECTED_SIZE}-byte image with SHA-256 {GOLDEN_SHA256}"
        )
    return data


def parse_cafe_source(payload: bytes) -> tuple[bytes, list[CafeSourceRecord], int]:
    report, _ = inspector.parse_cafe(payload, include_records=False)
    if not report["adler32_valid"] or report["duplicate_paths"]:
        raise BuildError("source WEBI CAFE archive is not internally valid")
    position = inspector.CAFE_HEADER_SIZE
    records: list[CafeSourceRecord] = []
    while inspector.u32(payload, position) != 0xDADADADA:
        header = payload[position : position + inspector.CAFE_RECORD_HEADER_SIZE]
        size = inspector.u32(header, 4) & 0x00FFFFFF
        path = header[8:].split(b"\0", 1)[0].decode("ascii")
        start = position + inspector.CAFE_RECORD_HEADER_SIZE
        records.append(CafeSourceRecord(path, header, payload[start : start + size]))
        position = start + size
    return payload[: inspector.CAFE_HEADER_SIZE], records, position


def patch_index_loader(stock: bytes) -> bytes:
    if INDEX_LOADER in stock or CANARY_MARKER in stock:
        raise BuildError("golden index already contains Canary material")
    logical_end = len(stock)
    while logical_end and stock[logical_end - 1] == 0xFF:
        logical_end -= 1
    html = stock[:logical_end]
    match = re.search(br"(\s+)</body>", html, re.IGNORECASE)
    if not match or len(match.group(1)) != len(INDEX_LOADER):
        raise BuildError("stock index no longer has the reviewed 41-byte pre-body whitespace slot")
    patched = html[: match.start(1)] + INDEX_LOADER + html[match.end(1) :]
    if len(patched) != len(html):
        raise BuildError("index loader patch changed the record size")
    return patched + stock[logical_end:]


def rebuild_cafe(
    payload: bytes,
    replacements: dict[str, bytes],
    additions: dict[str, bytes] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    cafe_header, records, old_sentinel = parse_cafe_source(payload)
    paths = {record.path for record in records}
    additions = additions or {}
    missing = sorted(set(replacements) - paths)
    if missing:
        raise BuildError("replacement paths are absent from WEBI: " + ", ".join(missing))
    duplicate_additions = sorted(set(additions) & paths)
    if duplicate_additions:
        raise BuildError("added paths already exist in WEBI: " + ", ".join(duplicate_additions))
    rebuilt = bytearray(cafe_header)
    changes = []
    for record in records:
        data = replacements.get(record.path, record.data)
        if len(data) > 0x00FFFFFF:
            raise BuildError(f"replacement for {record.path} exceeds the CAFE size field")
        header = bytearray(record.header)
        old_flags = inspector.u32(header, 4)
        struct.pack_into("<I", header, 4, (old_flags & 0xFF000000) | len(data))
        rebuilt.extend(header)
        rebuilt.extend(data)
        if data != record.data:
            changes.append(
                {
                    "path": record.path,
                    "size_before": len(record.data),
                    "size_after": len(data),
                    "sha256_before": inspector.sha256(record.data),
                    "sha256_after": inspector.sha256(data),
                }
            )
    added = []
    for path in sorted(additions):
        data = additions[path]
        encoded_path = path.encode("ascii")
        if not encoded_path or len(encoded_path) >= 128 or len(data) > 0x00FFFFFF:
            raise BuildError(f"invalid added CAFE record {path}")
        header = bytearray(inspector.CAFE_RECORD_HEADER_SIZE)
        struct.pack_into("<I", header, 0, 0xCAFE1000)
        struct.pack_into("<I", header, 4, 0x03000000 | len(data))
        header[8 : 8 + len(encoded_path)] = encoded_path
        rebuilt.extend(header)
        rebuilt.extend(data)
        added.append({"path": path, "size": len(data), "sha256": inspector.sha256(data)})
    sentinel = len(rebuilt)
    rebuilt.extend(struct.pack("<I", 0xDADADADA))
    if len(rebuilt) > len(payload):
        raise BuildError(
            f"rebuilt WEBI exceeds its fixed slot by {len(rebuilt) - len(payload)} bytes"
        )
    rebuilt.extend(b"\xFF" * (len(payload) - len(rebuilt)))
    adler = zlib.adler32(rebuilt[8:sentinel]) & 0xFFFFFFFF
    struct.pack_into("<I", rebuilt, 4, adler)
    report, _ = inspector.parse_cafe(bytes(rebuilt), include_records=False)
    if not report["adler32_valid"]:
        raise BuildError("rebuilt WEBI Adler-32 verification failed")
    return bytes(rebuilt), {
        "changes": changes,
        "additions": added,
        "sentinel_before": f"0x{old_sentinel:x}",
        "sentinel_after": f"0x{sentinel:x}",
        "padding_before": len(payload) - old_sentinel - 4,
        "padding_after": len(payload) - sentinel - 4,
        "adler32": inspector.hex32(adler),
    }


def encrypt_header(header: bytes, key: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError as exc:
        raise BuildError("header rebuilding needs the Python cryptography package") from exc
    encryptor = Cipher(algorithms.AES(key), modes.CBC(bytes(16))).encryptor()
    return encryptor.update(header[: inspector.ENCRYPTED_HEADER_SIZE]) + encryptor.finalize()


def build_image(
    golden_raw: bytes,
    identity: inspector.IdentityMaterial,
    script: bytes,
) -> tuple[bytes, dict[str, Any]]:
    if not script.strip() or CANARY_MARKER not in script:
        raise BuildError("Canary script does not contain the exact marker")
    if b"</script>" in script.lower():
        raise BuildError("standalone Canary script unexpectedly contains an HTML script terminator")
    header = bytearray(inspector.decrypt_header(golden_raw, identity))
    partitions, layout_errors = inspector.parse_partitions(header, len(golden_raw))
    if layout_errors:
        raise BuildError("golden partition layout is not the expected contiguous layout")
    try:
        webi_index, webi = next(
            (index, part) for index, part in enumerate(partitions) if part.name == "WEBI"
        )
    except StopIteration as exc:
        raise BuildError("golden image has no WEBI partition") from exc
    webi_payload = golden_raw[webi.offset : webi.offset + webi.length]
    _, records, _ = parse_cafe_source(webi_payload)
    stock_index = next((record.data for record in records if record.path == INDEX_PATH), None)
    if stock_index is None:
        raise BuildError("golden WEBI has no www/index.html record")
    canary_index = patch_index_loader(stock_index)
    rebuilt_webi, cafe_report = rebuild_cafe(
        webi_payload,
        {INDEX_PATH: canary_index},
        {SCRIPT_PATH: script},
    )
    candidate = bytearray(golden_raw)
    candidate[webi.offset : webi.offset + webi.length] = rebuilt_webi

    descriptor = inspector.DESCRIPTOR_OFFSET + webi_index * inspector.DESCRIPTOR_SIZE
    webi_sum = inspector.byte_sum(rebuilt_webi)
    struct.pack_into("<I", header, descriptor + 0x10, webi_sum)
    plaintext_image = bytes(header) + bytes(candidate[inspector.HEADER_SIZE :])
    global_sum = inspector.byte_sum(plaintext_image[0x20:])
    struct.pack_into("<I", header, 0x1C, global_sum)
    encrypted_prefix = encrypt_header(bytes(header), identity.key)
    candidate[: inspector.HEADER_SIZE] = (
        encrypted_prefix + bytes(header[inspector.ENCRYPTED_HEADER_SIZE : inspector.HEADER_SIZE])
    )
    if len(candidate) != EXPECTED_SIZE:
        raise BuildError("candidate image size changed")
    return bytes(candidate), {
        "cafe": cafe_report,
        "index": {
            "path": INDEX_PATH,
            "size_before": len(stock_index),
            "size_after": len(canary_index),
            "sha256_before": inspector.sha256(stock_index),
            "sha256_after": inspector.sha256(canary_index),
        },
        "script": {
            "path": SCRIPT_PATH,
            "size": len(script),
            "sha256": inspector.sha256(script),
        },
        "checksums": {
            "webi_byte_sum": inspector.hex32(webi_sum),
            "global_byte_sum": inspector.hex32(global_sum),
        },
    }


def write_exclusive(path: Path, data: bytes) -> None:
    temporary = path.with_name(path.name + ".tmp")
    if path.exists() or temporary.exists():
        raise BuildError(f"refusing to overwrite {path.name}")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
        temporary.unlink()
    except OSError as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise BuildError(f"could not write {path.name} atomically") from exc


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="Build a structural-only MF885 WEBI log Canary")
    value.add_argument("--golden", type=Path, required=True)
    value.add_argument("--identity-xml", type=Path, required=True)
    value.add_argument("--script", type=Path, required=True)
    value.add_argument("--output", type=Path, required=True)
    value.add_argument("--report", type=Path, required=True)
    value.add_argument("--confirm-structural-only", action="store_true")
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    temporary = args.output.with_name(args.output.name + ".verify.tmp")
    try:
        if not args.confirm_structural_only:
            raise BuildError("--confirm-structural-only is required; this does not qualify a flash")
        if not args.output.parent.is_dir() or not args.report.parent.is_dir():
            raise BuildError("output and report directories must already exist")
        if args.output.exists() or args.report.exists() or temporary.exists():
            raise BuildError("output, report, or verification temporary already exists")
        golden_raw = require_exact_golden(args.golden)
        identity = inspector.load_identity(args.identity_xml)
        script = args.script.read_bytes()
        golden = inspector.inspect_image(args.golden, identity, include_records=True)
        if golden.report["verification"]["status"] != "verified":
            raise BuildError("golden did not pass the full independent inspector")
        candidate, build_report = build_image(golden_raw, identity, script)
        with temporary.open("xb") as stream:
            stream.write(candidate)
            stream.flush()
            os.fsync(stream.fileno())
        parsed = inspector.inspect_image(temporary, identity, include_records=True)
        comparison = inspector.compare_images(golden, parsed)
        if parsed.report["verification"]["status"] != "verified":
            raise BuildError("candidate failed the full independent inspector")
        partition_diffs = {item["name"]: item.get("diff_bytes") for item in comparison["partitions"]}
        if any(value for name, value in partition_diffs.items() if name != "WEBI"):
            raise BuildError("a non-WEBI partition changed")
        cafe = comparison["cafe"].get("WEBI", {})
        changed = [item.get("path") for item in cafe.get("changed_records", [])]
        if changed != [INDEX_PATH] or cafe.get("added_paths") != [SCRIPT_PATH] or cafe.get("removed_paths"):
            raise BuildError("logical delta is not exactly the fixed-size index loader plus canary_logs.js")
        report = {
            "schema": "mf885-webi-canary-build/v1",
            "id": "0.0-logs-r1",
            "marker": CANARY_MARKER.decode("ascii"),
            "source": {"size": len(golden_raw), "sha256": GOLDEN_SHA256},
            "artifact": {
                "file": args.output.name,
                "size": len(candidate),
                "sha256": inspector.sha256(candidate),
            },
            "identity_fingerprint_sha256": identity.fingerprint,
            "script_sha256": inspector.sha256(script),
            "build": build_report,
            "verification": {
                "status": "verified",
                "structurally_verified": True,
                "changed_partitions": [name for name, value in partition_diffs.items() if value],
                "logical_changes": ["WEBI:www/index.html", "WEBI:www/js/canary_logs.js"],
                "non_webi_partitions_byte_identical": True,
            },
            "qualification": {
                "flash_qualified": False,
                "live_tested": False,
                "restore_allowlisted": False,
                "reason": "structural build only; golden qualification and reviewed one-shot RestoreFw transport are still required",
            },
        }
        temporary.unlink()
        write_exclusive(args.output, candidate)
        write_exclusive(args.report, (json.dumps(report, indent=2, sort_keys=True) + "\n").encode())
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except (BuildError, inspector.InspectionError, OSError) as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        print(f"build failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
