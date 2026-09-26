# Issue 6 verification: standalone setup and recovery

## Operator decisions (2026-09-26)

- **Cleanup between calls:** trust the native close. A resolved native peer
  close now counts as confirmed, so a finished call releases its lock and the
  same Pi process can start another. Accepted limit: the native close ignores
  its own errors, joins the microphone send task for at most one second and
  never joins the remote-audio task, which cannot play once the speaker is
  stopped. A proxied sideband stays unconfirmed.
- **Home setup:** a one-time `/live setup` command replaces the
  development-only `PI_LIVE_DEV_TRUST_HOME=1` switch, which is removed.
- **Loading:** Pi Live stays an explicitly loaded extension
  (`pi -e <checkout>/index.ts`). Adding it to the operator's global extension
  set in dotfiles comes later, after it passes here.
- **Version:** the reviewed version is `0.1.0`, tagged `v0.1.0` once this work
  merges and the operator confirms the tag.

## What changed

- `/live end` and `/live off` stop a call through the same path as
  `/live stop`.
- `/live setup` asks first, then creates `~/.local/state/pi-live` (mode 0700),
  refuses a divergent HOME, a redirected or foreign-owned folder, or a mount
  without the `local` flag, and atomically writes `setup.json` (mode 0600)
  naming the home and state directory identities. The default certifier accepts
  a call only when that record matches what the lifecycle observes; otherwise
  the call refuses with `setup-required` and the message says to run setup.
- The native peer adapter reports a resolved close as confirmed.
- `cleanup-blocked` refusals point to the README recovery steps.
- The package is `0.1.0` with a current description. The transfer check still
  rejects the developed tree; its test now accepts either `package.json` or
  `src/live.ts` as the first differing file.
- README gains a setup, recovery and rollback guide; DESIGN and CONTEXT drop
  the development switch.

## Review

A fresh-context review (standards and spec axes) found no high-severity issue.
Fixed from it:

- Setup checked only permission bits while calls require exactly 0700, so a
  sticky or setgid bit left setup "ready" and every call refused. Setup now
  clears those bits and finishes by running the call-time certifier on what it
  wrote.
- A home path over about 420 bytes overflowed the 1 KiB record limit; the limit
  is now 4 KiB (two maximum-length macOS paths fit).
- The mount check used the first `mount` line for a mount point; the last one
  covers the others, so a network share mounted over a local point passed.
- The help text said a proxied `cleanup-blocked` clears when Pi restarts; the
  lock survives, so it now says to remove it by hand.
- Setup now checks the home's disk before creating anything, rechecks that
  voice is off after the confirm prompt, names the error code when it fails,
  refuses on non-macOS hosts, and removes its temporary file on any failure.
- New tests cover the native-close mapping, stacked mounts, special mode bits,
  long home paths, an existing lock left untouched, the setup refusal hint, and
  `setup` outside the TUI.

Accepted as is: setup tightens an existing state directory to 0700 rather than
refusing it; the optional `setup` dependency keeps fixtures from touching a real
home; foreign-owned paths are not tested because that needs another account.

## Checks

With fake media and fake provider responses on macOS arm64: 387 tests,
typecheck, formatting, the source/package/loader checks and all 18 PTY
scenarios pass. The setup tests use temporary homes, and on macOS one runs the
real `df`/`mount` local-disk check against a temporary folder.

Guards proven by breaking them once:

- Removing the `off` alias made the new alias test fail; restoring it passed.
- Making the setup record's identity match always succeed made the
  replaced-state-directory test fail; restoring it passed.
- Reverting the native adapter to report every close unconfirmed made the new
  native-close test fail; restoring it passed.

## Not yet verified

- `/live setup` on the real home, and several real calls in a row in one Pi
  session with the microphone and speakers.
- `check:production` (a disposable frozen install that fetches from the
  registry); it needs its own authorization.
- The #7 canary and the adoption decision.
