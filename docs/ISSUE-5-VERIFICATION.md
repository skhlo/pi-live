# Issue #5 - voice as ordinary Pi input

## Current contract

The user explicitly asked to remove the extra restrictions and keep voice as
another input to ordinary Pi. This supersedes the earlier #5 single-flight,
receipt, exclusive-result-ownership and context-audit requirements. The earlier
SDK counterexample is now an extension-compatibility test: both load orders must
work. The obsolete blocker document is removed; history retains that decision.

Voice requests call `pi.sendUserMessage` directly, including while Pi is busy. Typed
input, installed extensions, tool execution, retries and context processing remain
Pi's responsibility. When Pi settles, its reply returns through the upstream
GPT-Live commentary (see [the design](DESIGN.md#voice-as-ordinary-pi-input) for
the later GPT-Live port and progress notes). An error/abort without a reply produces a short
fixed notice to check Pi, without ending the voice call or exposing raw errors.

The bridge has no request receipt, history fingerprint, branch snapshot, pending
request limit, replay history, request quota, five-second receipt deadline or
thirty-minute coding timer. The service delegation ID is only a wire reply
address. Repeated request events are ordinary input. The bounded transport writer
can handle successive replies without a final-specific single-flight restriction.

Consent, microphone mute, call cleanup, transport bounds and host compatibility
remain. Stopping voice stops its delivery and audio; Pi work continues. Existing
Pi lifecycle teardown still closes the call, and reported dialogs retain their
existing behavior and disclosed shortcut/nesting limits. No new confirmation step
or SDK extension is needed.

## Verification

Current checks pass: **395 tests** (390 under OS network denial, four loader
tests with their own sandbox, and the existing permission-bit case separately),
typecheck, formatting, source/package checks and isolated real-Pi loading.
All 18 PTY scenarios and the actual Paseo controls/conversation checks pass.

The real Pi 0.87.1 SDK tests use an in-process provider and fake media under OS
network denial, empty fixture homes and `--no-addons`. They cover:

- starting voice while Pi is busy, multiple voice requests and typed clarification
  in one conversation, followed by Pi's reply;
- Pi input transformations and ordinary agent-start extension hooks;
- context enrichment by extensions loaded before and after Pi Live;
- Pi-owned retry, error and abort handling, and unrelated typed work;
- actual custom-tool execution, final reply frames and UTF-8 truncation;
- consent cancel/late Yes, mute/unmute, unchanged settings during conflict checks,
  and Pi completion after stopping voice;
- ordinary successive wire requests/replies alongside existing byte, rate,
  backpressure and cleanup checks.

The old tests requiring those removed policies were replaced or removed with
those policies. Audio cleanup and transport-bound regressions remain intact.
The old replay mutation receipt belongs to the superseded contract.

The PTY harness includes a conversation case that sends more voice input and a
normal typed clarification while the fixture tool runs. The actual Paseo terminal
is also checked with fake media. Existing Unicode/resize, editor, consent, dialog,
shortcut-exception and stop checks still exercise the current controls.

Current results, source identities and terminal receipts are recorded in
`/private/tmp/pi-live-issue-5/preview/issue-5-simple/MANIFEST.md`.
Earlier receipts under `preview/issue-5-checks` describe their recorded snapshots.
All pnpm commands use the README's four explicit policy flags. The production
unit test uses its stub package manager; the real production install/fetch check
is not run.

## Remaining scope

No real credentials, native-addon execution, microphone/speaker or
provider access was used. Dependencies, package/lock, upstream snapshot and
notices are unchanged. Actual-home certification still belongs to #6 and the
real-access trial to #7. Native/proxied cleanup uncertainty remains as documented
in #4; it is independent of treating voice as Pi input.

The task branch/worktree, dependency symlink, verification receipts and Paseo
terminal are retained. Nothing is pushed or published by this work.
