#!/usr/bin/env python3
"""Rebuild the quarantined Canary r3 as a structural, non-qualified candidate.

This tool performs no network operation. It accepts only the exact golden and
Canary r3 hashes, fixes the two outer ZIMI additive byte sums, re-encrypts the
device-bound header, and independently re-runs the full inspector before writing
a new file. The result is deliberately *not* a flash allowlist entry.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
from pathlib import Path
from typing import Any

import mf885_firmware_inspect as inspector


GOLDEN_SHA256 = "2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531"
CANARY_R3_SHA256 = "f2ee088574634d822d5feed8210578a62788c8837fabc80129c6ce51ddfb429c"
STRUCTURAL_CANDIDATE_SHA256 = "77c1f51c556415b8807209ff1263b25fa66225dc2bb56da3f88c1030598270a7"
EXPECTED_SIZE = 8_323_644


class RepairError(Exception):
    pass


def require_exact(path: Path, expected_sha256: str, label: str) -> bytes:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise RepairError(f"could not read the {label} input") from exc
    digest = inspector.sha256(data)
    if len(data) != EXPECTED_SIZE or digest != expected_sha256:
        raise RepairError(
            f"{label} must be the exact {EXPECTED_SIZE}-byte artifact with SHA-256 {expected_sha256}"
        )
    return data


def require_expected_r3_delta(golden: inspector.ParsedImage, canary: inspector.ParsedImage) -> None:
    comparison = inspector.compare_images(golden, canary)
    if comparison["raw_diff_bytes"] != 64 or not comparison["encrypted_header_byte_identical"]:
        raise RepairError("Canary r3 does not have the reviewed 64-byte/header-identical delta")
    partition_diffs = {item["name"]: item.get("diff_bytes") for item in comparison["partitions"]}
    if partition_diffs != {"OSLO": 0, "GRBI": 0, "WEBI": 64, "WIFI": 0, "WCAL": 0, "RFBN": 0}:
        raise RepairError("Canary r3 partition delta does not match the reviewed WEBI-only change")
    cafe = comparison["cafe"].get("WEBI", {})
    changed = [item.get("path") for item in cafe.get("changed_records", [])]
    if changed != ["www\\index.html"] or cafe.get("added_paths") or cafe.get("removed_paths"):
        raise RepairError("Canary r3 logical CAFE delta is not exactly www\\index.html")


def encrypt_header(header: bytes, key: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError as exc:
        raise RepairError("header rebuilding needs the Python 'cryptography' package") from exc
    encryptor = Cipher(algorithms.AES(key), modes.CBC(bytes(16))).encryptor()
    return encryptor.update(header[: inspector.ENCRYPTED_HEADER_SIZE]) + encryptor.finalize()


def build_candidate(canary_raw: bytes, identity: inspector.IdentityMaterial) -> tuple[bytes, dict[str, Any]]:
    header = bytearray(inspector.decrypt_header(canary_raw, identity))
    partitions, layout_errors = inspector.parse_partitions(header, len(canary_raw))
    if layout_errors:
        raise RepairError("Canary r3 layout is not the reviewed contiguous six-partition layout")
    try:
        webi_index, webi = next(
            (index, part) for index, part in enumerate(partitions) if part.name == "WEBI"
        )
    except StopIteration as exc:
        raise RepairError("Canary r3 has no WEBI descriptor") from exc

    webi_payload = canary_raw[webi.offset : webi.offset + webi.length]
    webi_byte_sum = inspector.byte_sum(webi_payload)
    descriptor = inspector.DESCRIPTOR_OFFSET + webi_index * inspector.DESCRIPTOR_SIZE
    old_webi_sum = inspector.u32(header, descriptor + 0x10)
    struct.pack_into("<I", header, descriptor + 0x10, webi_byte_sum)

    assembled = bytes(header) + canary_raw[inspector.HEADER_SIZE :]
    global_byte_sum = inspector.byte_sum(assembled[0x20:])
    old_global_sum = inspector.u32(header, 0x1C)
    struct.pack_into("<I", header, 0x1C, global_byte_sum)

    encrypted_prefix = encrypt_header(bytes(header), identity.key)
    candidate = (
        encrypted_prefix
        + bytes(header[inspector.ENCRYPTED_HEADER_SIZE : inspector.HEADER_SIZE])
        + canary_raw[inspector.HEADER_SIZE :]
    )
    report = {
        "schema": "mf885-canary-structural-repair/v1",
        "source_sha256": CANARY_R3_SHA256,
        "candidate_sha256": inspector.sha256(candidate),
        "size": len(candidate),
        "patched_fields": {
            "webi_byte_sum": {"before": inspector.hex32(old_webi_sum), "after": inspector.hex32(webi_byte_sum)},
            "global_byte_sum": {"before": inspector.hex32(old_global_sum), "after": inspector.hex32(global_byte_sum)},
        },
        "payload_changes_beyond_r3": 0,
        "header_reencrypted_for_matching_unit": True,
        "flash_qualified": False,
        "qualification_blockers": [
            "no successful golden-to-golden RestoreFw qualification",
            "no reviewed production RestoreFw adapter",
            "no compiled software-only-risk-v1 or physical recovery record",
        ],
    }
    return candidate, report


def verify_candidate_bytes(
    candidate: bytes,
    identity: inspector.IdentityMaterial,
    expected_payload: bytes,
) -> dict[str, Any]:
    if len(candidate) != EXPECTED_SIZE:
        raise RepairError("candidate size changed")
    if candidate[inspector.HEADER_SIZE :] != expected_payload[inspector.HEADER_SIZE :]:
        raise RepairError("candidate payload changed while repairing only the ZIMI header")
    digest = inspector.sha256(candidate)
    if digest != STRUCTURAL_CANDIDATE_SHA256:
        raise RepairError(f"candidate SHA-256 is unexpected: {digest}")

    header = inspector.decrypt_header(candidate, identity)
    plaintext = header + candidate[inspector.HEADER_SIZE :]
    partitions, layout_errors = inspector.parse_partitions(header, len(candidate))
    errors = list(layout_errors)
    if header[:4] != b"ZIMI":
        errors.append("missing ZIMI magic")
    if inspector.u32(header, 0x1C) != inspector.byte_sum(plaintext[0x20:]):
        errors.append("global byte sum mismatch")
    for part in partitions:
        payload = candidate[part.offset : part.offset + part.length]
        if part.checksum != inspector.byte_sum(payload):
            errors.append(f"{part.name} byte sum mismatch")
        if payload[:4] == struct.pack("<I", 0xCAFECAFE):
            cafe, _ = inspector.parse_cafe(payload, include_records=False)
            if not cafe["adler32_valid"]:
                errors.append(f"{part.name} Adler-32 mismatch")
        elif part.name in {"OSLO", "GRBI", "RFBN"}:
            if not inspector.inspect_lzma(payload).get("stream_complete"):
                errors.append(f"{part.name} LZMA stream incomplete")
    if errors:
        raise RepairError("candidate failed independent structural verification: " + "; ".join(errors))
    return {"structurally_verified": True, "errors": []}


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description="Repair only the outer byte sums of exact quarantined MF885 Canary r3"
    )
    value.add_argument("--golden", type=Path, required=True)
    value.add_argument("--canary-r3", type=Path, required=True)
    value.add_argument("--identity-xml", type=Path, required=True)
    value.add_argument("--output", type=Path, required=True)
    value.add_argument(
        "--confirm-structural-only",
        action="store_true",
        help="acknowledge that the result is not flash-qualified or allowlisted",
    )
    value.add_argument("--json", action="store_true")
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if not args.confirm_structural_only:
            raise RepairError("--confirm-structural-only is required; this does not create a flash-qualified image")
        if args.output.exists():
            raise RepairError("output already exists; refusing to overwrite it")
        if not args.output.parent.is_dir():
            raise RepairError("output directory does not exist")
        golden_raw = require_exact(args.golden, GOLDEN_SHA256, "golden")
        canary_raw = require_exact(args.canary_r3, CANARY_R3_SHA256, "Canary r3")
        identity = inspector.load_identity(args.identity_xml)
        golden = inspector.inspect_image(args.golden, identity, include_records=False)
        canary = inspector.inspect_image(args.canary_r3, identity, include_records=False)
        if golden.report["verification"]["status"] != "verified":
            raise RepairError("golden input did not pass full structural verification")
        require_expected_r3_delta(golden, canary)
        candidate, report = build_candidate(canary_raw, identity)
        report["verification"] = verify_candidate_bytes(candidate, identity, canary_raw)

        temporary = args.output.with_name(args.output.name + ".tmp")
        if temporary.exists():
            raise RepairError("temporary output already exists; refusing to overwrite it")
        try:
            with temporary.open("xb") as stream:
                stream.write(candidate)
                stream.flush()
                os.fsync(stream.fileno())
            os.link(temporary, args.output)
            temporary.unlink()
        except OSError as exc:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise RepairError("candidate output could not be written atomically") from exc

        if args.json:
            print(json.dumps(report, indent=2, sort_keys=True))
        else:
            print(f"Wrote structural candidate: {args.output.name}")
            print(f"Size: {report['size']} bytes")
            print(f"SHA-256: {report['candidate_sha256']}")
            print("Structural verification: PASS")
            print("Flash qualification: NO")
        return 0
    except (RepairError, inspector.InspectionError) as exc:
        print(f"repair failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
