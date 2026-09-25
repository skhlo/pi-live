# Pi Live design

## Status

Issue #5 remains under spec review. Its automatic final-forwarding candidate
fails the retained later-context-edit regression; the earlier positive receipts
do not establish result ownership. See [the blocker](ISSUE-5-BLOCKER.md).

Pi Live is a standalone, private Pi extension. The repository owns development;
dotfiles is only the retained extraction source. Issues #3/#4 supply lifecycle
and bounded auth/media/transport. Issue #5 connects public Pi controls and
conservative delegation to those owners. Actual-home certification still refuses,
and real native/proxied cleanup remains unconfirmed. Fake success does not imply
usable real calls, provisioning, rollout or adoption.

## Implemented behavior

One default factory registers `/live`, `Ctrl+Shift+L`, the historical request
renderer and required public lifecycle/dialog/delegation listeners. It registers
no tool or provider and does not replace Pi's model, instructions, footer,
editor, authentication, memory or MCP configuration. Discovery remains free of
native import, credentials, ownership, timers and provider operations.

The controls share the existing lifecycle. Each new attempt requires standard
TUI consent after compatibility/admission checks and before ownership, credentials
or native initialization. Unsupported modes/host/Pi refuse early. Start and stop
are idempotent; toggle cancels a pending attempt and cannot queue a replacement.
Mute stops capture, not speakers. Voice changes require off. Status/help remain
read-only. Async preference/compatibility preparation is cancelable, so a stop
cannot be undone by a late initial read.

Consent names the execution host and all specified data/proxy limitations. Own
consent uses the session-event context, including when invoked through a shortcut,
so it still passes through Pi's reported confirm primitive. Other shortcuts keep
their unwrapped UI and disclosed behavior. Only `pi-live` is painted: bounded
current transcripts and sample-driven input level, with explicit connecting,
listening, muted and working states. Failure is reported with fixed diagnostics;
teardown removes the widget. No animation timer or input handler is installed.

Preferences live below Pi's agent directory in `pi-live/config.json`. Missing
state defaults to `sol` without writing. Existing directories/files must be
private and non-redirected; malformed or invalid state is refused rather than
repaired. Writes use a private same-directory temporary file, sync, compare, and
rename while preserving unknown fields.

That writer is optimistic, not a general compare-and-swap implementation. It can
observe a conflict and retry, but a concurrent writer can still change the file
after the last comparison. It therefore does not guarantee preservation of all
concurrent changes. The transfer restores deterministic coverage of an observed conflict; a valid
final file or two concurrent successful writes alone does not prove no-lost-update
semantics.

## Call lifecycle

`src/live.ts` also contains `createLiveLifecycle` and `bindPiLiveLifecycle`.
The default factory binds them without starting a call. Callers use controls,
interruptions, generation-owned outgoing/settlement capabilities, and a read-only
snapshot; ownership records and cleanup decisions stay inside the module.

The approved plan and detailed contract live in
[`ISSUE-3-PLAN.md`](ISSUE-3-PLAN.md). In brief:

- Fresh consent precedes ownership and resource setup. The connection and call
  budgets start at entry to acquiring; delegation expiry starts at admission.
- Ownership uses exclusive mkdir under a certified canonical OS-account home,
  independent of Pi agent directories. The default certifier refuses. Only
  fixture homes have been used; #6 owns production certification and recovery.
- Stop fences delivery before external callbacks. Unconfirmed resource shutdown
  at the five-second observer deadline becomes process-sticky blocked, retaining
  the lock. Confirmed shutdown permits asynchronous releasing; pending removal
  reports release-pending and refuses same-process starts across reload. Only
  successful final removal reports off. A timeout cannot cancel a deletion.
- A stopped generation cannot send samples/data, adopt resources, or cancel a
  later generation's work timer. Mute controls capture, not playback. Voice stop
  does not call Pi abort or cancel admitted coding work.
- The Pi binding uses public 0.87.1 lifecycle operations, retires outgoing
  bindings, and refuses observed conflicts. Discovery is limited to supplied
  configured-source facts and command provenance, not a complete extension list.

Tests use certified temporary homes, fake resources/clocks, real child contenders
and real SDK operations. They do not prove native shutdown, transport behavior,
UI readiness or suitability of this host's actual home. Issue #5 verifies their connection to the current controls and presentation.

## Extracted transport

`createLiveRuntimeResources` in `src/live.ts` supplies the existing lifecycle's
preparation and connection operations. Credentials and attestation are passed
between phases within one attempt; the SDK remains the only credential/refresh
owner. Native and network dependencies stay lazy and replaceable by test fakes.
The factory constructs call-scoped resources only after consent and certified ownership.

The extraction retains the pinned experimental endpoints, headers, identifiers,
voice payloads, proxy selection and final-context convention. Application code
adds bounded bodies/events/samples, classified pre-open retries, replay tracking,
latest transcript tails, a capacity-aware incremental writer and closed
non-secret diagnostics. Queued producers are discarded at stop while actual
in-flight work remains tracked. The Pi adapter below owns admission/correlation and final eligibility; transport
does not read session history or dispatch Pi work.

The retained native peer close does not prove hidden task/speaker termination;
the proxy agent likewise leaves CONNECT cleanup uncertain. Their real adapters
invoke cleanup but report it unconfirmed, so lifecycle ownership stays blocked.
Fake adapters can positively confirm shutdown and exercise the successful release
path. This is an explicit acceptance gap, not an upstream repair project or proof
that a real call can safely restart. Native internal buffering and DeviceCheck's
timeout allocation remain disclosed dependency limitations.

See the [extraction plan](ISSUE-4-PLAN.md) and
[verification record](ISSUE-4-VERIFICATION.md). No real credentials, DeviceCheck,
media, provider request or native addon execution was used for this work.

## Accepted decisions

- Pi Live is a standalone extension repository, not a standalone application,
  monorepo, generic installer, or framework.
- Runtime Pi/TUI dependencies remain wildcard peers; development uses exact
  Pi/TUI 0.87.1. Node >=22.19.0, pnpm 11.8.0, the four runtime dependency pins,
  and native leaf 17.2.9 remain fixed.
- The exact upstream snapshot is provenance-only and never runtime-loaded.
- The native binary remains npm-fetched only during separately authorized
  provisioning. This repository does not commit, mirror, or republish it.
- The operator accepted the documented native notice/provenance residuals for
  personal and open-source use. The acceptance is not legal clearance or a
  complete target-specific SBOM claim.
- The gathered notice corpus and public author credits remain with the package.
- No transfer artifact is a new home installation, extension registration,
  native/device/service authorization, provider call, or adoption decision.

## Pi delegation and result eligibility

The transport parser owns bounded structure/UTF-8 validation and replay tracking
for the entire call, including after settlement. Its callback asks the Pi adapter
to admit one request only when the call is active, Pi is idle with no pending
messages or active signal, and session/leaf identity still matches. A busy/new
request stops voice; it never queues, steers or aborts accepted coding work.

Before the single void `pi.sendMessage`, the adapter snapshots session, branch
prefix, leaf-derived position and entry IDs, and arms versioned local receipt
details containing source, call generation, delegation ID and a random token.
The visible `better-openai-live-delegation` message has `display: true`,
`triggerTurn: true` and an explicit voice-origin marker. Its content is not
expanded as a slash command or treated as an approval.

Eligibility requires exactly one matching custom-message start/end pair and
persisted active-branch receipt within five seconds. New branch entries and
projection catch non-trigger appends that bypass extension hooks. Unknown input,
multiple runs/finals, context edits, compaction, retry failures, errors, aborts or
navigation invalidate delivery. The post-context public event compares non-system
model context with Pi's projection; Pi-owned system deltas remain allowed.
This is conservative observed correlation, not isolation from another extension
in the same process or an atomic scheduler reservation.

At `agent_settled`, the same call/session must still own one successful final in
that interval. Only bounded final text is retained for sending; tool/thinking
observations are fingerprints. The upstream `Agent Final Message` convention
wraps at most 64 KiB of final body including its visible truncation marker. No
historical context, intermediate commentary, tool output or errors are forwarded.
The thirty-minute delegated-work deadline stops voice only. Generation-owned
senders and abort cleanup prevent later delivery from stopped calls.

## Remaining limits

Pi 0.87.1 reports only outermost blocking extension prompts after a microtask
notification delay. Unreported nested prompts and shortcut-opened dialogs can
leave voice active. Consent/help disclose this; users needing capture/delivery
stopped must stop voice first. The adapter keeps lifecycle handlers first so its
stop fence does not acquire another event-handler delay.

Known package-source/command observations and validated pooling announcements
reuse the existing binding. The shipped path reads global and trusted-project
package declarations through Pi's public settings parser, using bounded read-only
snapshots rather than its file-locking storage. Command provenance is inspected
through public `pi.getCommands()`. This is not a complete extension or shortcut
inventory, and no settings or lock file is written by source inspection.

The user's #5 implementation instruction authorizes local work and fake-resource
verification. Actual-home certification/recovery remains #6, real-access trial
remains #7, and native/proxy cleanup uncertainty from #4 remains explicit. See
[issue #5 verification](ISSUE-5-VERIFICATION.md) for current evidence.

## Historical statements that are superseded

The archive intentionally preserves old text unchanged. For current work:

- “dotfiles owns this” and “no new repository is needed” are superseded; this
  repository owns development;
- “G0 remains blocked” is superseded by the operator's later residual-risk
  acceptance, subject to the conditions in `PROVENANCE.md`; this does not become
  legal clearance;
- old “no PR exists,” “no push,” and issue-gating statements describe their
  original turns; they neither prohibit nor authorize a later repository PR;
- old green receipts apply only to their recorded revisions and layouts; and
- old dotfiles rollout/adoption tickets are historical context, not obligations
  to recreate dotfiles integration or migrate/close issues.

The local extraction creates no PR and changes none of those issues.

## Verification

The standalone commands are local development checks over the checkout or
disposable fixtures, not a real-home installer. The explicit pnpm policy in the
root README also applies to script invocation, not only dependency restoration.

[Delegation/control verification](ISSUE-5-VERIFICATION.md) owns current adapter
checks. [Transport verification](ISSUE-4-VERIFICATION.md) retains its extraction
evidence and remaining gaps. [Lifecycle verification](ISSUE-3-VERIFICATION.md)
and [transfer verification](VERIFICATION.md) retain their historical scope.
[The extraction receipt](history/extraction/transfer-receipt.json) owns copied
source identity, adaptations, and historical evidence custody. Those are distinct
from live-runtime or adoption evidence. No general native/audio/auth/provider
verification is claimed.

## Historical evidence

See [`history/extraction/README.md`](history/extraction/README.md). The archived
originals explain why the inert boundary and residual disclosures exist, but
must be read with their dates, source revisions, and superseded-status warning.
