# Recovery

Failure codes, the stuck-lock procedure and going back to a previous version.

- **Setup refused:** the message says why, for example a folder that is not
  yours, is reached through a link, or is not on a local disk. Fix that and run
  `/live setup` again.
- **Start failed:** use `/live status` to see compatibility and the last failure
  code. For `missing-auth`, check Pi's `openai` API key; for unsupported
  compatibility, restore the checked Node, Pi and dependency versions listed in
  [the README](../README.md#before-you-start).
  For `denied` or `audio-error`, check consent and the terminal's microphone
  permission. For `connect-timeout` or `protocol-error`, check network/proxy
  access and service availability. Quit this Pi invocation after a failed start,
  correct the cause, then explicitly load the checked version again. If the
  failure persists, leave Pi Live unloaded or choose a previously verified
  version. A retained lock requires the manual recovery below.
- **`cleanup-blocked`:** this Pi process cannot start another call. Quit Pi.
  If a new Pi then reports `busy` while no other Pi has a call running, the lock
  was left behind: remove `~/.local/state/pi-live/active.lock/owner.json`, then
  the `active.lock` folder. Behind an HTTPS proxy this happens after every
  call. Pi Live never automatically recovers a retained lock; normal confirmed
  shutdown removes the call's own lock.
- **Going back:** start Pi outside this checkout's root without `-e`, or with
  `--no-approve`, to stop using Pi Live. To use an earlier
  version, check out its tag and restore dependencies with the install command in
  [the README](../README.md#install). Before
  v0.1.0 there is no earlier supported version.

Pi Live never deletes its state folder, preferences (`pi-live/config.json` in
Pi's agent directory), prior checkouts or pnpm caches. Remove them by hand if
you no longer need them.

See [setup and readiness verification](ISSUE-6-VERIFICATION.md),
[delegation/control verification](ISSUE-5-VERIFICATION.md),
[transport limits](ISSUE-4-VERIFICATION.md), and
[lifecycle verification](ISSUE-3-VERIFICATION.md). The author adopted
`v0.1.0` for personal use on a MacBook Air after the
[canary](ISSUE-7-VERIFICATION.md), with the real
denied-microphone-permission check explicitly waived. Loading is explicit; there
is no global registration or installer.

The preference writer uses an optimistic read/compare/retry sequence and atomic
same-directory rename. That does **not** guarantee that every concurrent change
is preserved: another writer can still win after the final observation. A deterministic regression covers a competing update observed before the final
comparison; the design makes no general compare-and-swap claim.
