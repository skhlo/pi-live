# Luna bounded probe 1 - controller/registration lifecycle

Status: spec research only. No implementation, installation, authentication, microphone access, provider request, push, PR, or merge was performed.

## Scope and source

The probe is bounded to these six cases:

1. callbacks from a parked session after a new session is active;
2. disposal while `stop()` is unresolved;
3. two `delegation.created` IDs before agent settlement;
4. stop while transport connect is pending;
5. `/live` while Pi reports a busy agent; and
6. mute, park, and reactivation.

The pinned source is `/tmp/pi-better-openai.qnz8hk` at commit
`39171682343754366439b2c0890f5b0f4c3ed891`. Its worktree already had an
unrelated modified `bun.lock`; the probe did not write to that checkout. The
source checkout's installed Pi declaration is
`@earendil-works/pi-coding-agent` `0.87.0`
(`node_modules/@earendil-works/pi-coding-agent/package.json:1-4`).

The entry source keeps enrollment separate from a realtime session
(`src/live/index.ts:34-38`), parks by clearing the current session and calling
`stop()` without awaiting it (`:167-174`), creates a fresh session on activation
(`:176-212`), and awaits the current session during disposal (`:214-224`). The
controller starts capture before `connect()` (`src/live/controller.ts:172-220`),
keeps one active delegation ID (`:254-265,341-355`), and closes the transport
only from its stop path (`:268-303`).

The exact installed Pi types expose `ctx.isIdle()` in
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:210-250`,
`agent_settled` and `message_end` at `:624-672`, and `sendMessage()` with
`triggerTurn`/`deliverAs` returning `void` at `:978-1049`.

## Method and reproducible command

`preview/live-spec/lifecycle/lifecycle-probe.ts` imports only the pinned source.
It verifies the source commit before running. Registration cases use a fake Pi
custom factory, fake arbiter, fake sessions, and fake TUI. Controller cases use
fake native bindings, fake audio capture, and fake transport. No fake invokes a
microphone or network provider, and the credential callback returns
`undefined`.

The existing checkout dependencies are used through the retained symlink at
`preview/live-spec/lifecycle/node_modules`.

From the repository root:

```sh
cd preview/live-spec/lifecycle
perl -e 'alarm 30; exec @ARGV' -- \
  node --experimental-strip-types lifecycle-probe.ts
```

Observed run: the command exited successfully within the 30-second hard timeout
and printed `fakesOnly: true` for all six cases. The probe process and timeout
wrapper exited; no persistent process or child service remains.

## Evidence

### 1. Parked callbacks after reactivation

**Confirmed behavior.** The fake activated session 1, parked it, activated
session 2, then invoked session 1's `onPhase`, `onTranscript`, and `onTerminal`
callbacks. The old phase and transcript appeared in the active visualizer, and
the old terminal error completed the current UI run and produced an error
notification.

Observed call order (including render requests):

```text
[tui.requestRender, arbiter.join, session.create:session-1,
 session.start:session-1, tui.requestRender, tui.requestRender,
 session.stop:session-1, session.create:session-2, session.start:session-2,
 tui.requestRender, tui.requestRender, tui.requestRender, arbiter.leave,
 session.stop:session-2]
```

Observed result:

```json
{
  "staleRenderObserved": true,
  "commandResult": "resolved",
  "notification": { "message": "late parked terminal", "type": "error" }
}
```

This is a deterministic reproduction of the injected callback ordering. It is
not a claim that a real transport produced the late callback in this run.

**Static risk.** The four session callbacks close over the shared visualizer
and `sessionParked` flag (`src/live/index.ts:193-210`). Reactivation sets that
single flag back to `false` (`:176-179`), so the source has no session-generation
check to reject an old callback. The source's existing registration tests cover
normal activation/cleanup and standby after floor loss
(`tests/live-registration.test.ts:203-298`), not this late-callback ordering.

### 2. Disposal with an unresolved stop promise

**Confirmed behavior.** The fake session's `stop()` recorded a pending promise.
Disposal called `arbiter.leave` first, then `stop`, and the command remained
unsettled at the 60 ms probe timeout. `registration.isActive()` remained true.
After the fake stop was released, the command resolved and `isActive()` became
false.

Observed call order and result:

```json
{
  "callOrder": [
    "tui.requestRender", "arbiter.join", "session.create:session-1",
    "session.start:session-1", "tui.requestRender", "arbiter.leave",
    "session.stop:session-1:pending", "session.stop:session-1:released"
  ],
  "beforeRelease": "timeout",
  "activeBeforeRelease": true,
  "afterRelease": "resolved"
}
```

**Static risk.** `stopActive()` awaits `run.dispose()` (`src/live/index.ts:116-124`),
and `dispose()` awaits the current session's stop with no timeout or cancellation
boundary (`:214-224`). The probe does not establish that a real transport hangs;
it establishes that this registration path has no bounded completion when its
injected stop promise does not resolve. Existing registration tests use
immediate fake stops (`tests/live-registration.test.ts:203-246,248-298`).

### 3. Two delegation IDs before agent settlement

**Confirmed behavior.** The fake transport delivered IDs `delegation-a` and
`delegation-b` before settlement. Both requests reached the delegate callback,
but the only final context append targeted `delegation-b`; `delegation-a` got no
settlement context.

Observed result:

```json
{
  "delegated": ["first request", "second request"],
  "contextMessages": [
    {
      "type": "delegation.context.append",
      "delegation_item_id": "delegation-b",
      "content": [
        { "type": "input_text", "text": "Agent Final Message: result after the second delegation" }
      ]
    }
  ],
  "activeDelegationId": null
}
```

The actual text contains the source's exact two newlines after `Agent Final
Message:`. The controller overwrites `#activeDelegationId` and clears the one
pending final on each new event (`src/live/controller.ts:341-355`); settlement
reads that one ID and clears it (`:254-265`).

**Static risk.** A second ID is not rejected, queued, or tracked independently.
This probe confirms the overwrite behavior, but not the realtime service's
policy for emitting two IDs. The existing controller test covers one delegation
with commentary and final context (`tests/live-controller.test.ts:34-137`), not
multiple IDs.

### 4. Stop while connect is pending

**Confirmed behavior.** The fake `connect()` remained unresolved. `stop()` still
completed, stopping the recorder, sending `session.close`, closing the transport,
and emitting a terminal callback. The original `start()` remained pending until
`connect()` was released; it then rejected with
`The live session stopped while connecting.`

Observed call order and result:

```json
{
  "callOrder": [
    "phase:connecting", "transcript:clear", "transport.connect",
    "recorder.stop", "transport.send:session.close", "transport.close",
    "terminal:none"
  ],
  "stopResult": "resolved",
  "startBeforeConnectRelease": "timeout",
  "startAfterConnectRelease": "rejected:The live session stopped while connecting."
}
```

**Static risk.** `start()` awaits `transport.connect()` and only checks
`#stopped` afterward (`src/live/controller.ts:208-220`). `#stop()` can close the
transport while that await is still pending (`:273-303`). At registration level,
the scheduled `created.start().catch(...)` unconditionally calls `finishUi` on a
late start rejection (`src/live/index.ts:204-210`); this is a static risk for a
parked/replaced run, not a reproduction from this direct controller probe.
The existing connect test releases connect before stopping
(`tests/live-controller.test.ts:138-170`).

### 5. `/live` while Pi reports a busy agent

**Confirmed behavior.** The fake context returned `false` from `isIdle()`. The
command still enrolled and started the live session; `isIdle()` was never read.
The delegation callback sent this exact custom message and steer options:

```json
{
  "idleChecks": 0,
  "sessionStarted": 1,
  "sentMessages": [
    {
      "message": {
        "customType": "better-openai-live-delegation",
        "content": "busy-agent request",
        "display": true,
        "details": { "source": "live" }
      },
      "options": { "triggerTurn": true, "deliverAs": "steer" }
    }
  ],
  "commandResult": "resolved"
}
```

The source command only validates arguments before toggling live
(`src/live/index.ts:316-329`); the delegation callback calls `pi.sendMessage`
with the steer options (`:184-192`).

**Static risk.** This offline fake did not run Pi's busy-agent scheduler. It
proves there is no live-side busy gate and that the handoff shape is a void
`sendMessage()` call. Whether Pi accepts, queues, or otherwise handles that
steer while busy remains unprobed.

### 6. Mute, park, and reactivation

**Confirmed behavior.** Space toggled session 1 to muted and the visualizer
showed `muted`. Park showed `standby` and stopped session 1. Reactivation created
session 2, whose fake mute state was `false` and whose visualizer showed
`listening`; session 2 received no mute toggle.

Observed result:

```json
{
  "firstSession": { "muted": true, "toggleMuteCalls": 1 },
  "secondSession": { "muted": false, "toggleMuteCalls": 0 },
  "commandResult": "resolved"
}
```

The source routes space to the current session only
(`src/live/index.ts:154-159`), and the visualizer maps space to
`onToggleMute()` (`src/live/visualizer.ts:97-105`). The controller's mute state is
per instance (`src/live/controller.ts:222-235`); activation constructs a new
instance (`src/live/index.ts:176-212`).

**Static risk.** Mute intent is not retained by the registration or arbiter. The
probe did not open a microphone, so it does not claim an audio frame was sent
unmuted. It confirms that a reactivated fake session starts with the controller's
fresh default state. No existing registration test covers mute followed by park
and reactivation; the controller test covers mute only within one session
(`tests/live-controller.test.ts:208-256`).

## Missing tests in the pinned source

The existing tests establish the normal registration path, floor-loss standby,
one delegation, capture-before-connect, and single-session mute. They do not
cover:

- late callbacks from a parked session after a replacement is active;
- a stop promise that does not resolve during registration disposal;
- two delegation IDs before `agent_settled`;
- stopping a controller before a pending connect resolves;
- the command/delegation path with `ctx.isIdle() === false`; or
- mute state and UI phase across park/reactivation.

The six retained probes above cover only deterministic fake-dependency behavior.
They do not prove Pi's internal busy scheduling, a real native capture result, a
real WebRTC close, or provider behavior.

## Proposed MUST-level acceptance criteria

These are bounded lifecycle criteria, not a whole extraction specification:

1. **Callback ownership:** A live session MUST have a generation/ownership token.
   Callbacks from a parked, stopped, or replaced generation MUST NOT repaint the
   current visualizer, finish the current UI, or deliver agent events.
2. **Stop completion:** Disposal MUST have a bounded and observable outcome for
   an unresolved session stop. It MUST NOT silently remain active forever; if
   cleanup cannot complete, the feature MUST expose a terminal failure and MUST
   prevent a new session from claiming the live surface until ownership is
   resolved.
3. **Delegation correlation:** Each accepted `delegation.created` ID MUST be
   settled independently, or a second ID MUST be rejected/queued explicitly.
   A later ID MUST NOT silently discard the earlier ID's final context.
4. **Pending connect:** Stop-before-connect completion MUST be deterministic.
   Releasing a pending connect after stop MUST NOT emit an error into a newer
   live generation or complete a replacement UI. The test MUST cover both the
   stop result and the late `start()` result.
5. **Busy-agent policy:** `/live` MUST make an explicit decision when Pi is busy:
   either refuse with a visible result or support the documented steer path. If
   steer is supported, the exact custom message and `triggerTurn: true,
   deliverAs: "steer"` contract MUST be tested against the installed Pi API.
6. **Mute safety:** Park/reactivate MUST preserve the user's mute intent, or
   explicitly reset it and show the unmuted state before audio capture can
   forward input. The chosen behavior MUST be tested without requiring a real
   microphone.
7. **Handoff ordering:** A new realtime session MUST NOT begin before the prior
   session has acknowledged stop, unless callback fencing independently proves
   that old capture, transport, and UI callbacks cannot affect the new session.

## Created artifacts and processes

Created under the requested ignored probe directory:

- `preview/live-spec/lifecycle/lifecycle-probe.ts` - deterministic six-case
  fake-dependency probe;
- `preview/live-spec/lifecycle/node_modules` - symlink to the existing pinned
  source checkout's `node_modules`.

Created at the requested report path:

- `docs/research/harnesses/pi/live-extraction/probes/lifecycle.md` - this
  evidence report.

The successful probe ran as one short-lived Node process under a Perl alarm
wrapper. Both exited. No microphone, provider network, credential resolver,
background service, or persistent process was used. The pinned source checkout
still has only its pre-existing `bun.lock` modification.
