# Pi Live design

## Status

Pi Live is a standalone, private Pi extension. The repository owns development;
dotfiles is only the retained extraction source. Issues #3/#4 supply lifecycle
and bounded auth/media/transport. Issue #5 connects public Pi controls and
ordinary Pi input to those owners. Actual-home certification still refuses,
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
interruptions, call-scoped outgoing delivery, and a read-only
snapshot; ownership records and cleanup decisions stay inside the module.

The approved plan and detailed contract live in
[`ISSUE-3-PLAN.md`](ISSUE-3-PLAN.md). In brief:

- Fresh consent precedes ownership and resource setup. The connection and call
  budgets start at entry to acquiring.
- Ownership uses exclusive mkdir under a certified canonical OS-account home,
  independent of Pi agent directories. The default certifier refuses. Only
  fixture homes have been used; #6 owns production certification and recovery.
- Stop fences delivery before external callbacks. Unconfirmed resource shutdown
  at the five-second observer deadline becomes process-sticky blocked, retaining
  the lock. Confirmed shutdown permits asynchronous releasing; pending removal
  reports release-pending and refuses same-process starts across reload. Only
  successful final removal reports off. A timeout cannot cancel a deletion.
- A stopped generation cannot send samples/data, adopt resources, or cancel a
  later call. Mute controls capture, not playback. Voice stop
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
adds bounded bodies/events/samples, classified pre-open retries,
latest transcript tails, a capacity-aware incremental writer and closed
non-secret diagnostics. Queued producers are discarded at stop while actual
in-flight work remains tracked. The short Pi bridge below submits requests and returns replies; transport does
not read session history or schedule Pi work.

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

## Voice as ordinary Pi input

The user's simplification instruction supersedes #5's former ownership-proof and
single-flight requirements. Voice is another input to the current Pi conversation.
Installed extensions, typed clarifications, retries and context processing are
part of ordinary Pi execution and can influence the answer returned to voice.

The bridge has one path in and one path out. A voice request calls
`pi.sendMessage` with the existing visible custom-message type and a voice-origin
label. Pi decides how input joins current work. `message_end` remembers the
assistant's reply; `agent_settled` sends it back to voice using the retained
`Agent Final Message` convention. If Pi has no successful reply, a fixed notice
directs the user to the terminal. Raw errors, thinking and tool output stay there.

There is no separate voice task scheduler, pending-request limit, replay history,
request quota, local receipt, branch snapshot, transcript hash or context audit.
Pi being busy does not block starting voice. The extra receipt deadline and
thirty-minute coding timer are removed. The transport retains the latest service
delegation ID only to address the wire reply, matching the upstream protocol.
The bounded writer can drain successive replies normally.

Audio resource ownership, transport bounds, explicit consent, mute and stop keep
their existing jobs. Stopping voice closes its resources and discards unsent data;
it does not abort Pi. Pi lifecycle changes tear down the call through the existing
lifecycle binding. No additional result-confirmation dialog is introduced.

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
