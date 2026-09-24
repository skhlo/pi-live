# Luna final bounded review

Scope: only prior findings B1, B2, B3, M1, and M2, plus direct contradictions introduced by their corrections. This is a document review; it does not execute acceptance gates.

## Verdict

All five prior findings are **closed**. The corrected text is actionable and names corresponding tests. No direct new contradiction or remaining spec blocker was found within this scope.

### B1 — Command and state transitions: **closed**

The state table now distinguishes the last-failure outcome from the lifecycle
states, defines start/toggle/stop/mute behavior for every state, and makes
`stopping` single-flight: start/toggle reports stopping, while stop joins the
same cleanup. `blocked` refuses new starts and retains the lock; an off state,
including a failed outcome, starts only a new consent attempt. The active-state
start path is explicitly idempotent and does not request new consent.

`G2` covers every command/state row, canceled consent, and start-during-stop;
`G4b` covers late consent completion and the own-consent behavior.

### B2 — Prompt notification ordering: **closed**

The spec now makes the live-owned consent prompt an explicit exception. For a
non-live `ui_prompt_start`, the handler fences capture/send callbacks and starts
cleanup without changing the dialog or its result. It also records that Pi's
microtask notification creates a detection window, rather than claiming zero
audio from the instant an arbitrary prompt is invoked. The supported prompt
primitive boundary and the unsupported universal-detection claim are explicit.

`G4b` requires the own-consent exception, late-Yes fencing, normal dialog
focus/keys/results, and no further live sends after notification while
acknowledging the detection window.

### B3 — Five-second stop result: **closed**

Five seconds is now expressly a best-effort responsive observer deadline, not
a hard wall-clock native-stop guarantee. A responsive cleanup that cannot
establish resource termination reports sticky `blocked` and retains ownership;
a blocked event loop is reported only when it resumes. The spec rejects
`Promise.race` as proof of cancellation and makes native blocking or uncertified
close a canary stop condition.

The state table, cleanup ordering, and budget table agree on `off` versus
`blocked`. `G2`/`G3` cover unresolved native work, late results, and release only
after confirmed stop; `G5` covers the authorized cleanup canary.

### M1 — Serialized queue bound: **closed**

The limits are now defined over UTF-8 bytes rather than JavaScript string
length. Final production is incremental: only the next envelope is produced
when pending capacity permits, and the fragment/serialized-byte checks include
existing unsent envelopes and that next envelope. The queue bound applies to
currently unsent envelopes, not the whole final; a valid final waits for drain
and fails on its send deadline only if capacity never becomes available. The
text also preserves inclusive boundary semantics, escaped-content expansion,
control-close discard behavior, and one monotonic containing deadline for
phases/backoff/body reads.

`G3` covers byte/count/deadline/backpressure boundaries and +1 cases, exact
boundary and multibyte/escaped content, final truncation, and transport
failure. The event-rate limit is likewise explicitly counted before dispatch.

### M2 — Reload/start ownership invariant: **closed**

The lock authority is now the real-pathed OS account home, independent of
`HOME` and `PI_CODING_AGENT_DIR` for lock placement, with alternate-home and
non-local-home activation refused. Existing, partial, malformed, unreadable,
or redirected locks remain busy; no PID/heartbeat takeover is allowed. Session
shutdown fences delivery but cannot authorize release, and every replacement
runtime starts empty and must contend for the same lock. A pending or blocked
old owner therefore prevents a new runtime from opening resources; manual
recovery remains separate from in-process retry.

`G2` explicitly requires active -> reload -> pending-close -> new-runtime
contention, start during stopping, crash/partial locks, canonical-home and
separate-agent-directory cases, and manual recovery independent of PID age.

## Evidence boundary

`preview/live-spec/verification/receipt.json` records successful reruns of the
prior upstream probes and explicitly describes itself as not extraction
acceptance tests. Its contents do not substitute for the unexecuted G2-G5
implementation gates; those are implementation prerequisites, not document
defects in this bounded review.
