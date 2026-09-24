# Pi live extraction research

Start with [the hardened extraction spec](SPEC.md). It is a reviewed proposal,
not implementation, runtime installation, microphone permission or delivery
approval.

Five Luna/max scouts and probes examined lifecycle, microphone ownership,
transport/privacy, extraction/rollout, and exact Pi 0.87.1 contracts. A Luna
challenge and independent reviewer completed two rounds; their final reports
are in [reviews/](reviews/). The spec separates reproduced source defects,
static risks, proposed behavior and unexecuted acceptance gates.

Recommended v1 differs from upstream: no automatic focus handoff, a render-only
widget, single-flight idle-only delegation, final-only result sharing, and
Pi-owned credentials. Other extension dialogs end the call rather than letting
voice interfere with approval input. These changes need user approval.

## Evidence

- [Probe reports](probes/)
- [Final Luna review](reviews/luna-final.md)
- [Final independent review](reviews/independent-final.md)
- `verification/receipt.json` - parent's recorded network-denied reruns,
  command/exit receipts, hashes and the successful EPERM guard
- `harnesses/` - retained fake-only source probes; their original absolute paths
  and existing dependency checkout remain necessary to run them unchanged

The copied harnesses are archival evidence, not production code or completed
extraction acceptance tests. The original runnable layout is
`/tmp/dotfiles-pi-live-spec/preview/live-spec/`; source and installed test
prerequisites are at `/tmp/pi-better-openai.qnz8hk`. No new dependency or runtime
was installed in this research turn.

An early transport mock failed to intercept a request using synthetic credentials;
connection success was not established. No real credential/audio was used.
That run is excluded. Final parent reruns used OS-level network denial and empty
auth homes, not mocks alone. The transport report and spec retain the caveat.

## Retained work

Research branch/worktree: `docs/pi-live-extraction-spec` at
`/tmp/dotfiles-pi-live-spec`, based on current origin/main
`de9bab8a4f2cdb7c13650c43920545a544af41da`. No tracked source changes, commits,
pushes or running task processes. The primary checkout remains on main.

The handoff copy is under
`/Users/skhl/dotfiles/docs/research/harnesses/pi/live-extraction/`.
This directory follows the repository's ignored, local-only research convention;
it will not reach GitHub unless an approved contract is deliberately promoted.
