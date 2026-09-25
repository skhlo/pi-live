# Issue #4 - extracted transport verification

## Scope and result

The user authorized execution of the [extraction plan](ISSUE-4-PLAN.md), with no
upstream repair project. The dormant implementation is in `src/live.ts`; the
shipped factory and setup-only controls are unchanged. Dependency/native pins,
package/lock, upstream snapshot, notices and historical receipts are unchanged.

Implemented application behavior includes registry-only credential resolution,
bounded attestation, pinned signaling/sideband protocol and identifiers, proxy
selection, classified pre-open retries, generation-scoped preparation, Float32
sample/rate limits, bounded ingress/transcripts/seen IDs, incremental final
encoding, checked backpressure and closed diagnostics.

This is local extraction evidence, **not complete #4/native-cleanup acceptance**.
Real native and proxied-sideband cleanup cannot be positively established through
the retained interfaces. Those real adapters perform cleanup but return
unconfirmed, so the lifecycle becomes sticky blocked rather than releasing the
owner. Confirmed fake resources exercise the successful stop/release path.
Nothing enables real calls or certifies account entitlement, media behavior,
DeviceCheck, end-to-end proxy routing or safe real-call restart.

## Effective identity

This receipt was captured from uncommitted implementation on
`feat/issue-4-extraction`, based on plan commit
`711f6efa0f08b043c6d63166884a31a486be5851`. The runtime hash below identifies the
checked implementation independently of its subsequent delivery commit.

| Input                        | SHA-256                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `src/live.ts`                | `ebf59022f2ebac4c1dfb8c7309b90bd9ddbd9ed1b728602d722fd36224e283b1` |
| `index.ts` (unchanged)       | `1b0642cbbf4334392e999e194bc47dfe9d1a83441844b0b2281bfcadee27e92d` |
| `package.json` (unchanged)   | `375d1573ff8f75c5255bbc82c29274bb2ca3c146a481d2d1f84d3241728ea276` |
| `pnpm-lock.yaml` (unchanged) | `7230a1cf633b74dc0fe3d7b6ec014f66edb636623a92e060dd75d0adf9d9e597` |

Host: macOS 27.0 arm64, Node 26.6.0, pnpm 11.8.0, Pi/TUI 0.87.1. Existing
installed dependencies were reused through the worktree's `node_modules` symlink;
no install/fetch or native import occurred. Minimum-supported Node and Linux were
not rerun. Test/helper identities and exact commands are retained in the local
receipt below.

## Verification

The complete current suite was split to preserve isolation: provider/SDK/resource
cases ran under OS network denial; loader tests used their own sandbox; the
existing special-permission fixture ran separately without the outer sandbox.
This was not one unrestricted `pnpm test` invocation.

| Check                                                                                | Result                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| All test files except loader, excluding the one sandbox-incompatible permission case | 376 passed under network denial and `--no-addons`            |
| Loader test file                                                                     | 4 passed; real isolated Pi loader, native execution disabled |
| Special-permission fixture                                                           | 1 passed separately, `--no-addons`                           |
| Complete suite across those runs                                                     | **381 passed**, no failing/cancelled cases                   |
| `typecheck`, `check:source`, `check:package`, `check:loader`                         | Passed                                                       |
| `format:check`, Git whitespace check                                                 | Passed                                                       |
| Bound-removal mutation                                                               | Failed behaviorally; baseline and rerun passed               |
| Raw-error diagnostic mutation                                                        | Failed behaviorally; baseline and rerun passed               |

Every pnpm invocation used:

```text
--config.auto-install-peers=false --config.ignore-scripts=true
--config.enable-global-virtual-store=false --config.verify-deps-before-run=error
```

The sandbox runner used `(version 1) (allow default) (deny network*)`, `env -i`,
empty fixture HOME/agent roots and `node --no-addons`. A real loopback bind
attempt returned `EPERM`. Account-home authority was injected for ownership
fixtures. No task test/contender process remains; fixture HOME and agent roots
contain no files.

The initial broad sandbox run failed only the already documented special
permission-bit fixture: its negative name regex did not exclude that case on
this Node version. The final run used `--test-skip-pattern` for that exact name;
it passed separately without the outer sandbox. The excluded case is not counted
as a sandbox pass even though Node's footer reports zero skips. No test was
removed to make the run green.

The production-check test still uses a stubbed package manager. The real
`check:production` CLI was not run. Historical transfer positive/tamper tests
passed in the suite; default `check:transfer` remains an initial-snapshot
comparison, not a developed-runtime gate.

## Behavioral coverage

- Actual Pi registry OAuth resolution with a fake serialized credential store:
  valid, expiring, concurrent refresh/recheck, failed/missing and runtime override.
  Local parsing tests cover expiry/account consistency, byte bounds, malformed
  JWT/UTF-8 and late/cancelled results. No parallel refresh implementation.
- DeviceCheck success/unsupported/error/timeout distinctions, canonical bounded
  token encoding, CBOR/header output, and never/late-result fencing.
- Retained endpoint/header/session-ID values; one signaling POST, redirects and
  bounded body reads; exact SDP/request boundaries; strict Location parsing;
  three-attempt classified sideband policy and common connect deadline.
- Actual default network-adapter wiring with low-level fakes, including owned
  direct/proxy HTTP dispatchers, delayed dependency load cancellation, locked
  Fetch-style stream cancellation, same-turn sideband close and retired callbacks.
- Float32 and rate guards; bounded shared event ingress, IDs/content/replay,
  transcript tails and final truncation; UTF-8/escaped chunking; queued byte/count
  bounds, immediate discard at stop, framing-aware socket capacity and deadlines.
  A valid escaped final exceeding the pending-byte cap over its lifetime drains
  incrementally. Socket headroom is checked for the next frame, not every queued
  frame together.
- Confirmed fake stop with at most one immediately writable semantic close;
  saturated close omission; independent cleanup; late-peer refusal, rejected
  operation joins, stale generations, mute, blocked and release-pending outcomes.
  Existing ownership/SDK tests remain, with Float32 fixtures and the whole-connect
  guard moved from ten seconds to the total budget; transport tests own the
  separate ten-second phases.
- Fixed diagnostics, synthetic secret non-disclosure and refusal of inherited
  `DEBUG`/`NODE_DEBUG` configurations before credential/native preparation.

The fixed application-header set cannot reach 64 KiB while its tighter
individual token/attestation/ID bounds hold. The combined guard is retained, but
there is no claim of a provider-valid integrated 64 KiB/+1 header fixture.
The writer has a separate bounded raw-producer allowance as well as serialized
pending envelopes; its five-second operation deadline includes queue wait and
all fragments. The 64 KiB final body includes its truncation marker; the fixed
upstream `Agent Final Message` label is additional protocol text. Local socket
write completion is not an acknowledgement that the provider consumed the final.

## Mutation and review evidence

Fresh mutation copies match the effective runtime hash above. Removing the
inbound-byte guard admitted an oversized frame; the named assertion observed no
expected `protocol-error`. Allowing the provider's raw error message into one
diagnostic leaked `synthetic-provider-secret`; its non-disclosure assertion
failed. Both mutants exited 1 through normal failed-test teardown, not an import,
type or watchdog failure. Their named positive cases passed before and after.

Read-only reviews and parent checks prompted regressions for cleanup/send
ordering, native startup fencing, sideband adoption races, owned dispatchers,
wrapped-token validation, attestation errors, UTF-8, explicit queue discard and
stream cancellation. The parent additionally reproduced and fixed a writer
headroom stall. The final suite and mutations cover the corrected snapshot;
preliminary green logs and earlier mutation copies are superseded, not relabeled.

## Remaining limitations and handoff

- Native close and proxied-sideband cleanup remain deliberately unconfirmed.
  A real call reaching those resources would retain blocked ownership on stop.
  This is an unresolved acceptance gap, not an enabled usable-call claim.
- The retained native playback queue, DeviceCheck timeout allocation and proxy
  CONNECT buffering/cancellation limitations are disclosed in the plan. No
  upstream dependency was modified, replaced or upgraded.
- The provisional Location allowlist still needs the separately authorized
  provider trial. HTTP/WebSocket proxy selection does not prove ICE/media routing.
- #5 owns enabled UI, Pi admission/correlation and eligible final forwarding;
  #6 owns actual-home certification/recovery; #7 owns the real-access canary.
  G3 is not complete from this transport evidence alone.
- No real credentials, OAuth refresh, DeviceCheck, audio, native execution,
  provider request, real-home modification or remote-host operation occurred.
  At receipt capture there was no push/PR or issue update. No new visible UI was
  introduced.

Retained worktree: `/tmp/pi-live-issue-4-extraction` on
`feat/issue-4-extraction`, with the dependency symlink. The plan worktree remains
`/tmp/pi-live-issue-4-plan`. Main is unchanged.
Final local receipt: `/tmp/pi-live-issue-4-checks/MANIFEST.md`; final mutations:
`/tmp/pi-live-issue-4-checks/mutations-final/MANIFEST.md`. Earlier logs/copies under
that root and `/tmp/final-fix-*.log` remain retained. No persistent task process
remains. Delivery and issue acceptance are separate decisions.
