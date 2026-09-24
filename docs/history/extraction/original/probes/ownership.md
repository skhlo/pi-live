# Luna bounded probe 2: cross-process microphone ownership

Status: research only. No implementation, installation, authentication, microphone
access, provider request, push, PR, or merge was performed.

The inspected upstream checkout was `/tmp/pi-better-openai.qnz8hk` at
`39171682343754366439b2c0890f5b0f4c3ed891`. The checkout already had an
unrelated modified `bun.lock`; the live source files were not changed.

## Bottom line

The file floor is not an instantaneous microphone fence.

- A focused preemption deterministically leaves the old and new arbiters with
  `hasFloor === true` until the old arbiter evaluates again. The file itself
  names only the new holder.
- Two challengers that both retain `focused === true` can alternate the file
  floor. Each replacement again leaves the displaced local arbiter believing it
  still holds the floor until its next evaluation.
- A live process whose heartbeat is older than 8 seconds is reclaimable. The
  injected liveness function can report that its PID is alive; heartbeat age
  still wins.
- A malformed `floor.json` is treated as “no parsed claim” but is not removed.
  The existing `open(..., "wx")` path then treats the still-present file as
  busy. This is a fail-closed block, not recovery.
- Preemption/reclamation can activate a new session before the old asynchronous
  session stop completes. Final disposal can release the floor and return
  before the stop started by `onDeactivated` resolves.

Therefore the current source can support best-effort coordination, but it cannot
honestly promise “at most one live microphone/WebRTC session at every instant.”
That promise needs a stop acknowledgement or a real fencing/locking protocol,
not only a JSON claim and a next-tick correction.

## Commands and results

All commands below are offline. The queue and filesystem probes inject clocks,
PID liveness, and file operations. The lifecycle probe supplies fake sessions,
arbiter callbacks, and TUI dependencies; it never constructs the native audio
or transport path.

```sh
bun preview/live-spec/ownership/queue-probe.ts
bun preview/live-spec/ownership/filesystem-probe.ts
bun preview/live-spec/ownership/lifecycle-probe.ts
(cd /tmp/pi-better-openai.qnz8hk && \
  bun run test -- tests/live-queue.test.ts tests/live-focus.test.ts \
    tests/live-registration.test.ts tests/live-controller.test.ts)
```

Results:

- Every probe verified the pinned source head before importing it.
- The source narrow test command passed: 4 test files, 28 tests.
- Focus preemption output: before the displaced tick, both
  `2101-session-alpha` and `2102-session-beta` had `hasFloor: true`, while
  `floor.json` named `2102-session-beta`; the next alpha tick deactivated alpha.
- Focused-challenger output alternated the file holder
  `2203-session-b -> 2202-session-a -> 2203-session-b`. At each replacement
  both local challengers still reported `hasFloor: true` until the displaced
  one ticked.
- Stale-owner output used `LIVE_QUEUE_STALE_MS = 8000`, advanced the injected
  clock by 8001 ms, and reported the owner PID alive. The taker acquired the
  file floor while the owner still reported `hasFloor: true`; the owner's next
  tick deactivated it.
- Five malformed floor values (empty, invalid JSON, `null`, `{}`, and a claim
  with a string PID) all remained byte-for-byte present, produced no activation,
  and left the candidate member enrolled.
- The filesystem boundary probe observed an empty final floor file while a
  non-preemptive writer held its `wx` descriptor. A candidate could not claim
  during that window. After the writer completed, the candidate reclaimed the
  stale claim on its next tick.
- The lifecycle fake recorded `stop-called:session-1`, then creation and start
  of `session-2` before session 1 resolved its stop. On final close it recorded
  `leave-start`, `stop-called:session-2`, `leave-end`; the command returned with
  session 2's stop still unresolved. Session 1's mute was `true`; the new
  session began with mute `false`.

The filesystem probe's read-old / peer-replace / unconditional-delete sequence
is deliberately labeled operation-level only. It demonstrates the race allowed
by the source's separate operations; it does not claim that this bounded run
forced a particular OS scheduler interleaving between two real arbiters.

## Source line evidence

### Queue and focus

- `src/live/queue.ts:15-29` documents a per-user shared directory, one floor,
  atomic-create acquisition, atomic-replace preemption, and asymmetric focus
  semantics. Those comments are the intended contract, not proof of the
  required instant-level safety.
- `src/live/queue.ts:31-32` sets the heartbeat stale threshold to 8,000 ms.
- `src/live/queue.ts:100-102` derives `agentDir/live-queue`.
- `src/live/queue.ts:152-164` swallows every JSON read/parse error and writes
  replacement JSON through a temporary file followed by `renameSync`.
- `src/live/queue.ts:223-249` makes enrollment durable through member files and
  ticks; `setFocused` evaluates immediately; `tick` writes, sweeps, and
  evaluates.
- `src/live/queue.ts:289-307` defines liveness as PID liveness plus heartbeat
  age for other processes and deletes stale or malformed member files.
- `src/live/queue.ts:312-328` checks the existing local `#hasFloor` before any
  new claim. A changed token causes local deactivation, but only when this
  arbiter next evaluates.
- `src/live/queue.ts:331-349` allows a focused live claimant to preempt by
  replacement, removes a parsed non-live claim unconditionally, and otherwise
  claims a vacant floor. There is no compare-and-delete operation.
- `src/live/queue.ts:352-377` uses `openSync(..., "wx")` for vacant claims and
  direct writes to the final file, but uses temp-write/rename for preemption.
  It reads the file after writing and then sets local `#hasFloor`; that
  confirmation is not held as a lease or fencing check.
- `src/live/queue.ts:379-387` reads the token and then separately removes the
  floor on leave. The remove is not conditional on the token at the filesystem
  operation itself.
- `src/live/focus.ts:1-15` selects terminal mode 1004 and defines the exact
  focus and DECRQM sequences. `src/live/focus.ts:36-64` falls back after a
  timeout, and `src/live/focus.ts:66-91` attaches, consumes, and later disables
  focus reporting.

The matching tests cover the happy path but not the two-owner window:
`tests/live-queue.test.ts:100-121` asserts one challenger and one displaced
holder after the next tick; `tests/live-queue.test.ts:163-188` covers stale and
corrupt member files, not a corrupt floor; and
`tests/live-focus.test.ts:57-125` covers parsing, timeout, consumption, and
idempotent disposal.

### Registration and session lifecycle

- `src/live/index.ts:34-38` explicitly makes enrollment outlive a realtime
  session and says activation creates the microphone/WebRTC session.
- `src/live/index.ts:138-174` shows the local session slot, `parkSession`, and
  fire-and-forget `current.stop()` on floor loss.
- `src/live/index.ts:176-211` creates a new session when activated and schedules
  `start()` with `setImmediate`; it only refuses creation while the local
  `session` slot is still populated.
- `src/live/index.ts:214-224` clears timers and calls `arbiter.leave()` before
  looking at the session to await. If `leave()` synchronously calls
  `parkSession`, that callback clears `session` first, so the later `current`
  is undefined and the stop is not awaited.
- `src/live/index.ts:233-280` probes focus, chooses `focus` or `fifo`, enrolls,
  and debounces focus-in for 400 ms. Focus-out immediately calls
  `setFocused(false)`; the queue itself does not yield the floor on that edge.
- `src/live/controller.ts:134-165` keeps mute as an in-memory controller field.
  `src/live/controller.ts:222-235` toggles only that controller and its current
  transport. `src/live/controller.ts:268-303` stops capture, waits for queued
  sends, sends the session-close message, and awaits transport close.
- The matching registration tests use immediate fake stops and therefore do not
  expose the pending-stop ordering: `tests/live-registration.test.ts:203-246`
  and `tests/live-registration.test.ts:248-297`. The controller tests confirm
  mute behavior at `tests/live-controller.test.ts:208-255`.

## Probe 1: focus preemption and ping-pong

### Reproduction

The offline queue harness creates arbiters in one temporary directory with an
injected clock and a fake `isProcessAlive` set. It performs only the public
queue calls `join`, `setFocused`, and `tick`.

1. Alpha joins with `focus` policy and claims a vacant floor.
2. Beta joins but does not preempt merely by joining.
3. Beta receives `setFocused(true)`.
4. Before alpha ticks, beta has replaced the file, but alpha's local
   `#hasFloor` is unchanged.
5. Alpha's next tick sees the token mismatch, clears its local state, and calls
   `onDeactivated`.

This is a deterministic reproduction, not only a static concern. It is the
minimum two-owner interval promised by the current callback ordering. The
registration layer turns those callbacks into session creation and asynchronous
stop, so the in-memory interval is also a session-overlap risk.

For ping-pong, A and B both receive `setFocused(true)`. B replaces A. A's first
tick steps down; A's next tick is now a focused challenger and replaces B. B's
first tick steps down; B's next tick replaces A. The source has no shared fact
that only one terminal can remain focused, and no one-shot claim fencing that
makes an old local `hasFloor` false before the new callback runs.

This does **not** establish that focus following is a user requirement. It
establishes only what the selected preemption policy does if two enrolled
processes believe they are focused. The focus tests prove the terminal event
plumbing; they do not prove a single global focus owner.

### Static risk, separate from reproduction

The source's `writeJsonAtomic` prevents a reader from seeing a partially written
replacement on the preemption path when the rename succeeds. It does not make
the read / decide / replace sequence a compare-and-swap. A second preemptor can
replace the first replacement, and the first process can still have already
confirmed its own token and called `onActivated`. The bounded probe reproduced
the resulting delayed local invalidation through sequential public calls; it did
not force a concurrent rename between those private synchronous statements.

## Probe 2: stale but live owner

The test owner joined at injected time 1,000,000. The clock then advanced by
8,001 ms while the fake liveness function continued to return `true` for the
owner PID. A FIFO taker joined. Its tick swept the old member and reclaimed the
floor. Before the owner resumed, both local arbiters reported `hasFloor: true`
and the file named the taker. When the owner finally ticked, its fresh member
write did not restore ownership; the changed token caused deactivation.

This is a deterministic reproduction of the lease rule. It does not signal a
real PID and does not prove that a particular operating-system pause will occur.
It shows that “PID still alive” is not a safety barrier in this design. A live
process that is event-loop blocked, suspended, or otherwise unable to heartbeat
for more than the threshold can be replaced while its session remains active.

## Probe 3: malformed files and filesystem races

### Malformed `floor.json`

`readJson` returns `undefined` for invalid JSON, and `parseClaim` also returns
`undefined` for valid JSON with the wrong shape. The evaluator then skips the
`claim && !holderAlive` deletion branch. A candidate's vacant `openSync(...,
"wx")` fails because the malformed file still exists. Repeating `setFocused`
does not change that. The deterministic cases stayed present and blocked all
five candidates.

This differs from a malformed member: the sweep explicitly removes a malformed
member (`src/live/queue.ts:295-309`), and the existing test checks that behavior.
There is no matching floor recovery.

### Direct write window

The non-preemptive claim path creates the final `floor.json` first and writes its
JSON second (`src/live/queue.ts:363-368`). The filesystem probe held that file
descriptor open after `wx`: its size was zero, and the candidate saw no parsed
claim but could not create the already-present file. This is a deterministic
boundary probe of the actual arbiter, not a provider or microphone test. A
crash in that interval leaves the same kind of blocking malformed/partial file.

### Read/delete and rename races

The following are static race findings, with the operation-level sequence shown
by the probe:

- Stale takeover reads a claim, decides it is not live, and then calls
  `rmSync` (`src/live/queue.ts:315-342`). A peer can atomically replace the file
  with a fresh claim between those operations. The stale evaluator then deletes
  the fresh claim. The probe ran exactly read old -> atomic replace fresh ->
  unconditional delete and confirmed that the fresh file is lost; it labels
  this result operation-level only because no filesystem injection seam exists
  in the source.
- Leave has the same shape: read the token, then remove the path
  (`src/live/queue.ts:382-384`). A replacement between those statements can be
  removed by the departing holder.
- Sweep reads a member, decides it is stale, and later removes the path
  (`src/live/queue.ts:302-308`). A fresh atomic heartbeat replacement can be
  deleted by the older sweep observation.
- Preemption writes a replacement and reads it back (`src/live/queue.ts:360-375`)
  but does not reserve the name or fence the callback. The final JSON is a
  complete value under temp-write/rename, as the probe confirmed; ownership is
  still last-writer-wins rather than compare-and-swap.

These are static risk findings. The bounded work intentionally did not use real
process signals or attempt a nondeterministic multi-process stress race.

## Enrollment, mute, focus, and scope semantics

### Enrollment and focus

Enrollment is the member file, not the realtime session. `join()` writes the
member and calls `tick()`; floor loss calls `onDeactivated` but does not call
`leave()`. The member therefore remains enrolled through a handoff. `leave()`
removes the member and attempts to remove the floor claim.

The member schema contains `id`, `pid`, `sessionId`, `label`, `joinedAt`, and
`heartbeatAt` (`src/live/queue.ts:38-45`). It contains neither focus nor mute.
Focus is only the arbiter's in-memory `#focused` value
(`src/live/queue.ts:179-182`). It starts as `undefined`; a vacant focus-policy
floor accepts “not known to be unfocused” and reports activation as
`background`. `setFocused(false)` records the edge but does not yield an
existing floor. `setFocused(true)` evaluates immediately and can preempt.

A new enrollment starts with unknown focus. A parked session is replaced with a
new controller on reactivation. Neither state is persisted to the queue files.

### Mute

Mute belongs to `LiveSessionController`, whose private field starts as
`false`. The visualizer routes the space key to the current session only
(`src/live/index.ts:154-159`). `parkSession` discards that session reference,
and `activateSession` constructs a fresh controller. The lifecycle probe's fake
session made this observable without audio: session 1 was muted, then stopped;
session 2 began unmuted. Existing behavior cannot honestly promise mute
continuity across floor handoff.

### Per-agent-dir, not per-host

`src/paths.ts:10-13` resolves `PI_CODING_AGENT_DIR` or the home default
`$HOME/.pi/agent`; `src/live/queue.ts:100-102` appends `live-queue`. Production
registration uses the default (`src/live/index.ts:104-108`) and does not add a
host identifier.

Consequences:

- Processes using the same agent directory coordinate, normally within one user
  profile.
- Two different `PI_CODING_AGENT_DIR` values on the same host do not
  coordinate, so the source does not provide a host-wide microphone singleton.
- A shared agent directory mounted across hosts has no safe host namespace.
  `defaultIsProcessAlive` uses the local `process.kill(pid, 0)` semantics
  (`src/live/queue.ts:86-98`), while the claim carries no host identity. A PID
  from another host can therefore be misclassified or collide with a local PID.
- Separate home directories on separate hosts do not coordinate at all. The
  current source should be described as per-agent-directory ownership, not
  per-host ownership.

## Minimum requirements for a safe v1

This is the smallest safety bar, not a redesign proposal:

1. Define the scope first: one authoritative directory and host identity for the
   processes that may open the microphone. Refuse or clearly partition shared
   cross-host storage.
2. Make acquisition, release, stale recovery, and replacement conditional on an
   atomic owner identity. A read followed by an unconditional delete is not
   enough. A fencing token must be checked at the boundary that starts and
   continues the realtime session, or an OS-level lock must remain held for that
   session.
3. Do not start a new realtime session on a preemption callback until the old
   session has acknowledged recorder and transport stop. The queue callback and
   the asynchronous controller stop need an explicit ordering/acknowledgement.
4. Treat an unreadable or malformed floor as busy and provide an explicit,
   separately authorized recovery path. Never silently reinterpret it as vacant.
5. Choose a lease policy deliberately. If live-but-stale processes are allowed
   to be reclaimed, the protocol must fence the old owner; PID liveness plus an
   old heartbeat cannot do that. Otherwise require explicit release and accept a
   stuck busy state after a crash.
6. Test at least: rapid preemption, two simultaneous focused contenders, a live
   stale heartbeat, a partial/malformed floor, release versus replacement, and a
   pending asynchronous stop. The test must observe session start/stop, not only
   the final JSON file.

## Simple no-preemption alternative

A simpler safe-v1 policy is an explicit busy refusal:

- Use exclusive create for a vacant floor.
- If any floor file exists, including malformed or partial JSON, report
  “Live is busy” and do not preempt, delete, or follow focus.
- Let the current holder release explicitly. A crash may leave the feature busy
  until a human-authorized recovery or a separately designed lease mechanism.
- Start the realtime session only after the exclusive claim is acquired, and
  release/await the session before making the floor available again.

This removes the reproduced focused-challenger ping-pong and avoids replacing a
live owner's claim merely because its heartbeat is old. It does not magically
repair a partial file; treating that file as busy is the intended fail-safe. It
also makes focus useful only as UI information or as a choice among contenders
when the floor is already vacant. Whether users need focus-following is a
product decision not established by this probe, so it should not be silently
assumed as a v1 requirement.

## What the existing behavior cannot guarantee

The pinned implementation cannot honestly guarantee:

- exactly one active microphone/WebRTC session between the claim replacement
  and the old process's next tick;
- no overlap while `stop()` waits for queued sends and transport close;
- safe takeover of a process that is alive but has missed its heartbeat;
- safe recovery from malformed or partial `floor.json`;
- that a stale evaluator or departing owner cannot delete a peer's newer claim;
- that different agent directories on one host, or shared directories across
  hosts, form one ownership domain;
- persisted mute or focus state across session replacement; or
- that “converges within one tick” is a safety guarantee under concurrent
  rename/delete operations.

Those limits are conclusions from the source and the bounded offline probes,
not claims about a real provider or microphone run.

## Retained artifacts and limits

The runnable offline harnesses are retained at:

- `preview/live-spec/ownership/queue-probe.ts`
- `preview/live-spec/ownership/filesystem-probe.ts`
- `preview/live-spec/ownership/lifecycle-probe.ts`

`preview/` is repository-ignored by design. Each probe removes its temporary
queue directory before exit. No child process, provider connection, auth read,
or microphone device was started by the bounded probes. The filesystem race
section intentionally distinguishes the deterministic operation-level model
from a forced cross-process scheduler reproduction.
