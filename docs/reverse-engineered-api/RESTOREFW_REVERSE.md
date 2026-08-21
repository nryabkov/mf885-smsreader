# MF885 2.5.94 ZIMI and RestoreFw reverse engineering

This document is the reproducible reverse-engineering record for the exact
MF885/LV01 `2.5.94_release_MF855_NZ_CP_2.129.003` BackupFw image. It covers the
device-bound ZIMI container, its payload formats, native checksum and restore
logic, the HTTP upload parser, the restore-status state machine, and the limits
of a restore attempted without an external flash dump.

It is not authorization to flash. No `RestoreFw` POST was sent while producing
this record. The shipped Scriptable build still contains no production upload
adapter and its transport/recovery allowlists remain empty.

## Result at a glance

- The stock golden image is internally valid under the exact checksum,
  encryption, partition, CAFE and LZMA rules recovered from firmware.
- `RestoreFw` accepts a device-bound **ZIMI** container, not a Marvell FBF
  update. The restore path checks no RSA signature that we could find.
- The server requires a multipart POST containing a part whose MIME header is
  exactly `application/octet-stream`; its parser does not inspect that part's
  form name or filename.
- A successful HTTP upload response means only that the body was accepted for
  asynchronous processing. It does not prove checksum acceptance, flash
  completion or a successful reboot.
- The published WEBUI Canary r3 is **structurally invalid and quarantined**. Its
  builder preserved a 32-bit word sum, while the native restore routine sums
  bytes. Do not submit that image to `RestoreFw`.
- Without a physical 32 MiB NOR dump there is no out-of-band recovery guarantee.
  A software-only golden-to-golden test can only be a consciously accepted,
  bounded-risk experiment after the remaining session/transport evidence is
  closed.

## Evidence and confidence labels

The claims below use four labels:

- **exact-image** — reproduced directly from the two exact files and hashes;
- **native-confirmed** — recovered from the exact golden OSLO code;
- **live-read-confirmed** — observed through read-only GETs on the target unit;
- **unresolved** — not safely provable without the first destructive request or
  additional hardware evidence.

Runtime addresses are Thumb virtual addresses in the exact raw OSLO image with
SHA-256 `d51fb378d8ccf68662174f39d6b8c4f6be5571280790bc3a4dc4a9e8a967078c`.
They are not portable to another firmware build.

## Exact artifacts

| Artifact | Size | SHA-256 | Result |
|---|---:|---|---|
| stock golden BackupFw | 8,323,644 | `2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531` | structurally valid |
| Community Canary WEBUI r3 | 8,323,644 | `f2ee088574634d822d5feed8210578a62788c8837fabc80129c6ce51ddfb429c` | quarantined: invalid byte sums |
| decompressed golden OSLO | 9,648,064 | `d51fb378d8ccf68662174f39d6b8c4f6be5571280790bc3a4dc4a9e8a967078c` | exact analysis baseline |

A previous project report records two consecutive, byte-identical clean
BackupFw captures with the golden hash. The local corpus currently proves the
bytes and hash, but does not independently preserve both acquisition sessions.
An older backup containing a zero-filled `0x10000` block is not golden and must
not be restored.

## 1. ZIMI container layout

The container is a 572-byte (`0x23c`) header followed by six contiguous,
fixed-size partition slots. The descriptor offsets and lengths sum exactly to
the complete file size.

| Partition | File offset | Slot length | Stored additive byte sum | Slot SHA-256 |
|---|---:|---:|---:|---|
| `OSLO` | `0x00023c` | `0x460000` | `0x232c9a1e` | `8b3da09d8d1aa4c8dbc493b8b1ceaeaabb51746744515dc8cdf66d65461260ca` |
| `GRBI` | `0x46023c` | `0x0c0000` | `0x06cb4bb8` | `e2f0e115ae091bc018c6c2bac6560368dbdf1d4b66a3334450f113548f244de0` |
| `WEBI` | `0x52023c` | `0x1c0000` | `0x097c3a03` | `86fda63366438a166c7ef334042af410e55289e7591a0743c47797404c08bb56` |
| `WIFI` | `0x6e023c` | `0x080000` | `0x05ad8fba` | `db5a098ae78ed29206b97afaa9329d743d934290df53eab6e4feec75e3b448cd` |
| `WCAL` | `0x76023c` | `0x080000` | `0x06736250` | `aab1c19f4ec1f5c9da3099d1041754ab9dfa9e7daa22fcc02a3b4db74d618eeb` |
| `RFBN` | `0x7e023c` | `0x010000` | `0x00cce703` | `644d300771c71b193030066a52ae1ff0723bfb84b218861a60de4ce3f5202902` |

The fixed slot includes compressed/archive data and its `0xff` padding. The
partition checksum covers the **whole slot**, not only the used stream.

## 2. Device-bound AES header

The header is not globally encrypted with a shared static key. The exact
firmware function at `0x0675ce68` derives a per-unit AES-128 key from the live
serial number and MAC address.

Pseudocode recovered from the native function:

```text
base    = ASCII("0123456789abcdef")
macmix  = lowercase sprintf("%02x:%02x:%02x:%02x:%02x%02x", MAC[0..5])
snmix   = 15 ASCII serial bytes || 0x00

for i in 0..15:
    key[i] = base[i] XOR macmix[i] XOR snmix[i]
```

Header decoding is:

```text
plaintext[0x000:0x230] = AES-128-CBC-decrypt(ciphertext, key, IV=16 zero bytes)
plaintext[0x230:0x23c] = image[0x230:0x23c]  # copied, not decrypted
```

The encrypted span is therefore 560 bytes (35 AES blocks), followed by 12
plaintext bytes. A read-only `GetInfo&Id=Base` response supplied the exact target
identity for local verification. The serial, MAC and key are deliberately not
stored in this repository or emitted by the inspector; only privacy-safe
fingerprints are reported.

The live-derived key produces a `ZIMI` header whose checksum and all six
descriptors match the golden payload. This independently confirms the derivation
rather than merely finding plausible plaintext.

## 3. Decrypted header structure

| Offset | Size | Meaning |
|---:|---:|---|
| `0x00` | 4 | ASCII magic `ZIMI` |
| `0x04` | 24 | description (`Image file with header`) |
| `0x1c` | 4 | little-endian global additive byte sum |
| `0x20` | 4 | format version (`1`) |
| `0x24` | 32 | software string (fixed-width and therefore truncated) |
| `0x44` | 32 | hardware string (`MF96 Ver.D`) |
| `0x64` | 4 | partition count (`6`) |
| `0x68` | `N * 0x1c` | partition descriptors |

Each 28-byte descriptor is:

| Relative offset | Size | Meaning |
|---:|---:|---|
| `+0x00` | 4 | partition name |
| `+0x04` | 12 | reserved |
| `+0x10` | 4 | additive byte sum |
| `+0x14` | 4 | file offset |
| `+0x18` | 4 | fixed slot length |

The 32-byte header software field ends in `..._2.12`; it is a truncation of the
full live version `2.5.94_release_MF855_NZ_CP_2.129.003`, not a different build.

## 4. Native checksum algorithm

Both the global and per-partition checksums are unsigned additive **byte** sums
modulo `2^32`:

```text
sum = 0
for each byte b in range:
    sum = (sum + b) & 0xffffffff
```

The native loop in the exact OSLO uses `LDRB`, not a 32-bit load:

```text
0675d9e4  ldrb r2, [r6, r1]
0675d9e6  adds r4, r2, r4
0675d9e8  adds r1, r1, #1
0675d9ea  cmp  r1, r0
0675d9ec  blo  0x0675d9e4
```

A second fragment buffer is accumulated with the same `LDRB` loop at
`0x0675d9fa`. The golden arithmetic reproduces every stored value exactly:

```text
global = sum(decrypted_image[0x20:]) = 0x40621839
```

This distinction between byte sum and 32-bit little-endian word sum is critical.

## 5. Partition payload formats

### LZMA-alone slots

`OSLO`, `GRBI` and `RFBN` start with an LZMA-alone stream and end in `0xff`
padding.

| Partition | Compressed stream | Uncompressed size | Uncompressed SHA-256 |
|---|---:|---:|---|
| `OSLO` | 4,548,166 | 9,648,064 | `d51fb378d8ccf68662174f39d6b8c4f6be5571280790bc3a4dc4a9e8a967078c` |
| `GRBI` | 678,845 | 2,621,440 | `f71025ac8f4d75894995a94f1a2daa12ff6c142b0a627173ae6e0f1605e345b5` |
| `RFBN` | 25,732 | 131,072 | `0bb837d10f4a014849a1c3bf01e9186dbfdbff986a1ca29b677d6e99fcfefda1` |

All three streams reach their LZMA end marker and all remaining slot bytes are
`0xff`.

### CAFE archives

`WEBI`, `WIFI` and `WCAL` use a simple CAFE archive:

```text
+0x00  u32  0xcafecafe
+0x04  u32  Adler-32
+0x08  u32  0x00001019
+0x0c  u32  reserved
+0x10  u32  reserved
+0x14  records...
```

Each record is stored without alignment padding:

```text
u32 marker       # upper 16 bits are 0xcafe
u32 size_flags   # payload length is the low 24 bits
u8  path[128]    # NUL-padded
u8  data[length]
```

`0xdadadada` terminates the archive; the remainder of the fixed slot is `0xff`.
The stored Adler-32 is exactly:

```text
adler32(partition[0x08:sentinel_offset])
```

Golden results:

| Partition | Records | Sentinel | Adler-32 |
|---|---:|---:|---:|
| `WEBI` | 320 | `0x1bcb08` | `0xbcc7fc55` |
| `WIFI` | 1 | `0x03958c` | `0x80f69429` |
| `WCAL` | 1 | `0x025f68` | `0xf3e67225` |

## 6. Canary r3 checksum defect

Canary r3 differs from golden in only 64 raw bytes, all inside the WEBI slot:

- four bytes of the CAFE Adler-32;
- same-length edits in `www/index.html`;
- a four-byte compensation word at WEBI offset `0x1bfffc` (file offset
  `0x6e0238`).

Its CAFE archive is internally sound: 320 paths, unchanged sentinel, valid new
Adler-32 `0x1225f939`, and only `www\index.html` changes logically. All other
partitions and the encrypted ZIMI header are byte-identical to golden.

The defect is in the outer ZIMI checksum layer:

| Check | Header expects | Canary computes | Delta |
|---|---:|---:|---:|
| global byte sum | `0x40621839` | `0x4062123d` | `-0x5fc` |
| WEBI byte sum | `0x097c3a03` | `0x097c3407` | `-0x5fc` |

The r3 report instead preserved the WEBI **word** sum
`0x4be2d813`. The native code does not use that value. Consequently r3 should
fail native validation before erasing/writing partitions, but relying on that
failure is unnecessary risk: the artifact is now excluded from `SAFE_IMAGES`
and must not be uploaded.

A replacement Canary must receive a new hash and pass all of these checks:

1. valid CAFE Adler-32;
2. exact outer WEBI byte sum;
3. exact global byte sum;
4. decryptable, re-encrypted ZIMI header if stored sums change;
5. unchanged non-WEBI partitions;
6. full inspector result `verified` on the target identity.

### Structural repair proof

The checksum model was tested by rebuilding r3 locally with only two decrypted
header fields changed: the WEBI descriptor byte sum becomes `0x097c3407`, and
the global byte sum becomes `0x4062123b`. The 560-byte prefix was then
re-encrypted with the same unit-bound key; every payload byte after the header
remained identical to r3.

That deterministic structural candidate is:

```text
size    8,323,644
sha256  77c1f51c556415b8807209ff1263b25fa66225dc2bb56da3f88c1030598270a7
```

It passes the complete inspector: all six outer byte sums, global sum, three
LZMA streams and three CAFE archives. This proves the reverse and repair
arithmetic. It does **not** prove boot behavior, is not in `SAFE_IMAGES`, and is
not flash-qualified.

## 7. RestoreFw HTTP request parser

The exact native request handler begins at Thumb address `0x066e8484`.

Confirmed request envelope:

```http
POST /xml_action.cgi?Action=RestoreFw HTTP/1.1
Content-Type: multipart/form-data; boundary=<boundary>
Content-Length: <exact body length>
```

The CGI dispatcher rejects a non-POST invocation as `Not Form Post`. The handler
requires `boundary=` in `Content-Type`, then searches the body for this literal:

```text
application/octet-stream\r\n\r\n
```

The firmware bytes begin immediately after that marker. The handler locates the
closing multipart boundary, strips the boundary and adjacent CR/LF/hyphen
characters, then forwards only the extracted bytes to the internal restore
operation (`0x56`).

No check for `name="file"`, `filename=`, a `target` form field, or `/MiFi/` was
found in this handler. Those fields are historical-client conventions, not
native parser gates. A future sender should nevertheless retain the conservative
stock-client `file` name and exact image filename unless a captured client proves
otherwise; the MIME value must remain exactly `application/octet-stream`.

## 8. HTTP acceptance response

If the internal body-forwarding call returns success, Mongoose emits exactly:

```http
HTTP/1.1 200 OK
Content-Type: text/html
Server: Mongoose/3.0

Server get upload file successfully

```

This is an upload-acceptance predicate only. Image decryption, checksum checks,
flash writes and reboot occur asynchronously. A future adapter must require the
expected HTTP status and body, then transition exclusively to bounded GET
polling. It must never replay the POST after a timeout, 401, disconnect or
ambiguous response.

## 9. Authentication and session boundary

The generic Mongoose session gateway at `0x066e58d8` runs before the RestoreFw
handler. Its static request bypass list includes `/`, `/index.html`,
`Action=GetInfo`, `file=locale`, `file=debugmodeon`, `file=sdenable`,
`file=alert0`, `file=alert2`, `file=alert3` and `Action=BackupFw`.
`Action=RestoreFw` is **not** in that list.

For a non-bypassed request, the gateway resolves the client into its session
record, logs its client type and login status, and enforces the login-status and
timeout fields before continuing to CGI dispatch. The request is associated
with the session by the observed client/MAC record; the RestoreFw body handler
itself contains no Digest parser.

Read-only live work confirmed the router's APP/Digest login flow and the
physical/Digest URI split used elsewhere:

```text
physical path: /xml_action.cgi
Digest URI:    /cgi/xml_action.cgi
```

The historical Stage0 Python client logs in with Digest and keeps the cookie jar,
then sends RestoreFw without a per-request Authorization header. That behavior
is consistent with the native active-session gate: Digest establishes the
session, while the upload is admitted by its still-live session record. It is
not evidence that RestoreFw is unauthenticated.

The remaining implementation detail is narrower: reproduce the exact fresh APP
login/session bootstrap, keep its cookie store and source interface unchanged,
perform the final harmless status read, and submit immediately before the
session timeout. A future sender should not invent a second Digest exchange or
reauth/replay after arming. Redirect behavior and the first destructive POST
remain intentionally untested live.

## 10. Native restore pipeline

The restore worker begins at Thumb address `0x0675ed6a`. Its relevant sequence is:

1. derive the unit AES key and decrypt the ZIMI header;
2. require `ZIMI` magic;
3. verify the global additive byte sum (skipping the first `0x20` header bytes);
4. compare the image hardware field with the live hardware identity;
5. iterate 28-byte partition descriptors;
6. verify each complete slot's additive byte sum;
7. erase/format/write through the stock partition helpers;
8. update restore status/progress/cause;
9. expose final success briefly, then reboot.

No RSA/signature verification was found on this ZIMI restore path. The signed FBF
software-update path has separate RSA machinery and must not be conflated with
RestoreFw. ZIMI's effective authorization is therefore possession of the
device-bound identity/key plus a valid authenticated router session; the checksum
layer detects corruption but is not cryptographic integrity protection.

## 11. Restore status state machine

Read-only live GETs confirmed the idle schema:

```xml
<process>
  <status>0</status>
  <progress>0</progress>
  <cause>No Error!</cause>
</process>
```

Native status meanings:

| Raw status | Meaning | Client handling |
|---:|---|---|
| `0` | idle/not restoring | valid only before submission; ambiguous after an accepted POST |
| `2` | processing | continue bounded GET-only polling |
| `1` | success | wait for reboot, then perform independent boot checks |
| `3` | terminal failure | record exact cause and stop; never auto-retry |

On success, firmware sets status `1`, waits up to 20 × 200 ms for a host status
read, delays again, and invokes the reboot routine. A connection drop after
status `1` is expected. A connection drop before a conclusive status is
`UNKNOWN`, not success and not permission to POST again.

`GetFlashingStatus` exposes the same idle `status/progress/cause` shape on the
tested unit. `upgrade_firmware` is a separate aggregate model with distinct
upgrade, backup and restore fields. The exact upload adapter should choose one
captured status contract rather than switching models during a transaction.

## 12. What a missing 32 MiB dump changes

The external part is a 32 MiB, 1.8 V Macronix `MX25U25635FZ4I` Serial NOR. The
8.3 MiB ZIMI file is a logical six-partition backup, not a full-chip image. It
does not contain every bootloader, recovery, configuration or metadata region.

Therefore, without a physical dump and a proven programmer/recovery path:

- power loss or a firmware bug during erase/write can leave the router
  unrecoverable by HTTP;
- a successful upload response cannot be undone if the device never boots;
- recovery partitions visible in firmware are not a guaranteed entry mechanism;
- the exact worst-case outcome is a permanently bricked unit requiring later
  board-level work.

The absence of a dump does **not** block static reverse engineering. It changes
the first live restore from a recoverable engineering test into an explicit
operator-risk decision.

## 13. Software-only bounded-risk route

If the operator intentionally proceeds without out-of-band recovery, the project
should use a separate `software-only-risk-v1` evidence path rather than pretending
physical recovery exists. It must remain locked until all non-physical evidence
is complete:

1. exact golden hash/size and full inspector result `verified` using the same
   live unit identity;
2. at least two fresh BackupFw acquisitions with independently recorded
   timestamps and identical hashes;
3. exported router configuration and separately recorded Wi-Fi/APN settings;
4. exact native session/auth path and a reviewed, core-owned multipart sender;
5. one Scriptable execution only, global firmware-exclusive mode, polling paused,
   no other router clients, no automatic redirects or retries;
6. stable wall power plus a healthy battery at or above 80%; auto-sleep disabled
   for the test window;
7. durable `POST_ARMED` journal written and read back before the sole Request;
8. a typed native confirmation that states there is no hardware recovery and
   includes the golden SHA prefix and unit fingerprint prefix;
9. exactly one golden-to-golden POST, followed only by bounded GET status and
   boot/service checks;
10. any ambiguous post-arm result becomes terminal `UNKNOWN` and is never
    replayed automatically.

This route reduces avoidable software mistakes. It cannot reduce the physical
brick consequence to zero and must not be described as equivalent to a NOR dump.
Canary/native experiments remain blocked until golden-to-golden succeeds and a
new, structurally valid Canary replaces quarantined r3.

## 14. Reproducible inspector

[`tools/mf885_firmware_inspect.py`](../../tools/mf885_firmware_inspect.py) performs
the analysis without extracting secrets or writing to the router.

Full golden validation and Canary comparison:

```bash
python3 tools/mf885_firmware_inspect.py \
  MF885_firmware_backup_20260808_095130.bin \
  --identity-xml getinfo-base.xml \
  --compare MF885_Community_0.0-canary-webui-r3.bin
```

Machine-readable output:

```bash
python3 tools/mf885_firmware_inspect.py IMAGE.bin \
  --identity-xml getinfo-base.xml --json
```

The identity XML may contain additional secrets such as a default Wi-Fi
password. Keep it private. The inspector reads only the serial and MAC needed by
the native derivation and reports neither value. Without `--identity-xml`, it can
identify exact known hashes but cannot independently decrypt and validate an
unknown unit-bound header.

[`tools/mf885_canary_repair.py`](../../tools/mf885_canary_repair.py) reproduces
the structural candidate from the two exact source files. It refuses any other
source hash, verifies the reviewed 64-byte WEBI-only delta, refuses to overwrite
an output, re-runs every structural check and labels the result unqualified:

```bash
python3 tools/mf885_canary_repair.py \
  --golden MF885_firmware_backup_20260808_095130.bin \
  --canary-r3 MF885_Community_0.0-canary-webui-r3.bin \
  --identity-xml getinfo-base.xml \
  --output MF885_Community_0.0-canary-webui-r4-structural.bin \
  --confirm-structural-only
```

## 15. Remaining blockers before a golden POST

- an exact reviewed APP login/session bootstrap for the native active-session
  gate, including cookie retention and timeout bounds;
- a reviewed Scriptable `Request` construction that sends the exact hashed
  `Data` once, with redirects/retries disabled and no mutable adapter escape;
- a credible single-instance/exclusive-lease rule for Scriptable;
- two newly captured identical golden BackupFw files and reviewed hashed
  configuration evidence (stock export or the explicit private-bundle fallback);
- explicit operator acceptance of the no-dump brick risk;
- a GET-only boot-verification profile and timeout bounds fixed in source.

Until those are closed, the correct operational decision is: **golden verified,
Canary r3 rejected, RestoreFw not sent**.
