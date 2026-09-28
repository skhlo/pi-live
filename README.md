# pi-live

Private, experimental Pi extension. Voice feeds requests into the current Pi
conversation and receives Pi's reply. Pi handles typed and spoken input together,
including its normal extensions, tools and retries.

It is checked on macOS arm64 only. See [Using Pi Live](#using-pi-live) for
setup, calls and recovery.

## Current behavior

The package exports one Pi extension factory. Discovery registers `/live`,
`Ctrl+Shift+L`, the historical live-message renderer, public lifecycle, dialog
and delegation listeners, and the `live_browser` tool, which stays inactive
until a browser-mode call connects it. Discovery does not load the native addon,
resolve credentials, create call timers, touch ownership or contact a provider.

- `/live` toggles voice; `start` and `stop` are explicit forms, and `end` or
  `off` also stop. `browser` starts a browser-mode call (see below). Each new attempt requires ordinary TUI consent. The shifted shortcut follows the same path;
  commands remain the fallback for unsupported shifted-key encoding.
- `mute` stops microphone capture while speaker playback may continue. `unmute`
  reopens capture only within the same active call.
- `setup` prepares this account's home for calls; see below.
- `voice <name>` changes the host-local preference while off. `status` reports
  state, mute, voice, compatibility and a fixed last-failure code. `help` explains
  controls, data sharing and limitations.
- The render-only `pi-live` widget shows input level, current role transcripts,
  mute and working state. It does not replace the footer/editor or intercept
  their keys. Teardown removes it; there is no widget animation timer.
- Voice requests become visible Pi messages, including while Pi is working.
  Pi handles follow-ups and typed input normally. When it settles, its successful
  reply returns to voice; if it has no reply, voice gets a short notice to check
  the terminal. Stopping voice stops audio and delivery, while Pi work continues.

Voice runs on OpenAI's GPT-Live API (`gpt-live-1`), billed to the OpenAI API
key Pi uses for its `openai` provider. Audio, speech transcripts, the conversation
leading to each request, progress notes (Pi's narration and tools used, including
typed work), and Pi's final replies are shared with OpenAI. While Pi works, voice
receives short quiet progress notes; when Pi finishes, voice summarizes its reply
aloud. HTTP/WebSocket proxy settings do not establish WebRTC/ICE media proxying.

Consent identifies the execution host, OpenAI GPT-Live, microphone and speakers,
the conversation, progress and reply sharing, and proxy limitations. Reported non-live extension dialogs fence
voice when their delayed notification arrives. Shortcut-opened and unreported
nested dialogs can leave voice active; stop voice before opening them when
capture and delivery must stop. Voice never answers or grants an approval.

Do not load another live extension alongside Pi Live. It refuses observed
conflicts with `@monotykamary/pi-better-openai` 0.2.6 and its pinned Git source,
and refuses account pooling announced by `pi-multiprovider`. These source and
command checks cannot inventory every extension or conflicting shortcut.

## Using Pi Live

Pi Live is checked on macOS arm64 with Node 22.19.0 or later, Pi 0.87.1 and
`@oh-my-pi/pi-natives-darwin-arm64` 17.2.9. Other platforms are unverified.

1. In a checkout of this repository, restore dependencies with scripts and
   automatic peers disabled:

   ```sh
   pnpm install --frozen-lockfile --ignore-scripts --config.auto-install-peers=false --config.enable-global-virtual-store=false
   ```

2. Give Pi an OpenAI API key for its `openai` provider, in Pi's credential store
   or as `OPENAI_API_KEY`. Calls are billed to that key.
3. Start Pi in this checkout's root folder with `pi`. Once you trust the
   project, Pi loads the extension through `.pi/settings.json`. Elsewhere, run
   `pi -e /path/to/pi-live/index.ts`. Loading it does nothing until you use
   `/live`. To load a different copy with `-e` from this root, add
   `--no-approve`; two copies of Pi Live make Pi exit.
4. Run `/live setup` once. After you confirm, it creates
   `~/.local/state/pi-live`, private to your account, checks that it is on a
   local disk, and records it in `setup.json` there. Calls refuse with
   `setup-required` until setup has run, and again if the home folder is moved
   or restored; run setup again then.
5. Run `/live` and accept the consent prompt. macOS asks the terminal app for
   microphone access on first use.

Finishing a call releases its lock, so the same Pi session can start another.
The native audio library's close stops the speaker and the WebRTC connection;
its remote-audio task is not awaited, which is an accepted limit. Behind an
HTTPS proxy, the sideband's cleanup cannot be confirmed, so each call there ends
with `cleanup-blocked`.

### Browser mode (experimental)

`/live browser` starts a call that sends quick browser commands to a fast
browser controller and everything else to Pi
([#16](https://github.com/skhlo/pi-live/issues/16)). It needs
[voice-browser](https://github.com/moritzkremb/jev-voice-browser) running
on the same host. Pi Live can offer to start it with Chrome for this Pi session,
or reuse a controller you start yourself. Pi Live
connects to `ws://127.0.0.1:8787`; set `PI_LIVE_BROWSER_URL` to another `ws://`
loopback address if needed. Pi needs `TYPESAFE_API_KEY` (or `JEV_API_KEY`) for
routing. When voice-browser drives a Chrome started with remote debugging, set
`PI_LIVE_BROWSER_CDP` (for example `http://127.0.0.1:9333`) to give Pi a
`live_browser` tool on that Chrome. While Pi owns a running sidecar, the tool
uses `http://127.0.0.1:9333` automatically when `PI_LIVE_BROWSER_CDP` is unset.
These settings and `VOICE_BROWSER_DIR` can live in a
gitignored `.env` at the checkout's root, as in `.env.example`; Pi Live reads
it when `/live browser` starts, reads no other variables from it, and prefers
values set in Pi's environment.

### Browser sidecar

Set `VOICE_BROWSER_DIR` to an installed voice-browser checkout to enable the
offer. When no controller answers at `ws://127.0.0.1:8787` (or `localhost`), `/live browser` asks
before starting Chrome and third-party voice-browser code with your TypeSafe
key. It waits up to about 15 seconds for the controller before starting the
voice call. Declining keeps today's externally managed browser behavior and
suppresses further offers in this Pi session. No checkout configured, a custom
controller endpoint, or no interactive confirmation UI means no offer or start.
An already answering controller is always reused, without a prompt or restart.

The sidecar keeps its Chrome window, logins, tabs and current page across calls,
`/live stop` and voice ending. The end of the Pi session, not only quitting Pi
(see **Browser sidecar** in [CONTEXT.md](CONTEXT.md)), stops both processes if
this session started them, killing any still running after about 5 seconds. A Pi
crash leaves them running; the next Pi session reuses them without taking
ownership. Several Pi sessions can share a controller, but the session that
started it stops it on exit. There is no coordination between sessions.

Startup failures give one browser-mode notice naming the cause and the private
log file, stop what was started, and let the voice call continue with the
existing controller/Pi fallback behavior. Sidecar output goes to that log rather
than the Pi terminal. A sidecar's log is deleted when it stops, unless a notice
names it or the stop had to kill a process; kept logs stay in the host's
temporary directory.

`scripts/browser-sidecar.sh` starts Chrome and voice-browser together on one
host: a visible Chrome with its own profile and DevTools at
`http://127.0.0.1:9333`, and voice-browser attached to it on port 8787 (both
ports fixed). Set `VOICE_BROWSER_DIR` to a voice-browser checkout with its
dependencies installed (checked with commit `198a076`), and provide the key as
`TYPESAFE_API_KEY` or `JEV_API_KEY`. Settings the environment leaves unset come
from an env file named by `SIDECAR_KEY_FILE`, by default the checkout's `.env`.
The script uses Google Chrome's macOS path unless `SIDECAR_CHROME` names another
binary, and keeps its profile in `~/.cache/pi-live/browser-profile` unless
`SIDECAR_CHROME_PROFILE` names another; both may also come from the env file. Then start Pi with the key and
`PI_LIVE_BROWSER_CDP=http://127.0.0.1:9333` in its environment or `.env`. Ctrl+C stops
voice-browser and Chrome.

The script also remains usable directly from a terminal, with the same `.env`
that Pi Live reads.

### Browser requests

For each handoff, Pi Live asks TypeSafe's Jev model what kind of work the user's
request is:

- A single browser step (open a site, search, click a named link, scroll, type,
  go back, confirm, pick a number) goes to voice-browser, and voice says the
  observed outcome: done with the resulting page (or that it may still be
  loading), a confirmation question, or a numbered choice.
- A longer web task (several steps, comparing, reading a page, filling a form)
  goes to Pi with the page on screen. Pi uses `live_browser`, whose every action
  waits for the page and returns what it now shows, and runs at low thinking
  until it settles; then the previous level returns.
- Anything else, such as coding, goes to Pi unchanged.

When voice-browser refuses or fails a request, Pi gets it too, and so does a
request voice-browser was not running for, when Pi has `live_browser`. Without a
TypeSafe key, every request tries voice-browser first; `/live browser` warns
about that and about an unusable `PI_LIVE_BROWSER_CDP`. The router uses Node's
`fetch`, which ignores `HTTPS_PROXY` unless Node is configured for proxies (on
recent Node versions, `NODE_USE_ENV_PROXY=1`); where a proxy is required, routing fails and
requests go to voice-browser first.

`live_browser` refuses to click, submit or press Enter on anything that looks
like buying, paying, deleting, sending, booking or signing in, and says so; voice
cannot approve those steps, so the user does them. It presses Enter once per
submit and reports when the page did not navigate rather than trying again. `live_browser` appears
in Pi's tools once a browser-mode call has connected it and stays for the rest
of that Pi session, so handed-off work can finish after voice ends.

A newer browser request replaces one still waiting; work already handed to Pi,
or already routed to Pi, continues. Unfinished requests are withdrawn from
voice-browser so it stops asking Jev about them. Stopping voice does not undo a browser action already started.
GPT-Live's client handoff carries no text, so the voice model cannot rewrite a
vague request into a command; it is instructed to suggest a concrete option and
let the user say it. voice-browser follows only tabs it opened itself: after Pi
switches or opens a tab, quick commands still act on voice-browser's tab, so
`live_browser` keeps links in the current tab and opens new tabs only on request.

### Recovery

- **Setup refused:** the message says why, for example a folder that is not
  yours, is reached through a link, or is not on a local disk. Fix that and run
  `/live setup` again.
- **Start failed:** use `/live status` to see compatibility and the last failure
  code. For `missing-auth`, check Pi's `openai` API key; for unsupported
  compatibility, restore the checked Node, Pi and dependency versions above.
  For `denied` or `audio-error`, check consent and the terminal's microphone
  permission. For `connect-timeout` or `protocol-error`, check network/proxy
  access and service availability. Quit this Pi invocation after a failed start,
  correct the cause, then explicitly load the checked version again. If the
  failure persists, leave Pi Live unloaded or choose a previously verified
  version. A retained lock requires the manual recovery below.
- **`cleanup-blocked`:** this Pi process cannot start another call. Quit Pi.
  If a new Pi then reports `busy` while no other Pi has a call running, the lock
  was left behind: remove `~/.local/state/pi-live/active.lock/owner.json`, then
  the `active.lock` folder. Behind an HTTPS proxy this happens after every
  call. Pi Live never automatically recovers a retained lock; normal confirmed
  shutdown removes the call's own lock.
- **Going back:** start Pi outside this checkout's root without `-e`, or with
  `--no-approve`, to stop using Pi Live. To use an earlier
  version, check out its tag and restore dependencies as in step 1. Before
  v0.1.0 there is no earlier supported version.

Pi Live never deletes its state folder, preferences (`pi-live/config.json` in
Pi's agent directory), prior checkouts or pnpm caches. Remove them by hand if
you no longer need them.

See [setup and readiness verification](docs/ISSUE-6-VERIFICATION.md),
[delegation/control verification](docs/ISSUE-5-VERIFICATION.md),
[transport limits](docs/ISSUE-4-VERIFICATION.md), and
[lifecycle verification](docs/ISSUE-3-VERIFICATION.md). The operator adopted
`v0.1.0` for personal MBA use after the [canary](docs/ISSUE-7-VERIFICATION.md),
with the real denied-microphone-permission check explicitly waived. This is
explicit loading only, not global registration or dotfiles integration.

The preference writer uses an optimistic read/compare/retry sequence and atomic
same-directory rename. That does **not** guarantee that every concurrent change
is preserved: another writer can still win after the final observation. A deterministic regression covers a competing update observed before the final
comparison; the design makes no general compare-and-swap claim.

## Codex browser server

Separate from Pi Live, `src/mcp.ts` is a stdio MCP server that gives Codex,
including Codex voice, one `browser` tool with the same actions and refusals as
`live_browser`. When Codex trusts this checkout, `.codex/config.toml` starts it
and the `.agents/skills/voice-browser` skill tells Codex how to use it in voice
conversations; its tool description asks Codex to prefer it there over other
browser or computer-use tools. It needs no new dependencies. Its calls skip
Codex's approval review, which added seconds per call by voice, so the tool's
refusals are the only guard. It runs one action at a time, and an action that
takes more than 30 seconds is abandoned.

It drives the Chrome at `PI_LIVE_BROWSER_CDP`, or else the one at
`http://127.0.0.1:9333`. Set it in the checkout's `.env`: the plain `codex`
command runs MCP servers under its background app server, so variables from the
shell that started Codex may not reach the server. `SIDECAR_CHROME` and
`SIDECAR_CHROME_PROFILE`, in the environment or the checkout's `.env`, name
another Chrome or profile; the sidecar script reads them the same way.

When nothing answers at a `127.0.0.1` address, the next browser action starts a
visible Chrome there, on the browser sidecar's profile
(`~/.cache/pi-live/browser-profile`) so logins carry over, and its reply says
so. Other loopback names, such as `localhost`, only connect. Closing the
window leaves Chrome running on macOS, so the next action opens a new tab;
quitting Chrome means the next action starts it again. Quitting Codex closes the
Chrome it started: at once with `codex exec`, and within about a minute with the
plain `codex` command, whose background app server stops idle servers. A Chrome already answering, such as the sidecar's, is used as it is and
left running. Only a server killed outright leaves its Chrome behind, and the
next Codex session then reuses it. Several Codex sessions share one Chrome;
when the one that started it ends, the others' next action starts a new one.

Chrome runs one instance per profile, so use this server or Pi's browser
sidecar, not both at once: a sidecar started while this server's Chrome is open
attaches to that Chrome, which then closes with Codex.

The server itself does not use Jev, TypeSafe or the voice-browser controller.
Page content it returns goes to OpenAI through Codex.

## Development

The compatibility baseline is Node >=22.19.0, pnpm 11.8.0, Pi/TUI 0.87.1, and
`@oh-my-pi/pi-natives-darwin-arm64` 17.2.9. Pi and TUI remain wildcard runtime
peers and exact development dependencies.

Restore dependencies with the pinned policy:

```sh
pnpm install --frozen-lockfile --ignore-scripts --config.auto-install-peers=false --config.enable-global-virtual-store=false
```

Keep the same peer, script, and local virtual-store policy for development
commands. pnpm 11.8 can reconcile dependencies before running a script: bare
`pnpm` can rewrite the lock with automatic peers enabled, and a virtual-store
policy mismatch can trigger replacement of `node_modules`. Use
`verify-deps-before-run=error` so checks refuse dependency drift instead of
implicitly installing. No extra workspace or npmrc policy layer is required.

```sh
pnpm --config.auto-install-peers=false --config.ignore-scripts=true --config.enable-global-virtual-store=false --config.verify-deps-before-run=error check:source
pnpm --config.auto-install-peers=false --config.ignore-scripts=true --config.enable-global-virtual-store=false --config.verify-deps-before-run=error check:package
pnpm --config.auto-install-peers=false --config.ignore-scripts=true --config.enable-global-virtual-store=false --config.verify-deps-before-run=error check:loader
pnpm --config.auto-install-peers=false --config.ignore-scripts=true --config.enable-global-virtual-store=false --config.verify-deps-before-run=error test
pnpm --config.auto-install-peers=false --config.ignore-scripts=true --config.enable-global-virtual-store=false --config.verify-deps-before-run=error typecheck
pnpm --config.auto-install-peers=false --config.ignore-scripts=true --config.enable-global-virtual-store=false --config.verify-deps-before-run=error format:check
```

If a check reports `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`, inspect the mismatch and,
when dependency restoration is intended, run the explicit frozen install above.
Do not suppress the refusal with `CI=true`, automatic purge confirmation, or a
lockfile rewrite.

`check:loader` requires macOS arm64. Other routine checks are portable;
platform-specific tests explicitly skip on unsupported hosts. The full suite
includes historical transfer verification: it materializes 131 files from local
Git commit `f421dad09d376c02482924170d3796e516670021`, verifies the unchanged
repository receipt, and proves tamper rejection. Missing local history is a
prerequisite error, never an implicit fetch.

Default `check:transfer` is an initial-snapshot diagnostic, not a green current
runtime gate: it now intentionally rejects developed `src/live.ts`. Its explicit
`--root <snapshot-directory>` option redirects verified file bytes, never the
trusted receipt. Private research stays unchecked unless its custody directory
is explicitly supplied with `--private-evidence`.

The separate macOS arm64 production check performs a real frozen dependency
install/fetch in a disposable fixture. It requires its own authorization and is
not part of routine lifecycle verification. It keeps scripts disabled and never
imports the native addon:

```sh
pnpm --config.auto-install-peers=false --config.ignore-scripts=true --config.enable-global-virtual-store=false --config.verify-deps-before-run=error check:production
```

These are development checks, not a real-home installer or extension
registration. See [lifecycle verification](docs/ISSUE-3-VERIFICATION.md), the
[current test-cleanup record](docs/TEST-CLEANUP-VERIFICATION.md), and
[historical transfer verification](docs/VERIFICATION.md); receipts verify
only their recorded source and dependency identities.

## Continuous integration

[The portable CI workflow](.github/workflows/ci.yml) runs on pull requests to
`main`, pushes to `main`, and manual dispatch. Its Ubuntu 24.04 matrix uses
Node 22.19.0 (the supported minimum) and 26.6.0, with pnpm selected from the
exact `packageManager` pin. Actions are pinned to commit SHAs; the token has
read-only repository access and checkout does not persist its credentials.

CI explicitly installs frozen dependencies with scripts and automatic peers
disabled, then runs source/package checks, tests, typecheck and formatting with
the same refusal-on-drift policy as local development. Native addons are
disabled during verification. Full Git history makes the accepted historical
snapshot available without lazy fetching. Transfer regression cases run within
`test`; there is no additional standalone `check:transfer` step. The initial extraction's working-tree-byte check has been replaced with pinned
historical-snapshot verification and explicit developed-source drift rejection;
see [lifecycle PR #9](https://github.com/skhlo/pi-live/pull/9).

There are no dependency caches or artifact uploads. Linux skips the existing
macOS-arm64-only tests; this workflow does not replace macOS loader/isolation
receipts. It does not run `check:production`, real provider/audio/native trials,
or require secrets. Hosted runner tool/dependency downloads are part of CI
bootstrap, not permission for local installs or real-home adoption. Branch
protection and required-check policy are separate follow-ups. A configured
workflow is not passing hosted evidence until its jobs have actually run.

See [the current design](docs/DESIGN.md), [provenance](PROVENANCE.md), and
[third-party notices](THIRD_PARTY_NOTICES.md). Historical research is archived
behind [an explicit index](docs/history/extraction/README.md).
