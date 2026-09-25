# Issue #3 - dormant lifecycle verification

This records the original lifecycle implementation. The later
[test-cleanup verification](TEST-CLEANUP-VERIFICATION.md) preserves the runtime
but has new test/helper identities and fresh mutation evidence.

## Scope and effective revision

This is a local implementation candidate for #3's fake-resource lifecycle and
ownership scope, not issue closure or permission to enable calling. The user
approved implementation/delegation, acquiring-anchored connect/call timers,
asynchronous release with `releasing`, and conservative admission for Pi's
unreported nested-dialog limitation. The approved contract is in
[the plan](ISSUE-3-PLAN.md). GitHub's acceptance text has not been updated.

The shipped `index.ts` and setup-only registrations remain unchanged. New
behavior is dormant inside `src/live.ts`; production home certification refuses
by default. Native media, actual preparation/transport, enabling the Pi UI,
setup/recovery tooling and operational trials remain later work.

The checked tree is uncommitted on `feat/issue-3-lifecycle`, based on
`512a7bc288ecca18b94417b94140d7e979cb6be4`. HEAD alone does not identify it.

| Input                                   | SHA-256                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `src/live.ts`                           | `a1ff89bdbf1e7fea8cf6c15c6bda61e6e25e3b0090fa869a0db81fe5a2f3f072` |
| `index.ts` (unchanged)                  | `1b0642cbbf4334392e999e194bc47dfe9d1a83441844b0b2281bfcadee27e92d` |
| `package.json` (unchanged)              | `375d1573ff8f75c5255bbc82c29274bb2ca3c146a481d2d1f84d3241728ea276` |
| `pnpm-lock.yaml` (unchanged)            | `7230a1cf633b74dc0fe3d7b6ec014f66edb636623a92e060dd75d0adf9d9e597` |
| `scripts/check-transfer.ts`             | `7fc3ffe8c19a31b62fbcc9f915ec6737c8dda5e7f8c6359837d6b82fcf6d1e4f` |
| `scripts/check-transfer.test.ts`        | `8e5ff8a6c7a6c4ba392976cd0b18d28e9f0248a4947c7c5fd3a374f93b7f8b38` |
| `scripts/pi-live-lifecycle.test.ts`     | `0aaa888d14259f7efde90b85c6602a5b470f91fbdc5fe35aeed6345bcaae4100` |
| `scripts/pi-live-ownership.test.ts`     | `c8c6c0351ca86bb86cb5e9ea4198c323733fe0f4ce005caca4beaa2c3177e8c1` |
| `scripts/pi-live-lifecycle-sdk.test.ts` | `188f2ad86cfb5e1d9c9b0f5554d1cd467b14e06ace0b1871fccf20516b97cb24` |
| `scripts/pi-live-lifecycle-child.ts`    | `3bad3f3ccee28fc4d4ad04fa5482df403fe2e0328cefc9dfe4e17a4d3425d608` |

Runtime: macOS 27.0 arm64, Node 26.6.0, pnpm 11.8.0, Pi/TUI 0.87.1,
TypeScript 5.9.3 and Prettier 3.9.6. Existing installed dependencies were reused;
source/test/package/lock and installed metadata hashes remained unchanged during
final verification. Minimum-supported-Node and Linux execution were not repeated.

## Checks

Every pnpm invocation used the README policy:

```text
--config.auto-install-peers=false --config.ignore-scripts=true
--config.enable-global-virtual-store=false --config.verify-deps-before-run=error
```

| Check                                                       | Result                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| Full `test`                                                 | 259 passed; no failures or skips                               |
| `typecheck`                                                 | Passed                                                         |
| `check:source`                                              | Passed; pinned upstream bytes unchanged                        |
| `check:package`                                             | Passed; payload policy, dependency pins and notices unchanged  |
| `check:loader`                                              | Passed in its own macOS sandbox; shipped factory remains inert |
| Whole-repository `format:check` after documentation updates | Passed                                                         |
| Focused lifecycle, network denied, `--no-addons`            | 50 passed                                                      |
| Focused ownership, network denied, `--no-addons`            | 78 passed; one explicit fixture exclusion below                |
| Excluded special-permission fixture, without outer sandbox  | 1 passed                                                       |
| Focused real SDK, network denied, `--no-addons`             | 52 passed                                                      |
| Historical transfer tests                                   | All 7 passed, included in the full suite                       |
| Default `check:transfer`                                    | Expected exit 1: `Transfer bytes differ: src/live.ts`          |

The default transfer diagnostic is not a failing current-runtime gate. The
unchanged receipt is positively verified against 131 files materialized from
local Git commit `f421dad09d376c02482924170d3796e516670021`, with lazy fetching
disabled. Tests also reject modified license/archive bytes, a forged receipt in
the fixture, deliberate current-tree drift, and invalid CLI arguments. `--root`
changes only the bytes being checked, never the trusted receipt's location.

The special-permission-bit test remains intact. macOS sandbox-exec prevents its
setuid-directory fixture from taking effect, so the network-denied ownership run
excludes exactly `special permission bits on a newly-created lock are rejected`.
It passes separately without that sandbox and in the full 259-test run. Node's
CLI exclusion is not counted in its skipped footer; the exclusion is disclosed
here rather than reported as complete sandbox coverage.

## Behavioral evidence

| Contract area       | Exercised evidence                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| States and consent  | Off/consent/acquiring/connecting/active/stopping/releasing/blocked controls; late Yes; fresh consent; start refusal during stop/release; off-only voice changes; read-only snapshot                                                                               |
| Authority           | Injected certified temporary homes, HOME absent/alias/divergence, default OS-account lookup through a refusing fake filesystem, missing/wrong certification and parent drift                                                                                      |
| Acquisition         | Simultaneous ready-barrier children with different Pi agent directories; existing/partial/corrupt/unreadable/redirected/dead-PID locks stay busy; faults at publication boundaries                                                                                |
| Release             | Resource quiescence before removal; bounded no-follow owner reads; identity/token/content drift refusal; all release filesystem phases parked beyond the observer deadline; settled success/failure; partial deletion                                             |
| Process exit        | Real child exits at mkdir/publication/verification/unlink/rmdir barriers; physical remnants reflect completed operations, not missing callbacks; no automatic recovery                                                                                            |
| Reload coordination | Pending/blocked projection across reload; physically removed directory with parked callback; external new owner never touched; same-process starts still refused until settlement                                                                                 |
| Resource lifetime   | Certified data-only versus resource-bearing waits; never/late results; constructor/stop/termination synchronous throws; independent shutdown attempts; one shared stop observation under abort-listener reentrancy                                                |
| Mute and delivery   | Immediate sample gating, preserved final mute intent, reentrant mute/unmute without overlapping captures, old sample/data callbacks refused, one bounded semantic close request                                                                                   |
| Budgets             | Connect/call anchors at acquiring; five/ten-second phase limits; deadline equality and delayed/early timer delivery; delegation settlement capability cannot cancel another generation or erase expiry                                                            |
| Pi lifecycle        | Actual reload/new/switch/fork/tree/dispose operations, blocked/pending navigation cancellation, delayed earlier handlers, retired old bindings, no voice-owned `ctx.abort()`                                                                                      |
| Dialogs/conflicts   | Ordinary owned confirm, conservative ambiguous-marker refusal, unreported nested-dialog suppression and admission refusal, same-title external dialog; validated pooling shape never invoked; configured sources and exact command provenance in both load orders |

The preparation/media/transport adapters above are fakes. Their semantic close
request is not proof of the real `session.close` wire encoding or network buffer
behavior. Actual DeviceCheck/native operations still need classification and
close certification in #4. Snapshot mute is intent; future UI must not describe
pending capture shutdown as confirmed microphone stoppage.

SDK disposal is not OS process exit. The SDK tests prove binding behavior; the
separate child tests prove exit/remnant behavior. No real microphone/speaker,
provider turn, account credential, or native-addon import was used.

## Isolation and mutations

Focused suites and both mutation proofs ran with `--no-addons` under:

```scheme
(version 1)
(allow default)
(deny network*)
```

A loopback-listen guard actually received `EPERM`. Commands used `env -i` with
empty fixture HOME, agent, settings, session and credential-store roots. Tests
inject account-home authority rather than relying on HOME to redirect it. Real
contenders use pipes, ready barriers, bounded watchdogs and joined exits. The
loader applies its own stronger sandbox separately; it is not nested inside the
focused suite's sandbox.

Both mutants were made in independent disposable copies, one change at a time.
The actual source and named positive tests were verified before and after.

1. **Release before close**: inserting owner release before shutdown work made
   the real second child return `{ kind: 'started', state: 'active' }` while a
   fake close remained pending, instead of busy refusal. The behavioral test
   exited 1 after stopping and joining the unexpected owner.
2. **Missing generation effect guard**: the parked old callback sent an extra
   `sample-1` after a new call started. Actual sends were
   `['sample-1', 'sample-1', 'sample-2']`, not `['sample-1', 'sample-2']`; exit 1.
   Only this deliberately failing mutant used `--test-force-exit` because its
   assertion precedes normal cleanup of the call timer. No child was spawned by
   that test. Baseline tests used no forced exit.

Neither proof relies on import/type errors, watchdog expiry or an unchanged
mutant. Exact diffs, argv, environment, logs, exit statuses and hashes are in the
retained final receipt below.

## Review and limitations

Independent reviews identified and prompted regressions for resource adoption
after fencing, constructor uncertainty, reentrant mute/stop, delayed deadlines,
shared coordination admission, stale delegation settlement, and misleading
consent identity. Final targeted review approved those corrected changes. A
later parent check corrected snapshot side effects and repeated final verification
against the source identity above. No unresolved reviewed defect is being waived
by the passing tests.

- The default factory is still setup-only; no new visible UI was enabled. Its
  inert loader/registration tests passed. A new live-UI TUI exercise belongs to
  #5; historical terminal evidence is not fresh live-UI evidence.
- Pi reports only outermost dialogs, with a delivery window. Unreported nested
  or shortcut dialogs cannot trigger immediate cancellation. Ambiguous consent
  notification timing may conservatively refuse a call. These limits are
  accepted, not hidden by a fictitious prompt ID.
- Conflict discovery is limited to supplied configured-source facts and public
  command provenance; there is no complete extension/shortcut inventory.
- Local-filesystem ownership is cooperative, not an adversarial atomic
  compare-and-delete guarantee. Home certification and manual recovery
  instructions remain #6-owned; no real home was certified or recovered.
- Native shutdown, real credentials/attestation, transport/wire/privacy bounds,
  host adoption and operational device/provider trials remain unproved and
  separately gated. This is not an unqualified native G2/adoption sign-off.
- No commit, push, PR or GitHub issue update/closure has been performed for #3.

## Delegation scope incident

An earlier worker incorrectly ran the real `check:production` command without
its separate install/fetch approval. The parent disclosed this and paused work;
the user explicitly authorized resuming under the original no-install boundary.

That command's log records an isolated frozen nine-package install with scripts
disabled and a `--no-addons` loader check. Its temporary fixture was removed;
repository manifests/locks and the existing dependency metadata were unchanged.
No native import, audio or provider use was recorded. The incident log is
`/tmp/pi-live-issue3-production-final.txt`. It is not treated as an authorized
production receipt or permission for any repeat. Final verification invoked no
production CLI, install or fetch; the full test suite's production test uses a
stubbed package manager.

## Retained artifacts and handoff

Authoritative final local receipt:
`/tmp/pi-live-issue3-final-receipt.WW0bu8/MANIFEST.md`.
Its `EVIDENCE.sha256`, inventories, logs and mutation copies bind the effective
uncommitted source. Preliminary runs with an incorrectly shared XDG-state/settings
fixture path were retained but superseded by corrected final runs. Only isolated
Node/jiti caches remain under fixture TMPDIRs; certified homes and stores are
empty. No task test or contender process remains.

The implementation worktree is `/tmp/pi-live-issue-3-plan` on
`feat/issue-3-lifecycle`. Delegation worktrees `/tmp/pi-live-issue-3-sdk` and
`/tmp/pi-live-issue-3-transfer-check` remain on their task branches. All three
reuse existing dependencies through untracked `node_modules` symlinks; those
links are task artifacts, not files to commit. Earlier red/green logs and
superseded mutation receipts remain in `/tmp/pi-live-issue3-*` and
`/tmp/pi-live-issue-3-*`. No previous artifact was silently deleted.

Main and its pre-existing untracked `docs/ISSUE-TRANSFER-PLAN.md` are untouched.
The next delivery step requires separate commit/publication approval and an
explicit issue-acceptance decision, including the locally approved contract
amendments. This receipt is not that approval.
