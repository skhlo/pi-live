# Luna bounded scout 4: live extraction and rollout fit

Status: research only. No implementation, install, authentication, microphone access, live request, push, PR, or merge was performed.

## Scope and conclusion

Evidence was read from:

- Dotfiles `origin/main` / `HEAD` `de9bab8a4f2cdb7c13650c43920545a544af41da`.
- `/tmp/pi-better-openai.qnz8hk`, committed source tree at `39171682343754366439b2c0890f5b0f4c3ed891` (`@monotykamary/pi-better-openai` 0.2.6). Its worktree has an unrelated `bun.lock` edit; this note uses the pinned source files and manifest, not that edit.
- Installed Pi 0.87.1 declarations and docs under `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`.

The live feature is a coherent, small Pi extension slice, but it is not a normal baseline addition. It opens a custom TUI, loads platform audio/WebRTC natives, reads `openai-codex` credentials, and connects to an undocumented realtime service. The best current fit is a separately owned, opt-in capability with its own frozen runtime manifest/lock and explicit host canary. Do not add it to the ordinary baseline package list or imply a rollout to all three hosts.

There is no requirement in this scout to support Pi 0.85.1. The current dotfiles pin is 0.87.1, and the used Pi/TUI symbols are present in the installed 0.87.1 declarations.

## 1. Runtime and type-only import trace

Line references below are from the pinned source tree.

### Live files

| File | Runtime imports and edges | Type-only imports | Role and disposition |
|---|---|---|---|
| `src/live/index.ts:1-20,99-345` | `@earendil-works/pi-tui` `Text`; `../codex-auth.ts`; `../format.ts`; controller, focus, queue, visualizer | Pi `ExtensionAPI`/`ExtensionContext`; `../config.ts` `ResolvedConfig`; local callback types | Entry wiring. Adapt the config and credential seams; retain the live-only registrations and cleanup. |
| `src/live/controller.ts:1-11,119-530` | native loader; protocol; `CodexLiveTransport`; default voice | `CodexCredentials`, native/audio/transport types | Session state, microphone level/echo filtering, delegation progress and cleanup. Retain with an injectable credential/config boundary. |
| `src/live/transport.ts:1-13,115-445` | `https-proxy-agent`, `proxy-from-env`, `undici`, `ws`; attestation, native, protocol | `CodexCredentials`, native and WebSocket payload types | Codex signaling, WebRTC offer/answer, sideband WebSocket, proxy handling and retries. Retain only with the experimental endpoint policy accepted. |
| `src/live/attestation.ts:1,75-86` | Node globals `crypto`, `Buffer`, `Intl` | Native token result/bindings | macOS arm64 DeviceCheck attestation payload. Retain; its native import is erased. |
| `src/live/native.ts:1-109` | `node:module` `createRequire`; dynamic `require()` of one platform package | None | Validates and caches `AudioCapture`, `LiveWebRtcPeer`, DeviceCheck and Tokio-runtime bindings. Retain. |
| `src/live/queue.ts:1-13,166-388` | Node crypto/fs/path; `../paths.ts` `piAgentDir` | None | Cross-process floor/heartbeat arbitration under the Pi agent directory. Retain; narrow the path helper. |
| `src/live/focus.ts:1-92` | None | None | Terminal mode-1004 probe and focus listener. Retain. |
| `src/live/protocol.ts:1-234` | None | None | Realtime wire types, validation, payload builders and UTF-8 chunking. Retain. |
| `src/live/visualizer.ts:1-279` | `@earendil-works/pi-tui`: runtime `Key`, `matchesKey` and width helpers | Pi `Theme`/`ThemeColor`; TUI `Component`; controller transcript/phase types | Five-row focused custom component and `Ctrl+Shift+L` key. Retain. |
| `src/live/voices.ts:1-21` | None | None | Voice values, default `sol` and validator. Retain. |

The live entry uses `ctx.mode !== "tui"` as a hard gate at `src/live/index.ts:127-135`. It creates `ctx.ui.custom()` at `:138`, sends the coding request with `pi.sendMessage()` at `:184-192`, and registers only the live command/shortcut/renderer and `message_end`, `agent_settled`, and `session_shutdown` hooks at `:310-345`.

The controller creates audio capture before transport negotiation at `src/live/controller.ts:174-213`; it sends commentary/final delegation context at `:229-257` and closes the session at `:275-309`. The transport uses the signaling URL and sideband URL at `src/live/transport.ts:15-22,88-113,196-229`. These are runtime behavior, not metadata-only functionality.

### Shared-helper closure

The exact source closure reaches four shared files:

- `src/codex-auth.ts:1-7,57-159` is runtime-required by `live/index.ts`. It reads Pi's `auth.json`, resolves a model-registry token, extracts the JWT account ID, and optionally consults the in-process `multiprovider` bridge.
- `src/multiprovider.ts:1,6-64` is pulled in only because `codex-auth.ts` calls `getActiveMultiproviderService()`. It has no network by itself, but a standalone live package would not get the bridge unless another extension installs the service object.
- `src/paths.ts:1-17` supplies `piAgentDir()` for both auth and `live-queue`. `resolveUserPath()` is not in the live closure.
- `src/format.ts:1-93` is runtime-required only for `sanitizeDiagnosticError()` from `live/index.ts`. The rest of that file is unrelated footer/image/status formatting, and importing it also pulls Pi TUI width helpers.
- `src/config.ts` is imported with `import type` at `live/index.ts:4`; it is not a live runtime dependency. The live code needs only the narrow shape `{ live: { enabled: boolean; voice: string } }`, not the full fast/usage/image/websearch/pets configuration.

Recommended extraction boundary: inject a narrow credential resolver and a narrow live-config resolver into the package entry. If a package-local resolver is preferred, retain only the credential parser/auth-file logic from `codex-auth.ts`, `piAgentDir()`/tilde expansion from `paths.ts`, and the diagnostic sanitization function. Omit `multiprovider.ts` unless account-pooling behavior is explicitly owned and tested. Do not copy the full `config.ts` or `format.ts` merely to preserve their current source paths.

### Retain, adapt, omit

**Retain as the live slice:**

- `src/live/attestation.ts`
- `src/live/controller.ts`
- `src/live/focus.ts`
- `src/live/native.ts`
- `src/live/protocol.ts`
- `src/live/queue.ts`
- `src/live/transport.ts`
- `src/live/visualizer.ts`
- `src/live/voices.ts`

**Adapt:**

- `src/live/index.ts`: make the package entry call the live registrar without the full Better OpenAI config graph; keep the exact non-TUI gate, custom-message shape, focused UI cleanup, and lifecycle hooks.
- Credential resolution: either inject `getCredentials` or make a small package-local helper. Account-pooling support is an ownership choice, not a reason to import the whole Better OpenAI root.
- `piAgentDir()` and `sanitizeDiagnosticError()`: copy the small owned behavior into package-local helpers or create a deliberate shared helper boundary.
- Tests `tests/live-*.test.ts`: retain the protocol, focus, queue, native-binding validation, transport helper, visualizer and registration cases, replacing `tests/helpers.ts`'s full `ResolvedConfig` fixture with a narrow live fixture. Do not carry unrelated test helpers or source configuration.

**Omit:**

- Root `index.ts` and every registration beside `registerOpenAILive()`. The root also installs Codex model fallbacks, fast mode, usage, resets, image, web search, pets, settings and a replacement footer (`index.ts:276,525-541,1096-1106,1443-1553`).
- `src/codex-models.ts`, `fast-controller.ts`, `footer-layout.ts`, `pet-footer-controller.ts`, `pets.ts`, `reset-controller.ts`, `reset-guard.ts`, `resets.ts`, `usage-controller.ts`, `usage.ts`, `websearch.ts`, and unrelated configuration/identity code.
- `sharp`: it is used by image/pet code, not any `src/live` file.
- `@earendil-works/pi-ai`, `typebox`, and the source package's whole-package overrides unless a later dependency lock proves a live-specific need.
- Non-live tests and the full source package's settings, skills, prompts, themes and provider registrations.

## 2. Package bill of materials, native targets and attribution

### Runtime dependencies from the pinned manifest

The source manifest records these exact direct runtime pins at `package.json:57-62`:

| Dependency | Pin | Live use |
|---|---:|---|
| `https-proxy-agent` | `9.1.0` | `src/live/transport.ts:1,260-326` for proxied sideband WebSocket connections |
| `proxy-from-env` | `2.1.0` | `src/live/transport.ts:2,196,252` for proxy selection |
| `undici` | `8.10.0` | `src/live/transport.ts:3,196-229` for signaling `fetch` and `ProxyAgent` |
| `ws` | `8.21.2` | `src/live/transport.ts:4,252-326,380-413` for sideband WebSocket |

The source manifest also lists `sharp@0.35.4`, but it is outside the live closure. Pi 0.87.1 itself has an `undici@8.10.2` transitive dependency; that does not make it the live package's declared dependency. If the extracted package keeps the source pins, its own lock must own the direct `undici@8.10.0` selection or deliberately record a reviewed change.

### Pi and native dependencies

Pi's package guide says Pi supplies `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`; imported Pi packages should be peer dependencies with a `"*"` range and should not be bundled. The live slice actually imports only:

- `@earendil-works/pi-coding-agent` for type-only `ExtensionAPI`, `ExtensionContext`, `Theme`, and `ThemeColor`.
- `@earendil-works/pi-tui` for runtime `Text`, `Key`, `matchesKey`, and terminal-width helpers, plus the type-only `Component` contract.

The source `devDependencies` still say Pi `0.87.0` at `package.json:65-67`, while the source `peerDependencies` use `"*"` at `:76-79`. For this repository, develop and type-check against the installed/current Pi 0.87.1; do not carry the stale 0.87.0 development pin into an adoption decision.

`src/live/native.ts:45-53` maps these optional native packages, all pinned to `17.2.9` at `package.json:81-86`:

- `@oh-my-pi/pi-natives-darwin-arm64`
- `@oh-my-pi/pi-natives-darwin-x64`
- `@oh-my-pi/pi-natives-linux-arm64`
- `@oh-my-pi/pi-natives-linux-x64`
- `@oh-my-pi/pi-natives-win32-x64`

The loader accepts only `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `win32-x64`; unsupported targets fail before a session starts. The installed native package metadata identifies the packages as MIT, from `can1357/oh-my-pi`, `packages/natives`, and advertises a Bun `>=1.3.14` engine rather than a Node engine. The source loader uses Node `createRequire`; Node-host compatibility of each native addon remains a canary obligation, not a claim from the manifest alone. The native addon exposes the audio/WebRTC and runtime-install symbols checked by `validateLiveNativeBindings()` at `native.ts:69-82`.

A minimal candidate manifest therefore needs four direct runtime packages, two Pi peers (`pi-coding-agent` and `pi-tui`), the five platform optional native packages, Node `>=22.19`, and a Pi extension entry. It does not need `sharp`, `pi-ai`, `pi-agent-core`, `typebox`, or the full source `overrides`. This is a package shape recommendation, not a created manifest or a selected install destination.

### Attribution and notices

The pinned source's `THIRD_PARTY_NOTICES.md:3-28` says portions of `src/live/` are adapted from `can1357/oh-my-pi`, specifically live protocol, transport, session orchestration, attestation and terminal visualizer design. It includes the MIT notice and copyrights for Mario Zechner and Can Bölük. The source README also attributes the original `pi-better-openai` to Matt Leong and identifies the `@monotykamary` fork at `README.md:229-231`.

An extraction must carry the source package's MIT attribution and the complete oh-my-pi MIT notice with the retained/adapted live code. The native package metadata's MIT attribution must remain visible as well. No new upstream publication or destination is authorized by this note.

## 3. Pi 0.87.1 API fit

The installed package reports version `0.87.1`. The relevant declaration evidence is:

| Used symbol/contract | Pi 0.87.1 evidence | Fit |
|---|---|---|
| Custom TUI | `dist/core/extensions/types.d.ts:69-128`: `ExtensionUIContext.custom<T>(factory, options?)` receives `TUI`, `Theme`, keybindings and `done`; it returns `Promise<T>`. | Matches `ctx.ui.custom<LiveUiResult>` in `live/index.ts:138`. |
| Mode guard | `types.d.ts:209-210`: `ExtensionMode = "tui" \| "rpc" \| "json" \| "print"`. | Matches the explicit `ctx.mode !== "tui"` rejection. |
| Custom message send | `types.d.ts:299-305,1046-1050`: `sendMessage<T>()` accepts `customType`, `content`, `display`, `details` and `triggerTurn`/`deliverAs` (`steer`, `followUp`, `nextTurn`). | Matches `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`. The API returns `void`; the source correctly does not await it. |
| Message renderer | `types.d.ts:1040`: `registerMessageRenderer<T>()`. | Matches the live delegation renderer. |
| Lifecycle | `types.d.ts:479`, `:624`, `:669`, and `:988,1001,1008` define `session_shutdown`, `agent_settled`, `message_end` events and registrations. | Matches the three live hooks and the final-settlement boundary. |
| Pi TUI | Installed `@earendil-works/pi-tui@0.87.1/dist/index.d.ts:16,22,29,32` exports `Text`, `Key`, `matchesKey`, `Component`, `sliceByColumn`, `truncateToWidth`, and `visibleWidth`; `tui.d.ts:213-234` exposes `terminal` and `addInputListener`. | Matches the visualizer and mode-1004 focus adapter. |

The extensions guide says custom components are for interactive UI, RPC forwards supported dialogs/notifications but not custom terminal components, and JSON/print have no UI. The source is stricter and intentionally supports live only in TUI. The lifecycle guidance also requires long-lived resources to start from a session/command and close from an idempotent `session_shutdown`; the live registrar creates the queue/session/timer only from the command/custom component path and closes them in `session_shutdown`.

Result: the current 0.87.1 baseline meets the symbols used by this slice. The only source-version mismatch found is the candidate package's old 0.87.0 development/override metadata. No 0.85.1 compatibility work is justified for this task.

## 4. Current dotfiles rollout fit

### The real seams

The root `package.json:5-35` owns the repository's Node/pnpm checks and pins Pi `0.87.1` as a development dependency. `pnpm-workspace.yaml` only declares pnpm build permissions; it does not own a live package. The existing standalone runtime precedent is `config/pi-meta/package.json` plus `config/pi-meta/pnpm-lock.yaml`, both pinned to Pi 0.87.1. `scripts/pi-capabilities.ts:53-80` installs that runtime with `pnpm install --ignore-workspace --prod --frozen-lockfile --ignore-scripts` only after the versioned files have been rolled out.

`config/pi/settings.json` currently owns only the baseline `pi-blackhole` and `pi-mcp-adapter` package declarations. `scripts/rollout-plan.ts:107-193,325-382` merges wanted package entries into `.pi/agent/settings.json` during the ordinary baseline plan while preserving unrelated entries and host choices. Adding live there would make it an ordinary baseline package and would be carried by normal host rollout. That is not the required fit.

The closest existing opt-in seam is the capability inventory:

- `scripts/build.ts:144-190` maps source files to versioned `.local/share/dotfiles/capabilities/...` targets and maps optional launchers separately.
- `build.ts:264-266,322-330,398-406` hashes source bytes with SHA-256 and validates pinned file hashes before planning.
- `build.ts:447-489` includes configuration, extensions, generators, instructions, profiles and pinned snapshots in the ordered `catalogId`.
- `scripts/rollout-plan.ts:201-241` observes a requested home and captures source bytes without writing.
- `rollout-plan.ts:555-567` filters `--capabilities-only` changes to versioned capability paths, the shared A2A skill, and named launchers; it deliberately does not include `.pi/agent/settings.json`.
- `rollout-plan.ts:597-623` records a `sourceDigest` made from the catalog and rollout source files. `scripts/rollout.ts:80-105` recomputes the plan and refuses apply when source or destination hashes differ.
- `scripts/pi-capabilities.ts:43-63` requires installed capability inputs to be regular files whose bytes equal `configurationBytes(source)` before setup/check runs.

Therefore the real candidate seam is a new, explicitly named opt-in capability family with package source/manifest/lock bytes and a separate loading/launch contract. It is not the root workspace install and not an automatic change to `config/pi/settings.json`. The current code has no live-specific `CONFIG_FILES` entry, capability selector, launcher or runtime owner; adding those would be implementation work.

### Package discovery implications

The installed Pi package guide says a package can be an npm, git, or local directory; a `pi` manifest can expose a single extension; local paths load without copying; and package dependencies are installed for npm/git sources. It also says packages execute inside Pi's process and should be reviewed/trusted. A live candidate should expose only its extension entry: no skills, prompts or themes.

Two loading choices remain open:

1. A Pi package declaration or local package path in a deliberately scoped capability flow. This gives Pi normal package discovery but requires an explicit settings/package ownership decision because the current capabilities-only filter preserves `.pi/agent/settings.json` unchanged.
2. A versioned private runtime plus an explicit launcher/extension stack. This matches the `config/pi-meta` precedent and makes the opt-in boundary clearer, but needs a documented launcher contract for ordinary TUI use.

Do not invent a public npm/GitHub destination, silently add a new settings package, or use an ordinary baseline plan to install either form.

### Host and surface constraints

- **TUI versus RPC:** `src/live/index.ts:127-135` rejects RPC, JSON and print modes. Pi's docs independently state that RPC cannot render custom terminal components and JSON/print have no UI. A Paseo GUI or Pi RPC client cannot be treated as a live-audio surface.
- **Audio:** `controller.ts:201-210` constructs `AudioCapture(16_000, ...)`; the native peer carries output audio/WebRTC. The source README requires microphone and speaker access, `openai-codex` OAuth, and a supported native target. This scout did not request permission or open a device.
- **Network:** `transport.ts:15-22,196-229,252-326` calls the ChatGPT Codex realtime signaling endpoint and an OpenAI WebSocket sideband. It honors proxy environment variables, but it is an experimental `gpt-live-1-codex`/Quicksilver path, not the public Realtime API. No live network request was made.
- **Hosts:** MBA and Mac mini are macOS profiles; MBP is Arch Linux/Omarchy. The profiles do not record CPU architecture, so native-package eligibility still needs a host-local check. The native mapping supports the listed macOS/Linux targets, but native presence is not permission to claim microphone or speaker readiness. The phone is a Paseo client and is not an installation target.
- **Permissions:** the source README calls out a LocalTerm reinstall/microphone prompt on macOS. That is a host-owner canary step, not an installer side effect.

## 5. Offline and negative acceptance contract

The current builder/rollout fixtures establish the following invariants:

- `scripts/rollout.test.ts:352-367` proves a default plan is read-only and does not print private fixture contents.
- `build.test.ts:73-90` and `rollout.test.ts:638-639` use Pi model runtimes with `allowModelNetwork: false` and `refreshOnCreate: false` for offline metadata checks.
- `build.test.ts:212-240` rejects symlinked preview parents and modified pinned sources before writing.
- `rollout.test.ts:766-975` covers target/symlink/source drift before home writes; `:725-741` covers rollback; `:495-724` covers populated-home preservation and second-plan idempotence.
- `scripts/pi-capabilities.test.ts:201-223` requires missing or modified capability inputs to fail before runtime setup, and `:225-305` proves capabilities-only scope leaves an older baseline/settings and unrelated owned extension untouched.

A future live extraction should add or preserve these bounded checks:

1. **Source inventory/hash:** whitelist the live package files, manifest, lock and attribution notice. Every byte is hashed by the builder; changing a live source or lock changes the catalog/source digest. The public plan contains paths and hashes, never credentials or package bytes.
2. **Offline package fixture:** load the extension from a disposable fixture with injected credentials, transport, audio and arbiter doubles. Do not invoke package installation, Pi login, native device capture, signaling, WebSocket, or a provider request in this fixture.
3. **Exact registration negative test:** using an `ExtensionAPI` recorder, assert that the live package registers only `/live`, `Ctrl+Shift+L`, the one live custom-message renderer, and `message_end`/`agent_settled`/`session_shutdown`. Assert zero `registerTool`, `registerFlag`, `registerProvider`, model registration, footer, status, widget or MCP registration.
4. **Unrelated-surface negative test:** loading the extracted package must not add `fast`, `openai-usage`, `openai-resets`, `openai-settings`, `openai-image`, `openai-websearch`, or `pets`; must not alter the provider/model catalog; and must not call `ctx.ui.setFooter`, `setStatus`, or `setWidget`.
5. **Non-TUI negative test:** in `rpc`, `json`, and `print` contexts, `/live` must notify and return before `ctx.ui.custom`, native loading, credentials, queue creation, or network construction. A disabled live config must have the same no-side-effect property.
6. **Lifecycle test:** custom UI completion, floor loss, `/live` toggle, session shutdown and controller error must each stop audio, close the transport, leave the queue, dispose focus reporting, and resolve cleanup idempotently.
7. **Message contract test:** a delegation must be exactly the custom message type/content/display/details shape and `triggerTurn: true, deliverAs: "steer"`; final agent settlement must be sent through the live context channel without a second user message.
8. **Rollout-scope negative test:** a capabilities-only plan may include only the future live capability's owned files and explicitly selected loader/launcher files. It must preserve `.pi/agent/settings.json`, `.pi/agent/models.json`, `.pi/agent/mcp.json`, custom statusline/footer, shell files, shared instructions, unrelated packages, credentials, sessions and skills. No normal all-host plan should be generated as an implicit live adoption.
9. **Native metadata test:** test platform-to-package mapping and incomplete-binding rejection with injected `require` results. Do not run the real `AudioCapture` or `LiveWebRtcPeer` from this scout.

## Open ownership choices

- Who owns the extracted source pin, pnpm lock, native package pins and future refresh: dotfiles or the upstream package owner?
- Is the live feature a local/private package, a Pi package declaration, or an explicit launcher extension stack? No publish destination is selected.
- Does live own its own minimal config, or does a caller inject `{ enabled, voice }`? What is the default enablement and config path?
- Does credential resolution support only Pi's current `openai-codex` account, or also the optional multiprovider active-account bridge? The latter adds an extension-to-extension contract and must not be pulled in accidentally.
- Which named host owner can authorize a microphone/speaker/TUI canary, and which CPU/native target is present there? MBP's Linux audio/desktop permissions need an owner; the phone is not a target.
- Who accepts the experimental Codex Desktop protocol and its endpoint/entitlement drift, and who owns rollback when it changes?
- How does the live capability coexist with any existing footer/status owner? The recommended live slice owns no footer and must leave the baseline footer/provider/tool surface unchanged.
- What is the explicit update/rollback receipt for native binaries and package caches? File rollback alone must not be assumed to remove downloaded runtime artifacts.

Until these choices are answered, the correct state is a researched opt-in candidate, not a baseline rollout or live canary.

## Work performed and limits

Performed: local source/declaration/doc reading, static import tracing, manifest/native metadata inspection, and no-auth version/symbol metadata probes against existing installed files.

Not performed: `pnpm install`, package installation, auth/login, Pi package setup, typecheck/test execution requiring the absent dotfiles `node_modules`, live network, microphone/speaker access, native device capture, host rollout, push, PR, merge, or publication.
