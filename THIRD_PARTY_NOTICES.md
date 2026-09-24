# Pi Live third-party notices

This is the bounded, owned notice and attribution summary for the private
`pi-live` package. The exact upstream extension notice is also carried,
byte-for-byte, as `UPSTREAM_THIRD_PARTY_NOTICES.md`. `PROVENANCE.md` binds these
notices to the reviewed source and native package.

`notices/NOTICE-MANIFEST.json` binds 52 exact full texts and source headers under
`notices/`. They are the complete gathered bounded corpus for byte-proved
resources, direct native components, the pinned Rust runtime, and accepted
residual evidence. This corpus is not a complete target-specific SBOM or
independent legal clearance. Unresolved rows remain disclosed below.

## Extracted extension and oh-my-pi

This package adapts the live design and voice list from
`monotykamary/pi-better-openai`, which credits original work by Matt Leong and is
maintained by monotykamary. Portions derive from `can1357/oh-my-pi`.

MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The exact extracted extension license is `LICENSE`. The source-matched
`oh-my-pi` root MIT license has copyright notices for Mario Zechner and Can
Bölük. Those MIT notices do not replace independently licensed native inputs.

## Embedded fonts and syntax resources

- **Silver.ttf** - Poppy Works / Wolfgang Wozniak, with contributors Itou Hiro,
  leedheo, and ぶち. Source: <https://poppyworks.itch.io/silver>. Licensed under
  [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
  The reviewed npm binary contains the source-matched font bytes. This package
  does not modify or vendor those bytes.
- **5x8.bdf, 6x12.bdf, and 8x13.bdf** - Markus Kuhn; the source files state
  public-domain status. **unscii-8.hex** is from Viznut's Unscii 8-pixel
  public-domain variant. These statements apply to the audited embedded files,
  not to every similarly named font.
- **Julia syntax** - MIT, Copyright (c) 2015-2024 Viktor Qvarfordt and
  contributors, from `JuliaEditorSupport/Julia-sublime` commit
  `3366b10be91aaab7a61ae0bc0a5af5cc375e58d1`.
- **Nix syntax** - adapted from `wmertens/sublime-nix`, MIT, Copyright (c) Wout
  Mertens.
- **Mermaid syntax** - vendored from `SublimeText/Mermaid`, MIT, Copyright (c)
  Peng Wang.
- **Syntect default newline pack** - syntect code is MIT. Its source-matched
  Sublime Packages input has a custom permissive root grant and file-level
  exceptions. The audited exceptions include the separate Rust license,
  C# contributors (Sublime Text HQ Pty, @gwenzek, Matthew Winter, and Adam
  Lickel), and YAML copyright (c) 2015 FichteFoll. Exact serialized membership
  and all exception scope remain part of the accepted residual inventory.

## Tokenizer tables

The reviewed native binary contains exact copies of OpenAI's
`cl100k_base.tiktoken` and `o200k_base.tiktoken` tables. Their SHA-256 values are
recorded in `PROVENANCE.md`. The commit-pinned `openai/tiktoken` MIT notice is:

> Copyright (c) 2022 OpenAI, Shantanu Jain

The downstream `tiktoken-rs` MIT notice is:

> Copyright (c) 2023 Roger Zurawicki

`tiktoken-rs` also credits @spolu for the original code and `.tiktoken` files.
A captured `openai/tiktoken` collaborator statement says the repository license
applies to encoding files; it directly names the `cl100k_base` question and is
the qualified category basis also used for the later `o200k_base` encoding.
That statement is mutable and the latter application is an inference. This row
must be reviewed again if the statement, table bytes, source, or pin changes.

## Major linked native components

The source-matched native graph includes the following known notices and license
families. The package fetches the unchanged npm binary and does not vendor these
sources.

- **Opus / audiopus_sys** - Xiph.Org Foundation, Skype Limited, and other named
  contributors under the Opus BSD-style redistribution and patent terms;
  `audiopus_sys` wrapper by Lakelezz under ISC; Rust `opus` wrapper under the
  MIT or Apache-2.0 alternative.
- **miniaudio / maudio** - miniaudio by David Reid under its public-domain
  (Unlicense) or MIT-0 alternative; `maudio-sys` wrapper by David Reid and
  Cristian Roman under MIT; `maudio` wrapper under MIT.
- **PCRE2 / SLJIT / pcre2-sys** - PCRE2 by Philip Hazel and the University of
  Cambridge under its BSD-3-style terms; SLJIT by Zoltan Herczeg under its
  BSD-2-style terms; Rust wrapper under MIT or Unlicense.
- **Oniguruma / onig_sys** - Oniguruma by K. Kosako under BSD-2-style terms,
  with separately attributed/public-domain source files; Rust wrapper under
  MIT.
- **WebRTC and ring/BoringSSL graph** - WebRTC's Rust dependency graph includes
  ISC, Apache-2.0, BoringSSL component terms, and Fiat Apache-2.0 material.
  Exact retained-object membership was not independently established.
- **pi-shell and vendored utilities** - the source notice credits RTK under MIT
  for adapted pytest-minimizer code. Brush, jaq, uutils and related vendored
  sources carry their own MIT and variant notices, including uutils developers,
  Google Inc., Diomidis Spinellis, and Simon Sapin.
- **Tree-sitter grammars** - 56 lock-selected grammar archives were inventoried.
  They include MIT, Apache-2.0, CC0 and qualified/conflicting source paths. The
  `tree-sitter-just` source has an Apache-2.0 license/header despite MIT package
  metadata; both facts are retained rather than silently reconciled.
- **objc2 family** - 27 lock-selected crates derive bindings from Apple SDK
  headers/metadata. Pinned core crates retain the historical Steven Sheldon MIT
  attribution; other crates declare Zlib or Apache-2.0 or MIT alternatives.
  A later owner commit provides current complete MIT/Apache-2.0/Zlib bodies with
  Copyright 2026 Mads Marquart, but does not clearly republish or retroactively
  scope those notices to every pinned release. The source itself says Apple
  binding redistribution authority is unclear.

## Accepted residuals

The bounded audit did not produce a source/release-matched Darwin-arm64 linked
SBOM or an independently complete notice closure beyond the gathered corpus.
Open qualifications include the effective Bazel repository graph, 36
source-supplement rows from the initial zero-notice set, generated grammar
provenance and metadata conflicts, syntect pack membership, objc2 historical
attribution and Apple SDK-derived binding rights, and pin-specific terms for
some Rust/C/resources. The release Actions addon artifact expired, so the npm
binary was not directly compared with an archived workflow output, and the
Fulcio/Rekor chain was not independently verified.

On 2026-09-24 the operator accepted these documented residuals for personal and
open-source use only, provided the exact native leaf remains pinned and fetched
from npm, and neither the binary nor its tarball is committed, mirrored, or
republished here. This is accepted residual risk, not legal advice or legal
clearance. A source, native pin, distribution model, or repository-visibility
change reopens review.
