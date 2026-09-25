# Issue #5 - delegation and control verification

## Scope

Implemented after the user's explicit instruction to implement issue #5, from
`4802a59a7e64ae0811d08542498ec5f777984864` on `feat/issue-5-delegation`.
The existing lifecycle and transport now connect to commands, standard consent,
the render-only widget and conservative single-flight Pi delegation. The
implementation remains in the owned deep module, `src/live.ts`.

The contract is [issue #5](https://github.com/skhlo/pi-live/issues/5), the parent
SPEC with standalone overrides, and the accepted #3 lifecycle amendments.
This does not complete native-cleanup acceptance: #4's real native/proxy adapters
still report unconfirmed cleanup and retain blocked ownership. The default home
certifier still refuses; #6 owns actual-home setup/recovery. No real provider,
credentials, DeviceCheck, audio, native-addon execution or installed-home rollout
was used or authorized by this work. No dependency was added or installed.

## Delivery G3

The integrated fake-native/network transport uses the actual parser and writer.
It admits a visible origin-marked custom message through Pi and sends only the
owned final via `Agent Final Message`. Tests inspect every recorded frame, keep
thinking/commentary/raw tool results in Pi, verify unchanged-ID deduplication
after settlement, reject changed-ID content, and bound multibyte/escaped final
text with a visible truncation marker. Existing #4 protocol/UTF-8/ID/count/rate
and backpressure boundary tests remain part of the suite.

The replay mutation bypasses the existing per-call seen-ID guard in an isolated
source copy. The real-SDK/transport integration test then fails behaviorally:
the duplicate request causes a third provider call where the one tool/final
request permits exactly two. The positive case passed before mutation. Retained
mutation receipt: `/private/tmp/pi-live-issue-5-dedup-cm1iu9pt/receipt.json`.

## G4a - actual Pi SDK 0.87.1

The deterministic in-process provider and fake media exercise:

- one persisted custom receipt, actual custom-tool execution and successful final;
- a real competing dispatch inserted between admission and the void send call;
- competing typed input and a non-trigger custom append;
- another extension's continuation, persistent context edit and compaction draft,
  and an unpersisted context-handler edit;
- a failed provider request followed by a successful automatic retry, permanent
  errors and user abort;
- tree movement at the SDK's permitted settled boundary, reload, new, fork and
  resume; Pi refuses tree navigation while streaming;
- stopped-call settlement, a second request while busy, the five-second receipt
  deadline at 4,999/5,000 ms, and thirty-minute voice-only work expiry.

Assertions check final delivery/discard, persisted messages and continued Pi
work. The extension does not call Pi abort. Real-SDK lifecycle regressions retain
both conflict load orders, pooling announcement validation, consent ownership,
reported-dialog stopping and canceled/late consent behavior.

## G4b - PTY and actual Paseo terminal

`scripts/pi-live-tui-probe.ts` runs actual Pi `InteractiveMode` with the current
adapter. Its fake provider/media and fixture-certified temporary home are
explicit. Before startup, it proves a loopback connection receives `EPERM` under
the OS network sandbox; native addons are disabled. The PTY driver uses standard
library Python via `uv`, without adding dependencies.

The PTY matrix covers normal and shifted-key toggle, consent cancel and a late
Yes stopped before acceptance, sample-driven waveform/current role transcripts,
38/60/100/120-column resizing, Unicode and unchanged editor typing, mute/unmute,
and each reported dialog primitive with normal answers and cancellation.
Confirm covers Yes/No/cancel; select covers keyboard selection/cancel; input,
editor and custom cover typed/key input and cancel. Reported notification fences
further fake samples. A stopped coding task finishes in Pi without new frames.

An actual task-owned Paseo terminal separately verifies Unicode editor text and
widget/footer coexistence, all five reported dialogs, and task completion after
voice stop. Both PTY and Paseo reproduce the unreported shortcut-confirmation
exception: samples remain active, normal No/cancel results are preserved, then
explicit stop removes the widget and leaves zero call timers. The package adds
no animation timer. Actual terminal captures include the full consent disclosure,
waveform/transcripts, dialogs, working state and completion with the original
footer. No private runner patch or invented prompt coverage is used.

Run the explicit PTY fixture with:

```sh
uv run --offline --no-project --no-managed-python scripts/check-pi-live-tui.py all
```

On macOS this needs permission to create its child OS sandbox and PTY. The
script starts only disposable fake-media sessions. It never runs a real call.

## Repository checks and evidence

The complete suite passed: **408 tests**, comprising 403 under OS network denial,
four loader tests using their own stricter sandboxes, and the one existing
permission-bit case separately. Typecheck, formatting, source/package and real
loader checks passed. The replay mutation failed behaviorally, and the current
positive case passed again in the complete suite. No test was removed to obtain
a pass. The package-isolation fixture initially rejected a temporary root inside
the worktree's dependency ancestry; the final run used an external temporary root.

Effective runtime SHA-256:
`c29d5ec930726b9b3e4b79b576d2d405803845a483b7bfc3866583f9786be9cf`.

Current final-check results and source hashes are recorded in the retained local
manifest at
`/private/tmp/pi-live-issue-5/preview/issue-5-checks/MANIFEST.md`.
SDK/provider/resource tests run with empty external HOME/agent roots,
`node --no-addons`, and OS network denial. Self-sandboxing loader tests and the
previously documented sandbox-incompatible permission-bit case run separately.
The production-check unit test still uses a stub package manager; the real
production install/fetch check is not run.

All pnpm invocations use the README's four peer/script/store/refusal flags.
The root package/lock, upstream source, native/dependency pins and notice corpus
are unchanged. The standalone factory's registration tests now expect required
public lifecycle/delivery listeners rather than only inert shutdown handling.

Retained artifacts: the task worktree and dependency symlink, ignored preparation
and check receipts, disposable mutation copy, PTY event/raw logs, and the Paseo
terminal/captures. The shared checkout remains on main. Publication and a real
device/provider canary are separate decisions.
