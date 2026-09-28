# Pi Live design

## Status

Pi Live is a standalone, private Pi extension. The repository owns development;
dotfiles is only the retained extraction source. Issues #3/#4 supply lifecycle
and bounded auth/media/transport. Issue #5 connects public Pi controls and
ordinary Pi input to those owners. Issue #6 adds `/live setup`, which
certifies the account home, and trusts the native close so a finished call
releases its lock. Proxied-sideband cleanup remains unconfirmed. The operator
accepted `v0.1.0` for personal MBA use after the [#7 canary](ISSUE-7-VERIFICATION.md),
explicitly waiving the real denied-microphone-permission check. Loading remains
explicit; no global registration or dotfiles integration was added.

## Implemented behavior

One default factory registers `/live`, `Ctrl+Shift+L`, the historical request
renderer and required public lifecycle/dialog/delegation listeners. It registers
one tool, `live_browser`, kept inactive outside browser mode (see
[Browser delegation](#browser-delegation)), and no provider. It does not replace Pi's model, instructions, footer,
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
state defaults to `marin` without writing. Existing directories/files must be
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
  independent of Pi agent directories. The default certifier accepts a home
  only when `setup.json`, written by `/live setup`, names the observed home and
  state directory (device, inode, owner). Setup creates the private state
  directory, refuses redirected or foreign-owned paths, and checks the mount's
  `local` flag with macOS `df` and `mount`. It never touches a lock.
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
preparation and connection operations. The credential is the OpenAI API key Pi
resolves for its `openai` provider (its credential store or `OPENAI_API_KEY`);
the SDK remains its only owner, and a ChatGPT/Codex login is not used. Native and network dependencies stay lazy and replaceable by test fakes.
The factory constructs call-scoped resources only after consent and certified ownership.

The transport uses the public GPT-Live API (`gpt-live-1`) with client
delegation. The native peer's SDP offer is posted to `POST /v1/live/sessions`;
the JSON answer supplies the session ID and SDP answer. A sideband WebSocket
attaches at `/v1/live/sessions/{id}/attach` with the same key. The WebRTC data
channel observes the session from its start, so it alone owns transcripts and
delegations; the sideband carries outgoing context and reports command errors and
session end. Service `error` events are reported by code and do not end the call;
an unrequested `session.closed` ends it. This replaced the upstream's private
Codex endpoint, Codex Desktop identity and DeviceCheck attestation. Application code
adds bounded bodies/events/samples, classified pre-open retries,
latest transcript tails, a capacity-aware incremental writer and closed
non-secret diagnostics. Queued producers are discarded at stop while actual
in-flight work remains tracked. The short Pi bridge below submits requests and returns replies; transport does
not read session history or schedule Pi work.

The native peer close stops the speaker device and closes the peer, but it
ignores their errors, joins the microphone send task for at most one second and
never joins the remote-audio task. At the operator's direction (#6) the real
adapter treats a resolved close as confirmed, so the lock is released; the
unjoined task cannot play once the speaker is stopped. The proxy agent leaves
CONNECT cleanup uncertain, so a proxied sideband still reports cleanup
unconfirmed and blocks the process. Native internal buffering remains a
disclosed dependency limitation.

See the [extraction plan](ISSUE-4-PLAN.md) and
[verification record](ISSUE-4-VERIFICATION.md). No real credentials, media,
provider request or native addon execution was used for that work.

## Accepted decisions

- Pi Live is a standalone extension repository, not a standalone application,
  monorepo, generic installer, or framework. Its one other entry point is the
  Codex browser server below, which reuses the browser tool.
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

In an ordinary call the bridge has one path in and one path out; browser mode
adds a second destination (see [Browser delegation](#browser-delegation)). A voice request calls
`pi.sendUserMessage` with a visible voice-origin label and Pi's normal steering
delivery. Input and agent-start extensions run as they do for other Pi input.
GPT-Live's delegation event carries no task text, so the request is the
conversation since the previous handoff: both speakers' transcript, in order.
While Pi works, each tool-using turn sends a short progress note (the assistant's
narration and the tools it ran) as quiet `session.thinking.append` context, so
the voice model can answer "what is Pi doing?" without interrupting.
`message_end` remembers the assistant's reply; `agent_settled` sends it, capped
at 1,500 bytes, as spoken `session.commentary.append` for the latest delegation.
If Pi has no successful reply, a fixed notice directs the user to the terminal.
Raw errors, thinking and tool output stay there.

There is no separate voice task scheduler, pending-request limit, replay history,
request quota, local receipt, branch snapshot, transcript hash or context audit.
Pi being busy does not block starting voice. The extra receipt deadline and
thirty-minute coding timer are removed. The transport retains the latest service
delegation ID only to address the wire reply, matching the upstream protocol.
A reply may instead name its delegation; it then hands the slot back to the
delegation it replaced, so a browser outcome does not consume Pi's reply.
The bounded writer can drain successive replies normally.

Audio resource ownership, transport bounds, explicit consent, mute and stop keep
their existing jobs. Stopping voice closes its resources and discards unsent data;
it does not abort Pi. Pi lifecycle changes tear down the call through the existing
lifecycle binding. No additional result-confirmation dialog is introduced.

## Browser delegation

Before a browser-mode call, `browserEnvironment` reads five browser variables
from Pi's environment with the checkout's optional `.env` as fallback, including
`VOICE_BROWSER_DIR`. `src/browser-sidecar.ts` probes the controller without
sending a command. An answering controller is reused without ownership; only
the script's fixed IPv4 loopback port 8787 endpoint (`127.0.0.1` or `localhost`) and a configured checkout permit
an offer. An interactive confirmation discloses Chrome, third-party code,
TypeSafe key access and the Pi-session lifetime. A decline is remembered by
that session. No dialog-capable UI means no offer or start.

On acceptance, Pi starts `scripts/browser-sidecar.sh` as one child with stdin
ignored and both output streams in a private temporary log. The script alone
owns launching and stopping Chrome and voice-browser. A bounded readiness wait
finishes before voice consent, resources or provider connection. Missing
checkout, Chrome or key, early exit and readiness timeout produce a single
browser-mode notice with the cause and log path; failed children are stopped
before the call continues. The browser setup supplies injectable probe/start/
stop operations for tests. The package payload includes the script.

Sidecar ownership belongs to the Pi binding, independent of voice ownership.
Voice stop and later calls keep it running and preserve the current browser.
With no configured `PI_LIVE_BROWSER_CDP`, an owned running sidecar supplies
`http://127.0.0.1:9333` for `live_browser`. `session_shutdown`, which Pi emits
for every session ending listed under **Browser sidecar** in CONTEXT.md, signals
the script and awaits its exit. Pi awaits shutdown handlers without a timeout,
so the script bounds its own cleanup: it signals both children, waits up to
`SIDECAR_STOP_SECONDS` (five by default), then kills any still running and notes
that in its log. As a last resort Pi Live kills the script itself three seconds
after that bound. The script stays in Pi's process group, so terminal signals
such as Ctrl-C during a stalled quit still reach Chrome and voice-browser.
Shutdown is idempotent and cancels pending readiness or consent without a late
launch. The script bounds each DevTools HTTP probe to one second, so a stalled
response cannot indefinitely delay its signal trap or Pi's startup failure
handling. Crash cleanup is intentionally absent: a later session reuses the
controller and does not own it. Multiple Pi sessions are not coordinated; the
owner stops the shared sidecar when it exits. A stop deletes the sidecar's log
unless a notice names it (startup failures and readiness timeouts) or the stop
had to kill a process.

Browser mode (#16) keeps client delegation and chooses a destination per
request. `/live browser` selects it for the next call only; the call keeps its
choice for its lifetime and gets its own instructions and disclosure. The
transport reports each handoff's latest user turn (`userText`) beside the full
exchange, keeping the turn before it when the latest has three words or fewer
("the second one") and dropping transcript noise tags such as `[sniff]`.
Earlier turns are left out because GPT-Live can reply between them without
handing off, which glued fragments into one command.

A router asks Jev one `choice` over raw HTTPS with that user turn and the tab
on screen: `browser_step`, `browser_task` (web work needing several actions or
judgment) or `other`. Jev resolves single commands well but acts on the last
clause of a compound request instead of refusing it, so refusal alone cannot
route multi-step work. A missing key or an undecided, failed or timed-out
router call tries the controller first. The router's deadline is a plain timer,
because `AbortSignal.timeout()` does not keep Node running. It uses Node's
`fetch`, which ignores proxy environment variables unless Node enables them.
A newer request or a stop does not cancel routing: a request routed to Pi is
still delivered, as in an ordinary call, and only browser waits are abandoned.

`src/browser.ts` sends a single step to voice-browser's loopback WebSocket as a
final transcript with a Pi Live utterance ID, then reads the controller's
broadcast events: the echoed transcript marks the request as registered, and
the first decision, candidate list or error after it becomes the outcome. The
events carry no request ID, so an action counts only after this request's `act`
decision, or when a spoken number picked a listed choice; an earlier request's
action can still finish after this one registers. An action waits briefly for
the refreshed page snapshot and otherwise says the page may still be loading.
Done, confirmation and numbered choices return through the `final` path,
addressed to their own delegation. A refusal, a failed action, a controller
error or a repeated `wait` decision is handed to Pi instead, as is an
unreachable controller when Pi has the tool. Whenever a request ends without an
action, including a stop, a question or a timeout, an empty utterance stops the
controller re-asking Jev. The client opens one socket per request, never
retries, and never reports an action it did not observe. Timeouts and
disconnects are spoken rather than handed off, because the browser may still act.
Outcome texts carry no label, because the voice model reads labels aloud.

Browser tasks go to Pi as ordinary voice input with a note naming the tab on
screen and the `live_browser` tool (`src/browser-tool.ts`). The tool talks to
Chrome's DevTools endpoint with Node's fetch and WebSocket: it picks the visible
tab, clicks with real mouse events, types with `Input.insertText`, follows the
main frame's navigation events until the new document finishes loading, and
returns the resulting page with numbered element refs, so each action is also
its check. A submit presses Enter once and says so when nothing navigated. Back
uses DevTools history, since a cached page can replace the document before an
evaluated `history.back()` returns. Controls that look like buying, paying,
deleting, sending, booking or signing in, password fields and forms containing
them are refused with a message for the user: voice cannot grant approvals. It removes
`target=_blank` before a click so voice-browser, which follows only its own
tabs, stays on the same tab. The tool is registered at load, kept inactive by
`session_start`, and activated by the first browser-mode call with a DevTools
endpoint; it stays active afterwards so handed-off work can finish. A web task
lowers Pi's thinking to `low` (never raising it) and `agent_settled` restores
the previous level if the level is still the one lowering applied; typed work
started meanwhile shares the lower level. A new Pi session forgets the saved
level and deactivates the tool.

The public GPT-Live API gives client delegations no task text, and its function
tools exist only under Responses delegation, which is chosen per session and
adds a backend model. Browser mode therefore does not compose commands;
Responses delegation with a browser tool remains open in #16.

## Codex browser server

`src/mcp.ts` gives Codex the browser tool as a stdio MCP server (#23). Codex's
own voice replaces the voice call, and its agent decides what each request
needs, so neither the Jev router nor browser delegation ports; only
`createBrowserTool`, its schema and its refusals are shared. Any change to that
tool's actions, refusals or result text therefore reaches both Pi and Codex.

The server speaks newline-delimited JSON-RPC with Node built-ins, avoiding the
MCP SDK's dependency and notice inventory. It runs one action at a time and
releases the queue on cancellation or after 30 seconds, because some DevTools
requests ignore the abort signal. It ships in the package payload, since the
source inventory is exact, but Pi never loads it.

When nothing answers at a `127.0.0.1` DevTools address, the next action starts
Chrome with the sidecar script's flags and profile, without voice-browser or a
key (#29). It starts without a prompt, because Codex sends MCP approvals to its
automatic reviewer rather than the user. The next reply after the launch says
so, even when that action fails or is cancelled. Readiness waits for Chrome's first tab, and a Chrome with no
tab, as macOS leaves one after its last window closes, gets a new one.

Chrome stays in the server's process group. The server stops it on stdin close
or a stop signal, killing it after 3 seconds, and Codex also signals the group.
`codex exec` does this as it exits. The plain `codex` command hosts servers in
its background app server, which stopped an idle server about 50 seconds after
the terminal app quit, and shell variables from that app do not reach it, so
the server also reads `SIDECAR_CHROME` and `SIDECAR_CHROME_PROFILE` from the
checkout's `.env`, as the sidecar script does. Only a server killed outright
leaves its Chrome running for the next Codex session to reuse. A Chrome already
answering is reused and never stopped. Chrome allows one instance per profile,
so a sidecar started meanwhile attaches to this Chrome instead of its own.

The repository's `.codex/config.toml` starts the server from the Git root,
forwards `PI_LIVE_BROWSER_CDP` and the sidecar's Chrome settings, and skips
Codex's approval review. The tool description asks Codex to prefer it in voice
conversations, and `.agents/skills/voice-browser` covers its use; Codex's
built-in browser and computer-use tools stay enabled.

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
verification. See [issue #5 verification](ISSUE-5-VERIFICATION.md) and
[issue #6 verification](ISSUE-6-VERIFICATION.md) for implementation evidence.
[Issue #7 verification](ISSUE-7-VERIFICATION.md) records the real-access canary,
its explicit waiver and the operator's MBA adoption decision.

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
from live-runtime or adoption evidence. The [MBA canary](ISSUE-7-VERIFICATION.md)
owns its bounded real-native/audio/provider observations and adoption decision;
it does not establish general verification beyond that surface.

## Historical evidence

See [`history/extraction/README.md`](history/extraction/README.md). The archived
originals explain why the inert boundary and residual disclosures exist, but
must be read with their dates, source revisions, and superseded-status warning.
