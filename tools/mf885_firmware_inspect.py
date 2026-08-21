#!/usr/bin/env python3
"""Inspect and compare MF885 ZIMI BackupFw/RestoreFw images without writing them.

The encrypted ZIMI header is device-bound.  Pass a read-only
``GetInfo&Id=Base`` XML response with ``--identity-xml`` to derive the key and
perform the complete structural verification.  The report never emits the
serial number, MAC address, derived AES key, or archive contents.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import re
import struct
import sys
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


HEADER_SIZE = 0x23C
ENCRYPTED_HEADER_SIZE = 0x230
DESCRIPTOR_OFFSET = 0x68
DESCRIPTOR_SIZE = 0x1C
MAX_DESCRIPTORS = 16
CAFE_HEADER_SIZE = 20
CAFE_RECORD_HEADER_SIZE = 136

KNOWN_ARTIFACTS = {
    "2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531": {
        "id": "mf885-2.5.94-golden",
        "size": 8_323_644,
        "role": "stock-golden",
        "structural_status": "verified",
        "restorable": True,
    },
    "f2ee088574634d822d5feed8210578a62788c8837fabc80129c6ce51ddfb429c": {
        "id": "mf885-community-0.0-canary-webui-r3",
        "size": 8_323_644,
        "role": "webui-canary",
        "structural_status": "quarantined-invalid-byte-sums",
        "restorable": False,
        "issue": "ZIMI global and WEBI additive byte sums do not match the unchanged encrypted header",
    },
    "65e5f5b507b9fcf49609a6fd1f010daa6f18111dc6a829d5655fa6bd30553517": {
        "id": "mf885-community-0.0-canary-logs-r1",
        "size": 8_323_644,
        "role": "webui-logs-canary",
        "structural_status": "verified-not-flash-qualified",
        "restorable": False,
        "issue": "structurally verified, but golden-to-golden and live boot gates have not passed",
    },
}


class InspectionError(Exception):
    """Raised when an image cannot be parsed safely."""


@dataclass(frozen=True)
class IdentityMaterial:
    serial: bytes
    mac: bytes
    fingerprint: str
    key_fingerprint: str
    key: bytes


@dataclass(frozen=True)
class Partition:
    name: str
    checksum: int
    offset: int
    length: int


@dataclass(frozen=True)
class CafeRecord:
    path: str
    size: int
    sha256: str
    marker: int
    size_flags: int


@dataclass
class ParsedImage:
    raw: bytes
    plaintext: bytes
    partitions: list[Partition]
    report: dict[str, Any]
    cafe_records: dict[str, list[CafeRecord]]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def u32(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 4 > len(data):
        raise InspectionError(f"u32 outside buffer at 0x{offset:x}")
    return struct.unpack_from("<I", data, offset)[0]


def byte_sum(data: bytes) -> int:
    return sum(data) & 0xFFFFFFFF


def hex32(value: int) -> str:
    return f"0x{value:08x}"


def safe_ascii(raw: bytes) -> str:
    raw = raw.split(b"\0", 1)[0]
    return "".join(chr(value) if 0x20 <= value <= 0x7E else f"\\x{value:02x}" for value in raw)


def local_tag(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def find_identity_value(root: ET.Element, names: set[str]) -> str:
    values = []
    for element in root.iter():
        if local_tag(element.tag) in names and element.text and element.text.strip():
            values.append(element.text.strip())
    unique = list(dict.fromkeys(values))
    if len(unique) != 1:
        raise InspectionError(f"identity XML must contain exactly one of {sorted(names)}")
    return unique[0]


def load_identity(path: Path) -> IdentityMaterial:
    try:
        root = ET.fromstring(path.read_bytes())
    except (OSError, ET.ParseError) as exc:
        raise InspectionError("identity XML could not be read or parsed") from exc

    serial_text = find_identity_value(root, {"sn", "serial", "serialnumber"})
    mac_text = find_identity_value(root, {"mac", "macaddress"})
    try:
        serial = serial_text.encode("ascii")
    except UnicodeEncodeError as exc:
        raise InspectionError("identity serial is not ASCII") from exc
    if len(serial) != 15:
        raise InspectionError(f"identity serial must be exactly 15 ASCII bytes, got {len(serial)}")

    compact_mac = re.sub(r"[^0-9A-Fa-f]", "", mac_text)
    if len(compact_mac) != 12:
        raise InspectionError("identity MAC must contain exactly six bytes")
    try:
        mac = bytes.fromhex(compact_mac)
    except ValueError as exc:
        raise InspectionError("identity MAC is malformed") from exc

    mac_mix = (
        f"{mac[0]:02x}:{mac[1]:02x}:{mac[2]:02x}:{mac[3]:02x}:"
        f"{mac[4]:02x}{mac[5]:02x}"
    ).encode("ascii")
    serial_mix = serial + b"\0"
    base = b"0123456789abcdef"
    key = bytes(a ^ b ^ c for a, b, c in zip(base, mac_mix, serial_mix))
    identity_fingerprint = sha256(b"MF885-ZIMI-identity-v1\0" + serial + b"\0" + mac)
    return IdentityMaterial(
        serial=serial,
        mac=mac,
        fingerprint=identity_fingerprint,
        key_fingerprint=sha256(key),
        key=key,
    )


def decrypt_header(image: bytes, identity: IdentityMaterial) -> bytes:
    if len(image) < HEADER_SIZE:
        raise InspectionError(f"image is shorter than the 0x{HEADER_SIZE:x}-byte header")
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError as exc:
        raise InspectionError(
            "full header validation needs the Python 'cryptography' package"
        ) from exc
    decryptor = Cipher(algorithms.AES(identity.key), modes.CBC(bytes(16))).decryptor()
    plain_prefix = decryptor.update(image[:ENCRYPTED_HEADER_SIZE]) + decryptor.finalize()
    return plain_prefix + image[ENCRYPTED_HEADER_SIZE:HEADER_SIZE]


def parse_partitions(header: bytes, image_size: int) -> tuple[list[Partition], list[str]]:
    count = u32(header, 0x64)
    if count < 1 or count > MAX_DESCRIPTORS:
        raise InspectionError(f"invalid ZIMI partition count: {count}")
    partitions: list[Partition] = []
    errors: list[str] = []
    for index in range(count):
        base = DESCRIPTOR_OFFSET + index * DESCRIPTOR_SIZE
        if base + DESCRIPTOR_SIZE > len(header):
            raise InspectionError(f"partition descriptor {index} exceeds the header")
        name = safe_ascii(header[base : base + 4])
        checksum = u32(header, base + 0x10)
        offset = u32(header, base + 0x14)
        length = u32(header, base + 0x18)
        if not name:
            errors.append(f"descriptor {index} has an empty name")
        if offset < HEADER_SIZE or length == 0 or offset + length > image_size:
            errors.append(
                f"{name or index}: invalid range 0x{offset:x}+0x{length:x} for size 0x{image_size:x}"
            )
        partitions.append(Partition(name, checksum, offset, length))

    ordered = sorted(partitions, key=lambda part: part.offset)
    cursor = HEADER_SIZE
    for part in ordered:
        if part.offset != cursor:
            errors.append(
                f"layout is not contiguous before {part.name}: expected 0x{cursor:x}, got 0x{part.offset:x}"
            )
        cursor = part.offset + part.length
    if cursor != image_size:
        errors.append(f"layout ends at 0x{cursor:x}, image ends at 0x{image_size:x}")
    return partitions, errors


def inspect_lzma(payload: bytes) -> dict[str, Any]:
    result: dict[str, Any] = {"format": "lzma-alone"}
    try:
        decoder = lzma.LZMADecompressor(format=lzma.FORMAT_ALONE)
        unpacked = decoder.decompress(payload)
        consumed = len(payload) - len(decoder.unused_data)
        padding = decoder.unused_data
        result.update(
            {
                "stream_complete": decoder.eof,
                "compressed_bytes": consumed,
                "uncompressed_bytes": len(unpacked),
                "uncompressed_sha256": sha256(unpacked),
                "padding_bytes": len(padding),
                "padding_all_ff": bool(padding) and all(value == 0xFF for value in padding),
            }
        )
    except lzma.LZMAError as exc:
        result.update({"stream_complete": False, "error": type(exc).__name__})
    return result


def parse_cafe(payload: bytes, include_records: bool) -> tuple[dict[str, Any], list[CafeRecord]]:
    if len(payload) < CAFE_HEADER_SIZE or u32(payload, 0) != 0xCAFECAFE:
        raise InspectionError("partition does not start with a CAFE archive")
    stored_adler = u32(payload, 4)
    format_word = u32(payload, 8)
    reserved = [u32(payload, 12), u32(payload, 16)]
    position = CAFE_HEADER_SIZE
    records: list[CafeRecord] = []
    seen_paths: set[str] = set()
    duplicate_paths: list[str] = []
    while True:
        if position + 4 > len(payload):
            raise InspectionError("CAFE archive has no DADADADA sentinel")
        marker = u32(payload, position)
        if marker == 0xDADADADA:
            sentinel_offset = position
            break
        if marker >> 16 != 0xCAFE:
            raise InspectionError(f"invalid CAFE record marker 0x{marker:08x} at 0x{position:x}")
        if position + CAFE_RECORD_HEADER_SIZE > len(payload):
            raise InspectionError("truncated CAFE record header")
        size_flags = u32(payload, position + 4)
        size = size_flags & 0x00FFFFFF
        path_text = safe_ascii(payload[position + 8 : position + CAFE_RECORD_HEADER_SIZE])
        data_start = position + CAFE_RECORD_HEADER_SIZE
        data_end = data_start + size
        if not path_text or data_end > len(payload):
            raise InspectionError(f"invalid CAFE record at 0x{position:x}")
        if path_text in seen_paths:
            duplicate_paths.append(path_text)
        seen_paths.add(path_text)
        records.append(
            CafeRecord(
                path=path_text,
                size=size,
                sha256=sha256(payload[data_start:data_end]),
                marker=marker,
                size_flags=size_flags,
            )
        )
        position = data_end

    computed_adler = zlib.adler32(payload[8:sentinel_offset]) & 0xFFFFFFFF
    padding = payload[sentinel_offset + 4 :]
    listing = [
        {
            "path": record.path,
            "size": record.size,
            "sha256": record.sha256,
            "marker": hex32(record.marker),
            "size_flags": hex32(record.size_flags),
        }
        for record in records
    ]
    report: dict[str, Any] = {
        "format": "cafe",
        "format_word": hex32(format_word),
        "reserved_words": [hex32(value) for value in reserved],
        "record_count": len(records),
        "sentinel_offset": f"0x{sentinel_offset:x}",
        "stored_adler32": hex32(stored_adler),
        "computed_adler32": hex32(computed_adler),
        "adler32_valid": stored_adler == computed_adler,
        "duplicate_paths": duplicate_paths,
        "padding_bytes": len(padding),
        "padding_all_ff": bool(padding) and all(value == 0xFF for value in padding),
        "record_manifest_sha256": sha256(
            "\n".join(f"{r.path}\0{r.size}\0{r.sha256}" for r in records).encode("utf-8")
        ),
    }
    if include_records:
        report["records"] = listing
    return report, records


def artifact_info(name: str, data: bytes) -> dict[str, Any]:
    digest = sha256(data)
    known = KNOWN_ARTIFACTS.get(digest)
    return {
        "name": name,
        "size": len(data),
        "sha256": digest,
        "known_artifact": dict(known) if known else None,
        "known_size_valid": bool(known and known["size"] == len(data)),
    }


def known_is_quarantined(artifact: dict[str, Any]) -> bool:
    known = artifact.get("known_artifact")
    return bool(known and str(known.get("structural_status", "")).startswith("quarantined-"))


def inspect_image(path: Path, identity: IdentityMaterial | None, include_records: bool) -> ParsedImage:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise InspectionError(f"could not read image {path.name!r}") from exc
    artifact = artifact_info(path.name, raw)
    report: dict[str, Any] = {
        "schema": "mf885-zimi-inspection/v1",
        "artifact": artifact,
        "identity": None,
        "header": {"state": "encrypted-not-inspected"},
        "partitions": [],
        "verification": {
            "status": (
                "invalid"
                if known_is_quarantined(artifact)
                else "known-exact"
                if artifact["known_size_valid"]
                else "incomplete"
            ),
            "structurally_verified": False,
            "errors": (
                [artifact["known_artifact"]["issue"]]
                if known_is_quarantined(artifact)
                else []
            ),
        },
    }
    if identity is None:
        return ParsedImage(raw, b"", [], report, {})

    header = decrypt_header(raw, identity)
    plaintext = header + raw[HEADER_SIZE:]
    partitions, layout_errors = parse_partitions(header, len(raw))
    stored_global = u32(header, 0x1C)
    computed_global = byte_sum(plaintext[0x20:])
    header_report: dict[str, Any] = {
        "state": "decrypted",
        "plaintext_sha256": sha256(header),
        "magic": safe_ascii(header[0:4]),
        "description": safe_ascii(header[0x04:0x1C]),
        "stored_global_byte_sum": hex32(stored_global),
        "computed_global_byte_sum": hex32(computed_global),
        "global_byte_sum_valid": stored_global == computed_global,
        "format_version": u32(header, 0x20),
        "software": safe_ascii(header[0x24:0x44]),
        "hardware": safe_ascii(header[0x44:0x64]),
        "partition_count": u32(header, 0x64),
        "encrypted_prefix_bytes": ENCRYPTED_HEADER_SIZE,
        "plaintext_tail_bytes": HEADER_SIZE - ENCRYPTED_HEADER_SIZE,
    }
    report["identity"] = {
        "source": "GetInfo/Base XML",
        "identity_fingerprint_sha256": identity.fingerprint,
        "derived_key_sha256": identity.key_fingerprint,
        "serial_or_mac_disclosed": False,
    }
    report["header"] = header_report

    errors = list(layout_errors)
    if header[0:4] != b"ZIMI":
        errors.append("decrypted header magic is not ZIMI")
    if stored_global != computed_global:
        errors.append("global additive byte checksum mismatch")

    cafe_records: dict[str, list[CafeRecord]] = {}
    partition_reports = []
    for partition in partitions:
        payload = raw[partition.offset : partition.offset + partition.length]
        computed = byte_sum(payload)
        item: dict[str, Any] = {
            "name": partition.name,
            "offset": f"0x{partition.offset:x}",
            "length": f"0x{partition.length:x}",
            "stored_byte_sum": hex32(partition.checksum),
            "computed_byte_sum": hex32(computed),
            "byte_sum_valid": partition.checksum == computed,
            "sha256": sha256(payload),
        }
        if partition.checksum != computed:
            errors.append(f"{partition.name}: additive byte checksum mismatch")
        if partition.name in {"OSLO", "GRBI", "RFBN"}:
            item["payload"] = inspect_lzma(payload)
            if not item["payload"].get("stream_complete"):
                errors.append(f"{partition.name}: LZMA stream did not complete")
        elif payload[:4] == struct.pack("<I", 0xCAFECAFE):
            try:
                cafe_report, records = parse_cafe(payload, include_records)
                item["payload"] = cafe_report
                cafe_records[partition.name] = records
                if not cafe_report["adler32_valid"]:
                    errors.append(f"{partition.name}: CAFE Adler-32 mismatch")
                if cafe_report["duplicate_paths"]:
                    errors.append(f"{partition.name}: duplicate CAFE paths")
            except InspectionError as exc:
                item["payload"] = {"format": "cafe", "error": str(exc)}
                errors.append(f"{partition.name}: {exc}")
        else:
            item["payload"] = {"format": "opaque"}
        partition_reports.append(item)

    report["partitions"] = partition_reports
    if known_is_quarantined(artifact) and artifact["known_artifact"]["issue"] not in errors:
        errors.append(artifact["known_artifact"]["issue"])
    report["verification"] = {
        "status": "verified" if not errors else "invalid",
        "structurally_verified": not errors,
        "errors": errors,
    }
    return ParsedImage(raw, plaintext, partitions, report, cafe_records)


def diff_ranges(left: bytes, right: bytes) -> tuple[int, list[dict[str, Any]]]:
    ranges: list[dict[str, Any]] = []
    total = 0
    run_start: int | None = None
    common = min(len(left), len(right))
    for index in range(common):
        different = left[index] != right[index]
        if different:
            total += 1
            if run_start is None:
                run_start = index
        elif run_start is not None:
            ranges.append(
                {"start": f"0x{run_start:x}", "end": f"0x{index - 1:x}", "bytes": index - run_start}
            )
            run_start = None
    if run_start is not None:
        ranges.append(
            {"start": f"0x{run_start:x}", "end": f"0x{common - 1:x}", "bytes": common - run_start}
        )
    if len(left) != len(right):
        ranges.append(
            {
                "start": f"0x{common:x}",
                "end": f"0x{max(len(left), len(right)) - 1:x}",
                "bytes": abs(len(left) - len(right)),
                "reason": "length-difference",
            }
        )
        total += abs(len(left) - len(right))
    return total, ranges


def compare_cafe(left: Iterable[CafeRecord], right: Iterable[CafeRecord]) -> dict[str, Any]:
    left_map = {record.path: record for record in left}
    right_map = {record.path: record for record in right}
    changed = []
    for path in sorted(left_map.keys() & right_map.keys()):
        before = left_map[path]
        after = right_map[path]
        if (before.size, before.sha256, before.marker, before.size_flags) != (
            after.size,
            after.sha256,
            after.marker,
            after.size_flags,
        ):
            changed.append(
                {
                    "path": path,
                    "size_before": before.size,
                    "size_after": after.size,
                    "sha256_before": before.sha256,
                    "sha256_after": after.sha256,
                }
            )
    return {
        "added_paths": sorted(right_map.keys() - left_map.keys()),
        "removed_paths": sorted(left_map.keys() - right_map.keys()),
        "changed_records": changed,
    }


def compare_images(left: ParsedImage, right: ParsedImage) -> dict[str, Any]:
    raw_count, raw_ranges = diff_ranges(left.raw, right.raw)
    report: dict[str, Any] = {
        "left": {
            "name": left.report["artifact"]["name"],
            "sha256": left.report["artifact"]["sha256"],
            "verification": left.report["verification"]["status"],
        },
        "right": {
            "name": right.report["artifact"]["name"],
            "sha256": right.report["artifact"]["sha256"],
            "verification": right.report["verification"]["status"],
            "errors": right.report["verification"]["errors"],
        },
        "raw_diff_bytes": raw_count,
        "raw_diff_ranges": raw_ranges,
        "same_size": len(left.raw) == len(right.raw),
        "encrypted_header_byte_identical": left.raw[:HEADER_SIZE] == right.raw[:HEADER_SIZE],
        "partitions": [],
        "cafe": {},
    }
    if left.partitions and right.partitions:
        right_by_name = {part.name: part for part in right.partitions}
        for part in left.partitions:
            other = right_by_name.get(part.name)
            if other is None:
                report["partitions"].append({"name": part.name, "present_in_both": False})
                continue
            left_payload = left.raw[part.offset : part.offset + part.length]
            right_payload = right.raw[other.offset : other.offset + other.length]
            count, ranges = diff_ranges(left_payload, right_payload)
            report["partitions"].append(
                {
                    "name": part.name,
                    "present_in_both": True,
                    "same_offset": part.offset == other.offset,
                    "same_length": part.length == other.length,
                    "byte_identical": count == 0,
                    "diff_bytes": count,
                    "diff_ranges_partition_relative": ranges,
                }
            )
        for name in sorted(left.cafe_records.keys() | right.cafe_records.keys()):
            report["cafe"][name] = compare_cafe(
                left.cafe_records.get(name, []), right.cafe_records.get(name, [])
            )
    return report


def print_text(report: dict[str, Any], comparison: dict[str, Any] | None) -> None:
    artifact = report["artifact"]
    known = artifact["known_artifact"]
    print(f"Artifact: {artifact['name']}")
    print(f"Size: {artifact['size']} bytes")
    print(f"SHA-256: {artifact['sha256']}")
    print(f"Known: {known['id']} ({known['role']})" if known else "Known: no")
    print(f"Verification: {report['verification']['status']}")
    header = report["header"]
    if header["state"] == "decrypted":
        print(
            f"ZIMI: {header['software']} / {header['hardware']} / "
            f"global-sum={'OK' if header['global_byte_sum_valid'] else 'FAIL'}"
        )
        identity = report["identity"]
        print(f"Identity fingerprint: {identity['identity_fingerprint_sha256']}")
        print(f"Derived-key fingerprint: {identity['derived_key_sha256']}")
        for part in report["partitions"]:
            payload = part["payload"]
            detail = payload["format"]
            if detail == "cafe":
                detail += f" records={payload.get('record_count', '?')} adler={'OK' if payload.get('adler32_valid') else 'FAIL'}"
            elif detail == "lzma-alone":
                detail += f" out={payload.get('uncompressed_bytes', '?')}"
            print(
                f"  {part['name']:4} {part['offset']}+{part['length']} "
                f"sum={'OK' if part['byte_sum_valid'] else 'FAIL'} {detail}"
            )
    else:
        print("ZIMI header: encrypted; pass --identity-xml for structural verification")
    for error in report["verification"]["errors"]:
        print(f"ERROR: {error}")
    if comparison is not None:
        print(
            f"Comparison: {comparison['right']['name']} is "
            f"{comparison['right']['verification']}; {comparison['raw_diff_bytes']} differing raw bytes"
        )
        for error in comparison["right"]["errors"]:
            print(f"COMPARE ERROR: {error}")
        print(f"Encrypted header identical: {comparison['encrypted_header_byte_identical']}")
        for part in comparison["partitions"]:
            if part.get("present_in_both"):
                print(f"  {part['name']:4} diff-bytes={part['diff_bytes']}")
        for name, cafe in comparison["cafe"].items():
            paths = [item["path"] for item in cafe["changed_records"]]
            if paths or cafe["added_paths"] or cafe["removed_paths"]:
                print(f"  {name} changed records: {', '.join(paths) or '(membership only)'}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only structural inspector for MF885 ZIMI BackupFw/RestoreFw images"
    )
    parser.add_argument("image", type=Path, help="firmware image to inspect")
    parser.add_argument(
        "--identity-xml",
        type=Path,
        help="read-only GetInfo&Id=Base XML used to derive the device-bound header key",
    )
    parser.add_argument("--compare", type=Path, help="second image for a byte/logical comparison")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument(
        "--list-records",
        action="store_true",
        help="include CAFE record paths, sizes and hashes (never contents)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        identity = load_identity(args.identity_xml) if args.identity_xml else None
        primary = inspect_image(args.image, identity, args.list_records)
        comparison = None
        secondary = None
        if args.compare:
            secondary = inspect_image(args.compare, identity, args.list_records)
            comparison = compare_images(primary, secondary)
        if args.json:
            output: dict[str, Any] = {"image": primary.report}
            if secondary is not None:
                output["compared_image"] = secondary.report
                output["comparison"] = comparison
            print(json.dumps(output, indent=2, sort_keys=True))
        else:
            print_text(primary.report, comparison)

        statuses = [primary.report["verification"]["status"]]
        if secondary is not None:
            statuses.append(secondary.report["verification"]["status"])
        if "invalid" in statuses:
            return 2
        if "incomplete" in statuses:
            return 3
        return 0
    except InspectionError as exc:
        print(f"inspection failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
