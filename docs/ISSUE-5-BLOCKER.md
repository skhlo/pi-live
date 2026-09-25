# Issue #5 - final context cannot be fully observed

Status: spec decision required; automatic final forwarding is not accepted for
delivery. The candidate is local only, and the default home certifier still
prevents real call setup. No push, PR, real provider or media access occurred.

## Reproduction

The fresh-context code review found an actual Pi 0.87.1 counterexample:

1. Pi Live admits one voice request and observes its exact custom receipt.
2. An after-loaded extension's public `context_with_system` handler returns a
   new message list containing additional user input.
3. The fake provider observes that input. The persisted branch remains unchanged.
4. The candidate forwards the assistant's final and leaves voice active.

`scripts/pi-live-delegation-sdk.test.ts` retains the regression in both load
orders. The earlier-handler case is detected; the later-handler case fails its
expected empty-output assertion. The provider fixture records its actual inputs,
so this is not a mocked event-order assumption. The run used empty fixture homes,
fake credentials/media, `--no-addons` and OS network denial.

## Public SDK limit

Pi 0.87.1's context dispatcher invokes handlers sequentially. Each later
`context_with_system` handler may replace the complete message list. It returns
that final list directly to the agent's request transform; there is no public
post-transform observation event. `before_provider_request` has the same
later-handler replacement property, as well as provider-specific payloads.

Retaining an earlier array reference or scheduling a microtask does not observe
a later replacement array. Checking persisted branch entries cannot reveal an
unpersisted edit. Registering last cannot be guaranteed through the extension API.
Inspecting or patching private runner state, replacing the provider/model, or
claiming a complete extension inventory is outside the contract.

This violates the issue's requirements that unknown model-visible input and
ambiguous context edits invalidate forwarding. Its stop condition requires a
return to spec review rather than delivery of ambiguous results. The original
408-test/terminal receipts missed this case and do not close the ownership gate.

## Decision options

- Keep automatic final forwarding disabled, retaining controls and coding
  delegation while coding output stays in Pi. This narrows issue #5's outcome.
- Amend the contract to require explicit confirmation before sharing a final.
  Specify the dialog, exact text being approved, and voice behavior while it is
  open; the existing own-consent-only exemption cannot silently be widened.
- Wait for a public SDK observation of the final effective model input, after
  all extension transformations, before claiming automatic ownership proof.

The user has been asked to select the intended outcome. No option has been
treated as approved by elapsed time. Until then, the failing regression and
candidate are preserved for review; automatic forwarding must not be published
or adopted.

## Other review findings

Configured package-source detection was present only as an injected fixture fact.
The correction wires the shipped dependency factory to bounded snapshots of
global and trusted-project settings, using public `SettingsManager.fromStorage`
parsing without file-locking or writes. Both scope/load-order combinations are
tested through `registerPiLive`. The reviewer also reported optional duplicated
completion predicates and handler-list expectations; no hard standards violation
was found.
