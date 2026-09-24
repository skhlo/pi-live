# Pi live feasibility - completed bounded probes, 2026-09-24

Issue: [#514](https://github.com/skhlo/dotfiles/issues/514), under
[parent #513](https://github.com/skhlo/dotfiles/issues/513).

**Recommendation: GO for a separately authorized extraction phase, under the
accepted shortcut-dialog limitation and explicit pnpm peer-policy flag.** No
production extraction, G0-G5 acceptance pass, real voice/media support or adoption
is claimed. The operator accepted this result and authorized #515 on 2026-09-24;
that package/provenance work starts with G0's native evidence, not a live call.
The subsequent [native audit](NATIVE-AUDIT.md) identifies the source pairing but
blocks #515 on the incomplete target-specific notice inventory. This does not
invalidate the bounded SDK/TUI/loader results below.

## Decisions and scope

The user authorized bounded feasibility with **Sol 6 xhigh**, then explicitly:

- Accepted and required disclosure that shortcut-opened dialogs may leave voice
  active. The stop/admission guarantee covers reported dialogs only; voice never
  answers or grants an approval.
- Approved a disposable fixture-only lock generation and frozen production
  installation, including necessary registry downloads, with scripts disabled.
  This was not installed-home provisioning or native/audio/service permission.

Six probe workers, two fresh reviewers and a dispatch smoke worker used
`openai-codex/gpt-6-sol:xhigh`. The parent verified actual Pi session/provider-request
model and thinking observations and assistant message model fields. No 5.6
substitution. Installed user profiles/defaults were unchanged; normal control-plane
authentication stayed Pi-owned, without credential copies or manual edits.

The task-local dispatcher derives the repository's patched launcher/persona via
`configurationBytes`. The builder lacks a per-task model option, so its script
substitutes only the approved model in task-local generated files and checks
source stability. It does not roll out a new installed profile.

## Evidence the parent independently verified

### Real SDK: 18 passing cases and one expected failing mutation

The final suite exercises actual Pi 0.87.1 public SDK operations with a deterministic
in-process provider, tools, in-memory credentials and local fixture sessions:

- Exact custom receipt -> real tool -> successful final -> `agent_settled`.
- Competing typed prompt, non-trigger custom append, continuation, context edit,
  compaction draft, abort/error, stopped-call final and tree navigation.
- Actual automatic retry, default threshold compaction and overflow recovery,
  observed through real recovery events and persisted entries, not fabricated
  lifecycle notifications.
- Real reload/new/fork/resume, refusal of an old successful final during a session
  replacement, and acceptance of a fresh receipt afterward.

The parent reran all 18 cases from an unchanged source copy, outside ambient
checkout dependencies, with fresh empty HOME/agent directories and OS network
denial. Removing the before-switch fence in a disposable source copy caused the
expected failure: the stale final was delivered. All 19 receipts passed hash,
status, isolation and EPERM-guard audits.

This establishes selected conservative correlation paths, not atomic admission
or universal isolation. The prototype's final-text/branch checks are not a
production identity binding. The extraction must establish interval/order/entry
ownership and test duplicate/deviating/missing receipts, timeouts, additional
queued-input races and finalized-message replacement before automatic forwarding.
The actual extraction still owes G3/G4a.

### Real TUI and Paseo: reported dialogs, disclosed exception, continued coding

Initial real PTY cases show the widget coexisting with ordinary editor input and
five reported command-dialog primitives, including consent cancellation/late Yes,
Unicode/resize, shifted toggle and teardown. A shortcut's real `ctx.ui.confirm()`
emits no `ui_prompt_start`; fake sends continue while it is pending, and No leaves
the fake call active. The parent independently reproduced that exception and a
command-dialog control that does stop delivery.

Follow-up PTY and actual Paseo captures display the session-ID and shortcut
warnings in consent/help. A voice-origin fixture request executes a harmless
in-process coding tool; explicit voice stop removes its timer/widget, then the
tool finishes with 42 and Pi renders its final normally. No fake sends occur after
stop; a later attempted send is rejected. The parent reran all three follow-up
slices and inspected the Paseo consent/help/final captures and event ordering.

Pi source confirms the distinction: `interactive-mode.js:1641-1685` supplies raw
shortcut UI, while `runner.js:318-359` wraps normal contexts. Missing shortcut
notification is separate from the microtask detection window for reported dialogs.
The user accepted the narrower contract; no private Pi patch, global key
interception, extra adapter or dialog-detection framework was added.

These are real TUI tests with fake media, not a G4b pass for an implemented
extraction. Pixel/cell correctness, every input/race combination and real audio
remain unproved.

### Frozen production package: nine packages, no private Pi/TUI

The authorized fresh fixture `/private/tmp/pi-live-frozen-FwKcAa` is outside all
checkouts. It installed the exact five candidate direct/optional packages and
four locked transitives: `agent-base@9.0.0`, `debug@4.4.3`, `ms@2.1.3` and
`proxy-agent-negotiate@1.1.0`. Production downloaded nine packages, reused zero and
installed no development tarballs; lock generation resolved 146 metadata entries.
Scripts were disabled on every install. Registry metadata cache/fetch breakdown
was not established.

The production tree has no private Pi coding-agent/TUI package and no links to the
upstream tree or outside its own node_modules. All 13 symlinks remain internal.
The exact installed Pi 0.87.1 loader supplies Pi/TUI imports for the inert entry.
The parent repeated frozen installation **offline under OS network denial**, with
an unchanged lock, then reran closure/SRI/store-index audits and the real loader
with fresh empty homes and an EPERM guard. No native addon was imported this round.

The initial bare command generated `autoInstallPeers: true` despite `.npmrc`.
pnpm 11.8 filters `.npmrc` to supported auth/network keys. Successful lock generation
and production install both require **`--config.auto-install-peers=false`**; full
and production locks then record false. The spec now assigns this policy to the
explicit flag, not an ineffective `.npmrc` or another configuration layer. The
old `.npmrc` and true-policy lock remain evidence; no production install ran under
the true policy. This is a correction enforcing the already-agreed policy, not a
new dependency or architecture.

The 17.2.9 native artifact matches the prior binary:
`35bbb69631c88b2691941a1df660eac3416e43cbef6ed0309a4742defde51cf4`.
That hash, tarball integrity and successful earlier Node export-shape inspection
**do not** resolve matching source/release, complete notices or native-device/close
support. Those remain G0/G5 gates. The earlier import invoked no exported function
or constructor, but opaque initialization was not certified device-free.

## Remaining gates and provisional estimate

No further feasibility blocker was observed at the tested SDK/TUI/loader seams.
Before adoption, the implementation still owes source/native provenance and
notices, inert loading, exclusive ownership and sticky uncertain cleanup, bounds
and privacy, production result correlation, the actual widget/dialog tests,
public installer preservation/rollback, and an explicitly authorized MBA native,
service and audio canary. Native closure or endpoint/data-policy failure can still
stop adoption or require a separately reviewed design. Mock success does not
waive any of these.

Parent planning estimate, not a delivery commitment:

| Work package                                 | Focused engineering days |
| -------------------------------------------- | ------------------------ |
| #515 package/extraction/provenance           | 0.5-1.5                  |
| #516 ownership/lifecycle                     | 1-2                      |
| #517 auth/transport/privacy                  | 1-2                      |
| #518 Pi adapter/result ownership/TUI         | 1-2                      |
| #519 provisioning/guide/integration          | 0.5-1.5                  |
| Total before the separately scheduled canary | 4-9                      |

This excludes external provenance/notice resolution delays and operator availability
for G5. Re-estimate if those checks change the design. The next bounded decision
was acceptance of this report and authorization for #515, now granted; it is not
blanket implementation or rollout approval.

## Instruction deviation and retained evidence

During the first SDK leg, `pnpm exec prettier --version` unexpectedly auto-installed
121 pinned dev packages in the worktree's ignored root node_modules despite the
no-install instruction. Output reported reused 121/downloaded 0, not proof of no
package-manager network activity. No manifest, lock or tracked file changed. The
parent disclosed this, retained the directory and moved independent verification
outside it. The later fixture-install approval **does not retroactively authorize
that action**. No cleanup or further installation scope is inferred.

Earlier failed fixture attempts are retained: a parent `/var` versus `/private/var`
environment assertion, a fake provider's abort-listener timing and summarizer
recognition, and PTY/terminal key-transport mistakes. They were corrected in probe
setup without deleting failing tests. An initial sandboxed Paseo prompt failed
with "No API key found" and is not counted as provider evidence. New provider/TUI/
loader probes used OS network denial, fake providers/media and empty credential
stores; permitted registry package fetching and Sol 6 control-plane calls were
separate. No real voice credential or device/service operation was intentionally
invoked. Disposable harnesses are not shipped checks; integrate owned TypeScript
checks through the later implementation issues.

Retained, with no task-owned worker/probe process remaining:

- `/tmp/dotfiles-pi-live-feasibility`, branch `feat/pi-live-feasibility`, base
  `de9bab8a4f2cdb7c13650c43920545a544af41da`; tracked tree clean. All initial and
  follow-up sources/reports/receipts are under its `preview/pi-live-feasibility/`.
- Parent SDK follow-up index: `parent-followup-sdk/latest-receipts.json`; audit
  reports 18 passes plus the expected failing mutation. Initial parent evidence
  remains in `parent-verification-PoYBTl/` and failed `parent-verification-wUSnXa/`.
- Parent package receipts: `/private/tmp/pi-live-frozen-FwKcAa/parent-prod-1790231866385.receipt.json`
  and `loader-repeat-1790231867286.receipt.json`, plus source, locks, store, audit
  and initial install receipts. Fixture uses approximately 312 MB.
- Parent TUI follow-up logs: `tui-followup/parent-{consent-help,shortcut-dialog,task-stop}.out`;
  actual Paseo captures: `tui-followup/runs/paseo-followup/`.
- Static independent reviews: `review/RESULT.md` and `review/FINAL.md`; final review
  recommends a conditional GO for separately authorized extraction, not adoption.
- The unexpected root node_modules (approximately 199 MB), isolated SDK temp
  fixtures indexed by the receipts, initial isolated loader fixtures, and old
  research/upstream worktrees remain. No artifacts were deleted.
- Both task Paseo terminals were stopped and the parent verified empty terminal
  lists for `wks_417a4d39b4c30062` and `wks_0c5bb94c500b322f`. Workspace metadata remains.
- Previous spec/report/issue-body snapshots and publication readbacks are retained
  in the primary checkout's `preview/pi-live-tickets/`.

No code was committed or pushed, no host live capability was installed, and no
G5 canary ran. Formatting, probe syntax/type checks where configured, real probe
runs and receipt audits own this phase's verification; repository implementation
checks remain obligations of the later source changes, not claimed results here.
