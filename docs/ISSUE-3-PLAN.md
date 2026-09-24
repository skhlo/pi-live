# Issue #3 - call ownership and cleanup plan

Status: proposed implementation plan, not runtime implementation or access
approval. Baseline: `87ae78fd2a62b759aec00e04823021d8de9ada0d` on `main`.

## Decision and scope

Implement the lifecycle inside the existing deep live module, using private
fake media/transport adapters and a real local-filesystem ownership adapter
exercised only against authorized fixture homes in this issue. Keep the shipped
extension setup-only until the later transport and Pi-control work is ready.
Do not add a runtime framework, another command namespace, a native/helper
dependency, or an installer.

[Issue #2](https://github.com/skhlo/pi-live/issues/2) is accepted, merged through
[PR #8](https://github.com/skhlo/pi-live/pull/8), and closed. Its accepted
native provenance residuals remain unchanged. Passing historical feasibility
and package evidence permit planning; this conversation authorizes the plan,
not implementation, publication, or a live call.

The behavioral contract is [issue #3](https://github.com/skhlo/pi-live/issues/3)
and the retained numbered SPEC in [issue #1](https://github.com/skhlo/pi-live/issues/1),
with its standalone overrides. Old local-only/package-blocked status text is
superseded by #2's closure record. [CONTEXT.md](../CONTEXT.md) owns domain terms.

### What #3 will deliver

- Every call-state/command row, fresh consent, cancellation, generation fencing,
  mute intent, bounded startup, and conservative stop outcomes.
- Exclusive ownership shared across cooperating calls under one certified local
  account home, independent of Pi agent-directory selection.
- Lifecycle interruption handling, including a process-sticky blocked result
  that survives extension reload.
- G2 behavioral evidence using fake resources/clocks, real fixture-home child
  contenders, and focused real Pi 0.87.1 lifecycle operations.
- Two failing mutation demonstrations: release before close, and missing
  generation fencing.

#4 owns real credentials, attestation, wire protocol, media/transport adapters,
privacy bounds, and native-close interpretation. #5 owns enabling actual
commands/dialogs, the live widget, delegation admission/correlation, and result
forwarding. #6 owns standalone setup/home-certification production and recovery
instructions. #7 owns separately authorized real-device/provider trials.

## Existing code and change map

`index.ts` loads `registerPiLive` with preferences, metadata compatibility and
terminal-width helpers. `src/live.ts` currently only implements setup commands,
a historical renderer, and widget cleanup. No current state machine, call lock,
media lifecycle, or process-level blocked state exists.

| File                                                | Planned treatment                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/live.ts`                                       | Add the dormant lifecycle implementation, ownership operations, and narrow lifecycle binding inside this existing module |
| `index.ts`                                          | Unchanged; do not construct or connect the new call runtime from the shipped factory                                     |
| `src/preferences.ts`, `src/compatibility.ts`        | Reuse existing behavior; do not turn metadata checking into native loading                                               |
| `scripts/pi-live-lifecycle.test.ts`                 | New table-driven lifecycle, cancellation, clock, resource and generation tests                                           |
| `scripts/pi-live-ownership.test.ts`                 | New real-filesystem and child-contention tests through the lifecycle interface                                           |
| `scripts/pi-live-lifecycle-child.ts`                | Narrow fixture child for real ownership and isolated lifecycle probes, not a general test runner                         |
| `scripts/pi-live-lifecycle-sdk.test.ts`             | Focused real-SDK shutdown/reload/replacement/tree tests with fake media                                                  |
| `scripts/check-transfer.ts`, its tests              | Explicit historical-snapshot verification described below; retain positive verification and tamper tests                 |
| `README.md`, `docs/DESIGN.md`, verification records | Distinguish dormant G2 implementation from enabled calls and record revision-specific evidence                           |

Keep the manifest, dependency pins, lock, native/source snapshot, notice corpus,
original extraction receipt and archived research unchanged. `src/live.ts` is
already an allowed runtime payload file; its current payload hash is computed
rather than pinned by `scripts/pi-live-package.ts`. No second executable copy
of the live implementation is introduced.

Existing setup-only command/renderer/loader tests remain. New lifecycle tests
must execute the same lifecycle implementation that #5 will use, not a parallel
model of it. A test-only inline Pi factory may bind that implementation for SDK
checks; the default factory stays inert.

## Interface and private seams

The Pi caller needs call controls, an interruption operation, and a read-only
snapshot. Keep generation tokens, lock identities, credentials, resource lists,
and cleanup promises out of caller-managed state.

- Controls cover start/toggle/stop, mute/unmute, and off-only voice selection.
  Status/help do not cause call mutations. Snapshot fields are state, mute
  intent, selected voice and a fixed last-failure code, not account/session IDs.
- Interruption uses closed reasons for lifecycle change, reported dialog,
  observed conflict, expiry and failure. It fences synchronously before any
  asynchronous cleanup. There is no reset-blocked or force-start operation.
- The Pi binding supplies current admission facts and narrowly scoped
  delegation-admitted/settled notifications for the work timer. It does not
  implement resource ownership, retry cleanup, or choose when release is safe.
- Outcomes are closed typed results. UI strings belong to the narrow Pi
  adapter. Use the SPEC diagnostic codes, not raw exceptions or new ad hoc codes.

Private seams cover consent/admission, preferences, clock, home authority and
filesystem operations, and resource preparation/media/transport. Real/fake
variation justifies those seams. Keep test adapters beside tests, not as a
production adapter framework. Production dependencies stay lazy: import and
ordinary extension discovery must not resolve home, write state, start timers,
subscribe a call runtime, read credentials, or import native/network modules.

Do not serialize all controls behind the entire start promise. A pending consent,
connect, or capture operation must not prevent stop from fencing immediately.
State transitions/adoption are synchronous decisions; external work is tracked
and awaited outside those decisions.

## State and admission

| State                                | Control behavior                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `off`                                | Start/toggle begins one consent attempt; stop is a no-op; mute/unmute refuses; voice selection is allowed |
| `consent`, `acquiring`, `connecting` | Start reports the existing attempt; toggle/stop cancels it; mute/unmute refuses                           |
| `active`                             | Start reports already active; toggle/stop starts cleanup; mute/unmute is idempotent                       |
| `stopping`                           | Start/toggle refuses to arm another attempt; stop joins the one shared cleanup outcome                    |
| `blocked`                            | No in-process retry/reset; stop reports blocked without releasing ownership                               |

Help/status are read-only in every state. A normal failure may return to off with
a fixed diagnostic only after cleanup is known complete. A blocked result is
not an ordinary retryable failure.

Each attempt gets a fresh random generation and a voice snapshot. Check TUI mode,
compatibility, observed conflicts, reported dialogs, Pi idleness and pending work
before consent; recheck after Yes and before capture. Track the live-owned
consent interaction so it is exempt from external-dialog stopping. Cancellation
before acquisition creates no lock and invokes no credential/native/transport
adapter. A late Yes or data result cannot revive the canceled attempt.

All scheduled work, resource adoption, callbacks, observations and sends must
check the generation and the permitted state at the point of effect. AbortSignal
is a cancellation request, not proof that a native operation terminated.

## Ownership protocol

### Authority and certification

Production authority comes from `realpath(os.userInfo().homedir)`, not
`os.homedir()` or `HOME`. If HOME is present, it must resolve to that same
canonical directory; absence uses the OS account home. Neither
`PI_CODING_AGENT_DIR` nor `XDG_STATE_HOME` selects ownership placement.

A canonical pathname does not establish local storage. #3 consumes an explicit
home-certification result bound to the canonical home and the observed
home/state-parent identities. Missing, inconsistent or unsupported certification
refuses before acquisition. Fixtures supply certified temporary homes through
the same private seam, with an injected OS-account lookup. Merely changing HOME
must never redirect the production account-home lookup in a test.

Do not invent a persistent certificate format or silently certify this host in
#3. #6 must define the actual standalone setup method and how its result binds
to the owning host and exact local filesystem. The dormant production path
cannot enable calls before that result exists. This is an explicit later
integration requirement, not a claim that a fake certificate proves locality.

Require validated private, owned, non-redirected state directories. The runtime
may acquire only below the certified state parent; setup owns creating and
certifying that parent. Home ancestry need not be mode 0700, but the Pi Live
state directory and lock are private. Verify canonical ancestry and relevant
identities rather than only the final pathname.

### Acquire and release

1. Exclusively create `<home>/.local/state/pi-live/active.lock/` with mode 0700.
   Any existing file, directory, symlink, partial record, unreadable entry or
   malformed lock is busy. No heartbeat, polling, PID-age or liveness takeover.
2. Create one mode-0600 owner record using exclusive/no-follow creation. Include
   a schema version, generation, separate random owner token and diagnostic
   process identity. Bound record size and retain exact bytes and filesystem
   identities, including ownership/type/mode, for later comparison.
3. Successful directory creation is provisional ownership. Track acquisition
   through owner-record creation, write, sync, close and verification. If a
   complete record is verified, cancellation uses normal cleanup, never active
   adoption. Any deterministic failure or uncertainty after directory creation
   but before that verification enters sticky blocked and leaves the partial
   directory untouched. An existing lock or a proven no-effect failure before
   creation does not make this process an owner.
4. Release only after all resource-bearing starts and resources are quiescent.
   Revalidate the certified parent, lock directory, owner record identity/token,
   exact bytes and exact directory contents. Remove only the verified owner
   record, then the unchanged empty directory with non-recursive `rmdir`.
5. Unexpected contents, identity drift or a release error produces blocked;
   never recursively remove, repair, replace or rename over a live lock.

The cleanup outcome needs one decision point, not a race between deletion and
reporting blocked. While still stopping, maintain an internal decision of
`pending -> release-commit -> off|blocked`, or `pending -> blocked`. This is not
another user-visible call state. Enter release-commit synchronously only after
quiescence, with no blocked latch and a monotonic time strictly before the stop
deadline; disarm the observer and make already-queued observer callbacks no-op.
Perform a short non-awaiting final validation/removal commit over the certified
local filesystem. Successful final `rmdir` commits off before callbacks resume;
no later deadline callback can mark that released attempt blocked. A failed
commit reports blocked and preserves whatever partial busy lock remains.

Do not start an asynchronous unlink/rmdir that may finish after blocked was
chosen. A stalled synchronous filesystem commit may finish off after wall-clock
expiry because the observer cannot run during that stall; resource quiescence
was established before entering the commit. This is not a hard filesystem or
native deadline. If time is already exhausted before entering release-commit,
choose blocked without attempting release. Review this trade-off and prove both
terminal-ordering invariants in the first ownership slice.

Node's pathname operations do not provide atomic compare-and-delete against
hostile same-user path substitution. Repeated identity checks detect observed
replacement; the guarantee remains cooperating calls on one certified local
home. Same-user tampering, other apps/users, upstream live, shared/network homes
and concurrent unauthorized manual recovery remain outside that guarantee.
Do not add a native lock helper to imply stronger semantics.

Recovery preconditions belong to #3's ownership contract: stop every possible
owner in the account/home scope, establish that none can resume, inspect the
exact record and path, and obtain explicit permission before deletion. PID
liveness or age alone never suffices. #3 proves there is no automatic/PID-based
recovery and that crash/partial locks remain busy; it implements no deletion
command and performs no real-home recovery. #6 turns these preconditions into
the operational guide. G2 evidence must record that distinction.

## Startup, mute and cleanup

### Startup and deadline ownership

After consent/revalidation: acquire ownership, complete credentials/attestation
preparation, construct/connect resources, recheck admission and ownership, then
start capture last. #3 supplies fake preparation; #4 must establish whether each
real operation genuinely belongs to the data-only or resource-bearing class.
Opaque native initialization is not assumed device-free merely because its
return value looks like data.

Track work before invoking it, including synchronous throws and callbacks fired
inside constructors. Late resource handles are disposed, never adopted by a
later generation. A resource adapter must expose cleanup/quiescence obligations
at construction, not only after a long connect promise succeeds.

All numeric budgets below are inherited from the SPEC. Plan-review decisions
are the precise start of total connect and total call: use entry into acquiring
for both, excluding user consent wait but including ownership/setup time. These
are proposed refinements, not already accepted timing semantics; approve them
as part of the plan before implementation. The other anchors follow the owned
phase, first stop fence, or actual delegation admission:

| Budget                            | Anchor and behavior                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 30-second total connect           | Entering `acquiring` after accepted consent; includes acquisition and all setup work; no reset between phases |
| 5-second credential / attestation | Each phase start, capped by remaining total connect time                                                      |
| 10-second resource setup phase    | Offer/answer/open/sideband phase start, capped by remaining total; #4 supplies real phase operations          |
| 5-second stop observation         | First stop fence; every repeated stop joins this same deadline                                                |
| 60-minute total call              | Entering `acquiring`, so resource-owning setup time is not excluded                                           |
| 30-minute delegated work          | #5's actual delegation-admitted notification; settlement cancels that work timer                              |

Use a monotonic clock. Timer expiry ends voice only, never Pi work. Timeouts and
failures take the same stop path; a timed-out resource operation is uncertainty,
not automatic permission to return to off. No whole-call retries or reconnects;
#4's allowed bounded pre-open sideband retries must consume the same budget.

### Muting

Mute records intent and gates outgoing samples synchronously, then stops capture.
It leaves playback running. Unmute rechecks active generation/admission/ownership
and creates at most one capture. Pending start/stop and repeated mute/unmute must
not create overlapping captures or lose the final requested mute intent.
A failed or uncertain capture stop enters whole-call cleanup, possibly blocked;
it must not display confirmed microphone stoppage without evidence.

### One stop outcome, with late disposal

First stop synchronously fences delivery, cancels scheduled starts/timers,
discards queued context/finals, and publishes stopping. All callers join its one
cleanup outcome. Stop capture and close media/playback/peer/sockets without
waiting indefinitely for a best-effort protocol close.

Issue #3 explicitly requires at most one fixed `session.close` control after
the fence. At its private seam this is one semantic close request with no caller
payload, bounded by remaining cleanup time, not a general send bypass. Fake
adapters prove its count/order and rejection of newly sent microphone samples,
queued finals and other application data. #4 owns its actual wire encoding,
buffering/backpressure and network enforcement. Already-buffered audio cannot
be retracted; no real wire behavior is claimed by G2.

Distinguish:

- Fenced data-only waits, such as a credential result that cannot independently
  create resources: discard late values without retaining ownership solely for
  that result.
- Resource-bearing waits, including acquisition, offer/answer/open/close and
  capture startup/stop: retain ownership until positive termination/cleanup is
  established. Rejection is not automatically a clean-close acknowledgement.

Name G2 fixtures by these semantic classes, not as proof of a real DeviceCheck
operation. Actual DeviceCheck/native initialization classification is untested
here and remains #4-owned; fake attestation success does not settle it.

When all obligations settle, enter the release decision described above; release
last and report off only on that successful path. Otherwise choose blocked and
retain ownership. Late finalizers may dispose resources but cannot release the
lock, publish live UI, start delivery or change blocked back to off.

Keep a minimal, version-checked process-global refusal cell, initialized lazily
by the call runtime and shared across reloads. Separate observed pooling conflict
from cleanup-blocked; malformed/incompatible state refuses. Pooling while off
leaves state off with a denied diagnostic and no lock. Pooling during a call
stops it: successful cleanup returns off but retains the future-start refusal;
uncertain cleanup enters blocked and retains the lock. A pooling event by itself
never invents a blocked call or ownership.

This cell confers no ownership and carries no resources into a replacement
runtime. Tests use isolated process cells/children, not an exported reset escape
hatch, and assert state, diagnostic and lock count for each refusal cause.

Five seconds is a responsive observer budget, not a hard native termination
promise. Real event-loop blocking or unprovable native shutdown remains a later
stop condition requiring a separate isolation design, not a Promise.race fix.

## Pi lifecycle, dialogs and competing sources

Implement a narrow reusable lifecycle binding in `src/live.ts`, exercised by a
test-only inline extension factory. #5 will connect it to the shipped commands
and real UI; do not create a second independent event state machine in tests.

| Input                                                          | Required module response and SDK proof                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `session_shutdown` (`quit`, `reload`, `new`, `resume`, `fork`) | Fence immediately, join stop, never reuse the old UI/context from a late finalizer                                |
| `session_before_tree`                                          | Begin stop before branch movement; return `{ cancel: true }` when cleanup cannot be established                   |
| `session_before_switch`, `session_before_fork`                 | Begin fencing before replacement; cancel cancellable navigation on blocked cleanup, with shutdown as the fallback |
| Replacement `session_start`                                    | Fresh lifecycle instance must contend for the same home lock; process blocked latch still refuses                 |
| Non-live `ui_prompt_start`                                     | Fence at observed notification; never answer or change the dialog; no automatic restart at prompt end             |
| Recognized pooling announcement                                | Latch refusal and synchronously stop consent/acquiring/connecting/active; all later starts refuse                 |

Pi 0.87.1 awaits `session_shutdown` during reload and replacement, but tree
navigation is separate. Test real `reload`, `newSession`, `switchSession`, `fork`,
`navigateTree`, and `AgentSessionRuntime.dispose()` (quit) operations, not just
hand-emitted event names. Immediate fencing means synchronously on entry to Pi
Live's handler: earlier extension handlers can delay event delivery. Test delayed
delivery separately rather than promising a fence at SDK-operation invocation.

This is integration evidence for the dormant inline lifecycle binding, not the
shipped default factory, whose exact inert registration checks remain intact.
The narrow binding never calls `ctx.abort()` to stop voice. Pi's own explicit
session replacement may abort coding work as part of its normal behavior; do
not confuse that with voice-stop behavior or promise that coding survives an
actual session replacement.

Keep the accepted reported-dialog limitation: notifications have a microtask
window, and shortcut-opened dialogs are not reported. Full consent/UI exception
verification remains #5; #3 must not add private runner inspection or claim
universal dialog coverage. Cancel the live-owned consent through its own signal
and attempt identity; do not infer prompt ownership from a display title alone.

Inspect observable configured Better OpenAI sources and `pi.getCommands()`
provenance at admission, after all factories have registered; test both load
orders. Define exact supported source/provenance matches from pinned fixtures,
not a broad substring search. Do not claim access to a complete extension or
shortcut inventory.

The existing pooling event is `pi-multiprovider:service`. Its pinned service
shape has three function members: `getActiveAccount`, `resolveActiveAccountAuth`,
and `onActiveAccountChanged`. Validate unknown payloads; never invoke those
methods to discover an account or obtain credentials. Test malformed payloads,
valid announcements in every state, and synchronous announcements from inside
startup operations. Subscription observes events only after it exists; no event
replay or universal installed-pool discovery is assumed.

## Implementation sequence and acceptance evidence

Use vertical slices. Each slice starts with tests through the owned interface,
then implements only enough behavior to pass them. Keep the shipped setup-only
surface green throughout.

1. **State/admission and lazy construction.** All state rows, fresh/late consent,
   off-only voice changes, immediate cancellation, fixed diagnostics, and zero
   resource effects on load or unsupported modes.
2. **Ownership.** Certified fixture homes, real exclusive creation, child
   contention, partial/crash locks, identity-safe release and cancellation during
   acquisition. Review filesystem/release semantics before adding media work.
3. **Resource lifetime.** Fake preparation/connect/capture, tracked operations,
   synchronous reentrancy, shared cleanup, deadline classifications, late disposal
   and process-sticky blocked.
4. **Mute, sends and expiry.** Capture interleavings, fenced queues/samples,
   bounded single close control, nested deadlines and no Pi abort.
5. **Lifecycle/conflicts.** Real SDK reload/replacement/tree checks and fake
   pooling/command-provenance fixtures. Preserve #5's UI/delegation scope.
6. **G2 verification and receipt.** Full regressions, network-denied focused
   runs, both mutation demonstrations and revision-bound evidence. Review the
   result against every #3 acceptance item before proposing closure.

Minimum test matrix:

| Group         | Required cases                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State/control | Every state/command row; concurrent start; stop during each pending phase; start during stopping; read-only help/status; late Yes                                                   |
| Home          | Missing/same/aliased/divergent/unresolvable HOME; absent/wrong certificate; redirected or changed parents; different Pi agent dirs, same lock                                       |
| Ownership     | Simultaneous real children yield one owner; process exit leaves busy; empty/partial/corrupt/unreadable/symlinked lock; old/dead PID never stolen                                    |
| Release       | Capture/peer/socket/startups close before release; exactly one release; owner-token/file/parent/directory drift or unexpected entry retains busy state; partial release error       |
| Async work    | Late and never-resolving data versus resource operations; constructor throws/callbacks; lock acquisition completes after cancellation; deadline equality/just beyond                |
| Generation    | Old callbacks/samples/sends/timers/adoption cannot affect a new attempt; no stale UI writes, new lock release or delayed restart                                                    |
| Mute          | Repeated controls; pending capture start then mute; unmute while capture stop is pending; at most one capture; playback unaffected; uncertainty not reported as confirmed mute      |
| Lifecycle     | Actual SDK quit/reload/new/resume/fork/tree, delayed event delivery, pending close during replacement, blocked latch after reload; standalone voice stop does not abort coding work |
| Conflicts     | Both configured-command load orders; invalid pool payloads ignored; recognized pool in off/consent/acquiring/connecting/active/stopping/blocked; late completion cannot revive      |
| Expiry        | Total connect and capped phase budgets; shared stop deadline; total-call and admitted-work expiry; no timer reset or Pi-work cancellation                                           |

Ownership fault injection must cover every post-mkdir publication boundary;
a child contender must remain busy after each failure. Release tests must put
an observer callback at the release-commit boundary and cover exact deadline
arrival: no release after blocked, and no blocked outcome after successful
release. Pooling tests assert state, fixed diagnostic, lock count and future-start
refusal in every row, not just that some stop callback ran.

For release-before-close mutation, keep one fake resource close pending and
attempt a real second-child acquisition. Moving release earlier must make that
assertion fail. For generation mutation, deliver a parked old callback after a
new attempt starts; removing the relevant generation guard must cause an
observable forbidden send/state effect. Use disposable source copies, one change
at a time, and retain exact mutation diffs, named test, exit status and output.
Do not accept a mutation failure caused only by typecheck/import errors.

## Extraction-history checks during development

`check:transfer` currently compares the working tree against the immutable
initial extraction receipt. An intentional edit to `src/live.ts` must stop being
reported as an exact transfer. Do not update the receipt, rehash original
research, add a developed-file ignore list, or remove the positive tamper guard.

Separate the two questions explicitly:

- Current development is checked by package/source/loader and behavioral tests.
- The initial transfer is checked against a fixture materialized from local Git
  commit `f421dad09d376c02482924170d3796e516670021`, the accepted post-extraction
  test-correction snapshot, using the unchanged receipt.

Plan a narrow explicit `--root <snapshot-directory>` input to the existing
transfer checker. Always read the unchanged receipt from the checker repository;
root redirects only the destination/archive bytes being verified, never the
trusted receipt. The default remains the working-tree exact comparison. Use
pinned local Git blobs/metadata to materialize the receipt's files in a temporary
fixture, with lazy fetch/network disabled and no checkout switch or historical
runtime execution. Verify the positive fixture first, then mutate one license
byte and require rejection. Prove that altering a receipt inside that fixture
cannot bless the modified license. Also retain a negative test showing that the
intentionally developed working tree is not the original snapshot.

Both positive historical verification and negative tamper/current-drift cases
must pass as tests. Do not replace all verification with an expected failure on
the first developed file: that would stop checking the rest of the archive.
Document default `check:transfer` as an initial-snapshot diagnostic, not a green
current-runtime gate after development. Missing local baseline history must
produce an explicit prerequisite error, never a silent fetch or skipped proof.

## Validation, access and handoff

Use the root README's full pnpm policy, including
`--config.auto-install-peers=false --config.ignore-scripts=true
--config.enable-global-virtual-store=false --config.verify-deps-before-run=error`.
The abbreviated issue commands omit the virtual-store/refusal follow-up from #8.

Run tests, typecheck, formatting, source/package and sandboxed loader checks.
Run historical transfer verification through its explicit snapshot fixture.
Provider/lifecycle tests use fake adapters, empty credential/settings/session
stores, `--no-addons`, and OS-level network denial with an exercised EPERM guard.
Real child contenders may spawn within their narrowly isolated fixture runner;
do not apply the loader's process-fork denial to tests that require children.
Keep nested loader sandboxes separate from an outer sandboxed focused suite.

Fixtures inject the account-home resolver as well as environment HOME, confine
writes to their temporary roots, and cannot fall back to real user state. Use
pipe IPC for child coordination, barriers instead of arbitrary sleeps, bounded
parent watchdogs, and explicit child joins/cleanup. Watchdog expiry is a failed
test, not successful runtime cleanup. Long stress runs belong on MBP through
Paseo if needed; do not substitute Linux results for macOS loader evidence.

| Needed action                                                                 | Access/approval point                                                                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Read code, docs, issue metadata; write/review this plan                       | Available now; no credentials/device access requested                                                                      |
| Implement #3 with temporary homes/fake adapters/real children                 | Separate implementation approval after plan review; no live credentials or hardware needed                                 |
| Use another Node version or restore/install dependencies                      | Ask before installing anything; current inspected runtime is Node 26.6.0 with Pi 0.87.1 and pnpm 11.8.0                    |
| Repeat real frozen production installation                                    | Ask for the exact disposable install/fetch scope first; scripts stay disabled and pins unchanged                           |
| Remote-host stress execution, if needed                                       | Ask before using another host; use Paseo CLI for authorized MBP work and retain macOS-specific checks on their owning host |
| Establish real-home/local-storage certification                               | #6's reviewed setup method and explicit real-home scope; no certification is issued by this plan                           |
| Native import/DeviceCheck, actual auth, microphone/speakers, provider request | Stop and ask before first use; reserve for separately reviewed real-adapter diagnostics/canary                             |
| Commit/push/PR, issue update/closure                                          | Separate delivery approval; earlier #2 delivery permission does not publish this plan                                      |

No new access is needed to finish planning. Native-close certification, home
certification and minimum-supported-Node execution remain named future evidence,
not new claims or reasons to access those surfaces during this phase.

The G2 handoff must bind effective source and dependency identities, command
argv/runtime versions, real versus fake adapters, passed/failed/skipped cases,
network-denial proof, mutation outcomes, and retained fixture/process inventory.
A fake G2 pass is not native shutdown, live UI, transport, host adoption, or a
waiver of later same-revision package/SDK/TUI evidence.

## Evidence used for this plan

- [Current design](DESIGN.md), [package verification](VERIFICATION.md),
  [provenance](../PROVENANCE.md), and #2's closure comment.
- Current `index.ts`, `src/live.ts`, `src/compatibility.ts`,
  `scripts/pi-live.test.ts`, `scripts/pi-live-package.ts`, and transfer/loader
  checks. The current G0/G1 tests do not exercise a call-lifetime implementation.
- Archived [SPEC](history/extraction/original/SPEC.md),
  [feasibility](history/extraction/original/FEASIBILITY.md),
  [ownership probes](history/extraction/original/probes/ownership.md),
  [lifecycle probes](history/extraction/original/probes/lifecycle.md), and
  [Pi contract inspection](history/extraction/original/probes/pi-contracts.md).
  Old harnesses demonstrate upstream defects; they are not G2 implementation
  evidence or a substitute for real child-process contention tests.
- Installed Pi documentation and lifecycle examples, checked against the exact
  project dependency's 0.87.1 declarations and implementation:
  `dist/core/extensions/types.d.ts` (session events/results),
  `dist/core/agent-session.js` (`reload`, `navigateTree`), and
  `dist/core/agent-session-runtime.js` (pre-switch/fork and teardown ordering).
- [Pinned upstream pooling shape](https://github.com/monotykamary/pi-better-openai/blob/39171682343754366439b2c0890f5b0f4c3ed891/src/multiprovider.ts),
  read as source only; SHA-256
  `60ba966288662da76534277352003d84e37e819c51370978c693a205ac025248`.
  It is not added to the executable package or the immutable 24-file snapshot.
