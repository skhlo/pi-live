# Standalone transfer verification

This records the local inert-package transfer, not a voice-runtime release or
adoption decision. The source was dotfiles commit
`db2c57f13c274d66d79287fda8de177c016f0c02`; old PR #522 and its cancelled
no-mistakes run were not resumed or changed.

## Result

- All five runtime files remain byte-identical to the extraction source.
- The transfer receipt accounts for 99 selected source files: 88 exact copies
  and 11 declared adaptations. It also accounts for 61 historical research files:
  32 exact repository copies and 29 private local captures.
- The 24-file upstream snapshot and 52-file notice corpus retain their exact
  original bytes. Private raw evidence is not claimed to be available to readers
  of this repository.
- The regenerated full lock has SHA-256
  `7230a1cf633b74dc0fe3d7b6ec014f66edb636623a92e060dd75d0adf9d9e597`.
  The production graph remains the same nine packages, with no private Pi/TUI.

## Checks exercised

The parent ran the documented development commands with explicit
`auto-install-peers=false` and `ignore-scripts=true` policy:

- frozen development restore, without lock drift;
- TypeScript and formatting;
- the full test suite: 73 tests passed on macOS arm64;
- portable tests separately under OS network denial and Node `--no-addons`;
- the pinned source importer and standalone package checker;
- the real Pi 0.87.1 loader in an isolated source-only package;
- a real frozen nine-package production install in a disposable package;
- the extraction receipt, both without private evidence and with its explicit
  local custody directory.

Loader probes use empty credential/session/workspace directories, disabled
native addons, and OS-level network, child-process, and non-scratch-write denial.
The production checker verifies source and dependency closure before and after
loading. This checks the opaque native file's identity without importing it.

A first attempt to wrap every test in an outer macOS sandbox failed because
macOS would not apply the loader tests' nested sandbox. No failing tests were
removed. The final runs separate portable network-denied tests from loader tests
that establish their own sandbox, and also run the complete public test command.

Bare `pnpm check:package` reproduced an unwanted peer-policy rewrite. The lock was
regenerated with pnpm's explicit false policy, returning to the hash above.
The documented policy-qualified commands then passed without changing it.

## Behavioral and terminal evidence

The preference regression forces a competing valid update before the writer's
final comparison, then verifies a retry and preservation of that observed
update. It passed repeated runs; bypassing the comparison/retry in a disposable
copy made it fail. This is not a guarantee against changes after the final
comparison and does not turn the writer into a compare-and-swap operation.

The extraction-receipt regression verifies an unchanged copy, mutates one license
byte, and requires rejection through the command-line checker.

An actual Paseo terminal ran the pinned Pi 0.87.1 TUI with the transferred
extension. It had an empty isolated home/agent directory, no available model or
provider credentials, OS networking denied, and native addons disabled. The
following were exercised and captured:

- `/live status` defaults to `sol` and reports setup-only behavior;
- `/live` and `/live start` display the off/setup-only widget;
- `/live voice arbor` persists `arbor` in a `0600` file under a `0700` directory;
- subsequent status/start read that preference;
- `/live mute` and `/live unmute` report unavailable, not active capture;
- `/live stop` clears the widget; and
- Ctrl+D exits the Pi process normally.

The transfer made no model turn, native import, audio/device operation,
authentication, provider call, real-home registration, or dotfiles change.

## Receipts and limits

The portable copy/adaptation and research-custody inventory is
[`history/extraction/transfer-receipt.json`](history/extraction/transfer-receipt.json).
It describes the initial extraction; intentional later edits are not unchanged
transfer bytes and must not silently rewrite original source evidence.

Detailed command argv, exit statuses, output hashes, logs, and terminal captures
are retained locally under `/tmp/pi-live-transfer.gxKryh/`. Final command receipts
bind the checked local commit after commit creation. Raw private research remains
under `~/.local/share/pi-live-transfer/evidence/`. Local-only records are not
remote CI attestations.

Portable checks were exercised on macOS, not a Linux execution host. The
macOS-only loader checks explicitly skip in the portable suite on other hosts;
the production check refuses unsupported hosts. No remote CI or publication was
performed. Real speech, authentication, transport, ownership/lifecycle, and
native shutdown behavior remain future work requiring separate scope and tests.
