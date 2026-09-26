# Issue 7 verification: MBA canary and adoption

## Decision (2026-09-26)

The operator accepted `v0.1.0` for personal use on the MBA, through explicit
`pi -e` loading. The exercised canary checks passed. The operator explicitly
waived the real denied-microphone-permission check after macOS required a Paseo
restart to apply the change. That path remains unverified; this is not a claim
that every original G5 check ran.

The operator authorized this documentation PR and closure of #7 and its parent
#1. Adoption does not register the extension globally, authorize dotfiles
integration or another host, or authorize merging the PR.

## Authorization and checked revision

Before any real call, the operator approved testing `v0.1.0` on the MBA with
Pi's OpenAI API key, microphone and speakers. Each call separately displayed
Pi Live's normal consent prompt. The disclosure covered audio, transcripts,
conversation handoffs, Pi progress and replies, plus proxy and dialog limits.

The unchanged runtime was:

- Commit `b368264220a2bf637049495185f70003c1a87763`, tagged `v0.1.0`.
- MBA, macOS 27.0 (26A428), arm64; Node 26.6.0; pnpm 11.8.0.
- Pi/TUI 0.87.1; `@oh-my-pi/pi-natives-darwin-arm64` 17.2.9.
- https-proxy-agent 9.1.0, proxy-from-env 2.1.0, undici 8.10.0 and ws 8.21.2.
  The production check verified the exact nine-package runtime closure and
  native hashes.

The real home already had a valid setup record. The state directory was 0700
and `setup.json` was 0600; the record's hash stayed unchanged throughout. No
setup rerun, credential copy, lock deletion or global configuration edit was
needed. The test invocations disabled other extensions and saved sessions,
allowed only Pi's read tool, and used the normal Pi credential owner.

## Package and fake-resource checks

All checks used the README's explicit pnpm peer/script/virtual-store policy
with dependency drift refused:

- Source, package, inert-loader, typecheck and formatting checks passed.
- All 387 tests passed, including lifecycle, ownership, transport and real-SDK
  coverage with fake media/provider responses.
- All 18 fake-media terminal scenarios passed under network denial.
- The separately approved disposable production install passed: frozen
  dependencies, scripts and automatic peers disabled, exact native hashes and
  unchanged closure before and after the sandboxed no-addons loader.

An initial test run had file-mode fixture failures. They reproduce with umask
077 and disappear with the normal 022; the complete unchanged suite passed
under 022. Both failure and passing logs are retained. No failing test was
removed or changed. Earlier task records continue to own their mutation proofs.

These results belong to the tagged runtime above. The closeout changes only
documentation; mocks are not substituted for the real observations below.

## Real native, service and terminal observations

Tests used the actual Pi CLI in Paseo terminals on the MBA, loading the tagged
checkout explicitly. Direct-call invocations cleared proxy variables only in
their own environment.

| Check                            | Observed result                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inert load and cancelled consent | Loading stayed off without a call lock. Cancelled consent returned off with `denied`, without a lock. The isolated loader check separately proves the stronger no-side-effects contract.                                                                                                                                                        |
| Fresh consent and repeated calls | Three calls ran in one Pi process. Each prompted anew, reached active, and ended through `end`, `off` or `stop` respectively. Each returned off and removed its own lock.                                                                                                                                                                       |
| Second terminal                  | A separately consented invocation refused with `busy` while the first owned the call; it did not displace that call.                                                                                                                                                                                                                            |
| Failed connection and recovery   | A process-local HTTPS proxy pointing to a verified refused loopback port made real signaling fail. Pi reported the fixed `protocol-error`, returned off and released the lock. After exiting and relaunching direct, fresh consent was required and a new call succeeded. This does not test a working HTTPS proxy or proxied sideband cleanup. |
| Speech and read-only handoff     | The operator confirmed microphone, waveform, transcripts and speakers. The retained terminal capture shows the spoken request becoming Pi input, a real read of `package.json`, Pi's `pi-live` / `0.1.0` result and the matching voice reply.                                                                                                   |
| Progress and another reply       | A spoken README/recovery request caused a second real Pi read. The operator asked voice what Pi was doing and confirmed progress, the spoken recovery answer and terminal responsiveness. Progress is operator-observed; no outgoing wire trace was collected.                                                                                  |
| Mute and unmute                  | The operator confirmed that speech while muted produced no transcript or response. After unmute, the read-only handoff worked.                                                                                                                                                                                                                  |
| Stop during playback             | While voice counted aloud, the operator requested stop. `/live stop` returned off and removed the lock; the operator confirmed prompt silence and no response to subsequent speech.                                                                                                                                                             |
| Quit while voice was active      | The operator deliberately exited an earlier trial. Pi exited and the lock was released; the next invocation started normally.                                                                                                                                                                                                                   |

No native hang was observed. There was no exact event-loop-lag trace and no
claim of a hard real-time shutdown bound. The operator's physical listening and
pickup checks supplement, rather than follow from, the lifecycle state display.

Retained task diagnostics were checked for API-key, bearer-token, JWT and SDP
signatures, with no matches. The observed connection failure displayed fixed
text rather than a provider body. Raw provider wire logging was not enabled.
This covers the retained output, not every possible secret format or unobserved
provider/native output.

## Explicit waiver and remaining limits

For the denied-permission test, the test Pi process was exited before opening
macOS Microphone settings. macOS requested a Paseo quit/reopen. Rather than
interrupt the active session, the operator restored microphone access and
selected: "Access restored - waive this check and record the limitation".
Actual denied-permission startup and recovery were not tested. Cancelling Pi's
consent or passing mock failures does not close that gap.

After reviewing the results and limits, the operator selected:
"Adopt on MBA - authorize a docs-only PR and closing #7 and #1".

The previously accepted limits remain:

- A successful real HTTPS-proxy call is unverified. Proxied sideband cleanup
  remains unconfirmed and needs the documented manual recovery.
- Resolved native close is trusted despite the bounded microphone-task join
  and unjoined remote-audio task; this trial does not strengthen that contract.
- Shortcut-opened and unreported nested dialogs can leave voice active. Stop
  voice first when capture and delivery must stop.
- Support and adoption are limited to this MBA/local-TUI surface. No phone,
  remote microphone, RPC or other-host support is established.

## Retention and recovery

The local, ignored `preview/issue-7-canary/` directory retains the trial
manifest, launch command, terminal captures, checks and diagnostic-scan receipt.
Its TUI log names the additional fake-media receipts under
`preview/issue-5-checks/`. Raw captures and credentials are not published in this
report. The production checker removed its own disposable fixture.

Both trial Pi processes exited. Their two named Paseo terminals remain as idle
shells; no call lock remains. Existing setup, preferences, checkouts, caches and
prior records were preserved. The operator confirmed restored microphone access.

This is the first supported version. Rollback means `/live stop`, exit that Pi
invocation, then start Pi without `-e`; there is no earlier supported version to
claim. To use the checked version again, restore a checkout of `v0.1.0` with the
README's frozen dependency command and explicitly run
`pi -e /absolute/path/to/that/checkout/index.ts`. Loading is inert; starting a
call still needs fresh consent. Do not switch a checkout used by a running Pi.
