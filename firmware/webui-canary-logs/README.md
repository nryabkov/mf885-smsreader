# WEBI Canary Logs 0.0-logs-r1

This is the smallest first firmware experiment. It keeps every native partition
byte-identical and changes only the fixed-size `WEBI` archive:

- a 41-byte whitespace slot immediately before `</body>` in `www/index.html`
  becomes a same-length loader for `js/canary_logs.js`;
- `www/js/canary_logs.js` is appended as one new CAFE record in existing `0xff`
  padding;
- no existing CAFE record moves or changes size;
- 1,688 bytes of WEBI padding remain.

The panel records XHR, fetch, form submissions, control clicks, JavaScript
errors, `console.warn/error`, and the stock `detailed_log` GET while the panel is
open. Technical values remain visible. SMS request/response payloads and active
credentials are hidden.

Reproduce the image from the exact target-unit golden and read-only identity XML:

```bash
python3 tools/mf885_webi_builder.py \
  --golden /path/to/MF885_firmware_backup_20260808_095130.bin \
  --identity-xml /path/to/getinfo-base.xml \
  --script firmware/webui-canary-logs/canary_logs.js \
  --output build/MF885_Community_0.0-logs-r1.bin \
  --report build/MF885_Community_0.0-logs-r1.report.json \
  --confirm-structural-only
```

Expected artifact SHA-256:

`65e5f5b507b9fcf49609a6fd1f010daa6f18111dc6a829d5655fa6bd30553517`

The builder requires the exact golden hash, recalculates CAFE Adler-32 plus the
WEBI/global additive byte sums, re-encrypts the unit-bound ZIMI header, and then
runs the independent full inspector. A second build was byte-identical. This is
structural evidence only: the artifact is not live-tested, flash-qualified, or
present in the restore allowlist.
