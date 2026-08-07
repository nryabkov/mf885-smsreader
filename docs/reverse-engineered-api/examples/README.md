# API examples

These examples show the **payload shape**, not a complete HTTP client. Requests still require the Digest flow documented in [../AUTHENTICATION.md](../AUTHENTICATION.md).

## Read router status

```http
GET /cgi/xml_action.cgi?method=get&module=duster&file=status1 HTTP/1.1
Host: 192.168.21.1
Authorization: Digest ...
```

Use `status1` for the common dashboard snapshot: system/firmware information, battery, cellular state and WAN counters.

## Read SMS page 1

```xml
<?xml version="1.0" encoding="US-ASCII"?>
<RGW>
  <message>
    <flag>
      <message_flag>GET_RCV_SMS_LOCAL</message_flag>
    </flag>
    <get_message>
      <page_number>1</page_number>
    </get_message>
  </message>
</RGW>
```

POST it to:

```text
/cgi/xml_action.cgi?method=set&module=duster&file=message
```

Do not trust `total_number` blindly. Some family firmware behaves as though it is a page count. Stop on empty/repeated pages and deduplicate records.

## Send an SMS

The analysed API path expects message text as UTF-16BE hexadecimal.

For example, `Hello` becomes:

```text
00480065006C006C006F
```

Payload:

```xml
<?xml version="1.0" encoding="US-ASCII"?>
<RGW>
  <message>
    <flag>
      <message_flag>SEND_SMS</message_flag>
      <sms_cmd>4</sms_cmd>
    </flag>
    <send_save_message>
      <contacts>+10000000000</contacts>
      <content>00480065006C006C006F</content>
      <encode_type>UNICODE</encode_type>
      <sms_time>26,8,7,12,0,0,+5</sms_time>
    </send_save_message>
  </message>
</RGW>
```

Use a fictitious phone number in logs/tests.

## Read engineering cellular information

```http
GET /cgi/xml_action.cgi?method=get&module=duster&file=Engineer_parameter HTTP/1.1
Host: 192.168.21.1
Authorization: Digest ...
```

Display unknown enum/raw values rather than assigning labels from another firmware revision.

## Read cellular WAN state

```http
GET /cgi/xml_action.cgi?method=get&module=duster&file=wan HTTP/1.1
Host: 192.168.21.1
Authorization: Digest ...
```

Useful fields vary by build. Known aliases include APN, PDP state/type, registration, roaming, IP/gateway/DNS and preferred-network controls.

## Restart / power off

These are deliberately not given as copy-paste write payloads here because the exact command tree/value is firmware-specific and connection loss makes verification special. Use only a confirmed compatibility profile and the project's write/verification helpers.

## Debug / Telnet / firmware operations

See [../RESEARCH_NOTES.md](../RESEARCH_NOTES.md). These are security-sensitive and should not be treated as routine discovery probes.
