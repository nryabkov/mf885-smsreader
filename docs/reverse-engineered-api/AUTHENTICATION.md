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

The project's fresh APP session starts this proof at nonce count 1:

```text
nc = 00000001
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
nc_header = 00000002
response_xml = MD5(HA1 + ":" + nonce + ":" + nc_header + ":" + cnonce2 + ":" + qop + ":" + HA2_xml)
```

Header shape:

```http
Authorization: Digest username="admin", realm="...", nonce="...", uri="/cgi/xml_action.cgi", response="...", qop=auth, nc=00000002, cnonce="...", client=APP
```

The recovered ZMI 1.2.42 client initializes its process counter differently, so its first observed pair is 2/3 rather than the project's 1/2. The protocol invariant is not a magic starting number: query and header must use separate, internally consistent nonce counts, `cnonce` values, and Digest responses. The non-standard `client=APP` marker appears both in the login query and as an unquoted trailing Digest auth parameter. It does not enter HA2 or the response hash.

## 4. Subsequent XML API requests

After the APP login consumes nonce counts 1 and 2, the first normal APP XML API call uses nonce count 3:

```text
00000003
```

For a GET request:

```text
HA2 = MD5("GET:/cgi/xml_action.cgi")
```

For a POST request:

```text
HA2 = MD5("POST:/cgi/xml_action.cgi")
```

Then calculate the normal RFC-style Digest response using the same `realm`, `nonce`, `qop` and `HA1`.

## Minimal pseudocode

```javascript
const ha1 = md5(`${username}:${realm}:${password}`);

function appAuthHeader(method, nonce, qop, nc, ha1) {
  const ncHex = Number(nc).toString(16).padStart(8, "0");
  const cnonce = randomCnonce();
  const ha2 = md5(`${method}:/cgi/xml_action.cgi`);
  const response = md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`);

  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", ` +
    `uri="/cgi/xml_action.cgi", response="${response}", qop=${qop}, ` +
    `nc=${ncHex}, cnonce="${cnonce}", client=APP`;
}
```

## Practical notes

- The router is normally reached over plain HTTP on the local network. Digest protects the password from being sent literally, but it does **not** encrypt traffic.
- A `401`, or XML `login_status` value `UNAUTHORIZED`, `TIMEOUT`, or `KICKOFF`, means the APP session cannot authorize the command.
- Restart and power-off create a fresh APP session, perform a harmless APP-authenticated `status1` identity probe, and then submit exactly one destructive GET. They do not retry after an authentication failure, timeout, or connection loss.
- The project treats the exact request path `/cgi/xml_action.cgi` as part of the Digest contract. Changing the URI used in HA2 breaks authentication.

**Confidence:** companion-client-confirmed request shape / project implementation; corrected live side effect pending
**Provenance:** `project-client`, `android-apk`, `live-device`
