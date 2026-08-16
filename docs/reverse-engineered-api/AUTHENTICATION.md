# Authentication

The MF855/MF885 family uses HTTP Digest authentication. Its recovered ZMI Android APP flow has a vendor-specific quirk: the login query and the `Authorization` header are calculated against **different request URIs**.

The project keeps its established WebUI-style dashboard session unchanged. Restart and power-off use a separate, short-lived APP-compatible session implemented in `scriptable.js`; the sequence below documents that scoped flow.

## 1. Obtain the challenge

Request:

```http
GET /login.cgi HTTP/1.1
Host: 192.168.21.1
```

Read the `WWW-Authenticate` response header and extract at least:

- `realm`
- `nonce`
- `qop` (normally `auth`)

Then calculate:

```text
HA1 = MD5(username + ":" + realm + ":" + password)
```

Do not log `HA1`, `nonce`, `cnonce` or the final Digest response in public diagnostics.

## 2. Build the login query

For the query-string `response`, the firmware expects `HA2` to be calculated for:

```text
GET:/cgi/protected.cgi
```

Like the recovered ZMI 1.2.42 process, the project's first APP session starts this proof at nonce count 2:

```text
nc = 00000002
HA2_login = MD5("GET:/cgi/protected.cgi")
response_login = MD5(HA1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + HA2_login)
```

The login request carries fields similar to:

```text
/login.cgi?
  realm=<realm>&
  nonce=<nonce>&
  response=<response_login>&
  qop=<qop>&
  cnonce=<cnonce>&
  Action=Digest&
  username=<username>&
  temp=marvell&
  client=APP
```

## 3. Build the login request's Authorization header

The same HTTP request also carries a Digest `Authorization` header, but **this response is calculated for `/cgi/xml_action.cgi`**, not `/cgi/protected.cgi`:

```text
HA2_xml = MD5("GET:/cgi/xml_action.cgi")
nc_header = 00000003
response_xml = MD5(HA1 + ":" + nonce + ":" + nc_header + ":" + cnonce2 + ":" + qop + ":" + HA2_xml)
```

Header shape:

```http
Authorization: Digest username="admin", realm="...", nonce="...", uri="/cgi/xml_action.cgi", response="...", qop=auth, nc=00000003, cnonce="...", client=APP
```

The process counter advances by two for any later APP login in the same script run. Query and header use separate, internally consistent nonce counts, `cnonce` values, and Digest responses. The non-standard `client=APP` marker appears both in the login query and as an unquoted trailing Digest auth parameter. It does not enter HA2 or the response hash. The recovered APP header also omits the optional Digest `opaque` parameter.

## 4. Subsequent XML API requests

The companion APP does **not** calculate a new Digest proof for each GET. Its shared HTTP client stores the login request's complete `Authorization` header and repeats that exact header—same `nc=00000003`, `cnonce`, and response—for `status1`, `reset`, and other command-on-read GETs. Those GETs do not advance the APP counter.

The same shared client also applies normal HTTP cookie handling. The project therefore forwards only cookies actually issued by the APP login and valid for the XML request's host/path/security scope. It never synthesizes the WebUI `locale`, `hard_ver`, or `platform` cookie.

## Minimal pseudocode

```javascript
const ha1 = md5(`${username}:${realm}:${password}`);

const loginQueryProof = digestProof("GET", "/cgi/protected.cgi", 2, randomCnonce());
const loginHeaderProof = digestProof("GET", "/cgi/xml_action.cgi", 3, randomCnonce());
const persistedAuthorization = appHeader(loginHeaderProof); // includes client=APP

await get(loginUrl(loginQueryProof), { Authorization: persistedAuthorization });
const appCookies = scopedResponseCookies();
await get(status1Url, { Authorization: persistedAuthorization, Cookie: appCookies });
await get(resetUrl,   { Authorization: persistedAuthorization, Cookie: appCookies });
```

## Practical notes

- The router is normally reached over plain HTTP on the local network. Digest protects the password from being sent literally, but it does **not** encrypt traffic.
- A `401`, or XML `login_status` value `UNAUTHORIZED`, `TIMEOUT`, or `KICKOFF`, means the APP session cannot authorize the command.
- The recovered client disables redirects. The project does the same and rejects redirects, HTML, and non-XML text instead of treating a final login page with HTTP 200 as command acceptance.
- Restart and power-off create a fresh APP session, perform a harmless APP-authenticated `status1` identity probe, and then submit exactly one destructive GET. They do not retry after an authentication failure, timeout, or connection loss.
- The project treats the exact request path `/cgi/xml_action.cgi` as part of the Digest contract. Changing the URI used in HA2 breaks authentication.

**Confidence:** companion-client-confirmed byte-level session behavior / project implementation; persisted-header live side effect pending
**Provenance:** `project-client`, `android-apk`, `live-device`
