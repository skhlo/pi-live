# Luna bounded probe 3: transport, auth, and privacy contracts

Status: research only. No implementation was made. The final recorded probe
run made no provider request.

The inspected source is `/tmp/pi-better-openai.qnz8hk` at
`39171682343754366439b2c0890f5b0f4c3ed891`. Its only pre-existing worktree change
was `bun.lock`; it was not changed. The probe used synthetic tokens, account IDs,
UUIDs, JWTs, proxy URLs, SDP, and text. It did not read a real auth file, open a
microphone, or contact a provider. `undici` and `ws` were aliased to local fakes
in the probe harness. The source native-loader test only loaded the installed
addon and initialized its runtime; it did not open a media device.

During harness bring-up, several discarded revisions used an ineffective
Vitest module mock and reached the real undici fetch path with only synthetic
credentials before the tests failed. They are excluded from the results below;
I cannot verify whether a socket was established. The final harness uses explicit
local module aliases and the recorded run was provider-free.

## Reproduction

The retained ignored harness is under `preview/live-spec/transport/`:

- `probe.test.ts` - deterministic probes.
- `fake-undici.ts` and `fake-ws.ts` - local transport fakes.
- `vitest.config.ts` - aliases the two transport dependencies to those fakes.

Run the probes from any directory:

```sh
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy NO_PROXY='*' \
  /tmp/pi-better-openai.qnz8hk/node_modules/.bin/vitest run \
  --root /private/tmp/dotfiles-pi-live-spec/preview/live-spec/transport \
  --config /private/tmp/dotfiles-pi-live-spec/preview/live-spec/transport/vitest.config.ts \
  probe.test.ts --reporter verbose
```

Run the inspected source tests without credentials or provider traffic:

```sh
cd /tmp/pi-better-openai.qnz8hk && \
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy NO_PROXY='*' \
  node_modules/.bin/vitest run \
  tests/live-transport.test.ts tests/live-native.test.ts tests/live-protocol.test.ts \
  tests/live-controller.test.ts tests/live-queue.test.ts tests/live-registration.test.ts \
  tests/multiprovider.test.ts tests/format.test.ts --reporter verbose
```

Probe result: **7/7 passed**. Source result: **42/42 tests passed** across 8
files. The probe output was:

```text
oversized-text: inputBytes=1048576 chunks=2098 maxChunkBytes=500
duplicate-delegation: delegateCalls=2
sanitizer-auth: rawJwtLeaks=true bearerJwtRedacted=true accountMasked=true uuidLeaks=true proxyPasswordLeaks=true selectedSource=multiprovider
abort-createOffer: connectAfterAbort=pending peerCloseCalls=1
abort-waitForOpen: connectAfterAbort=pending peerCloseCalls=1
abort-deviceCheck: resultAfterTimeout=pending acceptsAbortSignal=false
websocket-backpressure: bufferedAmount=16777216 sends=32
```

## Confirmed probe findings

### Text bounds and duplicate delivery

`parseLiveServerEvent` accepted a 1 MiB JSON-encoded delegation text and a 1 MiB
transcript. `chunkLiveContext` reassembled the delegation into 2,098 chunks and
kept each outgoing chunk at at most 500 UTF-8 bytes. The chunk bound is per chunk,
not a bound on the event, turn, delegation, total bytes, or number of chunks.
There is no inbound text limit in the parser. See
`src/live/protocol.ts:L1-L3,L96-L132,L144-L165,L212-L234` and the existing UTF-8
chunk test at `tests/live-protocol.test.ts:L97-L117`.

Delivering the same `delegation.created` event with the same ID twice called the
client `delegate` callback twice. The controller replaces the active ID and has
no seen-ID set or idempotency check. See `src/live/controller.ts:L316-L361`.

### Sanitizer and synthetic auth probe

The probe used a synthetic JWT whose payload contained
`chatgpt_account_id: "acct_probe_123456"`, the UUID
`123e4567-e89b-12d3-a456-426614174000`, and the proxy URL
`https://proxy-user:proxy-secret@example.test:8443`.

- A JWT in `Authorization: Bearer ...` was changed to
  `Authorization: [REDACTED] [REDACTED]` by the overlapping sanitizer patterns.
- The same JWT in ordinary text (`jwt=...`) remained unchanged.
- An `acct_...` account string was masked.
- The free-form UUID remained unchanged.
- The proxy URL password remained unchanged.
- `redactDiagnosticValue` protected `accessToken` and `accountId` fields, but a
  `proxyUrl` string still contained `proxy-secret`.
- The fake multiprovider credential was selected and the fake model registry was
  not called. No auth-file fallback was entered.

These are direct results of `src/format.ts:L6-L22,L64-L104` and
`src/codex-auth.ts:L57-L100,L126-L159`. The existing redaction test only covers
secret-like field names and Bearer/sk/acct patterns at
`tests/format.test.ts:L22-L47`.

### Abort while native work is pending

With a fake native peer whose `createOffer()` never resolved, abort followed by
`close()` invoked `peer.close()` once, but `connect()` was still pending after a
short deterministic wait. Releasing the fake promise then let `connect()` reject
with `AbortError`.

The same result occurred when signaling was fully fake and
`waitForOpen()` never resolved. A fake DeviceCheck promise also left
`generateCodexAttestation()` pending; the function has no `AbortSignal` parameter.
Releasing the fake token allowed it to complete.

This confirms that the transport abort path aborts its own signal and runs native
cleanup, but does not cancel or race the native promises. See
`src/live/transport.ts:L145-L184,L415-L445`,
`src/live/attestation.ts:L75-L86`, and the native promise contracts at
`src/live/native.ts:L14-L42`.

### WebSocket backpressure

A fake connected socket was marked with `bufferedAmount = 16 MiB`. Thirty-two
`send()` calls all ran and the buffered amount was not consulted or reduced by the
application. `CodexLiveTransport.send()` serializes calls with a Promise tail but
does not inspect `bufferedAmount`, use the `ws.send` callback, or wait for a drain
condition. See `src/live/transport.ts:L392-L407`.

The installed `ws@8.21.2` has an implicit default `maxPayload` of 100 MiB and
`followRedirects: false` in `node_modules/ws/lib/websocket.js:L643-L679`. That is
not an application-level message, event-count, or backpressure contract.

## Attestation and privacy data

On Darwin arm64 only, `generateCodexAttestation()` calls the native
`deviceCheckGenerateToken()` before signaling. Other supported platforms omit the
attestation header. A successful result is wrapped as
`{"v":1,"s":0,"t":"v1.<base64url-CBOR>"}`. The CBOR map contains:

- `token` with the native `tokenBase64` when `supported` is true and a token is
  present; otherwise `error_code` is `4` for supported-without-token or `3` for
  unsupported.
- `bundle_id: "com.openai.codex"`.
- `f`, a CBOR byte string containing signals: a fixed version value, the locale
  as a preferred-language entry, the locale, the timezone, two fixed numeric
  values, and a module-load `crypto.randomUUID()` value.
- `t`, the native latency as a CBOR float when it is finite.

Locale and timezone strings are sliced to 64 JavaScript characters. The native
`error` field is not included. The token has no source-level byte bound, and the
DeviceCheck promise has no signal or deadline. See
`src/live/attestation.ts:L3-L4,L40-L72,L75-L86`.

The provider-facing data set is therefore: bearer access token and account ID;
Pi session ID and a separate realtime UUID; fixed Codex Desktop/version headers;
WebRTC SDP offer; fixed live instructions; configured voice and model; optional
DeviceCheck token/attestation, locale, timezone, and app-session UUID; and live
context text containing delegated coding progress and the final agent message.
The native WebRTC path additionally receives microphone sample arrays. The
controller sends the same delegation request into the coding agent, so the text
can exist both in the provider context and the local agent message stream. No
source path persists raw audio or transcript text to disk, but in-memory strings,
Promise queues, provider buffers, and UI/session messages can retain it until
cleanup completes.

## Static transport contract

### Endpoints and request data

The source has two provider endpoints (`src/live/transport.ts:L15-L20,L252-L267`):

1. Signaling: `POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`.
2. Sideband: `wss://api.openai.com/v1/live/<encoded-call-id>`.

`getProxyForUrl()` is called separately for each URL. Signaling uses an undici
`ProxyAgent`; sideband uses `HttpsProxyAgent` (`transport.ts:L186-L227,L252-L267`).
Proxy URL credentials therefore enter the dependency agent even though the
source has no proxy-credential abstraction.

The application-provided headers are built at `transport.ts:L94-L112`:

```text
Authorization: Bearer <accessToken>
OpenAI-Alpha: quicksilver=v2
User-Agent: Codex Desktop/0.144.1
x-session-id: <module-instance random UUID>
originator: Codex Desktop
version: 0.144.1
session-id: <Pi session ID>
thread-id: <same Pi session ID>
chatgpt-account-id: <accountId>
x-oai-attestation: <optional JSON attestation>
```

The signaling request adds `Accept: */*` and `Content-Type: application/json`.
Its JSON body is constructed at `transport.ts:L186-L225` and
`protocol.ts:L168-L175`:

```json
{
  "sdp": "<native WebRTC offer>",
  "session": {
    "model": "gpt-live-1-codex",
    "instructions": "<fixed live instructions>",
    "audio": { "output": { "voice": "<configured voice>" } },
    "delegation": { "type": "client" }
  }
}
```

The SDP can contain the native WebRTC offer and its media/network details. The
fixed instructions tell the live model to create client delegations. The
configured voice, Pi session ID, account ID, bearer token, and optional
attestation are all sent as part of negotiation or headers.

After negotiation, the controller sends delegation context chunks, optional
`channel` values, and a final `"Agent Final Message"` context through the
sideband. It also sends `session.close` during cleanup. The message shapes are
at `src/live/protocol.ts:L16-L28,L177-L208`; the controller use is at
`src/live/controller.ts:L237-L266,L273-L301`. The delegation request is separately
copied into the coding agent with `display: true`, `details: { source: "live" }`,
`triggerTurn: true`, and `deliverAs: "steer"` at `src/live/index.ts:L176-L203`.

Native microphone samples are passed to the peer when the controller is active,
unmuted, and not suppressing likely speaker echo. Capture starts at 16,000 Hz
before transport negotiation completes (`src/live/controller.ts:L197-L219,
L364-L394`). The native peer is the component that sends those samples over the
WebRTC media path; that native implementation is outside this source checkout.
Incoming audio, transcripts, delegation events, and errors are parsed and routed
to callbacks at `src/live/transport.ts:L342-L390` and
`src/live/controller.ts:L316-L339`. Incoming transcript strings are retained in
controller state without a total-size limit (`controller.ts:L396-L456`).

### Response, redirects, and retry behavior

The signaling response body is always read in full with `response.text()` before
error truncation or SDP use (`transport.ts:L201-L225`). Error display is capped at
2,048 JavaScript characters after whitespace normalization, but the body read
itself has no byte cap. A successful response must be non-empty and must have a
`Location` containing a path segment matching `^rtc_[\\w-]+$`. The location host is
not validated; only the extracted call ID is used to build the fixed `api.openai.com`
sideband URL (`transport.ts:L68-L92,L214-L225`).

No `redirect` option is supplied to the signaling fetch. The installed
`undici@8.10.0` request implementation says the default is `follow` at
`node_modules/undici/lib/web/fetch/request.js:L703,L937`. A redirect policy is
therefore delegated to the HTTP client rather than made explicit by the source.
The installed `ws` client defaults to no redirect following, but the source also
does not set this option explicitly.

Sideband opening retries five times, with a 15-second open timeout per attempt and
200, 400, 800, and 1,600 ms waits between attempts
(`transport.ts:L19-L20,L231-L249,L268-L340`). This is approximately 78 seconds of
open-timeout and backoff budget before accounting for lower-level connection
behavior. All pre-open failures are retried with the same credentials and
attestation; there is no status/error classification and no credential refresh.
Signaling itself is attempted once. No reconnect is attempted after an already
open sideband closes.

## Auth selection, refresh, and fallback

The credential order is:

1. An active pi-multiprovider service, but only when a context is supplied.
   `resolveActiveAccountAuth("openai-codex", ctx, signal)` is awaited. The token
   is accepted only if its JWT payload has a non-empty
   `https://api.openai.com/auth.chatgpt_account_id` value.
2. `ctx.modelRegistry.getApiKeyForProvider("openai-codex")`. JSON values with
   `access` or `token` plus `accountId` or `account_id` are accepted; otherwise a
   raw JWT with the same account claim is accepted.
3. `~/.pi/agent/auth.json` (or `PI_CODING_AGENT_DIR/auth.json`) through the
   `openai-codex` entry, only when `type` is `oauth`, the access and account
   fields are present, and `expires` is absent or not reached.

The code and path derivation are at `src/codex-auth.ts:L7-L7,L57-L159` and
`src/paths.ts:L4-L14`. The multiprovider service shape is at
`src/multiprovider.ts:L6-L66`. The existing fake-only tests cover the first two
steps and fallback on missing, invalid, or rejecting multiprovider credentials at
`tests/multiprovider.test.ts:L42-L115`.

There is no refresh implementation in `codex-auth.ts`: the auth-file path only
checks expiry, and the registry path only parses the returned value. Any refresh
is an opaque responsibility of `resolveActiveAccountAuth`. A valid multiprovider
JWT is not signature-verified or expiry-checked here. A sideband retry reuses the
credential object selected before signaling; a 401/403 does not trigger a new
selection. `waitForSignal()` rejects its wrapper on abort but does not cancel the
underlying multiprovider or registry promise (`codex-auth.ts:L23-L55`).

The probe never called `readCodexAuth()`. The credential selection assertion
returned from the fake multiprovider before any registry or auth-file fallback.

## Native operations and cleanup promises

| Operation | Source behavior | Cleanup/limit observation |
| --- | --- | --- |
| Native package load | Resolve one of five platform/architecture package names; require it; validate four function exports; call `__ompInstallTokioRuntime()`; cache the default load (`native.ts:L45-L109`). | Runtime initialization is synchronous. There is no timeout around package load or runtime init. |
| `AudioCapture` | Construct with `16_000` and an audio callback before `transport.connect()` (`controller.ts:L197-L219`). | `stop()` is synchronous and called first in controller stop. Capture can start while auth, attestation, or signaling is pending. |
| `LiveWebRtcPeer` constructor | Register event, level, and failure callbacks (`transport.ts:L161-L173`; `native.ts:L14-L29`). | Callback errors become live error events; no callback count or payload bound. |
| `createOffer()` | Awaited before signaling (`transport.ts:L174-L180`). | No signal or source-imposed timeout. A never-resolving offer leaves `connect()` pending after close, as probed. |
| `acceptAnswer(sdp)` | Awaited after signaling (`transport.ts:L176-L178`). | No signal or source-imposed timeout. |
| `setMuted()` | Called after answer and for later mute changes (`transport.ts:L178,L410-L413`). | Synchronous interface; no error isolation around the initial call in `connect()`. |
| `waitForOpen()` | Called with no timeout argument (`transport.ts:L178-L180`). | Optional native timeout is not selected by this source. A never-resolving wait leaves `connect()` pending after close, as probed. |
| `pushAudio()` | Passes non-empty samples directly to the peer (`transport.ts:L405-L407`). | No sample-count or rate/byte validation in the TypeScript layer. |
| `deviceCheckGenerateToken()` | Called only on Darwin arm64 before signaling; result is encoded into attestation (`attestation.ts:L75-L86`). | No `AbortSignal` or timeout. A pending promise leaves attestation pending, as probed. Errors silently omit attestation. |
| WebSocket close/terminate | Abort and timeout call `close`; pre-open error calls `terminate`; transport close calls `close` for open/connecting sockets (`transport.ts:L268-L340,L424-L440`). | Socket close is not awaited. Peer `close()` is awaited, but errors are swallowed during transport cleanup. |
| HTTP proxy close | `ProxyAgent.close()` is awaited in the signaling `finally` block (`transport.ts:L198-L228`). | No separate close deadline. |

Controller cleanup first stops capture, then awaits the entire `#sendChain`, sends
`session.close`, and awaits transport close (`controller.ts:L268-L301`). Thus a
stuck sideband send can prevent the rest of cleanup. Floor deactivation starts
`current.stop()` without awaiting it, while final UI disposal does await the
current session (`src/live/index.ts:L167-L174,L214-L236`). Queue heartbeat and
stale-member constants are 1 second and 8 seconds (`src/live/queue.ts:L31-L32`),
but they do not bound the live transport itself.

## Missing bounds and ownership risks

The following are static findings from the pinned source and installed dependency
code, not provider observations:

| Area | Present behavior | Missing contract |
| --- | --- | --- |
| Time | Sideband open has 5 attempts and 15 seconds each; retry waits are abortable. | No overall connect deadline; no source timeout for credentials, DeviceCheck, offer, answer, native open, peer close, response body, proxy close, or queued sends. |
| Bytes | 500-byte outgoing context chunks; 2,048-character non-OK error display; `ws` implicit 100 MiB payload default. | No inbound event/text total, delegation/transcript total, SDP body, successful response, token, audio sample, or application frame limit. The error body is read before it is truncated. |
| Message count | Promise tails preserve send order. | No maximum delegation/content entries, inbound event count, outgoing append count, retry count by reason, or queued message count. |
| Queues | `CodexLiveTransport.#sendTail` and `LiveSessionController.#sendChain` serialize work. | Both can grow without a byte/count cap. Controller stop waits for the chain, so queue growth and a stuck send delay cleanup. |
| WebSocket backpressure | `sideband.send(JSON.stringify(message))` is called in order. | No `bufferedAmount` threshold, callback/drain wait, serialized-message cap, or policy for rejecting/dropping queued context. The fake 16 MiB probe sent all 32 messages. |
| Redirects | `ws` dependency default is no-follow; `undici` fetch default is follow. | Signaling does not set `redirect: "error"`; no redirect count/host policy is owned by this code. `Location` call-ID extraction does not validate the signaling origin. |
| Credentials | Multiprovider -> registry -> auth-file fallback; sideband retries reuse the selected object. | No refresh owner for registry/auth-file credentials, no auth-failure retry policy, no expiry/signature/audience validation, and no bound on resolver promises. Abort can leave underlying resolver work running. |
| Retry ownership | Transport owns sideband open retries; signaling and send have no retry loop. | No classification for auth versus transient errors and no single owner for refresh/retry. The five attempts can repeat an invalid credential. |
| Privacy/error text | Known secret-shaped fields and a few token forms are redacted at UI formatting time. | Raw JWTs, free-form UUIDs, arbitrary account IDs, and proxy URL passwords can remain in diagnostic strings. Transport error events are not sanitized at the transport boundary. |
| Delivery identity | Transcript state suppresses a few repeated fragments; delegation IDs are not tracked. | No idempotency contract for repeated `delegation.created` events or a second delegation while one is active. |

## Recommended concrete constraints and tests

These are bounded follow-up recommendations, not an implementation or a complete
live-session specification.

- Give every awaited external/native operation a signal-aware deadline. A useful
  first test budget is 5 seconds for credential/DeviceCheck work, 10 seconds for
  offer/answer/native-open, 30 seconds for the complete connect, and 5 seconds
  for peer/socket cleanup. On expiry, reject the operation, terminate the stale
  socket if needed, and make `close()` settle exactly once.
- Set an explicit signaling policy of `redirect: "error"`; require the expected
  HTTPS origin and an exact call-ID location shape. Add tests for same-origin,
  cross-origin, relative, query-only, malformed, and repeated redirects.
- Make the sideband retry policy explicit: for example, at most 3 attempts within
  a 30-second total deadline, retrying only transport/5xx failures and not 401,
  403, malformed SDP, or invalid call IDs. Give credential refresh one owner and
  at most one refresh/retry cycle.
- Add application limits independent of dependency defaults. Candidate starting
  values are 256 KiB per inbound WebSocket frame, 64 KiB per transcript or
  delegation text, 256 KiB per delegation total, 1 MiB per signaling/SDP body,
  128 queued outbound messages, and 1 MiB of queued serialized bytes. Test exact
  limit, limit plus one, multibyte UTF-8, many small content entries, and a long
  error body whose transport read must stop rather than merely truncate later.
- Set an explicit WebSocket `maxPayload` below the dependency's 100 MiB default.
  Bound serialized outgoing messages and gate on `bufferedAmount` or the `ws`
  send callback. Test a blocked socket, a high buffered amount, queue overflow,
  close during a queued send, and preservation of session-close delivery.
- Define delegation idempotency by ID. At minimum, repeat the same ID and assert
  one client delivery; test a repeated ID with changed content and a new ID while
  the old agent run is active. Define whether the old run is cancelled, queued, or
  replaced.
- Bound transcript accumulation and test partial fragments, repeated fragments,
  `turn.done` after a partial, a 1 MiB fragment, and alternating roles. Keep the
  existing 500-byte UTF-8 chunk test as a per-message invariant, not as the total
  bound.
- Expand sanitizer tests for raw and Bearer JWTs, JWTs in URLs and JSON, UUIDs in
  free text and `sessionId` fields, arbitrary account IDs, `acct_` IDs, URL user
  info with percent-encoded passwords, `Proxy-Authorization`, ANSI/control bytes,
  and strings over the length limit. Assert that no synthetic secret survives the
  final user-visible diagnostic.
- Add fake-only auth tests for a valid/invalid/rejecting/never-resolving
  multiprovider resolver, registry JSON and raw JWT forms, expiry, abort, and
  fallback. Inject an auth reader for the auth-file branch; do not create or read
  a real `auth.json` in the test.
- Add never-resolving tests for `createOffer`, `acceptAnswer`, `waitForOpen`,
  DeviceCheck, credential resolution, `response.text()`, `ProxyAgent.close`,
  `peer.close`, WebSocket open, and `transport.send`. Each must assert bounded
  `connect()`/`close()` completion, one terminal callback, no stale socket, and no
  second delegation or cleanup race.

## Dependency and platform facts

These facts come from installed/package metadata, not the project README:

- Root package `@monotykamary/pi-better-openai@0.2.6` requires Node `>=22.19.0`
  and pins `undici@8.10.0`, `ws@8.21.2`, `https-proxy-agent@9.1.0`, and
  `proxy-from-env@2.1.0` in `package.json:L1-L3,L57-L62,L97-L98`.
- Installed metadata reports `undici@8.10.0` Node `>=22.19.0`,
  `https-proxy-agent@9.1.0` Node `>=20`, `ws@8.21.2` Node `>=10`, and
  `proxy-from-env@2.1.0` Node `>=10`.
- Root optional native dependencies pin `17.2.9` for Darwin arm64, Darwin x64,
  Linux arm64, Linux x64, and Windows x64 (`package.json:L81-L86`). The native
  source maps exactly those five target names at `src/live/native.ts:L45-L55`.
- The installed current-host addon is
  `@oh-my-pi/pi-natives-darwin-arm64@17.2.9`, with package metadata `os: ["darwin"]`,
  `cpu: ["arm64"]`, and Bun `>=1.3.14`. The probe host reported Node `v26.6.0`,
  Darwin arm64, and Bun `1.3.14`. The installed Vitest used by both commands was
  `4.1.11` (the root package range is `^4.1.5`).

## Source/test map

- Transport: `src/live/transport.ts:L15-L20,L57-L112,L115-L143,L145-L229,L231-L340,L342-L445`.
- Native loader and interfaces: `src/live/native.ts:L3-L109`.
- Attestation: `src/live/attestation.ts:L3-L86`.
- Protocol/parser/chunking: `src/live/protocol.ts:L1-L234`.
- Auth and fallback: `src/codex-auth.ts:L7-L159`; multiprovider bridge:
  `src/multiprovider.ts:L6-L66`.
- Sanitization: `src/format.ts:L6-L104`.
- Controller delivery and cleanup: `src/live/controller.ts:L172-L301,L316-L469`.
- Registration/floor cleanup: `src/live/index.ts:L167-L250,L332-L349`; queue timing:
  `src/live/queue.ts:L31-L32,L223-L245`.
- Existing tests read and run: `tests/live-transport.test.ts`,
  `tests/live-native.test.ts`, `tests/live-protocol.test.ts`,
  `tests/live-controller.test.ts`, `tests/live-queue.test.ts`,
  `tests/live-registration.test.ts`, `tests/multiprovider.test.ts`, and
  `tests/format.test.ts`.
