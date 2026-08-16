# Authentication

The MF855/MF885 web interface uses HTTP Digest authentication, but its login flow has a vendor-specific quirk: the login query and the `Authorization` header are calculated against **different request URIs**.

This project already implements the working sequence in `scriptable.js` / the API helpers. The description below documents the observed 2.5.x behaviour.

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

Using nonce count 1:

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
  temp=marvell
```

## 3. Build the login request's Authorization header

The same HTTP request also carries a Digest `Authorization` header, but **this response is calculated for `/cgi/xml_action.cgi`**, not `/cgi/protected.cgi`:

```text
HA2_xml = MD5("GET:/cgi/xml_action.cgi")
response_xml = MD5(HA1 + ":" + nonce + ":" + nc + ":" + cnonce2 + ":" + qop + ":" + HA2_xml)
```

Header shape:

```http
Authorization: Digest username="admin", realm="...", nonce="...", uri="/cgi/xml_action.cgi", response="...", qop=auth, nc=00000001, cnonce="..."
```

The query-string `cnonce` and the header `cnonce` need not be the same in the working implementation; what matters is that each Digest response is calculated consistently with the values carried in that part of the request.

## 4. Subsequent XML API requests

After the login request consumes nonce count 1, the first normal XML API call uses nonce count 2:

```text
00000002
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

function authHeader(method, nonce, qop, nc, ha1) {
  const ncHex = Number(nc).toString(16).padStart(8, "0");
  const cnonce = randomCnonce();
  const ha2 = md5(`${method}:/cgi/xml_action.cgi`);
  const response = md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`);

  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", ` +
    `uri="/cgi/xml_action.cgi", response="${response}", qop=${qop}, ` +
    `nc=${ncHex}, cnonce="${cnonce}"`;
}
```

## Practical notes

- The router is normally reached over plain HTTP on the local network. Digest protects the password from being sent literally, but it does **not** encrypt traffic.
- A `401` can mean an expired/invalid nonce or a failed session. Re-authenticate rather than blindly replaying state-changing POSTs.
- For destructive commands, disable automatic retry entirely—including after `401` or XML `unauthorized`. The project refreshes identity/session state with `status1` before the one-shot request; restart/shutdown can then drop the connection before a response arrives.
- The project treats the exact request path `/cgi/xml_action.cgi` as part of the Digest contract. Changing the URI used in HA2 breaks authentication.

**Confidence:** live-tested / project-client  
**Provenance:** `project-client`, `web-ui-js`, `live-device`
