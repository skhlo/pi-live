# Lifecycle test cleanup

This implements the [cleanup plan on PR #9](https://github.com/skhlo/pi-live/pull/9#issuecomment-5827069102).
The original [lifecycle verification](ISSUE-3-VERIFICATION.md) remains historical;
its test hashes and mutation copies have not been relabeled as cleanup evidence.

## Changes and size

Shared test-only fixtures now own clocks/deferreds, temporary homes, fake resources,
real SDK setup, and child/filesystem test machinery. Scenario files retain their
specific actions and assertions; no replacement lifecycle model or scenario DSL
was added. Lazy/refusal tests retain direct minimal construction. Ordinary tests
retain the production clock; formerly manual-clock cases select it explicitly.

| File                                        |    Before |     After |
| ------------------------------------------- | --------: | --------: |
| `scripts/pi-live-lifecycle.test.ts`         |     2,222 |     1,673 |
| `scripts/pi-live-lifecycle-sdk.test.ts`     |     1,469 |       878 |
| `scripts/pi-live-ownership.test.ts`         |     2,070 |     1,353 |
| `scripts/pi-live-lifecycle-child.ts`        |       309 |       270 |
| `scripts/test-support/live-fixture.ts`      |         0 |       336 |
| `scripts/test-support/live-sdk.ts`          |         0 |       514 |
| `scripts/test-support/live-ownership.ts`    |         0 |       674 |
| **Total, including every helper and child** | **6,070** | **5,698** |

The net reduction is **372 lines (6.1%)**. The three scenario entrypoints shrink
from 5,761 to 3,904 lines (32.2%); the difference is not all deletion. Real SDK
construction, process control and filesystem fault injection still require
substantial specialized support. The benefit is less repeated arrangement and
clearer separation, not a claim that the test surface is now small.

Teardown is registered early, bounded and ordered before home removal. It joins
children, restores SDK fixture HOME even on failure, checks manual timers, and
rejects unresolved release or unexpected cleanup failure. The deliberately
synthetic pending-coordination case retains explicit construction and proves
actual resource/filesystem settlement; it does not clear the pending cell to
make generic cleanup pass.

## Coverage map

All generated test names, nesting, outcomes, skip and todo flags match the
baseline. No case was renamed or removed, so the mapping is the identity mapping.
The baseline and after inventories were collected from actual Node test events,
not source-string assertions.

| Suite              | Baseline / after cases | Protected observations retained                                                                                                    |
| ------------------ | ---------------------: | ---------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle          |                50 / 50 | State/control rows; consent; generation effects; resource uncertainty; reentrant stop/mute; deadlines and delegation settlement    |
| Ownership          |                79 / 79 | Real contenders and process exits; lock inventories; publication/release faults; late callbacks; home authority and identity drift |
| Real SDK           |                52 / 52 | Actual reload/new/switch/fork/tree/dispose; dialog limitations; retired bindings; conflict provenance and pooling                  |
| Rest of repository |                78 / 78 | Existing package, transfer, source, preferences, compatibility and inert registration checks                                       |
| **Full suite**     |          **259 / 259** | **All passed; no failures, cancellations or skips on the local macOS run**                                                         |

The stale-release scenario now also positively waits for its injected filesystem
failure and continuation before inspecting the synthetic replacement owner.
Exact baseline/current event streams and their comparison are retained in the
local receipt's `inventory/` directory.

## Verification and identity

The cleanup was checked at HEAD `905caae28365603e720430ab8661a51544e9a269`
with uncommitted test changes; that commit preserves published history and brings
in the merged portable CI workflow. The receipt binds the effective test/helper
bytes separately from HEAD.

`src/live.ts` is byte-identical at SHA-256
`a1ff89bdbf1e7fea8cf6c15c6bda61e6e25e3b0090fa869a0db81fe5a2f3f072`.
`index.ts`, package/lock, dependency pins, notices and extraction receipt are
unchanged. No runtime behavior or production interface changed.

On macOS arm64, Node 26.6.0, pnpm 11.8.0 and Pi/TUI 0.87.1:

- Full tests, typecheck, formatting, source/package and isolated loader passed.
- Network-denied `--no-addons` runs passed lifecycle 50, SDK 52 and ownership 78.
  The existing sandbox-incompatible special-permission fixture passed separately
  unsandboxed; no other exclusion was added. The `EPERM` network guard was exercised.
- Seven historical transfer tests passed. Default `check:transfer` still reports
  the intended `src/live.ts` extraction drift, not a cleanup regression.
- Both fresh mutations failed behaviorally with all new helper dependencies copied:
  early release let the real child wrongly acquire; the missing generation effect
  guard produced an extra old-generation sample. Actual positives passed before
  and after. Neither failure was an import/type error or watchdog expiry.
- The generation mutant now exits through normal failed-test teardown, without
  the earlier `--test-force-exit` workaround. No fixture child or test process remains.

The standard four pnpm refusal-policy flags were used throughout. No local
install/fetch, production CLI, native/device/provider/audio, real-home or remote
host operation was performed. The full suite's production test is stubbed.

Receipt: `/tmp/pi-live-test-cleanup.LZsosU/final/MANIFEST.md`, with exact argv,
environments, statuses, test/helper hashes, mutation diffs and retained copies.
The implementation and failure-teardown probes are retained alongside that
receipt. Earlier evidence was preserved.

Hosted Node 22.19.0 and 26.6.0 validation must be bound to the updated PR head;
PR #10's earlier inert-package CI results are not evidence for this cleanup.
Publication and those results are recorded on PR #9 rather than inferred here.

## Subsequent SDK polling correction (test-phase evidence)

The preceding receipt is historical evidence for its original 5,698-line tree;
its helper hashes and mutation copies do **not** describe the corrected head.
At `52b02f8decdc909807c0438fd094db438099bc85`, the SDK polling helper
uses a monotonic ten-second deadline instead of 200 `setImmediate` turns. This
adds two lines to `scripts/test-support/live-sdk.ts` (516 rather than 514),
so the seven-file surface is **5,700 lines**, a **370-line (6.1%)** net reduction
from 6,070. The scenario files remain 3,904 lines. The corrected helper SHA-256
is `d4e1f8f4254850bb9b5ce212eb55a5d765638de3abc405966130cc5de930ddf9`.
The other six file hashes remain those in the historical receipt. Runtime
`src/live.ts` remains byte-identical to the SHA-256 recorded above.

In this isolated worktree, `node --test scripts/pi-live-lifecycle-sdk.test.ts
scripts/pi-live-ownership.test.ts scripts/pi-live-lifecycle.test.ts` passed at
default concurrency (181 passed, zero failed/cancelled/skipped; 17.3 seconds).
The focused `node --test --test-name-pattern='child failures are joined and
clear their bounded watchdog' scripts/pi-live-ownership.test.ts` also passed
(one passed, zero failed/cancelled/skipped); it exercises an actual failed child
read, waits for the child exit and asserts that no child watchdog remains. These
are focused local test results, not another full-suite or live-call result.
The original mutation proofs have **not** been repeated against the corrected
helper bytes and must not be presented as proofs bound to this head. No new
mutation receipt or hosted CI evidence is claimed here.
