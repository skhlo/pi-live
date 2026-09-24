# Transfer Pi Live out of dotfiles

Status: local execution authorized by the operator after reviewing this plan.
Publication remains separate. See `VERIFICATION.md` for execution results; the
original scope below remains the transfer contract.

## Outcome

Make `skhlo/pi-live` the development home of the existing inert Pi extension.
Transfer its implementation, provenance, tests, and design context without adding
voice functionality. Dotfiles stays unchanged: no pin, copied runtime, launcher,
settings entry, installation integration, or tracking document. Reconsider
integration when the extension is useful.

The external interface remains one Pi extension factory and the existing `/live`
namespace. This is a standalone repository, not a standalone application,
monorepo, generic installer, or framework.

## Baselines and custody

- Destination: private `skhlo/pi-live`, repository ID `1385761841`, local clone
  `/Users/skhl/Repositories/pi-live`; initial main commit
  `ca92eba6072edd210c046b0290d4fa06360a5095`.
- Implementation source: `skhlo/dotfiles` (repository ID `1228109764`), local
  `/tmp/dotfiles-pi-live-package`, branch `feat/pi-live-package`, commit
  `db2c57f13c274d66d79287fda8de177c016f0c02`.
- [Dotfiles PR #522](https://github.com/skhlo/dotfiles/pull/522) is open, unmerged,
  and published only through `d66287e4c6046ae61fb42133958c46655480434e`.
  Its CI failed. The later local commit contains a recovered, unpublished
  test-only CI repair; it is not a green remote result.
- The old no-mistakes run `01M39VVQ5AMZEMJWYCE8PT5RGS` is cancelled. Leave it
  cancelled. Do not restart its review or use it to deliver the new repository.
- Research is under
  `/Users/skhl/dotfiles/docs/research/harnesses/pi/live-extraction/`.
  It is ignored local data, not part of the source commit.

Use a new `feat/initial-extraction` branch for implementation. Read committed
source bytes from the source commit, not mutable worktree contents. Inventory and
hash the selected local research separately. Preserve the old branch, worktrees,
PR, caches, and evidence until transfer verification and explicit cleanup approval.

## Proposed layout

```text
index.ts                     One extension factory
src/                         Owned implementation
package.json                 Private Pi package and development commands
pnpm-lock.yaml               Standalone frozen dependency graph
LICENSE                      Existing upstream license text
PROVENANCE.md                Source identity, extraction map, current limitations
THIRD_PARTY_NOTICES.md        Known notices and accepted residuals
UPSTREAM_THIRD_PARTY_NOTICES.md
notices/                     Exact 52-file gathered corpus and manifest
upstream/pi-live/            Exact 24-file upstream snapshot; never runtime-loaded
upstream/pi-live.lock.json   Original immutable snapshot/native receipt
scripts/                     Focused import/package/loader checks and tests
README.md                    Actual current behavior and development commands
docs/DESIGN.md               Current status, accepted decisions, proposed next work
docs/history/extraction/     Selected historical design and audit evidence
```

Keep current script/test filenames initially to reduce movement noise. Do not
copy the entire dotfiles repository or its Git history. The recommended transfer
is a source snapshot with the original commit, path mapping, byte hashes, and
attribution recorded in `PROVENANCE.md` and a small extraction receipt. The
trade-off is losing inline Git blame before extraction. The existing local
source branch remains the owner of unpublished history; do not claim the
source commit is available on GitHub or remove that branch during this transfer.

## 1. Copy the owned package and exact provenance

| Source relative to the source checkout                                     | Destination           | Treatment                                                                  |
| -------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| `config/pi-live/index.ts`, `config/pi-live/src/**`                         | `index.ts`, `src/**`  | Preserve runtime bytes and behavior initially                              |
| `config/pi-live/LICENSE`, `config/pi-live/UPSTREAM_THIRD_PARTY_NOTICES.md` | Same root filenames   | Exact bytes                                                                |
| `config/pi-live/notices/**`                                                | `notices/**`          | Exact texts, manifest, metadata, and modes                                 |
| `config/pi-live/THIRD_PARTY_NOTICES.md`                                    | Root notice summary   | Preserve facts; change only obsolete ownership/path references if needed   |
| `config/pi-live/PROVENANCE.md`                                             | Root provenance       | Adapt current claims; retain source/native identities and residuals        |
| `config/pi-live/package.json`, `config/pi-live/pnpm-lock.yaml`             | Root package and lock | Seed from originals; apply only declared standalone tooling changes        |
| `upstream/pi-live/**`, `upstream/pi-live.lock.json`                        | Same paths            | Exact bytes and modes; exclude snapshot tests from the active test command |

Keep Pi/TUI development compatibility at 0.87.1, Node >=22.19.0, pnpm 11.8.0,
and the reviewed runtime/native pins. Runtime Pi imports remain wildcard peers;
production installation must not bring its own Pi/TUI. Transfer existing
TypeScript, Node types, and formatter tooling using their existing exact pins,
not upgrades or additional frameworks. Declare any tooling dependency additions
before installation; use pnpm to generate lock changes rather than hand editing.
Keep install lifecycle hooks absent and dependency scripts disabled. Pass the
explicit `--config.auto-install-peers=false` flag; `.npmrc` alone did not enforce
that policy in the original pnpm trial.

The old full-lock hash describes the old manifest. If standalone development
metadata changes the generated lock, record the new hash and verify that the
production graph and native identity did not change; do not keep an obsolete
whole-lock hash as a current guarantee.

**Done when:** every copied file is accounted for as exact or intentionally
adapted; exact snapshots and notices verify; only one implementation is loaded;
no native binary, archive, dependencies, credentials, or session data is tracked.

## 2. Retain focused checks, remove installer coupling

Transfer these scripts and their tests:

- `import-pi-live.ts` and `import-pi-live.test.ts`.
- `pi-live.test.ts`, `pi-live-preferences.test.ts`, and
  `pi-live-compatibility.test.ts`.
- The package/notice checks from `check-pi-live.ts`, `check-pi-live.test.ts`, and
  `pi-live-package.ts`.
- `check-pi-live-loader.ts` and `pi-live-loader-probe.ts`.

Change runtime imports and fixture paths from `config/pi-live` to the root
package. The source importer can retain its `scripts/` and `upstream/` paths.
Keep its offline verification and explicit local-source import behavior.

Reduce `pi-live-package.ts` to package-owned checks. Remove dotfiles transaction
types, revision-home paths, host profiles, rollout planning, and provisioning.
Retain dependency/native verification needed by the disposable production test;
do not replace it with the mere existence of `node_modules`.

The loader checker currently imports `readEntry` from `rollout-files.ts`.
Replace that dependency with a narrow payload fingerprint rather than copying
the transaction module. Its production (`present`) mode currently relies on an
external caller checking dependency closure before and after loading. The new
test owner must perform those checks. Test a clean package copy outside the
repository dependency tree; a developer checkout with ambient Pi peers is not
production-loading evidence.

Allow development files in the repository root while validating the intended
package payload separately. Preserve the exact notice inventory. Do not rebuild
a whole-repository inventory policy or a new deployment system.

Leave these behind:

- `pi-capabilities.ts`, rollout scripts and their host/transaction tests.
- `hosts/mba.json`, dotfiles settings, launchers and root tooling configuration.
- The dotfiles `PI-LIVE.md` installer procedure; replace it with a small
  standalone development README, not a port of plan/apply/setup/recovery.
- Dotfiles-only GitHub checks, runner policy, no-mistakes configuration, and
  unrelated dependencies.

**Done when:** package tests and checks run from `pi-live` without importing,
reading configuration from, or depending on the dotfiles checkout.

## 3. Transfer context without importing obsolete intent

Create a concise current `docs/DESIGN.md`. Distinguish implemented behavior,
accepted decisions, proposed future behavior, and unverified claims. Link to
historical reports only where they inform a future decision.

Inventory this bounded set from the local research directory:

- `SPEC.md`, `FEASIBILITY.md`, `NATIVE-AUDIT.md`,
  `TIKTOKEN-TABLE-RIGHTS-RESEARCH.md`, `OBJC2-APPLE-SDK-RIGHTS-RESEARCH.md`,
  `README.md`, and `TICKETS.md`.
- All files in `probes/`, `reviews/`, `harnesses/`, `verification/`, and
  `evidence/`.

Record their source paths and hashes before changing anything. The existing
research tree is about 1.3 MB, including about 872 KB of rights evidence. Inspect
for secrets, personal state, and redistribution terms before publication. Keep
vetted files byte-for-byte beneath `docs/history/extraction/original/`; the new
archive index identifies their historical status. Unpublishable raw captures go
to the private local `/Users/skhl/.local/share/pi-live-transfer/evidence/`, with
identity and custody recorded in the transfer receipt. Preserve original
receipt hashes; do not silently redact a file and retain its old identity.
Do not import native archives or the gigabyte-scale registry/source audit corpus.
Historical harnesses with absolute external paths stay labeled archival, not
runnable standalone tests.

Put historical text behind a clear archive index. Its old statements that
"dotfiles owns this", "no new repository is needed", "G0 remains blocked", or
"no PR exists" are not current instructions. Record the later operator decisions
and current commit-specific evidence in the owning current documents. Do not
rewrite historical receipts to make them describe the new package.

Carry forward these distinctions:

- The operator accepted documented native notice/provenance and objc2/Apple
  uncertainties for personal/open-source use. The exact native dependency stays
  npm-fetched; its binary is not committed, mirrored, or republished. Preserve
  gathered notices and qualifications. This is not legal clearance or a complete
  target-specific SBOM. Keep the new repository private unless separately asked.
- The package is inert: discovery, commands, preferences, and presentation exist;
  voice calls, auth/transport, ownership, microphone/speakers and service support
  are not implemented by this transfer.
- Earlier green receipts belong to earlier revisions. The recovered CI repair
  and new layout need fresh verification. The latest package's actual TUI surface
  was not exercised in the cancelled delivery run.
- The concurrent-writer test was weakened by the old pipeline. Preserve this
  limitation visibly. A passing valid-file test does not prove retry or
  no-lost-update behavior. Add deterministic coverage for observed-conflict retry
  before claiming that property; if that requires broader coordination semantics,
  ask whether the user wants them rather than silently adding locks or weakening
  the contract. Do not bundle a preference-system redesign into the transfer.
- The accepted shortcut-dialog reporting limitation remains relevant to future
  live behavior. Historical proposed runtime requirements are not implementation
  authorization.

**Done when:** the new repository explains what exists and what is still owed
without relying on untracked dotfiles notes. Each selected historical file has
an explicit repository or private-local custody entry; local-only evidence is
not advertised as recipient-verifiable. Old approvals are not new runtime or
canary approvals.

## 4. Verify the standalone result

Run checks in disposable environments with empty credential stores. Registry
fetches for an authorized scripts-disabled dependency restore are separate from
network-denied extension execution.

1. Hash-check the copy/adaptation receipt, upstream snapshot, original license
   texts, and all notice files. Prove the byte guard rejects one deliberate
   mutation in a disposable fixture.
2. Run the standalone typecheck, formatter, focused behavioral tests and
   importer/package checks. Preserve tests and report inherited coverage gaps.
3. Perform a frozen production install in an isolated package copy with scripts
   and automatic peer installation disabled. Verify the same nine runtime
   packages, absent private Pi/TUI, and exact native package/member hashes.
4. On macOS arm64, use the real pinned Pi loader under denied network, child
   processes, and non-scratch writes, with native addons disabled. Verify inert
   registrations and unchanged protected fixture state. Loading a real addon is
   not part of this test.
5. Exercise `/live`, status, start, stop, and voice selection in an isolated actual
   Pi TUI without provider credentials or a model turn. Confirm setup-only/off
   presentation and private preference behavior. Capture the surface; if it
   cannot be exercised, report the gap and ask for a waiver instead of claiming
   visual verification.
6. Keep portable tests separate from the macOS sandbox check. Linux CI may
   simulate platform metadata for deterministic refusal/preflight cases, but
   must not report that as real macOS/native support. Run the supported-host
   receipt on macOS. Dotfiles' repaired rollout/capability tests are not moved;
   rerunning the old CI suite is not a transfer requirement.

**Done when:** fresh receipts identify the new commit and dependency graph, all
required checks pass or explicit limitations/waivers are recorded, and dotfiles
and the real home remain unchanged. This establishes a standalone inert
extension, not a useful voice feature or adoption readiness.

## 5. Handoff

The transfer ends with a verified local standalone branch, its receipts, and an
honest list of remaining runtime work. Keep all dotfiles issues and PR #522
untouched. Historical issue links preserve context; moving or closing those
issues is not required to develop here. The old provisioning/adoption tickets
are not obligations to rebuild dotfiles integration in this repository.

Ask separately before publishing the extraction branch or opening its PR.
Repository-owned CI and delivery configuration belong to that delivery step,
not to recreating dotfiles' infrastructure during extraction. Keep main
protected, preserve the user's merge control, and do not restart the cancelled
no-mistakes run. If a future delivery tool automatically restarts review after
CI repair, surface that policy before starting it; do not promise an unsupported
override or change global settings.

No issue transfer, PR closure, dotfiles record, publication, native/device trial,
or artifact deletion is part of this planning turn.
