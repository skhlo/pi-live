# Standalone Pi live voice - hardened extraction spec

Status: proposed implementation contract, not implementation or rollout approval.
Prepared 2026-09-24 from five bounded Luna/max scouts and probes, then parent
verification. Scope decisions remain recommendations except where section 10
records a scoped user approval.

## 1. Decision and scope

Extract a private, opt-in `pi-live` capability from
`monotykamary/pi-better-openai@0.2.6`, pinned to
`39171682343754366439b2c0890f5b0f4c3ed891`. Do not install the original root
extension. Dotfiles owns the extraction, dependency lock, provenance, tests and
future adoption review. No new GitHub repository or npm publication is needed.

Target the current dotfiles source baseline
`de9bab8a4f2cdb7c13650c43920545a544af41da` and Pi **0.87.1**. The primary checkout
was one commit behind during the first assessment; its earlier 0.85.1 pin is not
the implementation target. Existing older hosts are not upgraded by this work.
First supported live surface: **MBA, macOS arm64, local Pi TUI**. Other native
targets remain candidates, not verified support. [I][D]

Deliver speech conversation, explicit microphone controls, visible transcripts,
one coding request at a time in the existing Pi session, and spoken final results
when their ownership is unambiguous. Keep Pi's chosen coding model, tools,
permissions, instructions, footer, memory, MCP and authentication ownership.

### Deliberate departures from upstream

These are part of the proposed v1, not claims that upstream already does them:

1. **No focus-following, FIFO promotion, standby enrollment or automatic
   reconnect.** A second call gets a visible busy result. Another terminal never
   becomes audible merely because it gains focus or the old terminal closes.
2. **A non-interactive live widget, not a long-lived `ui.custom()` prompt.** The
   ordinary editor and approval dialogs keep their input. `/live mute` and
   `/live stop` replace upstream's modal Space/Escape controls. The shifted
   toggle remains available where Pi delivers it. Do not intercept ordinary
   Space, Escape or Ctrl+C globally.
3. **Idle-only, single outstanding coding delegation; final-only return.** No
   steering into unrelated work, parallel delegation or forwarding intermediate
   commentary. Ambiguous results are shown in Pi but not sent to voice.
4. **Pi-owned Codex credentials only.** Do not extract account pooling or raw
   `auth.json` fallback. The SDK already owns OAuth refresh. A recognized active
   account-pooling service is a refused combination in v1, not permission to
   silently use another account. Recognition means the existing
   `pi-multiprovider:service` event with its validated service shape. Recognition
   refuses future starts and synchronously invalidates any consent, acquiring,
   connecting or active generation through the same stop path; late startup
   completions cannot revive it. This is not universal extension detection.
5. **Reported blocking extension dialogs end the call.** A non-live
   `ui_prompt_start` fences voice and begins cleanup; coding work and the dialog
   continue normally. Spoken completion is then unavailable, and restarting does
   not replay the old result. Pi 0.87.1 does not report dialogs opened through an
   extension shortcut's UI context; those dialogs may leave voice active. The user
   accepts this v1 limitation, disclosed in consent/help, rather than adding a
   private Pi patch or another adapter.

If automatic focus handoff, exact modal-key parity, pooled accounts, or seamless
voice through approvals is required, revise this spec before implementation.
Those are additional designs, not configuration toggles on this v1. [L][O][P]

### Explicit non-goals

No `/fast`, usage polling, reset redemption, image/search tools, model catalog
changes, pets, settings dashboard, footer replacement, shell services, telemetry,
new speech model, public Realtime API fallback, browser audio bridge, phone/RPC
support, remote microphone forwarding, automatic host rollout or Pi upgrade.
No claim to control other apps' microphones, other users or non-cooperating code.

## 2. Evidence and what was actually verified

The pinned `src/`, `tests/`, package manifest and notices match Git. Its local
`bun.lock` was already modified by the earlier assessment's unfrozen install;
that file is not reproducibility evidence or a proposed extraction input.

| Finding                                                                                                                              | Evidence                                                       | Required response                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Focus preemption leaves two local owners until the displaced tick; a live process can be replaced after an 8-second missed heartbeat | Fake-clock/public-queue reproduction [O]                       | No preemption, no time-based lock stealing                  |
| Stop can remain pending; real arbiter `leave()` can clear the reference before disposal awaits it                                    | Two complementary registration fakes [L][O]                    | One cleanup promise; release ownership last                 |
| Late parked callbacks repaint or close a newer run; mute resets on replacement                                                       | Deterministic callback and mute probes [L]                     | Generation fencing; no transparent replacement              |
| Repeated delegation executes twice; a second ID overwrites the first                                                                 | Controller fakes [L][T]                                        | Per-call deduplication and single-flight admission          |
| Native offer/open/DeviceCheck promises can outlive abort                                                                             | Fake-native promise probes [T]                                 | Deadlines, late-result disposal and uncertain-cleanup state |
| 1 MiB text is accepted; chunking only bounds each 500-byte fragment; high socket buffering does not stop sends                       | Parser/transport fakes [T]                                     | Total byte/count/time bounds and backpressure               |
| Sanitizer leaves raw JWTs and URL passwords in some error strings                                                                    | Synthetic-value probes [T]                                     | Fixed diagnostic codes; never echo upstream errors          |
| Pi custom messages have no public run ID or atomic admission reservation                                                             | Exact 0.87.1 source inspection [P]                             | Admission plus receipt/branch checks; explicit limits       |
| Long-lived custom UI obscures nested dialog events and does not restore reliably around independent dialogs                          | Exact TUI/runner source inspection; not a PTY reproduction [P] | Render-only widget and mandatory real-TUI tests             |

Parent reran all five executable probe commands under macOS
`sandbox-exec -p '(version 1) (allow default) (deny network*)'`, external 45-second
timeouts, and empty HOME/PI agent directories. All exited 0: six lifecycle cases,
queue/filesystem/ownership cases, and seven transport tests. Logs are retained in
`preview/live-spec/verification/` in the research worktree. A second recorded
rerun through `verify-probes.ts` retained `receipt.json` with exact command argv,
controlled environment, exit codes and output hashes. Its network-denial guard
also passed: a loopback socket attempt received `EPERM`. These tests reproduce
upstream behavior; they do **not** certify a fixed extraction.

An initial transport-probe mock was ineffective and reached the real undici fetch
path with synthetic credentials. Whether a socket connected was not established.
No real credential or microphone was used. Those attempts are excluded; corrected
aliases plus the parent's OS-level network denial own the recorded reruns. Do not
summarize the entire investigation as having made zero network attempts. [T]

Earlier upstream test counts (260 full-suite tests, and scout subsets) describe
the existing source with locally resolved dependencies, not a frozen install.
At initial spec preparation, no real voice call, entitlement check, audio
permission test, SDK correlation integration test or actual live TUI test had been
performed. Subsequent bounded [#514 feasibility](FEASIBILITY.md) supplies real-SDK,
fake-media TUI and frozen-production loader evidence, not implementation gate
passes. Parent reruns covered 18 SDK cases plus a failing guard mutation, the
accepted shortcut exception and continued coding after voice stop, and isolated
frozen loading with explicit pnpm peer policy. No real voice/audio canary has run;
native source/notices and the actual extraction's acceptance gates remain open.

## 3. Package and adoption ownership

### Source layout

Use one deep module: the caller loads one extension factory; protocol, native
media, call lifecycle and credential details remain its implementation. A narrow
Pi adapter handles commands, UI, credentials and delegation; the live module owns
startup, mute, stop, ownership and cleanup. Keep native/network seams private,
with real and fake adapters. Prefer changes in the owning implementation over
layered wrappers; no separate identifier adapter or generic policy framework.

Proposed repository ownership:

- `upstream/pi-live/`: exact selected upstream source/test bytes and MIT notices.
- `upstream/pi-live.lock.json`: repository, commit, selected-file hashes, native
  origin, original path mapping and extraction/adaptation provenance.
- `config/pi-live/`: owned entry, narrow settings/auth/diagnostics/ownership
  modules, hardened live modules, package manifest and pnpm lock.
- `scripts/check-pi-live.ts` and tests: actual Pi loading/correlation checks and
  public rollout fixtures; native/network fakes are explicit internal adapters.
- `docs/guides/agent/PI-LIVE.md`: eventual user controls, data disclosure,
  experimental support limits, setup/canary/recovery instructions.

Keep exact source snapshots separate from owned adapted files. An import/check
command verifies the selected upstream inventory and records intentional changes;
it must not silently refresh main or rewrite source hashes. Avoid a second
hand-maintained runtime copy: only `config/pi-live/` is loaded. Retaining original
files is provenance, not another installed extension.

| Upstream material                                                              | Extraction treatment                                                                                       |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `src/live/protocol.ts`, `voices.ts`                                            | Retain wire formats/voice list; add bounds and tests                                                       |
| `controller.ts`, `transport.ts`, `native.ts`, `attestation.ts`                 | Adapt ownership, deadlines, startup ordering, data and cleanup contracts                                   |
| `visualizer.ts`                                                                | Retain compact waveform/transcript rendering; adapt to a widget, remove modal key handling                 |
| `src/live/index.ts`                                                            | Replace full-config coupling with narrow extension registration and lifecycle                              |
| `queue.ts`, `focus.ts`                                                         | Keep provenance/evidence only; not v1 runtime                                                              |
| `codex-auth.ts`, `paths.ts`, `format.ts`                                       | Reuse reviewed parsing/path ideas only; no raw-auth fallback or general-purpose config/format graph        |
| `tests/live-*.test.ts`                                                         | Preserve applicable behavior tests; explicitly supersede focus/FIFO/modal behavior with new contract tests |
| Root entry, config, footer, reset, image, websearch, pets, model/usage helpers | Omit                                                                                                       |

Initial direct dependency candidates remain the source pins:
`https-proxy-agent@9.1.0`, `proxy-from-env@2.1.0`, `undici@8.10.0`, `ws@8.21.2`.
Use the current host's `@oh-my-pi/pi-natives-darwin-arm64@17.2.9` as the initial
optional native dependency. Other upstream native targets may be added only with
an explicit support decision and host test. No `sharp`, pooled-account bridge or
additional OS-lock package is required by the proposed v1.

Use Node >=22.19.0 and pinned pnpm 11.8.0. Pi peers are `pi-coding-agent` and
`pi-tui` with `"*"` per Pi package guidance, with exact 0.87.1 development tests
and an activation-time compatibility check. No reliance on undeclared Pi
transitive dependencies. The addon advertises Bun, not a Node support contract;
its successful prior Node import is not proof of device or shutdown behavior.
Audit exact dependency/native pins before approval; do not inherit the whole
upstream overrides list or its rewritten Bun lock. New dependencies/installations
need implementation authorization. [I][T]

Carry complete upstream MIT and `THIRD_PARTY_NOTICES.md` text, including the
Mario Zechner / Can Bölük notices, and provenance to Matt Leong and monotykamary.
G0 must resolve exact native-binary provenance and complete notice obligations
before any adoption: the currently installed addon contains only a binary,
README and MIT-labeled manifest, not a license/third-party notice bundle. Record
the artifact integrity, matching native source/release and required notices;
metadata alone is not a complete license verification. If these cannot be
established, stop rather than assert compliance. The MIT source license is not
a grant of OpenAI service access or protocol stability. [U]

### Load and rollout contract

Avoid adding an activation transaction or persistent launcher to v1. Use an
explicit versioned package path; no active pointer or settings entry can switch
to an unprovisioned revision.

Proposed public additions (not existing commands):

1. `pnpm rollout --host mba --home <home> --live-only --output <plan>` stages
   only the private package beneath
   `~/.local/share/dotfiles/capabilities/live/<revision>/`. The plan schema gains
   `scope: "live"` and `liveRevision`; apply recomputes and validates both.
   Reject combining `--live-only` with `--capabilities-only`.
2. `pnpm capabilities setup --only live --revision <revision> --home <home>`
   provisions only those verified files. `check` with the same selectors is
   read-only/offline. `revision` is the full SHA-256 of the canonical sorted map
   of effective runtime relative paths to SHA-256 bytes, including package,
   any package-manager configuration, pnpm lock and provenance; exclude dependencies/receipts and the
   containing revision path. Setup accepts only the current source's revision.
3. Successful check prints the exact explicit loading command:
   `pi -e <absolute-revision-path>/index.ts` (plus user-selected resume options).
   Only the user's invocation selects that revision. It does not start audio;
   `/live` remains necessary. No mutation of a held session.

Do not silently extend ordinary baseline rollout, `--capabilities-only`, or
`setup --only all` to include live. They retain their prior behavior; explicit
live scope owns the new source inventory. Revisions are additive. Failed
stage/setup/check leaves any old ready revision runnable through its old explicit
path. First installation simply has no runnable live revision until setup passes.

Setup verifies regular host-local source/manifest/lock bytes before running
`pnpm install --ignore-workspace --prod --frozen-lockfile --ignore-scripts --config.auto-install-peers=false`
in the staged directory. Lock generation must also pass
`--config.auto-install-peers=false`, and both locks must record that policy.
pnpm 11.8.0 ignores this setting in `.npmrc`; do not rely on that file or add a
second configuration layer for this policy. The feasibility fixture retains its
ineffective `.npmrc` as evidence, not as required runtime configuration. Pi peers
remain `"*"`, while development has exact Pi 0.87.1 dev dependencies. A production install must contain no private
`pi-coding-agent` or `pi-tui`; the actual Pi loader supplies those imports through
its installed aliases (0.87.1 `dist/core/extensions/loader.js:35-83,404-414`).
G0/G1 must prove production loading without an ambient parent `node_modules`.
If this resolution policy fails or the native addon needs a dependency script,
stop for a specific review; do not install a second Pi or enable scripts broadly.

No native/audio or network modules are used by file planning. `check` validates
installed dependency identities and imports only as needed for an explicitly
non-device loader check; it never opens media, resolves auth or connects.
Source hash drift, missing inputs, redirected parents or unsupported host/Pi
versions fail before setup or call activation. Old versions/caches and private
rollout records remain. Runtime rollback means exiting the new Pi invocation
and explicitly launching the previously checked revision. File rollback affects
only the scoped source files, never authentication or the live lock, and must
not be applied to a revision still used by a running Pi process. Cached runtime
removal requires separate authorization. [I][D]

## 4. User-visible contract

Commands share `/live`; no other command namespace is installed:

- `/live` toggles; `/live start` and `/live stop` are explicit, idempotent forms.
- `/live mute` stops microphone capture; `/live unmute` reopens it only for the
  same active call after prerequisites still hold.
- `/live voice <name>` changes the next call's voice, only while stopped.
- `/live status` reports the lifecycle state and mute flag, plus a last-failure
  code when off; it exposes no account/session IDs or credentials. `failed` is
  a diagnostic outcome, not an additional lifecycle state.
- `/live help` states host-local audio, controls, data sent, limits and recovery.
- `Ctrl+Shift+L` uses the same toggle path. If terminal encoding cannot deliver
  the shifted chord, the command remains the supported fallback.

The widget owns only the key `pi-live`; it never calls `setFooter`, replaces the
editor, registers a model tool, or consumes normal editor/dialog input. Retain
small waveform and current user/voice transcript display, visible muted state,
and explicit working/failure state. Stop/dismiss removes only this widget and
its timer. A stopped or failed call must never display "listening".

Store host-local voice preference at `$PI_CODING_AGENT_DIR/pi-live/config.json`
(default `~/.pi/agent/pi-live/config.json`), private permissions, atomic write,
unknown-field preservation. No project config, writes on load, or migration of
the original Better OpenAI configuration. Missing config defaults to `sol`;
malformed config or invalid selected voice fails visibly without auto-repair.
The source voice enum is the allowed list. No persistent desired-active flag.

Each new start attempt obtains a standard TUI confirmation before any native
initialization or credential resolution. It names the execution host, microphone
and speaker use, OpenAI/experimental protocol and final-result sharing. Consent
and `/live help` also disclose that Pi's session identifier is sent to OpenAI,
linking calls made from that Pi session, and that shortcut-opened dialogs may
leave voice active because Pi does not report them. Tell the user to stop voice
before opening such dialogs when they need capture/delivery stopped. Cancel means
no network, native load, lock or audio. An approved call starts unmuted
only after the visible connecting panel and all setup gates below. Restart after
failure requires another explicit start and confirmation.

All non-TUI modes refuse before reading credentials, touching call ownership,
loading natives, creating timers or constructing transports. Installation and
extension discovery are inert. Remote TUI launchers use the remote host's audio,
not the phone/client microphone; unsupported remote usage must be described,
not silently treated as working local speech.

## 5. Call lifetime, ownership and mute

### State machine

`off -> consent -> acquiring -> connecting -> active -> stopping -> off`.
Validation failure before acquiring returns to off with a fixed diagnostic.
Cleanup uncertainty enters `blocked`, not off. No automatic restart, promotion,
reconnect, retry of a coding task or re-opening after session replacement.
Mute is a boolean intent within active, independent of working/speaking state;
it cannot reset because a transport object was replaced.

| Current state                        | Start / toggle / stop / mute policy                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| off (including last-failure outcome) | Start or toggle begins one consent attempt; stop is a no-op; mute/unmute refuses                                                   |
| consent/acquiring/connecting         | Start reports the existing attempt; toggle or stop cancels that attempt; mute/unmute refuses; later consent completion is ignored  |
| active                               | Start reports already active without another consent; toggle/stop begins cleanup; mute/unmute is idempotent within this generation |
| stopping                             | Start/toggle reports stopping and never arms another call; stop joins the same cleanup; mute/unmute refuses                        |
| blocked                              | Start/toggle refuses; stop only reports the blocked state and keeps the lock; no in-process reset or retry                         |

Voice selection is allowed only in off. Help/status are read-only in every state.
Live's own consent prompt runs only in consent, before any audio; it is not an
independent prompt-triggered stop. Track its attempt token so a canceled attempt
cannot be revived by a late Yes. Every real start rechecks admission afterward.

Every attempt has an unguessable generation token. All callbacks, scheduled
starts, timers, sends and late promise completions check it before touching UI,
audio or Pi. Stopping invalidates delivery immediately, then runs exactly one
shared cleanup promise. Repeated stops join that promise. A late native result
is disposed, not adopted by a later generation. [L]

### Minimal no-preemption lock

For the first supported host, derive the authoritative home from
`realpath(os.userInfo().homedir)` (the OS account record), not environment HOME.
Refuse call activation if HOME resolves elsewhere, if the account home cannot
be resolved, or if setup has not certified it as local storage. Use its private
`.local/state/pi-live/active.lock/`, **independent of PI_CODING_AGENT_DIR**.
Exclusive directory creation is acquisition. Owner metadata is private and may
contain PID, call generation and process-start information for diagnosis; it is
not authority to steal. Any existing, partial, unreadable, malformed or redirected
lock is busy. Do not poll, queue, replace, rename over, sweep or age-reap it.

Only its creator removes its verified unchanged owner files/directory, after
capture, peer, sockets, timers and pending startups are confirmed stopped.
Verify filesystem identity and owner token; identity mismatch or unexpected
contents leaves it blocked. No recursive force-removal. The guarantee applies
to cooperating v1 calls under the same OS user/canonical local home. It does not
cover other apps, upstream `/live`, different users, tampering by that same user,
or a network/shared home. Setup certifies the owning host's local home; do not
claim portable cross-host locking.

A crash may leave a stale busy lock. Recovery is deliberately manual: stop all
possible owner processes in that scope, verify no owner can resume, inspect the
exact task-owned record and ask before deletion. PID liveness or heartbeat age
alone is insufficient. No `/live force` command. Loading old Better OpenAI live
alongside the extraction is unsupported. Refuse known configured Better OpenAI
package sources and observable competing `/live` commands through
`pi.getCommands()` provenance; test both load orders. Pi has no public complete
extension/shortcut inventory, so do not claim universal conflict detection.
Additional manual/project-loaded live implementations may not be detectable and
are expressly outside the lock guarantee. Document that they must not be loaded
alongside v1; do not reach into private runner state to pretend otherwise. [O][P]

### Startup/stop ordering

1. Require supported TUI/host/Pi, no conflict, no reported blocking dialog, idle Pi and no
   pending work; display/obtain consent; recheck conditions afterward.
2. Acquire ownership; resolve one credential/account; load/validate native
   bindings; establish peer/signaling/sideband under the connect deadline.
3. Before opening capture, recheck current generation, mute intent, session and
   ownership. Capture never starts merely because authentication is pending.
4. On mute, gate outgoing samples immediately and stop capture. In-flight audio
   already sent cannot be retracted. Speaker playback may continue; mute is not
   a claim of silence or disabled output. Unmute creates at most one capture.
5. On stop/failure/shutdown, invalidate callbacks and gate audio first, stop
   capture, cancel startup/retries, discard pending context, close sideband and
   peer, clear buffers/widget/timers, then release ownership. From the stop fence,
   reject new microphone samples and data-bearing sends, including queued final
   text. Permit at most one best-effort, fixed `session.close` control frame within
   the cleanup budget; it cannot delay local cleanup indefinitely. Audio already
   handed to native/network buffers cannot be retracted; confirmed cleanup means
   no remaining capture or speaker playback.
6. If native stop throws, a peer close never resolves, or any late resource can
   still open, the responsive observer reports blocked at its cleanup deadline
   and keeps the lock. Timing out an await is **not** proof the operation stopped.
   Blocked is sticky for the remainder of that Pi process even if cleanup later
   succeeds. A background finalizer may dispose late resources but never release
   the lock, resume delivery or admit a new call. End the process and recover.

Track data-only waits separately from media-resource waits. A late SDK credential
or DeviceCheck result cannot open audio by itself; after fencing all continuation
paths it may be discarded, and otherwise confirmed cleanup may release ownership.
Pending offer/answer/open/close or capture operations are resource uncertainty:
enter sticky blocked unless their termination is positively established before
the observer deadline. Resolve credentials/attestation before constructing a peer
to keep the data-only distinction real. Test each class and exactly-one release.

Five seconds is a best-effort **observer** deadline while the event loop remains
responsive, not a hard wall-clock native stop guarantee. If a synchronous native
call blocks the loop, no timeout/UI notification can run until it resumes. Report
then and retain ownership. If a real canary finds event-loop blocking or cannot
certify native close, adoption fails; process isolation needs a separately
reviewed design. Do not hide the gap behind Promise.race.

Session shutdown (quit/reload/new/resume/fork) fences voice but does not by itself
authorize lock release. Every replacement/reloaded runtime starts empty and must
acquire the same canonical lock; it cannot inherit/bypass an old pending or
blocked owner. Same-session tree navigation begins stop before changing branch;
failed cleanup cancels cancellable navigation. If teardown prevents the finalizer
from completing, the safe result is a retained busy lock, not takeover.

On observing non-live `ui_prompt_start`, synchronously fence capture and
data-bearing send callbacks and begin cleanup; never modify the dialog or its
Yes/No result. Pi 0.87.1 queues this notification in a microtask and does not await
handlers: a small detection window exists between prompt invocation and voice
fencing. The guarantee starts at observed event delivery and covers only reported
select/confirm/input/editor/custom primitives, not every core/third-party approval
surface. Pi's shortcut handlers receive an unwrapped UI context; a real shortcut
`ctx.ui.confirm()` was verified to emit no prompt event, leaving fake sends active
while the dialog was pending. This is a missing notification, distinct from the
microtask window, and is an explicitly accepted v1 limitation. Consent/help must
name it; users needing capture and data delivery stopped must stop voice before
opening such a dialog. Do not claim automatic stopping for unreported shortcut dialogs.
Dialog admission checks likewise cover reported dialogs only; an unreported
shortcut dialog is not a detectable busy condition. Voice never authorizes or
answers that dialog. Live's widget holds no custom-prompt depth, and live-owned
consent remains exempt.
If all extension dialogs must stop voice, or zero audio from the instant an
approval is invoked is required, return to a Pi-owned pre-prompt design rather
than adding private runner access or describing the event as an input mutex.
[P] [#514 feasibility](FEASIBILITY.md)

## 6. Coding delegation and result ownership

The voice model can converse directly, but tool work remains in the active Pi
agent. A voice request is not an approval grant and cannot expand a slash command,
change the system prompt, choose a model, bypass tool guards or answer a dialog.
The visible request must identify voice as its origin, not impersonate a typed
user approval.

Admission at each `delegation.created`:

- Validate structure, target, UTF-8 size and bounded non-empty ID/content.
- Maintain a per-call map of seen IDs and request fingerprints. Same ID/same
  content never executes again, including after settlement. Same ID/different
  content is a protocol failure. Never replay after reconnect (there is none).
- Accept only one outstanding request, when current Pi context is idle, has no
  reported pending messages or active signal, has the same session/branch, and
  no reported blocking dialog. Busy/new second ID does not queue or steer: end voice with a fixed
  message; accepted Pi work, if any, continues normally.
- Arm correlation synchronously before the single `pi.sendMessage` call. Keep
  the existing custom type `better-openai-live-delegation` for session rendering,
  `display: true`, and `triggerTurn: true`. Add versioned details carrying source,
  generation, delegation ID and a local receipt token. Do not invent a Pi run ID.
  The message content is the displayed coding request, not hidden instructions.

`sendMessage` returns void and can steer if another task wins a race. Admission
checks are not a scheduler reservation. Require matching custom-message start/end
observations and the persisted matching entry on the active branch before any
answer may leave Pi. Capture session identity, pre-dispatch leaf/entry set and
new entries. Unknown user/custom input or an unrelated run before the receipt
invalidates voice correlation. Observe source events and the branch projection;
non-trigger custom appends are not all delivered through extension message hooks.

At `agent_settled`, require the same generation/session, one matching receipt,
no navigation or ambiguous model-visible additions, and a successful final
assistant text belonging to that admitted interval. Standard tool results and
Pi-owned system deltas are not by themselves new user requests. Compaction,
context edits or another extension's continuation must either preserve provable
ownership in a real SDK test or invalidate forwarding. No guessing from the last
assistant message, timestamp or session ID. On ambiguity, abort/error, missing
receipt or receipt timeout, stop voice and direct the user to the normal Pi
transcript. Never read the full historical session to construct voice context.

Send **only final text**, under the upstream `Agent Final Message` convention;
no thinking, raw tool results, command output or intermediate commentary. Add a
visible truncation marker if the final exceeds the budget; the full result stays
in Pi. Receipt metadata is local session metadata, not extra provider context.
User-facing session history persists the request and ordinary agent results;
raw speech fragments/audio are not separately persisted by this package.

This provides conservative observed correlation, not cryptographic isolation
from another extension in the same process. A real SDK race test is a release
blocker: if public 0.87.1 events cannot reliably reject a competing prompt, do
not ship automatic result forwarding. Return to spec review for an explicit
confirmation step or upstream atomic-dispatch seam; do not privately patch Pi
or market ambiguous results as owned. [L][T][P]

Stopping voice never aborts the coding task. Later `agent_settled` must not send
its output to a stopped or future call. Normal Pi cancellation remains the way
to stop that coding task. A 30-minute delegated-work deadline stops voice only.

## 7. Credentials, transport and data policy

Use only Pi's `modelRegistry.getApiKeyForProvider("openai-codex")` credential
path. It reaches SDK OAuth refresh and serialized credential-store writes;
refresh failures appear as undefined. Do not read/write auth files directly,
copy refresh tokens, resolve auth on load, or retry through another account.
Require a parseable Codex account identity, pin it for the call, and fail on an
unusable/expired result. Token decoding extracts identity, not signature proof.
The credential accessor may itself complete after a caller timeout; ignore its
late result and do not use it to resume setup. [P]

Retain the existing experimental signaling and fixed sideband origin:

- `POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`
- `wss://api.openai.com/v1/live/<call-id>`
- Model `gpt-live-1-codex`, Quicksilver v2 and the pinned desktop compatibility
  headers. Do not imply this is an official supported integration.

Preserve upstream's identifier mapping: `session-id` and `thread-id` both carry
`ctx.sessionManager.getSessionId()`; `x-session-id` carries a fresh random realtime
identifier for each call. Keep these values consistent across signaling and that
call's sideband attempts. This transmits Pi's session identifier, not its session
history. Do not substitute per-call values for the Pi identifier without separate
protocol evidence and review. The pinned `buildLiveHeaders` test records this
mapping; it is not proof that the provider requires it. [U]

Signal with redirects disabled. Accept only a bounded `rtc_` call ID extracted
from an absolute expected-origin or relative Location with no userinfo, query or
fragment; construct the sideband on the fixed origin, never the supplied host.
Confirm the permitted Location shape during the canary before freezing it.
Set explicit WebSocket no-redirect/maxPayload options. No bearer/header values,
SDP, device tokens, response bodies or credential-bearing proxy URLs reach logs.

Only sideband pre-open transient network/5xx failures may retry, at most three
attempts under one total connect budget. No retries for 401/403, malformed data,
permission failures, cancellation, or after sideband opens. No signaling POST
retry, account fallback, entitlement workaround or public-API substitution.
Fail clearly and let the user retry explicitly.

Honor the existing proxy environment for HTTP signaling and WebSocket traffic.
It does **not** establish that native WebRTC media/ICE is routed through that
proxy. State this in setup and disclosure; environments requiring all media to
traverse a proxy are unsupported until independently proven. [T]

macOS arm64 attestation sends DeviceCheck material plus locale/timezone and a
random app identifier, using the source's Codex bundle identifier. This is part
of the experimental protocol consent, not generic anonymous telemetry. Bound the
native call; distinguish cancellation/timeout from a provider-defined unsupported
result. On a hanging native operation stop adoption of that call, not an automatic
second negotiation without attestation. No attestation bypass is in scope.

### Initial budgets (design choices, not provider limits)

All time budgets are best-effort observer deadlines while the event loop is
responsive, measured from a monotonic clock. Every phase, backoff, body read and
cleanup wait consumes its containing total deadline rather than resetting it.
Text/body limits count UTF-8 bytes before TypeScript parse/copy/accumulation, not
JS length. Native callbacks already allocate data before entering TypeScript;
the pinned addon remains trusted for its internal allocations and device behavior.
These are application bounds, not a memory sandbox around native code. Limits
are centralized/tested; changes require an explicit spec/test update.

| Limit                                               | v1 value and overflow policy                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Full connect                                        | 30 s including credentials, attestation, native steps, HTTP/body and sideband attempts; cancel call                                         |
| Credential resolution / DeviceCheck                 | 5 s each, capped by remaining connect budget; stop call                                                                                     |
| Offer / answer / native open / sideband attempt     | 10 s each, capped by remaining connect budget                                                                                               |
| Stop observation                                    | 5 s total while responsive; report off or blocked, never infer native cancellation                                                          |
| Receipt ingestion                                   | 5 s; missing proof stops voice without resubmitting work                                                                                    |
| Delegated work / total call                         | 30 min / 60 min; visible expiry, end voice only                                                                                             |
| SDP offer / response answer                         | 1 MiB each; validate offer before serialization and stop streaming response read at limit + 1                                               |
| Serialized signaling request                        | 2 MiB including escaped SDP/instructions; reject before HTTP construction                                                                   |
| Access token / account ID                           | 16 KiB / 256 bytes; reject unusable credential before headers                                                                               |
| DeviceCheck token / full attestation header         | 8 KiB decoded / 16 KiB serialized; validate before CBOR/header construction                                                                 |
| Combined application request headers                | 64 KiB serialized; fail rather than emit oversized headers                                                                                  |
| Native microphone callback                          | Mono Float32Array, at most 16,000 finite samples per callback; token-bucket cap 32,000 samples, refill 16,000/s; invalid/overflow ends call |
| Non-OK body                                         | Do not print; read/discard at most 8 KiB then cancel body                                                                                   |
| Inbound event/frame                                 | 256 KiB before JSON parse, both sideband and native data callback                                                                           |
| Delegation request / transcript turn / final return | 64 KiB each; reject request, retain bounded transcript tail, truncate final with marker respectively                                        |
| ID / content entries / seen IDs                     | 256 bytes / 64 / 256 per call; invalid or exhausted call ends, no eviction permitting replay                                                |
| Context chunk                                       | Preserve upstream maximum 500 UTF-8 bytes                                                                                                   |
| Outgoing work buffer                                | At most 256 fragments and 256 KiB serialized pending data; enqueue final incrementally                                                      |
| WebSocket buffered bytes                            | 256 KiB high-water; wait via checked send completion within deadline, never enqueue blindly                                                 |
| Individual send                                     | 5 s, also capped by stop deadline; failure ends voice                                                                                       |
| Event ingress rate                                  | Token bucket capacity 200 events, refill 200/s from monotonic time; count before dispatch, exhaustion ends call                             |
| Transcript history                                  | Latest bounded turn per role only; no full audio/transcript ledger                                                                          |

All maxima are inclusive; the next byte/event/sample beyond available capacity
fails. Tests cover exact boundary and multibyte/escaped content. A 64 KiB final
can require at least 132 UTF-8 chunks before JSON overhead, and JSON escaping can
expand its serialized total beyond 256 KiB. Produce/serialize a chunk only when
pending capacity is available; the 256 KiB/256-fragment limits cover currently
unsent envelopes, not the full final. Include existing queued envelopes and the
next envelope when checking both limits. A valid final waits for capacity and
fails only on its send deadline if nothing drains, never just because a producer
materialized the entire final. Control close bypasses/discards pending context;
do not drain an unbounded queue to stop.

Diagnostics use a closed code set (busy, missing-auth, denied, connect-timeout,
protocol-error, audio-error, cleanup-blocked) with fixed text, phase, safe numeric
HTTP status and optional dependency version. Never attach raw Error.message,
cause, stacks or response strings. This avoids trying to prove regex redaction
for every possible secret. No hidden debug log escape hatch in v1. [T]

## 8. Acceptance gates and traceable tests

No canary before G1-G4 pass. No host adoption claim before G5 passes. A test using
a fake proves that seam's behavior, not a real audio/SDK interaction.

| Gate                           | Required evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0: provenance/package         | Exact upstream selection/hashes/notices and native-binary provenance/notice resolution; frozen prod pnpm install with auto-install-peers disabled; no private Pi runtime; real Pi loader resolves supplied imports with no ambient parent dependencies; native/Pi engine checks; no unrelated code or dependency scripts                                                                                                                                                                                                                                                                                                                                                                                                                        |
| G1: inert loading              | Real Pi 0.87.1 discovers only the live commands/shortcut/renderer, plus necessary live lifecycle listeners; zero tools/providers/model/footer/editor mutations, network/auth/native init/timers/files on load; non-TUI rejection has no call side effects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| G2: lifecycle/ownership        | Fake clocks/native/transport and real child contenders exercise exclusive calls; partial/corrupt/crash locks busy, no stale-PID reaping; alternate HOME refused, different PI agent dirs share lock; all command/state rows incl canceled consent and start-during-stop; reload -> pending close -> new runtime start remains busy; data-only late results versus sticky media uncertainty; exactly-one release only after confirmed stop; stale callbacks rejected; recognized pooling announcement cancels consent/acquiring/connecting/active and refuses later starts; mute capture counts; manual recovery never based on PID age                                                                                                          |
| G3: delivery/privacy/transport | Duplicate/changed/new IDs, exact receipt and busy refusal; no audio/data sends after stop fencing, at most one bounded session-close control frame; upstream session/header identifier mapping; byte/count/deadline/backpressure limits at boundary + 1; never-resolving native calls and late resolution; redirects/401/403/5xx/cancellation; SDK auth refresh fake store test; final truncation; synthetic secrets absent from every observable diagnostic                                                                                                                                                                                                                                                                                    |
| G4a: real SDK                  | In-memory Pi 0.87.1 with deterministic in-process provider and fake media: custom receipt -> tools -> final -> agent_settled; competing prompt race, non-trigger custom append, continuation, retry/compaction, errors/abort, tree/reload/new/fork/resume and stopped-call final all discard ambiguous/stale output. No invented run IDs or last-message shortcut                                                                                                                                                                                                                                                                                                                                                                               |
| G4b: real terminal             | PTY plus actual Paseo terminal review using fake media: waveform/status, narrow/wide/Unicode/resize, normal editor typing, toggle delivery; own consent exempt and late Yes cannot restart; consent/help disclose Pi session identifier sharing and shortcut-dialog exception; five reported extension dialog primitives retain focus/keys/Yes/No/cancel, observed prompt notification fences further audio/data sends with only bounded session-close permitted and the detection window acknowledged; reproduce unreported shortcut confirmation with voice still active, normal dialog result and subsequent explicit stop rather than claiming automatic fencing; task continues after stop, footer untouched, no call timer after teardown |
| G4c: public installer          | Fresh/populated homes: scope live/revision persisted/revalidated, incompatible selectors rejected, offline plan, second plan empty, exact inputs before setup; failed staging/setup leaves old explicit revision runnable, check emits only ready path; explicit pnpm peer-policy flag and matching lock; source/target/symlink drift refusal, partial apply and rollback, missing addon safe, unrelated settings/models/auth/memory/MCP/skills preserved; existing scopes/all exclude live                                                                                                                                                                                                                                                     |
| G5: authorized MBA canary      | Explicit microphone/service approval; load/stop, missing/denied mic, real speech/transcript, one harmless read-only coding task with correct spoken final, mute/unmute/stop, second terminal busy, failed connection/cleanup, immediate stop fencing of new microphone samples and no capture/playback after confirmed cleanup (already-buffered media cannot be retracted), real dependency closure and permission receipt. User verifies speakers/mic and terminal behavior; no claims from mock success                                                                                                                                                                                                                                      |

All G1-G4 provider tests use empty credential stores/homes and network-denied
execution (OS sandbox or repository-owned Linux network isolation), not mock
naming alone. Test fixtures use a throw-on-use network adapter by default, and
native capture is fake unless the test explicitly opts into a host canary.
Never use actual auth.json as a convenient fixture.

Run repository typecheck/format/test/test:github, relevant Pi integration checks
with their documented fixture prerequisites, and the new extraction checks.
No unrelated failing test deletion, inline lint suppression or SDK upgrade to
make a test pass. Prove cheap new guards by one mutation each: bypass dedup,
release lock before close, remove generation check, allow raw error text and
remove a bound; the corresponding tests must fail.

## 9. Work sequence, stop points and estimate

1. **Feasibility first:** build disposable real-SDK correlation and widget/dialog
   probes plus Node-native lifecycle checks (device access remains a later
   authorization). Resolve G4a/G4b contract gaps before vendoring a large slice.
2. **Extraction:** selected-source importer/provenance, private manifest/lock,
   narrow module and live-only configuration, inert discovery tests.
3. **Hardening:** ownership/state machine, mute/cleanup/callback fencing,
   single-flight receipts, budgets and closed diagnostics; port relevant tests.
4. **Integration:** explicit live-only plan/setup and versioned `pi -e` invocation,
   preservation/rollback fixtures, guide and supported-host checks. No persistent
   launcher/pointer transaction or global baseline activation.
5. **Canary and handoff:** obtain host/provider/audio authorization, execute G5,
   record retained runtimes and rollback artifacts; ask separately for push/PR.
   The user merges dotfiles. Never arm auto-merge here.

Stop and revise the design if the SDK cannot establish conservative delegation
correlation, the widget cannot coexist with reported approvals, a native operation cannot
be closed safely, the endpoint rejects the account, dependency scripts are needed,
or protocol requirements conflict with the disclosed data policy. None of these
is permission to broaden credentials, change systems or improvise a new service.

The earlier **1-2 day** estimate covered a mostly faithful extraction and does
not cover this contract. First authorize a bounded feasibility phase: plan
**0.5-1.5 focused engineering days** for SDK receipt/race probes, widget/dialog
PTY behavior and production peer resolution, stopping early on a failed seam.
Real native close/device behavior needs a separately authorized host diagnostic
window; fake close success cannot close that question.

The completed bounded probes support proceeding to a separately authorized
extraction phase under the accepted shortcut limitation and explicit pnpm peer
flag. The [feasibility report](FEASIBILITY.md) owns the provisional implementation
estimate and remaining gates. Extraction/provenance, lifecycle/ownership,
transport/privacy and installer/test work are not covered by feasibility approval.
There is still no fixed delivery date. Process isolation, pooled accounts
or focus-handoff redesign are separately estimated scope changes.

## 10. Approval and evidence status

| Decision/action                                                                                     | Status                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source investigation, Luna probes and this local spec                                               | Authorized and completed                                                                                                                                                                                                                                                                                                                                                       |
| Bounded feasibility #514 and Sol 6 xhigh dispatch                                                   | Completed and accepted by the user; #515 has separate package/provenance scope approval, not a G0-G5 pass                                                                                                                                                                                                                                                                      |
| #515 pinned package/provenance/inert-entry implementation and scoped dependency checks              | Completed locally on `feat/pi-live-package`: exact source receipt, 64-file revision `9c65c548f9a130b84f7bfed335b7a081333e4542eb4f498019462b7b8cf739f9`, frozen nine-package production closure and inert network/process/write-denied Pi loading passed. Committed locally as `18d0ed7`; pending delivery review. No installed-home, device/service/audio, push or PR approval |
| Fixture-only frozen install and necessary registry downloads, scripts disabled                      | Separately authorized and executed; no installed-home/runtime adoption, native-device or service/audio authorization                                                                                                                                                                                                                                                           |
| Reported-event dialog stopping; shortcut-opened dialogs may leave voice active                      | Accepted by the user after #514 reproduction; disclose in consent/help and test the exception; no private Pi patch                                                                                                                                                                                                                                                             |
| Three review corrections and minimal-adapter direction                                              | Approved for this spec only; no implementation, installation, service/audio or rollout authorization                                                                                                                                                                                                                                                                           |
| Remaining v1 scope/departures and MBA-only initial support                                          | Proposed; user approval required before implementation                                                                                                                                                                                                                                                                                                                         |
| Dotfiles-owned private package, explicit revision loading, scoped stage/setup (no launcher/pointer) | Proposed design; included in implementation approval                                                                                                                                                                                                                                                                                                                           |
| Exact dependency/native pins, native provenance/notices, frozen install/scripts                     | Operator accepted the documented native provenance/notice residuals on 2026-09-24 for personal/open-source use if the binary remains a pinned npm-fetched dependency and is not committed or rehosted; carry known notices/provenance and disclose residuals. Frozen install/scripts and technical G0/G1 checks still gate implementation.                                     |
| Experimental endpoint/data policy and actual MBA mic/speaker/service canary                         | Separate operator authorization required; operator owns host consent, dotfiles implementation owns evidence/rollback guide                                                                                                                                                                                                                                                     |
| Source/native updates and runtime retention/rollback                                                | Per-version reviewed adoption; retained caches are not deleted by source rollback                                                                                                                                                                                                                                                                                              |
| GitHub ticket publication for this contract                                                         | Authorized by the user's ticketing request; no implementation, install, service/audio or rollout approval                                                                                                                                                                                                                                                                      |
| Push/PR/runtime publication or another host                                                         | Not authorized; separate permission required                                                                                                                                                                                                                                                                                                                                   |

The operator's documented residual acceptance removes the evidence-only native
notice stop for this personal/open-source extraction. It is not a legal-clearance
claim and does not waive frozen package/install receipts, inert loading, SDK/TUI
feasibility, native lifecycle gates, or separate runtime provisioning approval.
The repository must fetch the exact native leaf from npm rather than commit,
mirror, or republish its binary. Changing repository visibility remains a separate
operator action.

This document owns the proposed behavior. Probe notes own observations, including
contradictory early recommendations: the integration scout's suggestion to retain
focus/queue and exact original hooks is superseded by this spec; the transport
scout's implication that registry auth does not refresh is corrected by [P].
No existing code or host has been changed to satisfy the contract.

### Review disposition

Two bounded challenge rounds are complete. The final [Luna review](reviews/luna-final.md)
and [independent review](reviews/independent-final.md) close their prior document
findings with no remaining specification blockers. This is not user approval or
proof of any unexecuted acceptance gate. Native notices, package resolution,
SDK correlation, actual terminal behavior and native/audio canary remain explicit
implementation/adoption prerequisites. The subsequent #514 trial and the user's
accepted shortcut-dialog exception are recorded in [FEASIBILITY.md](FEASIBILITY.md);
that decision narrows the behavior contract, not the remaining acceptance gates.

### Sources and retained evidence

- [U] [Pinned upstream source](https://github.com/monotykamary/pi-better-openai/tree/39171682343754366439b2c0890f5b0f4c3ed891), especially `src/live/`, `src/codex-auth.ts`, `src/format.ts`, `package.json`, `LICENSE`, `THIRD_PARTY_NOTICES.md`.
- [D] [Current dotfiles baseline](https://github.com/skhlo/dotfiles/tree/de9bab8a4f2cdb7c13650c43920545a544af41da), `scripts/build.ts`, `scripts/rollout-plan.ts`, `scripts/pi-capabilities.ts`, `docs/guides/operations/ROLLOUT.md`.
- [L] [Luna lifecycle evidence](probes/lifecycle.md), six fake-dependency cases with source lines.
- [O] [Luna ownership evidence](probes/ownership.md), fake-clock and operation-level findings distinctly labeled.
- [T] [Luna transport evidence](probes/transport.md), seven faked cases, dependency metadata and attempted-network caveat.
- [I] [Luna integration inventory](probes/integration.md), source closure, license and rollout analysis.
- [P] [Luna exact Pi contracts](probes/pi-contracts.md), installed 0.87.1 declarations/implementation, auth refresh correction, absent run IDs and dialog limitations.
- Pi installed docs read in full: `docs/extensions.md`, `docs/packages.md`, `docs/tui.md` beneath `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`.
- Research worktree: `/tmp/dotfiles-pi-live-spec`, branch `docs/pi-live-extraction-spec`; source checkout `/tmp/pi-better-openai.qnz8hk` retained. Executable probes and network-denied logs: worktree `preview/live-spec/`, including the verification runner/command receipt. No task-owned persistent processes.

This follows the repository's local-only `docs/research/` convention. Research is
ignored by Git; it is not a committed spec or a PR. Promote an approved contract
to the tracked guide with the implementation rather than pretending these local
notes are shipped documentation.
