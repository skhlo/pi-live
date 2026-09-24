# Independent final review

## Verdict

All seven findings from `independent-review.md` are closed at the specification
level. The revised document is an implementation-ready proposed contract: it
states the unresolved feasibility, provenance, package, native, TUI, and canary
questions as explicit stop gates rather than claiming that they are already
proved.

I found no remaining direct implementation-blocking contradiction inside the
spec. This verdict does not treat the proposed implementation, acceptance tests,
or host canary as completed.

## Finding closure

1. **Prompt timing and scope — closed.** `SPEC.md:366-373` now says
   `ui_prompt_start` is queued through a microtask, acknowledges the detection
   window, and promises only to fence capture/send when the event is observed.
   It limits coverage to the five reported extension UI primitives and says a
   zero-gap requirement needs a Pi pre-prompt seam. G4b carries the same limited
   assertion (`SPEC.md:544`). This matches Pi 0.87.1
   `runner.js:318-358`, where `select`, `confirm`, `input`, `editor`, and
   `custom` pass through `withUIPrompt()`, event delivery uses `queueMicrotask`,
   and the dialog call is not awaited behind the notification.

2. **Activation and peer policy — closed.** The spec deliberately removes the
   launcher/pointer transaction and uses an additive revision directory plus an
   explicit `pi -e <absolute-revision-path>/index.ts` invocation
   (`SPEC.md:168-210`). It now defines `--live-only`, plan `scope: "live"`,
   `liveRevision`, the setup/check selectors, revision derivation, selector
   incompatibility, and old-revision behavior. It also fixes the production
   install policy at `auto-install-peers=false`, forbids private Pi/TUI copies,
   and makes real loader resolution without ambient parent dependencies a G0
   requirement. The installed Pi package guide supports `-e` for one invocation,
   and its loader aliases Pi and TUI imports to the running Pi distribution
   (`loader.js:35-83`). No persistent activation mechanism is needed for the
   specified explicit-invocation design.

3. **Cleanup, late results, and home authority — closed.** Blocked is now sticky
   for the process; a late-resource finalizer may dispose but may not release the
   lock or admit another call (`SPEC.md:338-350`). Data-only credential and
   DeviceCheck waits are separated from offer/answer/open/close/capture resource
   uncertainty, with peer construction ordered after data-only work. G2 requires
   never/late settlement and exactly-one release. The lock root now derives from
   `realpath(os.userInfo().homedir)`, rejects a divergent `HOME`, and is independent
   of `PI_CODING_AGENT_DIR` (`SPEC.md:289-320`). The five-second value is correctly
   an observer deadline, not proof of native cancellation.

4. **Conflict observability and account pooling — closed.** The spec now limits
   conflict refusal to known configured sources and commands observable through
   `pi.getCommands()` provenance, requires both load orders, and expressly places
   undetectable manual/project live implementations outside the guarantee
   (`SPEC.md:313-320`). Pi 0.87.1 exposes command source information but no public
   complete shortcut/extension inventory, so this is the enforceable scope. The
   pooling refusal is tied to the existing `pi-multiprovider:service` event and a
   validated service shape, with a late announcement stopping an active call
   (`SPEC.md:42-47`). The retained source defines that event and validates the
   three service methods in `src/multiprovider.ts`.

5. **Transport/native bounds — closed.** The budget table now separately bounds
   offer and answer SDP, serialized signaling, access/account values, decoded and
   serialized attestation, application headers, and native sample shape/rate
   (`SPEC.md:486-529`). It also states that native allocations before the
   TypeScript callback remain inside the trusted pinned-addon boundary. This
   closes the scout's specific missing-limit findings without claiming a native
   memory sandbox.

6. **Native provenance and notices — closed as a spec finding.** The document no
   longer implies that package metadata establishes compliance. Exact native
   artifact provenance, matching source/release, integrity, and complete notice
   obligations are mandatory G0 evidence, with an explicit stop if they cannot
   be established (`SPEC.md:153-164`, `SPEC.md:539`). The underlying native notice
   chain remains unverified; that is now an adoption blocker owned by G0 rather
   than an unresolved contradiction in the contract.

7. **Estimate — closed.** `SPEC.md:561-595` limits the numeric estimate to a
   bounded feasibility phase, names its SDK/TUI/package-resolution work, keeps
   native close/device work in a separate authorized window, and requires
   implementation to be re-estimated afterward. It expressly provides no fixed
   delivery date and does not hide process isolation or other scope changes in
   the feasibility estimate.

## Verification receipt

The retained verification evidence closes the prior receipt-fidelity concern.
`preview/live-spec/verification/receipt.json` records the full
`/usr/bin/sandbox-exec` argv, denial profile, timeout wrapper, environment
overrides/proxy removal, statuses, signals, log names, durations, and SHA-256
hashes. The recorded runner hash matches `verify-probes.ts`; every recorded log
hash matches its retained file; all six recorded commands have status 0. The
network-denial guard log contains `EPERM`, matching the receipt's loopback guard
argv. I inspected these artifacts but did not rerun the probes.

## Remaining gates, not spec contradictions

The native binary provenance/notices, production peer resolution, conservative
SDK correlation race, real terminal/dialog behavior, native close behavior,
experimental endpoint/Location shape, and authorized MBA audio canary remain
open by design under G0, G4a, G4b, and G5. Their outcomes can stop adoption or
send the design back for revision. No retained evidence proves a fixed
extraction, a real voice call, universal race exclusion, or support beyond the
named MBA surface, and the spec does not claim otherwise.

No additional implementation-blocking specification correction is required from
this review.
