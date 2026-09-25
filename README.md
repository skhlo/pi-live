# pi-live

Private, experimental Pi extension extracted for standalone development. It is
setup-only: it does not make voice calls.

## Current behavior

The package exports one Pi extension factory. Loading it registers:

- `/live` with `start`, `stop`, `mute`, `unmute`, `voice`, `status`, and `help`
  subcommands;
- `Ctrl+Shift+L` as the same setup-only toggle path;
- one renderer for historical live-delegation messages; and
- a shutdown handler that clears its widget.

`/live` and `/live start` display an **off (setup-only)** widget. `stop` clears
it, `mute` and `unmute` report that calling is unavailable, and `status` reports
metadata compatibility. Voice selection writes only the private Pi Live
preference file and preserves unknown fields when possible.

The extension does not import the native addon, open audio devices, read
credentials, authenticate, contact a provider, or start a live session. Its
compatibility check reads package metadata only. Nothing in this repository is
an installation, device, service, or real-home authorization.

Issue #3 adds a dormant lifecycle module with fixture-tested ownership,
cancellation, mute, deadlines, asynchronous release, and Pi lifecycle binding.
The default factory does not construct it. Real media/transport, operational
home certification, and enabling the call UI remain later work. See the
[current lifecycle verification](docs/ISSUE-3-VERIFICATION.md).

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
registration. See [current lifecycle verification](docs/ISSUE-3-VERIFICATION.md)
and [historical transfer verification](docs/VERIFICATION.md); receipts verify
only their recorded source and dependency identities.

See [the current design](docs/DESIGN.md), [provenance](PROVENANCE.md), and
[third-party notices](THIRD_PARTY_NOTICES.md). Historical research is archived
behind [an explicit index](docs/history/extraction/README.md).
