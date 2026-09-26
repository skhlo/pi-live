# pi-live

Private, experimental Pi extension. Voice feeds requests into the current Pi
conversation and receives Pi's reply. Pi handles typed and spoken input together,
including its normal extensions, tools and retries.

It is checked on macOS arm64 only. See [Using Pi Live](#using-pi-live) for
setup, calls and recovery.

## Current behavior

The package exports one Pi extension factory. Discovery registers `/live`,
`Ctrl+Shift+L`, the historical live-message renderer and public lifecycle,
dialog and delegation listeners. Discovery does not load the native addon,
resolve credentials, create call timers, touch ownership or contact a provider.

- `/live` toggles voice; `start` and `stop` are explicit forms, and `end` or
  `off` also stop. Each new attempt requires ordinary TUI consent. The shifted shortcut follows the same path;
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
key Pi uses for its `openai` provider. While Pi works, voice receives short quiet
progress notes; when Pi finishes, voice summarizes its reply aloud.

Consent identifies the execution host, OpenAI GPT-Live, microphone and speakers,
the conversation, progress and reply sharing, and proxy limitations. Reported non-live extension dialogs fence
voice when their delayed notification arrives. Shortcut-opened and unreported
nested dialogs can leave voice active; stop voice before opening them when
capture and delivery must stop. Voice never answers or grants an approval.

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
3. Start Pi with the extension: `pi -e /path/to/pi-live/index.ts`. Loading it
   does nothing until you use `/live`; Pi without `-e` is unchanged.
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

### Recovery

- **Setup refused:** the message names the folder and the reason (not yours,
  redirected through a link, or not on a local disk). Fix that and run
  `/live setup` again.
- **`cleanup-blocked`:** this Pi process cannot start another call. Quit Pi.
  If a new Pi then reports `busy` while no other Pi has a call running, the lock
  was left behind: remove `~/.local/state/pi-live/active.lock/owner.json`, then
  the `active.lock` folder. Pi Live never removes a lock itself.
- **Going back:** start Pi without `-e` to stop using Pi Live. To use an earlier
  version, check out its tag and restore dependencies as in step 1. Before
  v0.1.0 there is no earlier supported version.

Pi Live never deletes its state folder, preferences (`pi-live/config.json` in
Pi's agent directory), prior checkouts or pnpm caches. Remove them by hand if
you no longer need them.

See [setup and readiness verification](docs/ISSUE-6-VERIFICATION.md),
[delegation/control verification](docs/ISSUE-5-VERIFICATION.md),
[transport limits](docs/ISSUE-4-VERIFICATION.md), and
[lifecycle verification](docs/ISSUE-3-VERIFICATION.md). The MBA canary and
adoption decision remain #7.

The preference writer uses an optimistic read/compare/retry sequence and atomic
same-directory rename. That does **not** guarantee that every concurrent change
is preserved: another writer can still win after the final observation. A deterministic regression covers a competing update observed before the final
comparison; the design makes no general compare-and-swap claim.

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
