# Luna bounded spec challenge

Scope: read-only challenge of `SPEC.md` and the five linked reports `[I]`,
`[L]`, `[O]`, `[P]`, and `[T]`. This review does not add platform or feature
requirements beyond the proposed MBA-only v1.

## Verdict

Blocking defects: **yes**. The command/state contract, the literal five-second
stop promise, and the `ui_prompt_start` ordering claim need correction before
implementation. The no-preemption lock is conservative enough for cooperating
MBA callers, but its reload/start invariant needs to be made explicit and gated.

## Findings

### B1 — Command and state transitions are incomplete [BLOCKING]

**Spec sections:** `§4 User-visible contract` (commands, status, and consent);
`§5 Call lifetime, ownership and mute / State machine`; `§5 / Startup/stop
ordering`.

**Counterexample:** A call reaches a connection failure. The public status list
contains `failed`, but the state graph has no `failed` state or transition. If
cleanup is uncertain, the state is `blocked`, but the graph has no behavior for
`/live start` or `/live stop` there. A second `/live start` during `stopping`
is also unspecified: “idempotent” can mean join the cleanup, while “each
explicit start obtains” consent can mean start another attempt. A conforming
implementation could therefore either reuse a live lock or start a second
attempt while the first cleanup is pending.

**Smallest correction:** Add a command transition table. At minimum, define
that an active/stopping call cannot start a new generation; `failed` can start
only through `consent`; `blocked` refuses start and keeps the lock; stop is
idempotent in `off`, `failed`, and `blocked`; and a start from `stopping` joins
or reports the one cleanup promise. State whether the consent requirement
applies only to a new attempt, not to an idempotent start while already active.
Add these cases to `G2` and the consent cases to `G4b`.

### B2 — `ui_prompt_start` cannot support the literal ordering claim [BLOCKING]

**Spec sections:** `§1 / Deliberate departures` items 2 and 5; `§4 / User-visible
contract` (consent); `§5 / State machine` and the final session/UI paragraph;
`§8 / G4b`.

**Counterexample:** While the live widget is active, another extension calls
`ctx.ui.confirm()`. Pi reports `ui_prompt_start`, but the public event is a
notification, not a cancellation or input reservation. The live handler can
invalidate its generation and gate audio immediately, then stop asynchronously;
it cannot claim that the dialog has received no input merely because the event
was observed. Conversely, the live-owned confirmation used by `/live start` is
itself a prompt and must not be classified as an “other” prompt that stops the
call. A long-lived custom prompt would also make nested `ui_prompt_start`
insufficient, although this v1 correctly chooses a widget instead.

**Smallest correction:** Exempt the live-owned consent prompt explicitly. Change
“ends it before dialog input” to an enforceable rule: on the prompt notification,
invalidate/gate live delivery before the next live callback, leave the dialog's
input and Yes/No result untouched, and report `stopping` or `blocked` if cleanup
is not finished. Do not imply that the event cancels the dialog. Make `G4b`
assert the consent exception and the no-audio/no-forwarding behavior during an
independent prompt.

### B3 — The five-second stop result is not enforceable for in-process native work [BLOCKING]

**Spec sections:** `§5 / Startup/stop ordering` steps 5-6 and the native
responsiveness paragraph; `§7 / Initial budgets`; `§8 / G2` and `G3`.

**Counterexample:** The transport probe leaves `createOffer()` or
`waitForOpen()` unresolved after abort, and DeviceCheck has no abort signal.
The source also has synchronous native initialization/stop surfaces, while the
spec acknowledges that the addon may block Pi's entire event loop. If that
happens, the five-second timer cannot run, so “Stop: 5 s total; return stopped
or blocked” and “report blocked within the cleanup budget” cannot both be
promises. A `Promise.race` would only return to the caller; it would not prove
that the native operation stopped, which the spec correctly says not to claim.

**Smallest correction:** Define five seconds as a best-effort **observer**
deadline while the event loop is responsive. A responsive caller may return
`blocked` without awaiting an uncooperative operation; the lock remains held,
late results stay generation-fenced, and the result is reported when a blocked
loop resumes. State that a hard wall-clock stop bound is not available in this
in-process v1. Keep the existing canary stop condition: if native behavior
blocks the loop or native close cannot be certified, `G5` fails and adoption
stops. `G2`/`G3` must test the bounded responsive case and must not treat a
promise timeout as cancellation.

### M1 — UTF-8 chunk arithmetic does not establish the serialized queue bound [MAJOR]

**Spec sections:** `§7 / Initial budgets` (64 KiB final, 500-byte context
chunks, 256-fragment/256 KiB serialized queue, WebSocket high-water);
`§8 / G3`.

**Counterexample:** The `132` figure is correct for `ceil(65,536 / 500)` raw
UTF-8 bytes. It is not a bound on serialized envelopes. A valid 64 KiB string
of U+0000 bytes is six bytes per character after JSON escaping, so its 132
chunk envelopes can contain roughly 393 KiB of escaped text before fixed
fields. It exceeds the 256 KiB *serialized pending* limit if the final is
materialized into the queue. Existing pending context can also consume part of
the 256-fragment allowance. A blocked socket therefore makes it unclear
whether a valid final is rejected because transport backpressure was exceeded
or merely because the producer materialized it all at once.

**Smallest correction:** Define the 64 KiB limit as raw UTF-8 source bytes and
require incremental production: serialize/enqueue one 500-byte chunk only when
pending serialized capacity is available. Define the 256 KiB limit as currently
unsent serialized envelopes, not the total final, and state that a final may
fail only after the transport/send deadline if capacity never drains. Give the
256 KiB/256-fragment comparisons inclusive boundary semantics and make control
close bypass and discard data work. Add escaped-content, existing-queue,
exact-boundary, and limit-plus-one cases to `G3`; do not use JavaScript string
length.

The shared connect budget is otherwise arithmetically coherent only if every
phase, retry backoff, body read, and proxy/native wait consumes one monotonic
30-second deadline. Say that explicitly in the same section. Likewise define
whether the 200-events-per-second threshold is inclusive and counted before
queueing.

### M2 — Reload/start ownership needs an explicit lock invariant [MAJOR]

**Spec sections:** `§5 / Minimal no-preemption lock`; `§5 / Startup/stop
ordering`; `§5` session shutdown paragraph; `§8 / G2` and `G4a`.

**Assessment:** The proposed primitive itself is conservative for the stated
scope. Exclusive creation of the canonical local directory, treating every
existing or malformed lock as busy, never preempting or age-reaping, and
releasing only after confirmed resource cleanup prevents overlap among
cooperating MBA calls. A crash produces a stuck busy lock rather than an
automatic takeover. PID liveness and heartbeat age are not sufficient evidence
and are not used as authority. Same-user tampering and non-cooperating
processes are explicitly outside the guarantee.

**Counterexample:** A call is active when Pi reloads or starts a replacement
runtime while peer close or a pending native startup is unresolved. The old
runtime must retain `active.lock`; otherwise the new runtime can acquire it and
open native resources while the old generation is still capable of opening or
using them. If the old runtime is invalidated before it can finish cleanup, the
safe outcome is a busy lock, but the new runtime's status and recovery path are
not specified. The same ambiguity exists for a start arriving during
`stopping`. The existing `G2` wording tests child contenders and stale locks,
but does not name reload-to-new-runtime contention or crash recovery as a
sequence.

**Smallest correction:** Make these invariants normative: every post-reload
runtime attempts the same canonical lock and never inherits or bypasses the
old one; `session_shutdown` invalidates delivery but does not authorize lock
release; only the one shared cleanup outcome may release an unchanged owner
identity after pending startup/resource operations are known safe; otherwise
the new runtime reports busy/blocked. Add to `G2` an active -> reload -> start
attempt with pending close, a start during stopping, a crash/partial-lock
fixture, and manual recovery that does not rely on PID age. This is a safety
clarification, not a request for an atomic Pi SDK run guarantee.

## Confirmed probe defects mapped to requirements and gates

| Confirmed defect | Proposed requirement | Named acceptance gate |
| --- | --- | --- |
| Focus preemption leaves old and new local owners briefly; live stale heartbeat can be replaced ([O]) | `§5 / Minimal no-preemption lock`: no preemption, no heartbeat/PID stealing, any existing lock busy | `G2` — exclusive child contenders, no stale-PID reaping |
| Partial/corrupt ownership records and separate agent directories do not form the required domain ([O]) | `§5 / Minimal no-preemption lock`: canonical home-independent path, partial/malformed busy | `G2` — corrupt lock and different `PI_CODING_AGENT_DIR` cases |
| Stop can remain pending and `leave()` can clear ownership before disposal ([L][O]) | `§5 / State machine` and `Startup/stop ordering`: one cleanup promise, release last, `blocked` on uncertainty | `G2` — release only after confirmed stop; uncertain cleanup retains lock |
| Parked callbacks repaint/finish a newer run; mute resets on replacement ([L][O]) | `§5 / State machine`: generation fencing, no transparent replacement, stable mute intent | `G2` and `G4a` — late callbacks, stopped-call output, mute/capture count |
| A pending connect rejects after stop and can reach a newer UI path ([L][T]) | `§5 / State machine` and startup ordering: invalidate before cleanup; late start/result is disposed | `G2`/`G3` — pending native work and late resolution |
| Busy Pi was admitted and a second delegation overwrote the first ([L][P]) | `§6 / Admission`: idle-only, one outstanding request, busy refusal, synchronous local correlation before void `sendMessage()` | `G3` and `G4a` — busy refusal, exact receipt, competing prompt race |
| Repeated delegation ID executes twice ([L][T]) | `§6 / Admission at each delegation.created`: seen-ID map, same ID/content deduplication, changed content is a protocol failure | `G3` and `G4a` — duplicate/changed/new IDs |
| Offer/open/DeviceCheck promises outlive abort ([T]) | `§5 / Startup/stop ordering` and `§7 / Initial budgets`: deadlines, late-result disposal, uncertain cleanup; no invented cancellation | `G2`, `G3`, and the MBA stop portion of `G5` |
| 1 MiB text is accepted, chunks are only individually bounded, and high socket buffering does not stop sends ([T]) | `§7 / Initial budgets`: total byte/count/time bounds, incremental queueing, WebSocket high-water and send deadline | `G3` — UTF-8 boundary, queue, backpressure, and deadline tests |
| Sanitization leaves raw JWTs and URL passwords in diagnostics ([T]) | `§7 / Diagnostics`: closed fixed codes and no upstream error/response text | `G3` — synthetic secrets absent from every observable diagnostic |
| Pi has no public run ID or atomic admission reservation ([P]) | `§6 / Coding delegation and result ownership`: extension receipt plus branch/projection proof; fail closed, never invent a run ID | `G4a` — real 0.87.1 SDK race is an explicit release blocker |
| Long-lived custom UI obscures/restores poorly around dialogs ([P]) | `§1 / Deliberate departure 2`, `§4` widget contract, and `§5` prompt rule: render-only widget, dialog owns input, stale live state is discarded | `G4b` — real PTY/TUI widget and dialog behavior |

The table gives every confirmed probe defect a requirement and a named gate.
The gaps are that `G2`/`G4a` need the reload/start sequence above and `G3` needs
the serialized-queue interpretation above; the existing gate names alone do not
prove those additions.

## Approval status and remaining choices

There is no basis to treat the proposal as already approved: the header says
“proposed implementation contract,” `§1` calls the scope decisions
recommendations, and `§10 / Approval and evidence status` still requires
confirmation before implementation. The spec does already propose the
Pi-owned credential path, no pooling, no footer ownership, and MBA-only scope.

The following choices from `[I]` remain approval items or need an explicit
status line in `§10`, rather than being silently treated as settled:

- exact dependency/native pins and any required native install script (`§3 /
  Package and adoption ownership`, `G0`);
- the private runtime/launcher choice versus Pi package discovery, if the
  launcher wording is still only a recommendation;
- who accepts experimental endpoint/entitlement drift and owns the canary; and
- the exact update/rollback receipt for native binaries and package caches.

**Smallest correction:** add an approval ledger to `§10` that marks each item
`approved`, `proposed`, or `approval required`, and make `G0` stop on every
`approval required` item. This preserves the MBA-only scope and does not add a
new feature or host requirement.
