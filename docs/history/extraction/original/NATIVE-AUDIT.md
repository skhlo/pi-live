# #515 native provenance and notices - G0 blocked

2026-09-24. The user accepted #514 and authorized #515. Two verified Sol 6 xhigh
workers performed read-only primary-source audits; the parent independently
checked the evidence below. No package implementation or native adoption began.

## What is established

The exact npm `@oh-my-pi/pi-natives-darwin-arm64@17.2.9` tarball matches the frozen
fixture's integrity and native binary:

- Tarball SRI:
  `sha512-9Fmi4mXtybtKJ8WiVUMjhuVOFQOIHeE8wmxACT9h+OS/17UYC/xvYPWcGtUqbqI7RUIOqJl9gJxY8G7lsLNLug==`.
- Native `.node` SHA-256:
  `35bbb69631c88b2691941a1df660eac3416e43cbef6ed0309a4742defde51cf4`.
- Publisher-attested source:
  [`can1357/oh-my-pi@f7f8e040ee04710414fbd775431091fa301b9786`](https://github.com/can1357/oh-my-pi/tree/f7f8e040ee04710414fbd775431091fa301b9786),
  also the `v17.2.9` tag, through successful
  [CI run 30965471779](https://github.com/can1357/oh-my-pi/actions/runs/30965471779).
  The corresponding source package declares 17.2.9.

The parent independently retrieved npm metadata/provenance and the pinned workflow,
verified the registry signature using the registry key and the DSSE signature using
the supplied certificate, and matched the attestation's tarball digest. This is
publisher-attested source correspondence, not a reproduced build or independent
Fulcio/Rekor chain verification. The original Actions addon artifact has expired,
so no direct archived build-output byte comparison was made. Those limits are
reported, not silently turned into a new mandatory reproducible-build requirement.

Primary metadata:
[npm version](https://registry.npmjs.org/@oh-my-pi%2fpi-natives-darwin-arm64/17.2.9),
[npm attestations](https://registry.npmjs.org/-/npm/v1/attestations/@oh-my-pi%2fpi-natives-darwin-arm64@17.2.9).

## What blocks G0

The npm tarball contains only `package.json`, `README.md` and the native binary.
It has no standalone LICENSE or third-party notice bundle. The pinned
[leaf generator](https://github.com/can1357/oh-my-pi/blob/f7f8e040ee04710414fbd775431091fa301b9786/packages/natives/scripts/gen-npm-packages.ts)
explains that packaging choice.

This is a monolithic addon, not a voice-only binary. Parent byte comparisons
confirmed five whole font data files and three whole syntax definitions embedded
in the installed `.node`. In particular, `Silver.ttf` matches at offset 31,662,128;
its adjacent pinned
[Silver.LICENSE](https://github.com/can1357/oh-my-pi/blob/f7f8e040ee04710414fbd775431091fa301b9786/crates/pi-natives/src/fonts/Silver.LICENSE)
declares **CC BY 4.0**, with Poppy Works / Wolfgang Wozniak and contributor credits.
The Julia/Nix/Mermaid definitions have their own MIT attributions. Source/build
inspection also identifies native C and Rust obligations beyond the root MIT
text, including Opus, miniaudio, PCRE2/SLJIT and WebRTC's dependency graph.

Known texts were retained, but their presence does not establish a **complete
macOS-arm64 compiled-code notice inventory**. The workspace Cargo.lock covers
927 packages/multiple targets, not an addon-only composition record. The bounded
audit did not resolve the entire target/build-feature closure and all corresponding
Rust, C, vendored code and resource notices. No complete source-matched target
notice bundle/SBOM was found among the pinned tree, release assets or npm leaf.

Therefore **G0 remains blocked** under the agreed spec. This is an evidence and
packaging gate, not a legal finding that a license forbids the feature or that the
upstream package infringes. Adding only the known font and root MIT notices would
not close the missing inventory. A new adapter cannot close it either.

## Work needed to unblock

Obtain or establish a source/release-matched Darwin-arm64 dependency/resource
closure and complete notice texts/attributions, then include a clear delivery path
for that bundle alongside the installed binary. An independently checkable
upstream bundle for this version is the smallest next step. A locally assembled
bundle still needs the complete target evidence; do not infer it from SPDX names
or a workspace lock alone.

No upstream issue was posted. A concise request would be:

> For `@oh-my-pi/pi-natives-darwin-arm64@17.2.9`, is there a target-specific
> third-party notice/SBOM bundle matching source `f7f8e040...` and native SHA-256
> `35bbb696...51cf4`? The npm leaf contains the binary, README and manifest only.
> The matching binary includes Silver.ttf (CC BY 4.0 in the pinned source) and
> syntax resources, and the native build has additional Rust/C dependencies.
> Could you provide the corresponding complete notices and target inventory, and
> include a notice delivery path in the native leaf packages?

Do not upgrade the native pin, rebuild with a new toolchain, relax G0, install new
build tooling or contact the voice service as an incidental workaround. Any such
scope change needs review. No live credentials, DeviceCheck, microphone/speaker
or native export was accessed during this audit.

## Local follow-up: conservative inventory still blocked

The user chose to keep the follow-up local rather than post the prepared upstream
request. Four further Sol 6 xhigh audits and parent verification tested whether a
complete source/release-matched **build-input superset** could close the notice
gate without claiming an exact linked SBOM.

The follow-up checksum-verified all 869 Cargo-lock registry archives and found
that checked-in `MODULE.bazel.lock` differs on 15 versions. Including those
additional verified archives makes the conservative registry identity union 884,
plus 58 workspace identities. The exact first-party snapshot now covers all 6,249
Git blobs. All 56 lock-selected tree-sitter grammar sources and notices were
inventoried. The pinned Rust nightly std/source/compiler notices were collected,
and static Mach-O inspection found 26 direct loads, all macOS system libraries
rather than packaged non-system dylibs.

Several gaps were narrowed: tree-sitter-just has an affirmative Apache source
path despite contrary MIT metadata, and the byte-proved syntect packdump is
bounded to 74 pinned grammar-source candidates with its original exception
notices. Of 61 zero-archive-notice registry packages assigned to exact-source
supplementation, 25 gained source-bound full texts and 36 remain open. Grammar
metadata/source conflicts, generated-parser provenance, the effective Bazel
repository graph and notice delivery also remain incomplete.

A subsequent local-only primary-source pass found the tokenizer-table scope bridge
missed by the first audit. OpenAI/tiktoken issue #92 explicitly asked about
external encoding blobs including `cl100k_base`; repository collaborator
`hauntsaninja` answered that the repository license applies to encoding files and
immediately closed the issue. The same identity, using `shantanu@openai.com`,
later committed `o200k_base` as an encoding with its exact public URL/hash while
the repository remained MIT-licensed. For this evidence policy, that supplies a
qualified MIT path for both exact tables. Preserve the mutable comment receipt,
commit-pinned MIT text, downstream credit and table hashes; reopen on source or
statement change. This is not a legal-compliance opinion.

The next local pass found a different decisive blocker. Twenty-seven lock-selected
`madsmtm/objc2` packages derive Rust bindings from Apple SDK headers/metadata, and
the pinned upstream `LICENSE.md` says it is unclear whether distributing those
derived crates is allowed. A later owner commit supplies complete current
MIT/Apache/Zlib bodies, but does not clearly make its 2026 notices retroactive to
the pinned releases; inherited core-crate relicensing remains open. No inspected
Apple agreement or statement expressly authorizes distributing generated Rust
bindings derived from SDK material. The upstream owner discloses rather than
resolves that uncertainty.

Therefore G0 remains blocked. The smallest next input is an Apple-authored,
version-applicable classification/grant for generated SDK bindings or an explicit
human legal/risk decision on the retained terms. No upstream request was posted.
Local parent summary and receipt:
`/tmp/dotfiles-pi-live-feasibility/preview/pi-live-feasibility/native-local-parent/RESULT.md`
and `verification-receipt.json`. Table and Apple follow-up reports live beside
this file as `TIKTOKEN-TABLE-RIGHTS-RESEARCH.md` and
`OBJC2-APPLE-SDK-RIGHTS-RESEARCH.md`. The original parent verifier hashed 7,589
unique evidence files (1,140,607,222 bytes). No implementation, build, native
execution, install, device/service access or rollout followed.

## Operator disposition

On 2026-09-24 the operator accepted the documented native licensing/provenance
residuals for personal and open-source use. The extraction may proceed through
technical G0/G1 on these conditions:

- the exact native leaf remains a pinned dependency fetched from npm during
  provisioning;
- this repository does not commit, mirror or republish the `.node` binary;
- the package carries the complete known notices, hashes, provenance and explicit
  residual disclosures gathered here;
- no legal-clearance claim is made; a source, pin or distribution-model change
  reopens review; and
- repository visibility is unchanged unless the operator separately directs a
  visibility change.

This decision accepts the objc2/Apple uncertainty, pin-specific historical
attribution qualifications, and the other enumerated notice-closure gaps as
residual risk. It removes the evidence-only stop. It does not authorize
installed-home provisioning, native/device/service operation, rollout, push or
PR.

## Technical G0/G1 follow-up

The local `feat/pi-live-package` implementation at commit `18d0ed7` now passes
#515's remaining technical package and inert-loading gates:

- 24 exact Better OpenAI source/test/notice files are retained with Git blob,
  SHA-256, role and native provenance receipts; normal checking is offline and
  read-only, and the importer has no fetch/update/force path.
- The owned package contains 64 revision inputs, including a manifest-bound
  corpus of 52 gathered exact notice texts/source headers. Its byte-defined
  revision is `9c65c548f9a130b84f7bfed335b7a081333e4542eb4f498019462b7b8cf739f9`;
  exact `0644` modes are a separate enforced invariant.
- The frozen lock remains
  `5592ea11b80d66ef9d230b021903458d2de8360c28461d4a9a1b220bce0770ba`
  with `autoInstallPeers: false`. A disposable public-path setup installed the
  exact nine production packages with scripts disabled and no private Pi/TUI;
  production lock SHA-256 is
  `f179cf0d853740aac7469e0ea3a41ae222e4d83d51c6e1a3efa6da88ada6d846`.
- MBA-only live planning/apply is additive and versioned. Baseline,
  capabilities-only and `--only all` exclude it. Setup verifies in a sibling
  directory before atomic `node_modules` publication; check is read-only and
  emits only the explicit `pi -e` path.
- Pi 0.87.1 discovered only `/live`, the shifted shortcut, delegation renderer
  and shutdown listener under OS network/process/non-scratch-write denial with
  native addons disabled. No native import/export, authentication, device,
  audio or service operation occurred.
- Final retained checks passed: exact source check, typecheck, format, 193 tests,
  GitHub tests, `check:pi-live`, real Pi/MCP integration, focused unsupported
  host/Pi and missing-addon/closure negatives, and diff check.

Receipts are retained at
`/tmp/dotfiles-pi-live-package/preview/pi-live-final-install/receipt/` and
`preview/pi-live-final-checks/receipt/`; the successful disposable revision is
`/private/tmp/pi-live-final-CkFEVr`. Technical G0/G1 is complete for #515's inert
package scope. The branch is not pushed or installed into the real home, and
#516 lifecycle work has not started.

## Verification and retained artifacts

Initial parent verification passed: **182 evidence hashes, 94 commit-matched source files,
all eight whole-file binary embeddings**, tarball SRI/member inventory, registry
signature and provenance DSSE signature (with the trust limits above). These are
read/hash/crypto checks only; no native code was executed. The sibling audit also
checked eight lock-matched crate source archives and retains one mistaken extra
onig archive explicitly excluded from its conclusions.

- Audit reports and public evidence:
  `/tmp/dotfiles-pi-live-feasibility/preview/pi-live-feasibility/native-provenance/`
  and `native-notices/` (approximately 32 MB and 45 MB respectively).
- Parent proof script and receipt:
  `/tmp/dotfiles-pi-live-package/preview/pi-live-package/verify-native-evidence.ts`
  and `native-evidence-parent-receipt.json`, alongside independently fetched
  registry/workflow/source metadata and the conditional implementation plan.
- Implementation worktree `/tmp/dotfiles-pi-live-package`, branch
  `feat/pi-live-package`, base `de9bab8a4f2cdb7c13650c43920545a544af41da`.
  Tracked tree is clean; no config/pi-live, upstream/pi-live or node_modules was
  created there. No tests of an implementation were claimed.
- Previous feasibility/registry fixtures, old worktrees and the earlier disclosed
  unintended dependency tree remain untouched. No artifacts were deleted.
- Both audit workers and their dispatcher finished; no task-owned audit process
  remains. No build, new dependency installation, host change, commit, push, PR
  or rollout occurred in this phase.

#514 remains completed as accepted feasibility. #515 stays open and blocked at G0;
#516 onward cannot start from this audit. The earlier implementation estimate
excluded external provenance/notice delays and is not a delivery commitment.
