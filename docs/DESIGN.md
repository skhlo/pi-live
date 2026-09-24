# Pi Live design

## Status

Pi Live is a standalone, private, setup-only Pi extension. The repository owns
its development now; dotfiles is only the retained extraction source. No voice
runtime, installer, host adoption, or publication is part of the transfer.

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
It also retains the accepted limitation that Pi 0.87.1 does not report dialogs
opened through another extension's shortcut UI context. A future live runtime
would have to disclose that limitation and tell users to stop voice first when
capture and delivery must stop.

None of that behavior is implemented or authorized by this transfer. In
particular, historical requirements for microphone ownership, DeviceCheck,
authentication, signaling, WebRTC, result correlation, lifecycle locks,
provisioning, rollout, and a native/audio canary remain proposals. Implementing
them requires separate scope and fresh tests rather than importing archived
harnesses as production code.

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

[The verification record](VERIFICATION.md) owns fresh results for this layout.
[The extraction receipt](history/extraction/transfer-receipt.json) owns copied
source identity, adaptations, and historical evidence custody. Those are distinct
from live-runtime or adoption evidence. No general native/audio/auth/provider
verification is claimed.

## Historical evidence

See [`history/extraction/README.md`](history/extraction/README.md). The archived
originals explain why the inert boundary and residual disclosures exist, but
must be read with their dates, source revisions, and superseded-status warning.
