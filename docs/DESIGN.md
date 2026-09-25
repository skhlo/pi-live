# Pi Live design

## Status

Pi Live is a standalone, private, setup-only Pi extension. The repository owns
its development now; dotfiles is only the retained extraction source. Issue #3
adds a dormant, fixture-tested call lifecycle, not an enabled voice runtime.
The shipped factory stays setup-only. No installer, host adoption, or publication
is implied.

This document separates implemented behavior from accepted decisions and future
proposals. Historical reports are evidence, not current instructions.

## Implemented behavior

The package has one default extension factory. It registers `/live`,
`Ctrl+Shift+L`, one historical message renderer, and a `session_shutdown`
presentation cleanup handler. It registers no tool or provider and does not
replace Pi's footer, editor, model, authentication, or MCP configuration.

The current command surface is intentionally inert:

- start/toggle reads preferences and compatibility metadata, shows a static
  **off (setup-only)** widget, and reports that calling is unavailable;
- stop clears that widget;
- mute/unmute report that no call is active;
- status reports the selected voice and metadata compatibility;
- voice selection validates the retained nine-name enum and writes only the
  private Pi Live preference file; and
- non-TUI use refuses before call behavior.

Compatibility checking validates Node, platform, architecture, Pi package
metadata, and native package metadata. It does not import the addon. No current
path opens audio, resolves credentials, authenticates, constructs a provider
transport, sends a session identifier, or makes a voice request.

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

## Dormant call lifecycle

`src/live.ts` also contains `createLiveLifecycle` and `bindPiLiveLifecycle`.
Neither is constructed by the default extension factory. Callers use controls,
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
- The dormant Pi binding uses public 0.87.1 lifecycle operations, retires outgoing
  bindings, and refuses observed conflicts. Discovery is limited to supplied
  configured-source facts and command provenance, not a complete extension list.

Tests use certified temporary homes, fake resources/clocks, real child contenders
and real SDK operations. They do not prove native shutdown, transport behavior,
UI readiness or suitability of this host's actual home. The default factory's
inert registration and presentation remain unchanged.

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

## Proposed future runtime

The historical hardened spec proposes real speech, explicit microphone controls,
a render-only widget, one idle-only coding delegation, final-only result sharing,
Pi-owned credentials, bounded transport, and conservative ownership/cleanup.
Pi 0.87.1 reports only the outermost blocking prompt, with delayed notification;
shortcut-opened dialogs and dialogs nested inside another prompt are not
individually reported. The user accepted the nested-dialog limitation during
#3 implementation. The dormant binding narrowly tracks its own confirm
invocation, refuses ambiguous notification timing, and refuses startup if a
reported prompt remains open after consent. It cannot immediately cancel for an
unreported nested prompt. #5 must disclose these limits in the actual consent/UI;
users needing guaranteed capture/delivery stoppage must stop voice first.

The dormant lifecycle above is implemented under separate #3 approval. Real
microphone controls, DeviceCheck, authentication, signaling, WebRTC, result
correlation, enabling the Pi UI, provisioning, rollout, and a native/audio canary
remain later work requiring separate scope and fresh evidence. Archived harnesses
are not production code.

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

[The lifecycle verification record](ISSUE-3-VERIFICATION.md) owns the current
fake-resource results; [transfer verification](VERIFICATION.md) is historical.
[The extraction receipt](history/extraction/transfer-receipt.json) owns copied
source identity, adaptations, and historical evidence custody. Those are distinct
from live-runtime or adoption evidence. No general native/audio/auth/provider
verification is claimed.

## Historical evidence

See [`history/extraction/README.md`](history/extraction/README.md). The archived
originals explain why the inert boundary and residual disclosures exist, but
must be read with their dates, source revisions, and superseded-status warning.
