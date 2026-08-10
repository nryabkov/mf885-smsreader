# MF885 router uptime and connection-time evidence

## Result

MF885 firmware 2.5.94 does not currently expose a confirmed **router boot uptime** through the `status1` fields used by this project. The dashboard therefore must not label any guessed value as `Uptime`.

The dashboard now shows the firmware's already-supported **WAN/PDP connection time** instead. This is intentionally labelled `Connection time` because it measures the current cellular data session, not time since router boot.

The runtime source is the existing `status1` / `WanStatistics` parsing path:

```text
conn_days
conn_hours
conn_minutes
conn_seconds
```

`parseTraffic()` normalizes those four values into `traffic.sessionSeconds`; the normal 30-second status polling publishes the formatted value to the WebView. No extra HTTP request is introduced.

A cellular disconnect/reconnect may reset this timer without rebooting the MF885. It must therefore never be described as router uptime.

## Why the previous uptime implementation failed

A live 2.5.94 response from the target router (`2.5.94_release_MF855_NZ_CP_2.129.003`) was 4364 bytes and contained none of the guessed aliases:

```text
uptime
up_time
system_uptime
sys_uptime
run_time
running_time
work_time
router_startup
number_of_boots
```

This is the real evidence behind the former `Uptime: —` display.

PR #64 tested uptime with synthetic XML containing invented aliases, so those tests established parser behavior only; they did not establish a firmware source. The implementation also read the value only during initial `loadModel()` and did not include it in the regular polling payload.

The speculative uptime parser and its synthetic tests are removed by the connection-time change.

## What the stock WebUI establishes

The extracted stock WEBI distinguishes schema presence from real frontend use.

`config_save.xml` contains:

```text
RGW/sysinfo/router_startup
RGW/sysinfo/number_of_boots
```

but the generated WEBI call-site inventory has **no JavaScript usage for the `config_save` model**. Generic GET/POST forms mechanically derived from that XML schema are not stock-client evidence.

By contrast, the WAN model has real stock WebUI call sites and contains cellular connection-duration fields. The dashboard deliberately uses the already-parsed current-session fields:

```text
conn_days
conn_hours
conn_minutes
conn_seconds
```

The firmware family also contains `_all` duration names, but those are not used for the displayed `Connection time` because their exact accumulation/reset semantics have not been established at the same confidence level.

## Live transport evidence

The following tests were run on the target MF885 2.5.94:

```text
GET /xml_action.cgi?method=get&module=duster&file=status1
  -> HTTP 200, 4364 bytes

GET /xml_action.cgi?method=get&module=duster&file=config_save
  -> HTTP 500, 48 bytes

GET /xml_action.cgi?method=get&file=config_save
  -> connection closed / no HTTP response

GET /cgi/xml_action.cgi?...status1
  -> HTTP 404

GET /cgi/xml_action.cgi?...config_save
  -> HTTP 404
```

This confirms the established transport split: `/xml_action.cgi` is the physical HTTP path and `/cgi/xml_action.cgi` is the Digest URI/HA2 value. It also disproves the assumption that `config_save` can simply be read as an ordinary Duster model on this build.

No further `config_save` endpoint guessing should be used to discover uptime.

## Android companion evidence

Reverse engineering the period-relevant `com.xiaomi.mifi` 1.2.42 companion APK found no literal use of the guessed uptime aliases and no literal use of `router_startup` or `number_of_boots`. The recovered application API strongly establishes power-command transport, but it does not currently expose a true router boot-uptime field.

## Dashboard policy

The supported timer is now:

```text
Connection time -> current WAN/PDP session duration
```

Implementation rules:

1. derive it from `traffic.sessionSeconds`, which already comes from `conn_days/hours/minutes/seconds`;
2. show `—` only when those current-session counters are absent;
3. refresh it through the existing polling payload, with no additional router request;
4. never call it router uptime;
5. keep true boot-uptime research separate.

## Next evidence target for true router uptime

If true time-since-boot is still required, the clean next step is static native tracing in exact 2.5.94 OSLO:

- cross-reference `router_startup` and `number_of_boots`;
- identify the Duster/PSM producer that writes them;
- determine whether `router_startup` is a timestamp, counter, boolean/startup mode or persisted setting;
- identify whether any callable stock model returns the value.

Until that trace is complete, `router_startup` remains schema evidence only.
