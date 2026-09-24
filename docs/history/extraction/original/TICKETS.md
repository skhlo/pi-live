# Pi live extraction - GitHub work map

[Parent #513](https://github.com/skhlo/dotfiles/issues/513) preserves the complete
current contract snapshot and owns the work map. The initial SPEC SHA-256 at publication
is `c916307ee41e6dd0057b6632ee525beb7e72b23cd4d73687fa43bbb8077d4996`.

Native sub-issues and dependencies:

1. [#514 - SDK, TUI and package-loading feasibility](https://github.com/skhlo/dotfiles/issues/514)
2. [#515 - Pinned package, provenance and inert loading](https://github.com/skhlo/dotfiles/issues/515)
3. [#516 - Exclusive call ownership and fenced cleanup](https://github.com/skhlo/dotfiles/issues/516)
4. [#517 - Auth, media transport and privacy budgets](https://github.com/skhlo/dotfiles/issues/517)
5. [#518 - Pi delegation and approval-safe controls](https://github.com/skhlo/dotfiles/issues/518)
6. [#519 - Live-only provisioning and recovery](https://github.com/skhlo/dotfiles/issues/519)
7. [#520 - Authorized MBA canary and adoption decision](https://github.com/skhlo/dotfiles/issues/520)

Each package is blocked by its predecessor; the issue bodies additionally require
accepted evidence and explicit scope approval. Closing an issue is not approval.
Ticket creation does not authorize implementation, installation, native/device or
service/audio access, rollout, push or PR. The operator subsequently authorized
bounded feasibility and a disposable frozen install. [The result](FEASIBILITY.md)
now recommends proceeding to separately authorized extraction under the accepted
shortcut-dialog exception and explicit pnpm peer-policy flag. The operator accepted
#514 and authorized #515. The [native audit](NATIVE-AUDIT.md) now blocks #515 at G0:
source pairing is identified, but the complete target-specific notice inventory
is not established. Later implementation and rollout remain unapproved.

Inspected body files, source hash, published-body readbacks and native-graph
verification are retained under `preview/pi-live-tickets/` in the primary checkout.
No implementation probes or canary ran during ticket publication; no task-owned
persistent process was started.
