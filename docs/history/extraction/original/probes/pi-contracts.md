# Luna bounded follow-up scout - Pi 0.87.1 contracts

Status: static research only. No implementation, install, authentication, provider
request, microphone access, executable probe, push, PR, or merge was performed.
The other live-extraction reports were not changed.

The inspected package is `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`
`0.87.1`. The exact nested SDK dependencies used below are `@earendil-works/pi-ai`
`0.87.1` and `@earendil-works/pi-agent-core` `0.87.1`. Evidence is from their
installed `dist` files and the installed Pi docs.

## 1. Credential refresh: the registry path does refresh

### Facts

**Yes. `modelRegistry.getApiKeyForProvider()` delegates OAuth refresh through the
Pi SDK credential store.** Refresh is not limited to a multiprovider service.
The exact chain for the installed implementation is:

```text
ModelRegistry.getApiKeyForProvider(provider)
  -> ModelRuntime.getAuth(provider)
  -> pi-ai Models.getAuth(provider)
  -> resolveProviderAuth(...)
  -> credentials.read(provider)
  -> resolveStoredOAuth(...) when the stored OAuth credential is near expiry
  -> credentials.modify(provider, ...)
  -> OAuthAuth.refresh(current, refreshSignal)
  -> credential-store write of the returned credential
  -> OAuthAuth.toAuth(credential)
  -> { auth: { apiKey } }
  -> ModelRegistry returns auth.apiKey
```

The owning source points are:

- `dist/core/model-registry.js:82-87` awaits `this.runtime.getAuth(provider)`,
  returns `auth.apiKey`, and catches every error as `undefined`.
- `dist/core/model-runtime.js:339-342` delegates the provider overload to
  `this.models.getAuth(providerOrModel, overrides)`.
- `@earendil-works/pi-ai/dist/models.js:276-284` creates the operation signal,
  resolves the provider, and calls `resolveProviderAuth` with `this.credentials`.
- `@earendil-works/pi-ai/dist/auth/resolve.js:26-49` reads the stored
  credential and selects `resolveStoredOAuth` for a stored OAuth credential.
- `@earendil-works/pi-ai/dist/auth/resolve.js:64-110` applies the default
  five-minute minimum-validity window. When `expiresSoon` is true it rechecks
  expiry inside `credentials.modify`, calls `oauth.refresh` with the caller
  signal plus a 15-second timeout, uses the post-write credential, and calls
  `oauth.toAuth`.
- `@earendil-works/pi-ai/dist/auth/types.d.ts:57-75` defines `modify` as the
  serialized read-modify-write path and explicitly says `Models.getAuth()` runs
  OAuth refresh inside it.
- `dist/core/runtime-credentials.js:5-6,17-31` wraps the application store and
  delegates `modify` to it unless a runtime API-key override is present.
- `dist/core/model-runtime.js:74-76` constructs that wrapper around the default
  `AuthStorage` when no injected store is supplied. `dist/core/auth-storage.js:282-284`
  selects the file-backed `auth.json` store, and `:378-394` performs the locked
  write of the callback's returned credential.

For the provider relevant to the transport report, the built-in provider is
`openai-codex` and advertises lazy OAuth at
`@earendil-works/pi-ai/dist/providers/openai-codex.js:6-19`. Its loaded OAuth
implementation calls the token refresh function with the stored refresh token
and derives the request key from the refreshed access token at
`auth/oauth/openai-codex.js:420-447`.

The correction to the earlier transport report is therefore:

- the multiprovider path may be an additional application-level credential
  source, but it is not the only refresh path;
- `getApiKeyForProvider("openai-codex")` itself reaches the SDK's OAuth refresh;
- a refresh failure is deliberately hidden by the compatibility facade and is
  observed there as `undefined`, not as a typed refresh error;
- the registry method has no caller-supplied signal, but the SDK OAuth refresh
  still has its own 15-second refresh timeout.

### Proposed criteria

A fake-only contract test should inject a `CredentialStore` and an OAuth provider,
then assert all of the following without reading `auth.json` or contacting a
provider:

1. a credential outside the five-minute window returns its current access token
   and does not call `refresh`;
2. an expiring credential calls `modify`, rechecks the current credential, calls
   `refresh` once, persists the returned credential, and returns the new access
   token through `ModelRegistry.getApiKeyForProvider()`;
3. a refresh rejection makes the registry method return `undefined`; and
4. a runtime API-key override bypasses the persistent store.

This test should exercise the registry path directly. A multiprovider-only fake
would not prove the Pi 0.87.1 contract.

### Unresolved behavior

The installed contract does not make `getApiKeyForProvider()` distinguish a
missing credential, a failed refresh, and a provider whose `toAuth` failed: all
are caught as `undefined`. A custom injected `ModelRegistry`, credential store,
or provider extension can of course have different behavior. No live refresh was
run here.

## 2. `sendCustomMessage` correlation and the absence of run IDs

### Facts

The public extension API accepts `triggerTurn` and `deliverAs`, but ordinary
`ExtensionAPI.sendMessage()` returns `void`:
`dist/core/extensions/types.d.ts:1045-1049`. The runtime binding calls
`sendCustomMessage(...).catch(...)` without returning its promise at
`dist/core/agent-session.js:2396-2404`.

For a message carrying an extension-owned details token, the installed path is:

1. `sendCustomMessage()` creates an `AgentMessage` with
   `role: "custom"`, the supplied `customType`, `content`, `display`, `details`,
   and a Pi timestamp (`dist/core/agent-session.js:1481-1490`).
2. If `deliverAs` is `"nextTurn"`, it is held for the next prompt. Otherwise,
   when `isStreaming` is already true, `triggerTurn: true` is handled first as
   a direct `agent.steer()` (or `agent.followUp()`), not as a new isolated run
   (`:1491-1500`). This is the busy-agent contamination path.
3. Only when the session is not streaming does `triggerTurn: true` call
   `_runAgentPrompt(appMessage)` (`:1502-1507`).
4. `_runAgentPrompt` marks the session active and calls `agent.prompt(messages)`;
   its `finally` flushes pending messages and calls `_emitAgentSettled`
   (`dist/core/agent-session.js:1078-1103`).
5. The low-level agent loop emits `agent_start`, `turn_start`, then emits
   `message_start` and `message_end` for each initial message before entering
   the provider loop (`@earendil-works/pi-agent-core/dist/agent-loop.js:47-57`).
   The custom token therefore appears in the `message` object when the custom
   initial message is emitted. A system/tool declaration message may also be an
   initial message; do not assume that the custom message is always the first
   message event.
6. Pi forwards those events to extension handlers in
   `dist/core/agent-session.js:556-581,710-752`. For `message_end`, extension
   handlers run before the custom message is persisted by the session manager
   (`:583-589`).
7. After the low-level `agent_end` and any automatic continuation/retry work,
   `_emitAgentSettled` sets the session's active flag false, emits the extension
   `agent_settled` event, then notifies ordinary session listeners
   (`dist/core/agent-session.js:531-553`).

The public event shapes contain no run identifier:

- `agent_start` is only `{ type: "agent_start" }`;
- `message_start` and `message_end` contain only `type` and `message`; and
- `agent_settled` is only `{ type: "agent_settled" }`.

See `dist/core/extensions/types.d.ts:566-572,623-672` and the underlying
`@earendil-works/pi-agent-core/dist/types.d.ts:422-443`. There is no public
`runId` field in these Pi 0.87.1 contracts. `turnIndex` is reset at each
`agent_start` (`dist/core/agent-session.js:710-724`), so it is not a global run
identifier. `sessionManager.getSessionId()` identifies a session, not an agent
run. A message timestamp is not specified as a correlation identifier.

The details field is usable as extension-owned metadata, but its token shape is
not a Pi field. `CustomMessageEntry.details` is explicitly extension metadata
that is not sent to the model (`dist/core/session-manager.d.ts:97-107`). The
custom message content does enter model context; the session projection rebuilds
it from the active branch at `dist/core/session-manager.js:156-170,256-280`.
Therefore an extension can put, for example, `{ token: "..." }` in `details`,
then require an exact match after narrowing `event.message.role === "custom"`.
It must not claim that Pi provides `details.token`.

The SDK session-subscription stream can also emit `message_start`/`message_end`
without a new agent run: `_appendCustomMessage()` emits those events for the
non-trigger path at `dist/core/agent-session.js:1520-1524`. That path uses the
session listener emitter directly rather than the extension runner, so a
standalone `pi.on("message_start"/"message_end")` handler must not assume it
observes every non-trigger custom append. In either public stream, token
observation proves that the message was ingested; it does not, by itself, prove
that the surrounding `agent_start` or `agent_settled` belongs to that message.

The public busy and queue checks are also narrower than a complete scheduler
snapshot. `ctx.isIdle()` and `ctx.hasPendingMessages()` are public at
`dist/core/extensions/types.d.ts:232-241`. In the installed binding,
`isIdle` is `!_isAgentRunActive && !isCompacting` and the pending count is only
`_steeringMessages.length + _followUpMessages.length`
(`dist/core/agent-session.js:870-876,1591-1593,2445-2458`). Custom messages
queued while streaming go straight to the lower-level `Agent` queues, whose
`steer`/`followUp` and `hasQueuedMessages` are separate
(`@earendil-works/pi-agent-core/dist/agent.js:182-204`). Thus
`hasPendingMessages()` must not be treated as an atomic or complete indication
that no custom work is queued.

### Proposed fail-closed criteria

A standalone extension can use a conservative local state machine, but it cannot
prove exclusive ownership of a Pi run. The minimum safe criteria are:

1. **Admission gate.** From a user-initiated command, reject if local state is
   already armed; require `ctx.isIdle() === true`,
   `ctx.hasPendingMessages() === false`, and `ctx.signal === undefined`. Treat
   any inability to read a check as busy. Mark the local request armed before
   calling the void `sendMessage()` API. This closes the obvious busy path but
   cannot remove the check-to-send race.
2. **Opaque extension token.** Send one exact `customType`, exact content, exact
   `display` value, and an extension-owned random token under `details`. Do not
   use assistant text, timestamps, or an invented event field as the token.
3. **Message proof.** Accept `message_start` and `message_end` only when the
   message is a custom message with all expected fields and the exact token.
   Require one start and one end. A changed token, changed content, duplicate,
   or unexpected new user/custom message invalidates the request. Other
   extensions can replace a finalized message while preserving its role
   (`dist/core/extensions/runner.js:767-799`), so a replacement mismatch must
   fail closed.
4. **Settlement proof.** `agent_settled` is usable only after the exact custom
   message proof. It is a terminal notification, not a correlation field. Do
   not act on `agent_end` alone: the SDK docs state that automatic recovery or
   queued work may follow it (`docs/sdk.md:90-94`; `docs/cli-integration.md:46-50`).
5. **Context contamination check.** Snapshot the session ID, leaf ID, and active
   branch entry IDs before admission. At settlement require the same session,
   no branch/session boundary, exactly one matching custom-message entry on the
   active branch, and an active `buildSessionProjection()` containing the exact
   custom message. Track newly observed model-visible custom/user messages
   during the interval; any unrecognized one invalidates the request. Details
   are local metadata, so use the active branch/projection to verify the entry,
   not a provider echo.
6. **Boundary invalidation.** While armed, treat `session_before_tree`,
   `session_tree`, `session_shutdown`, and `session_start` as invalidation or
   cancellation signals. Also observe `session_before_switch` and
   `session_before_fork` if the extension must prevent a session replacement
   before its shutdown callback. On invalidation, stop or pause the voice path,
   clear local correlation state, and require a fresh user command.
7. **Timeout and no-evidence rule.** If the exact token events do not arrive in
   a bounded interval, or if `agent_settled` arrives without them, discard the
   result. There is no public send acknowledgement to use as a fallback.

This policy can prove only: “the current session emitted this exact extension
message and later reached a settled boundary without the contamination signals
we observe.” It cannot prove that no other caller won the race between the gate
and `sendMessage()`, because Pi 0.87.1 exposes no atomic reservation or run ID.

### Unresolved behavior

The installed source does not specify the race where another prompt starts after
`isIdle()` is checked but before `sendMessage()` enters `sendCustomMessage()`. It
also does not expose the lower-level custom-message queue through
`ExtensionContext`. A real SDK test must exercise that race and verify that the
extension rejects the result rather than treating a steered message as its own
isolated run.

Automatic retries and continuation runs can produce multiple `agent_start` /
`agent_end` pairs around one logical `sendCustomMessage()` call. The public
messages and the local token can be inspected, but there is still no run ID.

## 3. Custom TUI versus blocking approval prompts

### Facts

The public UI contract provides `select`, `confirm`, `input`, `editor`, and
`custom`; dialogs accept an optional abort signal and timeout, while custom has
an overlay option and an optional overlay handle callback
(`dist/core/extensions/types.d.ts:18-25,69-128,135-136`). Pi wraps all of these
methods in one UI-prompt depth counter at
`dist/core/extensions/runner.js:318-349`, and exposes
`ui_prompt_start`/`ui_prompt_end` with kinds `select`, `confirm`, `input`,
`editor`, and `custom` at `dist/core/extensions/types.d.ts:627-640`.

The interactive mode maps the public methods to one shared editor area at
`dist/modes/interactive/interactive-mode.js:1976-2001`:

- `select` creates an `ExtensionSelectorComponent`, clears the editor
  container, focuses the selector, and on completion restores and focuses the
  core editor (`:2032-2068`);
- `confirm` is exactly a selector with `"Yes"` and `"No"`, returning true only
  for the exact `"Yes"` result (`:2073-2075`);
- `input` and `editor` likewise replace the editor container, focus their
  component, and restore the core editor on completion
  (`:2084-2149`); and
- a normal, non-overlay `custom` clears the editor container, focuses the
  custom component, and later restores the saved editor text and focus when its
  supplied `done()` callback is called
  (`:2237-2305`).

This is not a UI mutex. If a blocking selector/confirm/editor is started while a
non-overlay custom view is pending, the dialog replaces the custom component in
the editor container. Completing the dialog restores the core editor; it does
not re-mount or re-focus the still-pending custom component. The custom promise
remains owned by its original `done()` callback until that callback is called.

With `overlay: true`, `showExtensionCustom` calls `TUI.showOverlay()` instead of
replacing the editor container (`interactive-mode.js:2272-2287`). The overlay
captures focus by default, remembers the pre-focus component, and is rendered on
top of base content. The installed TUI focus and overlay behavior is
`@earendil-works/pi-tui/dist/tui.js:347-409,687-728,903-968`:

- `showOverlay` focuses a capturing overlay unless `nonCapturing` is set;
- `setFocus(selector)` can move keyboard focus to a non-overlay selector while
  leaving the overlay mounted; and
- overlays are composited after the base content, in focus-order order.

Consequently, a non-overlay approval dialog can receive keyboard input while a
live overlay remains visible above the editor area. The overlay may cover the
approval UI visually. The focus-restore state is marked blocked rather than
silently disposing either component. When the custom callback later closes the
overlay, `showExtensionCustom` calls `ui.hideOverlay()` and disposes the custom
component; if the selector currently owns focus, the TUI does not automatically
restore focus to the old overlay because the removed overlay was not the focused
component. The selector's own cleanup then focuses the core editor.

A further concurrency detail matters for live voice UI. While a custom promise
is pending, `uiPromptDepth` remains nonzero. A nested `select` or `confirm` does
not emit a second `ui_prompt_start` or an intermediate `ui_prompt_end`; the
outer custom prompt remains the reported prompt until it closes. Therefore
`ui_prompt_*` events are not a reliable nested-approval lock.

The Pi docs describe custom UI as one temporary interactive screen and say to
finish it through `done()`; they also say that focused overlays retain input
ownership and that a component should release or redirect focus explicitly when
another component must receive input (`docs/tui.md:64-74`). RPC mode cannot run
this surface at all: `custom()` returns `undefined` there
(`docs/rpc-extension-ui.md:1-25`).

### Minimal safe policy

- Treat the live custom view and every blocking approval dialog as mutually
  exclusive. Before starting `select`, `confirm`, `input`, or `editor`, pause
  microphone/voice capture; if pause cannot guarantee that no input is sent,
  stop the voice session.
- Do not use `ui_prompt_start` as the only pause trigger because nested prompts
  under a pending custom view are not reported separately. The live extension
  must own an explicit pause/approval wrapper.
- Prefer closing or explicitly hiding and unfocusing the live view before the
  dialog. If the view is an overlay, retain its `OverlayHandle` through
  `onHandle` and use the documented handle operations for temporary visibility
  and focus; do not call `hide()` to close a `ctx.ui.custom()` interaction.
- Resume only after the dialog has returned and the live session/view still has
  the same ownership token. A timeout, abort, `undefined`, or any result from a
  stale view is cancellation.
- For confirmation, only exact `"Yes"` is approval. `"No"`, cancellation,
  timeout, abort, missing focus, or any UI race MUST never auto-confirm.

### Concrete real-SDK test required

A fake `ExtensionUIContext` is not enough. The required test is a provider-free
Pi 0.87.1 interactive-mode/PTY test using a disposable test extension and a
synthetic component:

1. Start the real installed TUI with an in-memory session and no provider
   request. The extension opens a custom component that records every key sent
   to its `handleInput` and exposes its `done()` callback.
2. While that custom promise is pending, invoke each of `select`, `confirm`,
   `input`, and `editor` from a separate scheduled task. Drive cancellation,
   timeout, and affirmative/negative keys through the PTY. Assert that the
   dialog receives the keys, the custom component does not, `confirm` is true
   only for `Yes`, and cancellation/timeout is false.
3. Repeat with the custom component in default non-overlay mode and with
   `overlay: true` plus `onHandle`. Record rendered frames and the focused
   component/handle state before, during, and after each dialog. Assert that
   cleanup does not leave a stale component receiving input and that the chosen
   policy explicitly restores or recreates the live view.
4. Add a voice-double assertion: no capture/send callback runs while the
   approval prompt is pending, and resume is refused after a stale or invalid
   result.
5. Record `ui_prompt_start`/`ui_prompt_end` to verify the nested-prompt depth
   behavior rather than assuming that those events delimit every dialog.

This test must run against the real Pi TUI and `ctx.ui` implementation, but can
keep the model, credential, voice, and transport sides fake and local.

### Unresolved behavior

Pi 0.87.1 has no documented serialization policy for two independent extension
calls to `ctx.ui.select()` or for a dialog concurrent with `ctx.ui.custom()`.
The source shows the shared-container and overlay effects above, but the
user-visible result of arbitrary timing, resize, and mouse input needs the real
TUI test. `custom()` has no abort option in its public signature, so generic
session cancellation does not provide a documented promise-cancellation
contract for a pending custom interaction.

## 4. Session replacement, reload, and same-session tree changes

### Facts

The event declarations distinguish replacement from same-file tree navigation:

- `session_start` reasons are `startup`, `reload`, `new`, `resume`, and `fork`,
  with an optional `previousSessionFile`;
- `session_shutdown` reasons are `quit`, `reload`, `new`, `resume`, and `fork`,
  with an optional `targetSessionFile`; and
- `session_before_tree` carries a `TreePreparation` containing `targetId`,
  `oldLeafId`, `commonAncestorId`, entries to summarize, and the user's summary
  choice. It is cancellable. `session_tree` reports old and new leaf IDs.

See `dist/core/extensions/types.d.ts:416-504` and the cancellation result at
`:922-944`.

The replacement runtime first aborts the current session, then emits
`session_shutdown`, then invalidates/disposes the old session
(`dist/core/agent-session-runtime.js:102-113`). The concrete paths are:

| Operation | Static sequence |
|---|---|
| `new` | `session_before_switch` can cancel; create the target manager; abort and emit `session_shutdown { reason: "new" }`; create the new runtime and emit `session_start { reason: "new", previousSessionFile }` (`agent-session-runtime.js:147-172`). |
| `resume` | `session_before_switch` can cancel; open the target; abort and emit shutdown with `reason: "resume"` and its target file; create the new runtime and emit `session_start { reason: "resume" }` (`:128-145`). |
| `fork` | `session_before_fork` can cancel; create the branched/new target; abort and emit shutdown with `reason: "fork"`; create the new runtime and emit `session_start { reason: "fork" }` (`:174-249`). |
| `reload` | The current `AgentSession` emits shutdown with `reason: "reload"`, invalidates the old extension runner, reloads resources, rebuilds the runner, and emits `session_start { reason: "reload" }` (`dist/core/agent-session.js:2603-2625`). This path does not itself call `session.abort()`. |

`navigateTree()` is different. It stays in the same session file and refuses to
run while streaming or compacting. It emits `session_before_tree`, can return
`{ cancel: true }`, changes the active leaf (with an optional summary), refreshes
canonical context, then emits `session_tree`
(`dist/core/agent-session.js:2855-3011`). There is no `session_shutdown` for
this same-session branch change.

### Proposed criteria

For an armed live correlation or approval request:

1. Register `session_before_tree` and cancel it while the interaction owns the
   live surface, or at minimum invalidate the request before any tree change.
2. Register `session_before_switch` and `session_before_fork` when replacement
   must be refused rather than merely cleaned up. `session_shutdown` is a
   cleanup/invalidation boundary; it is too late to preserve correlation.
3. In `session_shutdown`, pause/stop voice, dispose local UI ownership, and
   discard the token. The handler must be idempotent. A later `session_start`
   for `new`, `resume`, `fork`, or `reload` begins with no inherited pending
   correlation state.
4. For same-session tree navigation, compare the pre-admission session ID and
   leaf/branch snapshot with the post-event projection. Any `session_tree`, leaf
   change, summary entry, or missing token entry fails closed.
5. Rebind all handlers and UI state after replacement; the SDK docs state that
   the old extension context is invalid after session replacement
   (`docs/extensions.md:81-92`). Do not use an old context or old custom view
   after `session_start` for the replacement.

### Unresolved behavior

The static source establishes event order, but this scout did not run a pending
live custom view through each of `new`, `resume`, `fork`, and `reload`, nor did it
run a same-session tree navigation during a correlation window. In particular,
`reload` has a different source path from runtime replacement because it emits
shutdown without the runtime helper's explicit abort call. The interaction
between a pending `ctx.ui.custom()` promise, `resetExtensionUI()`, and extension
runner invalidation needs the real TUI/session test above plus a provider-free
lifecycle test.

A same-session `session_before_tree` event is a pre-change hook, not a run ID and
not a guarantee that no other append or UI action will race after the handler
returns. The proposed policy therefore treats any observed boundary as a hard
invalidation rather than trying to reconstruct ownership afterward.

## Bounded conclusion

The Pi 0.87.1 registry path already owns OAuth refresh through the SDK
credential store. The public custom-message path has a usable extension-owned
metadata token, but no public run IDs, no atomic send reservation, and an
incomplete pending-message view for custom queues. A safe standalone extension
must gate conservatively, verify the exact token and active session projection,
and discard any ambiguous result. Pi's custom TUI and blocking dialogs are also
not concurrency-safe by contract: pause or stop voice before approval, make UI
ownership explicit, and never auto-confirm.
