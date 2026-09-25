# Issue #4 - extract auth, transport and privacy behavior

Baseline: `6358af4d0d756df9d9fea9ebc372a5c3379744d7`.

## Direction

Extract the pinned upstream implementation, adapting only what issue #4 and the
existing lifecycle require. This is not an upstream improvement project. Keep
native/dependency versions, wire behavior and proxy selection. Do not add a
native fork, replacement proxy stack, helper process, generic adapter framework
or another authentication system.

The user's direction supersedes the earlier plan's proposed native/proxy repair
prerequisites. Known upstream limitations are recorded, not converted into new
work packages before extraction. This does not claim those limitations are fixed
or waive the issue's cleanup/privacy requirements.

The contract remains [issue #4](https://github.com/skhlo/pi-live/issues/4), the
[parent SPEC](https://github.com/skhlo/pi-live/issues/1) section 7 budgets, and
[#3](https://github.com/skhlo/pi-live/issues/3)'s accepted lifecycle refinements.
Package and lifecycle evidence are accepted. This turn authorizes revising and
committing the plan, not runtime implementation or real-access testing.

## Keep the change small

- Adapt `upstream/pi-live/src/live/{transport,protocol,native,attestation}.ts`
  and the registry-credential parsing into the owned `src/live.ts` implementation.
  The upstream snapshot remains immutable and is never runtime-loaded.
- Reuse #3's ownership, generation fences, resource obligations, mute behavior,
  deadlines and sticky blocked cleanup. Do not build another state machine.
- Keep `index.ts` and the shipped setup-only controls unchanged. #5 enables the
  UI and owns Pi delegation admission, correlation and final-result eligibility.
- Use existing dependencies and private real/fake seams. Add focused tests under
  `scripts/`, reusing existing fixtures instead of inventing a test framework.
- Keep package/lock, native pins, notices and extraction receipts unchanged.
  Ask before adding a dependency, including missing type packages.

## Implementation order

### 1. Connect the existing lifecycle to call-scoped preparation

Keep credentials, attestation, session identifiers and resource handles local to
one call attempt. Pass preparation results forward rather than storing late
results in a shared object that a later call could reuse.

Pass the existing monotonic total-connect deadline through the transport. Replace
the current ten-second limit around the entire fake `connect()` with the total
remaining budget; enforce the individual native/sideband phases inside it.
Retain phase tests when moving the guard.

Use `Float32Array` for microphone samples. Bind incoming events, failures and
outgoing completions to the current generation. Keep the existing controls and
read-only snapshot; expose no credential or socket state to the Pi caller.

### 2. Adapt credentials and attestation

- Resolve only through
  `ctx.modelRegistry.getApiKeyForProvider("openai-codex")`, once per attempt,
  after consent and ownership. Let Pi own refresh and serialized storage.
- Reuse applicable upstream parsing on that result, with byte bounds, usable
  expiry and account validation. No raw `auth.json`, pooling resolution, fallback
  account, new credential format or load-time auth. JWT decoding extracts an
  identity; it does not verify a signature.
- Pin the account/token for the call. Discard late results after timeout/stop;
  never use them to resume setup or overwrite another generation.
- Preserve DeviceCheck's bundle identifier, locale/timezone, app identifier and
  CBOR/header format. Validate sizes before encoding. Distinguish an explicit
  unsupported result from errors, timeout and cancellation; do not retry by
  silently omitting attestation.
- Complete these data-only waits before constructing a peer. Native offer/open
  and capture operations remain resource-bearing.

Test refresh through the actual Pi 0.87.1 registry using an injected fake
credential store and in-process OAuth behavior. Cover valid, refreshing, failed,
concurrent and late results without reading real credentials or contacting OAuth.

### 3. Adapt signaling and sideband

Preserve the upstream signaling POST, fixed
`wss://api.openai.com/v1/live/<call-id>`, `gpt-live-1-codex`, Quicksilver v2 and
Codex Desktop compatibility headers. Preserve Pi's session ID in both
`session-id` and `thread-id`, with one fresh `x-session-id` per call shared by
signaling and sideband attempts. These are retained behaviors, not claims about
what the provider requires.

- Disable signaling redirects and never retry the POST.
- Stream and bound the answer/non-OK body rather than reading an unbounded body
  and truncating it afterward. Never print response bodies.
- Validate bounded Location syntax/origin and `rtc_` ID; reject userinfo, query,
  fragment and ambiguous paths. Always build sideband on the fixed origin.
  Start with the pinned fixture's `/v1/live/<id>` shape on `api.openai.com` and
  its root-relative form; actual permitted shape remains for the authorized
  canary, not something fake tests establish.
- Set explicit WebSocket no-redirect and 256 KiB `maxPayload` options.
- Retry only classified pre-open transient network/5xx failures, at most three
  total attempts under the original connect deadline. Preserve the short
  upstream backoff pattern. No auth/permission/malformed-data/cancellation
  retry, account fallback, retry after open or public Realtime substitution.
- Honor the existing proxy environment through the pinned dependencies. Track
  call-owned requests, dispatchers, agents, sockets and pending connection work;
  do not equate `close()`/`terminate()` invocation with confirmed disposal.
- Use public dependency methods, not patches to their internals. An unresolved
  operation remains a cleanup obligation and prevents an overlapping retry.

HTTP/WebSocket proxy use does not establish that native WebRTC/ICE is proxied.
Keep that limitation visible rather than building a media-routing solution.

### 4. Add the issue's application bounds and writer

Centralize the parent limits. Count UTF-8 bytes before parsing, copying or
accumulating. Maxima are inclusive; test the boundary and the next unit.

| Area                                            | Required limit and response                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Total connect                                   | 30 s from acquiring; every phase/read/backoff consumes it                                   |
| Credentials / DeviceCheck                       | 5 s each, capped by remaining connect time; stop and discard late data                      |
| Offer / answer / native open / sideband attempt | 10 s each, capped by remaining connect time                                                 |
| Stop observation                                | 5 s from first fence; preserve #3's off, blocked and release-pending outcomes               |
| Individual send                                 | 5 s including its capacity wait; close also capped by remaining stop time                   |
| SDP offer / answer                              | 1 MiB each; reject overflow, stop streamed answer at limit + 1                              |
| Serialized signaling request                    | 2 MiB including escaped SDP/instructions                                                    |
| Access token / account ID                       | 16 KiB / 256 bytes; validate before headers                                                 |
| DeviceCheck / attestation header                | 8 KiB decoded token / 16 KiB complete serialized header                                     |
| Combined application headers                    | 64 KiB serialized; reject before sending                                                    |
| Non-OK body                                     | Discard at most 8 KiB, then cancel; never print                                             |
| Microphone callback                             | Mono Float32Array, at most 16,000 finite samples                                            |
| Microphone rate                                 | 32,000-sample bucket, refill 16,000/s; invalid/overflow ends call                           |
| Inbound native event / sideband frame           | 256 KiB before JSON parse                                                                   |
| Event rate                                      | Shared 200-event bucket, refill 200/s; count before dispatch                                |
| Request / transcript / final                    | 64 KiB each; reject request, retain transcript tail, truncate final with marker             |
| ID / content entries / seen IDs                 | 256 bytes / 64 / 256 per call; reject invalid/exhausted state, never evict to permit replay |
| Context chunks                                  | At most 500 UTF-8 bytes each                                                                |
| Unsent work                                     | At most 256 fragments and 256 KiB serialized pending envelopes                              |
| WebSocket buffered bytes                        | 256 KiB high-water; checked sends, wait for capacity                                        |
| Transcript history                              | Latest bounded turn per role only; no persisted audio/transcript ledger                     |

Preserve #3's 60-minute total-call and 30-minute admitted-work deadlines. #5 owns
the five-second receipt-ingestion limit; transport does not invent a second
receipt mechanism.

Validate both native and sideband ingress before dispatch. Track bounded seen
IDs and request fingerprints: identical repeats do not execute again, changed
content for the same ID fails, and a 257th new ID ends the call. #5 still owns
whether a validated request may enter Pi.

Send only an eligible final supplied by #5, under the existing `Agent Final
Message` convention. Generate its 500-byte chunks incrementally. Account for
JSON escaping and existing envelopes before producing the next one. A valid
final may exceed 256 KiB serialized over its lifetime; it waits for current
capacity instead of eagerly allocating all chunks and failing.

Use checked WebSocket send completion and bounded capacity waiting. Bound
producer admission too, so waiting promises do not become an uncounted queue.
Account for dependency control traffic: disable automatic pongs if they bypass
our send accounting, count ping/pong ingress and send any required reply through
the same bounded writer. Do not add a separate heartbeat subsystem.

### 5. Finish cleanup and closed diagnostics

Stop fences delivery immediately, discards queued context/finals, cancels retries
and begins capture/peer/socket cleanup independently of the send queue. Allow at
most one bounded fixed `session.close`; it must not delay local cleanup. No new
sample, context or final sends after the fence. Already buffered media cannot be
retracted.

Join tracked startup and shutdown work. Dispose late resources without adopting
them. Preserve sticky blocked cleanup and release ownership only under #3's
confirmed-quiescence rule. Do not use a timeout as proof of cancellation.

Emit only `busy`, `missing-auth`, `denied`, `connect-timeout`, `protocol-error`,
`audio-error` and `cleanup-blocked`, with fixed text/phase, safe numeric HTTP
status and optional dependency version. Never attach raw error message/cause/
stack, body, SDP, credential/header value or credential-bearing proxy URL.
Account for dependency debug output too; refuse a logging configuration that
would expose secrets rather than add a debug escape hatch or modify global Pi
logging.

## Known upstream limits - disclose, do not repair here

Static inspection of the pinned native source and installed dependencies found:

- Native peer close suppresses some peer/speaker errors and does not join every
  task. Pending offer/answer work also needs separate tracking. A fulfilled
  native close promise alone is not new proof of hidden task/device termination.
- Native playback uses an unbounded queue; DeviceCheck's internal timeout leaks a
  sender allocation per timeout. TypeScript limits do not bound native internals.
- The pinned proxy agent accumulates CONNECT headers internally and does not
  make its pending socket's cancellation evident through WebSocket close alone.
- Proxy dependency debug logging can print proxy URLs and response headers.

These are limitations of the retained dependencies, not assignments to fork or
replace them. Native source inspected was
`can1357/oh-my-pi@f7f8e040ee04710414fbd775431091fa301b9786`, principally
`crates/pi-voice/src/{live,audio}.rs` and
`crates/pi-natives/src/{live,audio,devicecheck}.rs`. The files matched the retained
source evidence manifest; no native code ran.

Proceed with extraction and application-owned guards, not an upstream repair
phase. Where a requirement cannot be established through the retained interface,
report the exact acceptance gap rather than weaken the requirement or expand
scope. Do not claim complete #4/native-cleanup acceptance from fake success.
Operational testing remains separately authorized; no real credentials,
DeviceCheck, microphone/speaker, provider access or canary is granted here.

## Verification and handoff

Add focused auth, transport and privacy suites. Reuse existing lifecycle/SDK
fixtures and preserve their distinct regression cases. Tests must exercise the
owned implementation, not a duplicate model. Cover:

- All exact limits and +1, multibyte text and JSON escaping.
- Refresh and late credentials; unsupported/error/never/late attestation.
- Redirects, status/retry matrix, cancellation, proxy selection and pending close.
- Shared audio/event buckets, duplicate IDs and bounded transcript/final handling.
- Draining/stalled buffers, checked send failures and stop during queued work.
- Never/late native promises, stale callbacks, release-pending and blocked cleanup.
- Synthetic secrets absent from diagnostics, callbacks and captured output.
- Two behavioral mutations: remove one bound and permit raw error text; each
  corresponding test must fail. Recheck generation and release guards after
  changing their seams.

Run `test`, `typecheck`, `format:check`, `check:source`, `check:package` and the
macOS-arm64 `check:loader`, using the README's four pnpm refusal-policy flags.
New provider/native tests use fake adapters, empty fixture stores/homes,
`--no-addons` and exercised OS-enforced network denial. Preserve the existing
sandbox exclusions/disclosures. Historical transfer tests stay intact; do not
rewrite the extraction receipt. The real `check:production` install/fetch still
needs separate approval.

Record the effective source/dependency identities, checks, mutations and remaining
upstream/real-access limits in `docs/ISSUE-4-VERIFICATION.md`. Keep the shipped
factory setup-only. G3 also needs #5's delivery evidence; this work does not enable
calls, certify real native shutdown or authorize publication/adoption.
