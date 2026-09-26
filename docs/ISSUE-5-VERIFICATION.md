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

At the #5 simplification (`bb3b3bf`) checks passed: **395 tests** (390 under OS
network denial, four loader tests with their own sandbox, and the existing
permission-bit case separately), typecheck, formatting, source/package checks and
isolated real-Pi loading. After the GPT-Live port the suite has 374 tests, since
the ChatGPT-token and DeviceCheck tests were removed with that code; see the
GPT-Live port section below.
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

Results, source identities and terminal receipts were recorded in the local,
untracked `preview/issue-5-simple/MANIFEST.md` of the task worktree; they are
not part of the repository.
All pnpm commands use the README's four explicit policy flags. The production
unit test uses its stub package manager; the real production install/fetch check
is not run.

## Remaining scope

No real credentials, native-addon execution, microphone/speaker or
provider access was used. Dependencies, package/lock, upstream snapshot and
notices are unchanged. Actual-home certification still belongs to #6 and the
real-access trial to #7. Native/proxied cleanup uncertainty remains as documented
in #4; it is independent of treating voice as Pi input.

This work was delivered in PR #12. Its verification receipts are kept in the
repository's ignored `preview/` folder.

## GPT-Live port

The runtime now uses the public GPT-Live API with Pi's `openai` API key; see
[the design](DESIGN.md#extracted-transport). With fake media and fake provider
responses, 375 tests, typecheck, formatting, the source/package/loader checks and
all 18 PTY scenarios pass.

Two real trials ran on macOS arm64 through the development-only
`PI_LIVE_DEV_TRUST_HOME=1` switch. A no-microphone connection created a session,
opened WebRTC and the sideband, had a quiet context append acknowledged and heard
GPT-Live speak; reflected sideband audio arrived at about 9 events per second,
well inside the 200-event bucket. A microphone call handed a spoken repository
request to Pi, which ran it and returned its reply to voice. Each real stop left
the process blocked with its ownership lock, as documented.

Accepted limits: the handoff uses transcript arrival order, so words transcribed
after the delegation event join the next request; the latest delegation receives
the next settled reply, so a voice message Pi never runs (for example one dropped
during compaction) can be answered with another run's reply.
