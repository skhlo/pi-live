# Extraction research archive

This directory preserves selected pre-extraction research as historical evidence.
The files under `original/` are exact source bytes; they were not rewritten to
match the standalone repository.

## Read this first

The originals contain obsolete instructions and status claims. In particular:

- dotfiles no longer owns Pi Live development;
- the statement that no new repository is needed is superseded;
- the evidence-only G0 stop was later removed by the operator's documented
  residual-risk acceptance, not by legal clearance;
- old no-push/no-PR statements describe their original research turns and are
  not current delivery policy; and
- old green receipts verify only their recorded source revisions, absolute
  layouts, and harnesses.

The current sources of truth are the root `README.md`, `PROVENANCE.md`,
`THIRD_PARTY_NOTICES.md`, and `docs/DESIGN.md`. The archive does not authorize
implementation, installation, native/audio/device use, authentication, provider
access, issue migration, rollout, publication, or adoption.

## Repository-retained originals

The 32 retained files comprise:

- `original/SPEC.md`, `FEASIBILITY.md`, `NATIVE-AUDIT.md`,
  `TIKTOKEN-TABLE-RIGHTS-RESEARCH.md`,
  `OBJC2-APPLE-SDK-RIGHTS-RESEARCH.md`, `README.md`, and `TICKETS.md`;
- five reports in `original/probes/`;
- four reviews in `original/reviews/`;
- eight archival harness files in `original/harnesses/`; and
- eight historical logs, scripts, and receipts in `original/verification/`.

The harnesses retain absolute paths to old temporary checkouts and dependencies.
They are not runnable standalone tests. Verification logs contain synthetic
session identifiers and historical temporary paths, not current user sessions.
A bounded review found no credential or private authentication material in the
repository-retained set. Historical absolute paths remain unchanged because
rewriting them would invalidate the original evidence identity.

## Private custody exclusions

Twenty-nine files below the source `evidence/` tree were not placed in the
repository. They are retained as exact private local copies. The exclusions
include Apple agreement PDFs/text for which the research found no affirmative
redistribution grant, plus unnecessary raw fetched GitHub/source/license payloads
whose relevant facts, author credits, and notice obligations are already carried
by the reports and repository notice corpus.

Those private captures are not recipient-verifiable repository evidence. Their
source-relative paths, original SHA-256 values, destinations, and exclusion
reasons are recorded in [`transfer-receipt.json`](transfer-receipt.json). The
private directory is `~/.local/share/pi-live-transfer/evidence/`; those records
do not include its raw contents. Public-source
names and attribution were not suppressed: current notices and the exact reports
retain the credits on which the package relies.

## Evidence boundary

The bounded source inventory contained 61 files and 1,188,859 bytes. All source
SHA-256 values were checked before copying. Repository originals and private
copies preserve their source bytes; no historical original was redacted and
then presented under its prior hash.

No source was fetched during this transfer.
