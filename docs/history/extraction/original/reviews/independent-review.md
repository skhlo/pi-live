# Independent review

## Verdict

The source diagnosis is generally careful and the proposed v1 is deliberately
narrow, but the spec is not yet an implementation-ready contract. The principal
upstream defects are supported by the retained fakes and exact local source. The
remaining blockers are at the new seams introduced by the hardening design:
approval timing, native cleanup/lock release, package activation, conflict
detection, and native licensing. These are not reasons to restore upstream
focus handoff, pooled accounts, or modal controls.

## Blockers and required corrections

1. **The “before dialog input” promise is not available from Pi 0.87.1.**
   `SPEC.md:295-297` says `ui_prompt_start` ends voice before dialog input. In
   the installed runner, `withUIPrompt()` queues `ui_prompt_start` in a
   microtask and immediately invokes the dialog; event handlers are neither
   awaited nor a pre-dialog veto
   (`dist/core/extensions/runner.js:328-358`). A widget avoids the old custom-UI
   focus conflict, but it does not turn this notification into a mutex. Revise
   the contract to: on observing an extension UI prompt, synchronously fence
   further capture/send callbacks and begin idempotent stop; the dialog itself
   remains untouched. State that a small detection window exists. If zero voice
   transmission from prompt invocation onward is required, v1 needs a Pi
   pre-prompt seam or cooperation from every dialog owner and must stop for
   redesign. Also narrow “approval dialogs” to the five extension UI primitives
   actually reported by `ui_prompt_*`; no evidence shows that every possible
   core or third-party approval surface uses them. Adjust G4b accordingly.

2. **The versioned runtime has no safe activation transaction.** The proposed
   live-only scope, setup selector, revisioned directory, and launcher are all
   new architecture. Today rollout has only `baseline` and `capabilities`
   scopes (`scripts/rollout.ts:80-89`), capability setup accepts only
   `all|meta|hound` (`scripts/pi-capabilities.ts:26-38`), and launchers point at
   fixed final directories (`config/pi/launchers/pi-workflow.ts`). As written,
   file apply can switch the launcher to a revision before its `node_modules`
   exists, while setup occurs later. Specify the exact public selector and plan
   schema, the revision identifier, and an activation sequence that keeps the
   last ready revision runnable until frozen setup and check pass. Define how
   rollback selects the old ready revision without touching a live lock.

   The package decision is also unfinished. Pi's package guide says Pi peers
   use `"*"`, but pnpm's current lock records `autoInstallPeers: true`
   (`config/pi-meta/pnpm-lock.yaml`), which can install a private Pi for an
   isolated peer-only package. Choose and test one exact peer/install policy
   that leaves no second `pi-coding-agent` or `pi-tui` runtime while still
   resolving Pi-supplied imports. “Check how” in `SPEC.md:171-175` is a design
   question, not an implementable requirement.

3. **Blocked cleanup and lock release need a complete state transition.** The
   probes establish that `createOffer()` and `waitForOpen()` can remain pending
   after close, and DeviceCheck has no cancellation seam
   (`probes/transport.md:105-119,297-303`). The spec correctly rejects
   `Promise.race` as proof of shutdown, but it does not say what happens if a
   timed-out operation later settles: whether a background finalizer may move
   `blocked -> off` and release, or whether the lock remains until process exit
   and manual recovery. Define this separately for data-only late results
   (DeviceCheck) and operations that own a peer/resource. G2 must exercise both
   never-settling and late-settling paths and prove exactly one release.

   Also define “canonical local home.” A literal `~/.local/state/...` does not
   itself guarantee that two processes with different `HOME` values share the
   lock. Name the authoritative derivation and refusal rule, then test alternate
   `HOME` and `PI_CODING_AGENT_DIR` values. Keep the current no-steal/manual
   crash-recovery policy; it is a sound narrowed-v1 tradeoff.

4. **The universal old-extension conflict check is impossible through the stated
   public API.** Pi exposes commands and their source information, but no public
   loaded-extension or shortcut inventory; shortcut diagnostics are runner
   internals (`types.d.ts:1071-1076`, `runner.js:408-439`). Setup inventory also
   cannot rule out a project extension or an additional manual `-e`. Revise
   `SPEC.md:263-265` to require refusal for conflicts that are actually
   observable (for example duplicate `/live` commands and known configured
   package sources), and explicitly leave manually or project-loaded upstream
   live outside the singleton guarantee. Define “recognized account-pooling
   extension” as an exact observable contract—presumably the existing
   `pi-multiprovider:service` event—and specify what a late announcement does;
   otherwise remove that detection claim. Do not add pooled credential support.

5. **The bounds do not close all risks identified by the transport scout.** The
   scout explicitly found no bound for the DeviceCheck token, outgoing SDP, or
   native audio samples (`probes/transport.md:149-152,321-327`). The table's
   “Signaling SDP body” is ambiguous and appears to cover only the response.
   Define limits before constructing the attestation header and signaling JSON,
   bound both native offer and response answer, and either bound native sample
   callback shape/rate or state that the pinned native binary is a trusted
   boundary and remove any broader resource-bound claim. This is hardening of
   the existing v1, not a new feature.

6. **Native-binary licensing remains unverified.** The source MIT and complete
   `THIRD_PARTY_NOTICES.md` are present and should be copied exactly. However,
   the installed `@oh-my-pi/pi-natives-darwin-arm64@17.2.9` contains only the
   binary, README, and package metadata; its manifest says MIT but supplies no
   license or third-party notices. The review could not verify the binary's
   complete notice obligations from local artifacts. Make exact native artifact
   provenance and notices a pre-adoption G0 blocker, not merely “check
   separately,” and do not claim complete compliance until recorded.

7. **The estimate is not supported by the specified work.** This is a transport
   and lifecycle rewrite plus a correlation harness, real TUI/PTY work, a new
   cross-process lock, a new rollout scope/setup/activation transaction, and a
   native canary. The stated 3-5 focused days has no decomposition or
   contingency for the acknowledged feasibility stop points. Replace it with a
   separately estimated feasibility phase and re-estimate the extraction only
   after G4a/G4b, package resolution, and native close behavior are known. This
   avoids hiding process isolation or installer redesign inside a nominal
   extraction estimate.

## Evidence fidelity and acceptable residuals

- The lifecycle, ownership, parser, sanitizer, and buffering claims match the
  retained logs and pinned source. They prove behavior of the injected seams,
  not real provider, audio, or fixed-extraction behavior; the spec says this
  accurately. The discarded real-fetch-path attempts are also disclosed
  honestly.
- I could not independently verify the parent's OS network-denial invocation
  from the five retained logs: they record probe output, but not the sandbox
  command/profile, environment, or exit receipt. Either retain a command/exit
  manifest in the next round or describe network denial as the parent's
  observed execution rather than something the logs themselves prove.
- Conservative custom-message correlation is feasible to probe, not to turn
  into exclusive run ownership. Pi exposes the extension token in message
  events and the active branch/projection, but `sendMessage()` is void and there
  is no run ID or atomic reservation (`probes/pi-contracts.md:228-239`; installed
  `agent-session.js:1481-1507,2396-2404`). Keep G4a as a release blocker and keep
  the guarantee phrased as observed, fail-closed correlation. Passing selected
  race schedules must not be described as proving that no caller can ever win
  the admission race.
- Acceptable residuals for this narrowed v1 are the stale lock after a crash,
  no preemption/focus handoff, call-ending dialog policy, final-only forwarding,
  MBA-only support, experimental endpoint/Location uncertainty, Node-native
  compatibility pending canary, and no guarantee for non-cooperating microphone
  users. These are already disclosed and should not be “fixed” by adding focus
  queues, account pooling, automatic recovery, or process isolation to v1.
