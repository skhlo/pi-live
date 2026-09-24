# Pi Live provenance and residual record

This record identifies the source and dependency boundary of the private,
setup-only extraction. It does not claim legal clearance, a complete
platform-specific SBOM, a reproduced native build, live-service support, or
successful native/audio use.

## Extraction source

The standalone repository was seeded from `skhlo/dotfiles` (repository ID
`1228109764`) at local commit
`db2c57f13c274d66d79287fda8de177c016f0c02` on the retained
`feat/pi-live-package` branch. That commit contains unpublished work and must not
be described as available from GitHub.

The initial mapping was:

- `config/pi-live/index.ts` -> `index.ts`
- `config/pi-live/src/**` -> `src/**`
- package license, notices, manifest, and lock -> repository root
- `upstream/pi-live/**` and `upstream/pi-live.lock.json` -> the same paths
- focused checks -> `scripts/**`, with dotfiles paths and rollout coupling
  removed for the standalone layout

`index.ts`, `src/**`, `LICENSE`, `UPSTREAM_THIRD_PARTY_NOTICES.md`, the upstream
snapshot, and the gathered notice corpus were seeded as exact bytes. The root
manifest, lock, scripts, and current documentation are standalone adaptations.
[The extraction receipt](docs/history/extraction/transfer-receipt.json), not this
narrative, owns the complete exact/adapted file inventory and initial hashes. Inline Git history before extraction remains
in the retained source branch rather than this repository.

## Extracted upstream extension

- Repository: <https://github.com/monotykamary/pi-better-openai>
- Commit: `39171682343754366439b2c0890f5b0f4c3ed891`
- Tree: `3aea19fabc79a2ec8f00469edc97b668b246ec94`
- Version: `0.2.6`
- Maintainer: monotykamary
- Original contributor credited upstream: Matt Leong
- Immutable selected snapshot: `upstream/pi-live/`
- Snapshot receipt: `upstream/pi-live.lock.json`
- Exact `LICENSE` SHA-256:
  `1126322e2cc8d165adc4c792eeb195717de2bcc7b39be1ce77959d78e87ef685`
- Exact `UPSTREAM_THIRD_PARTY_NOTICES.md` SHA-256:
  `58f8d237355fafb7832f9ad4e418aacd248223fd7818c36c00111da48caa279a`

The snapshot is provenance material and is never runtime-loaded.

## Dependency boundary

Runtime pins remain exact:

- `https-proxy-agent@9.1.0`
- `proxy-from-env@2.1.0`
- `undici@8.10.0`
- `ws@8.21.2`
- optional `@oh-my-pi/pi-natives-darwin-arm64@17.2.9`

Pi and TUI are wildcard runtime peers; standalone development pins both to
`0.87.1`. Development tooling remains `@types/node@22.19.19`,
`prettier@3.9.6`, and `typescript@5.9.3`, with Node >=22.19.0 and
`pnpm@11.8.0`.

The root lock was regenerated for standalone development metadata with automatic
peer installation disabled. The old full-lock SHA-256
`5592ea11b80d66ef9d230b021903458d2de8360c28461d4a9a1b220bce0770ba`
describes only the historical dotfiles package and its historical receipt. It is
not a current-root guarantee. The standalone full-lock SHA-256 is
`7230a1cf633b74dc0fe3d7b6ec014f66edb636623a92e060dd75d0adf9d9e597`.
The disposable production check verifies the same nine-package graph, absent
private Pi/TUI, disabled installation scripts, and exact native identity. The
production-lock hash remains
`f179cf0d853740aac7469e0ea3a41ae222e4d83d51c6e1a3efa6da88ada6d846`.
Development script invocation also needs explicit automatic-peer and ignored-script
policy, as documented in the README; bare pnpm can rewrite the full lock.

## Native npm artifact

- Package: `@oh-my-pi/pi-natives-darwin-arm64@17.2.9`
- Registry tarball:
  <https://registry.npmjs.org/@oh-my-pi/pi-natives-darwin-arm64/-/pi-natives-darwin-arm64-17.2.9.tgz>
- Tarball SRI:
  `sha512-9Fmi4mXtybtKJ8WiVUMjhuVOFQOIHeE8wmxACT9h+OS/17UYC/xvYPWcGtUqbqI7RUIOqJl9gJxY8G7lsLNLug==`
- Tarball SHA-256:
  `f9df6f01bd00a3a9f685cd87341b691699b409906767f8c75a0eb53b516cc7da`
- Tarball size: `26761088` bytes
- Native member: `package/pi_natives.darwin-arm64.node`
- Native member SHA-256:
  `35bbb69631c88b2691941a1df660eac3416e43cbef6ed0309a4742defde51cf4`
- Native member size: `144799744` bytes
- Manifest SHA-256:
  `9e985ae0ee2cd229326f9d1fed99ca0341a324720c96fcc2e123eaea4f97a44e`
- README SHA-256:
  `ee2db3b14282526ae7333398352640afd2f7a84b0c96d43e1eb97340e930498b`

The tarball contains its manifest, README, and native binary, but no standalone
license or third-party notice bundle. The binary and tarball are not committed,
mirrored, or republished here.

Publisher-attested source correspondence points to
`can1357/oh-my-pi@f7f8e040ee04710414fbd775431091fa301b9786` (`v17.2.9`), workflow
`.github/workflows/ci.yml`, Actions run `30965471779` attempt 1, Darwin-arm64
build job `92178406852`, and native-leaf publish job `92181848147`. This is not
an independently reproduced build. The release artifact had expired, and the
full Fulcio/Rekor chain and inclusion proof were not independently verified.

## Notices and accepted residuals

`notices/NOTICE-MANIFEST.json` binds 52 gathered exact texts and source headers;
its SHA-256 is
`3a674e1b218af8db3630e85dd0c468cdd39f09b4832010ee76e65f811b2bbdf2`.
The corpus preserves known resource and native-component attribution, including
public-source author names. Whole-file matches for selected embedded resources
do not prove the complete linked dependency graph.

On 2026-09-24 the operator accepted the documented notice/provenance residuals
for personal and open-source use, subject to the exact native pin, npm-only
fetching during separately authorized provisioning, no binary/tarball
republication, preserved notices and qualifications, and renewed review after a
source, pin, distribution-model, or visibility change. Accepted residuals
include objc2/Apple SDK-generated-binding uncertainty, pin-specific historical
attribution limits, remaining dependency/resource notice gaps, the absent
platform-specific linked SBOM, the expired build artifact, and bounded
attestation verification.

That decision removed the historical evidence-only G0 stop. It is accepted
residual risk, not legal advice, legal clearance, or proof that the corpus is a
complete target-specific SBOM. `THIRD_PARTY_NOTICES.md` remains the current
summary of obligations and qualifications.

## Historical research custody

Thirty-two authored research, probe, review, harness, and verification artifacts
are retained byte-for-byte under `docs/history/extraction/original/`. The archive
index marks their old ownership, gate, delivery, and absolute-path statements as
historical. Raw fetched payloads, including Apple agreement captures, remain in
private local custody and are not recipient-verifiable repository evidence.

## Current verification boundary

Earlier receipts verify earlier revisions and layouts only. Fresh source,
package, loader, production, transfer, test, typecheck, formatting, and isolated
TUI results are recorded in [the verification summary](docs/VERIFICATION.md),
with command/output receipts retained locally. Extraction byte identity is not
proof of a working voice runtime.

This extraction does not authorize home installation, extension registration,
native import, microphone or speaker access, DeviceCheck, authentication,
provider calls, rollout, or adoption.
