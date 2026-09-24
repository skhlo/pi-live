# objc2 notice text and Apple SDK binding rights - #515

Captured 2026-09-24 UTC. This is a source/evidence assessment, not legal advice. It does not infer permission from public availability, common practice, contract silence, or the absence of an enforcement statement.

## Disposition

**The two questions split.**

- **Open-source license bodies:** the missing text bodies are now obtainable from an official, immutable `madsmtm/objc2` owner commit. Commit [`ee9a7ada2131f5944b8750428e265c15632f2a19`](https://github.com/madsmtm/objc2/commit/ee9a7ada2131f5944b8750428e265c15632f2a19) adds operative MIT, Apache-2.0 sections 1-9, and Zlib texts with `Copyright 2026 Mads Marquart`. This resolves _where to get the repository owner's full current texts_. It does **not clearly say that the new 2026 copyright notices retroactively apply to every already-published pinned crate**, does not put those files into the pinned crate archives, and does not supersede the historical `Copyright (c) Steven Sheldon` MIT notice. Open issue [#23](https://github.com/madsmtm/objc2/issues/23) also confirms that relicensing the inherited core crates remains incomplete. Treat “license-body availability” as resolved, but not “pin-specific authoritative attribution/scope.”
- **Apple-derived bindings:** unresolved. Neither the Apple agreement served during the Xcode 15.4/macOS 14.5 SDK period, the agreement applicable when framework crates 0.3.2 were published, the current Apple agreement, nor a located Apple statement expressly authorizes distributing generated Rust bindings derived from SDK headers or metadata. The agreements authorize SDK use to develop software and conditionally permit distribution of macOS applications and libraries, while also treating headers/APIs as Apple SDK content, restricting SDK copying/redistribution and derivative works, and reserving ungranted rights. They do not decide whether these generated crates are distributable developer libraries, prohibited copies/derivatives, or something else.
- **objc2 owner's position:** disclosure, not resolution. The exact pinned `LICENSE.md` says distribution of derived crates is “unclear.” The later license-text commit changes only the three license links and leaves that Apple section intact. The project's generator README separately says, “We do not redistribute SDKs, to hopefully avoid a license violation.”

**#515 recommendation:** keep G0 blocked. Split this row into (1) open-source text bodies - collected; (2) historical/pinned notice attribution and later-text scope - qualified/unresolved; and (3) Apple SDK-derived binding redistribution authority - unresolved. The narrow research does not establish that distribution is forbidden or infringing; it establishes that the required affirmative, source-backed permission was not found.

## Exact package set examined

The source-matched `Cargo.lock` for `@oh-my-pi/pi-natives-darwin-arm64@17.2.9` contains the following 27 `madsmtm/objc2` packages. Each crates.io archive SHA-256 equals its Cargo checksum, each archive's `.cargo_vcs_info.json` identifies the commit below, and none of the 27 archives contains a filename including `LICENSE` or `NOTICE`.

The immutable archive URL form is `https://static.crates.io/crates/<name>/<name>-<version>.crate`; links below use that exact form.

| Exact crate                                                                                                                             | Archive SHA-256                                                    | VCS commit                                                                                  | Manifest license          |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------- |
| [`block2@0.6.2`](https://static.crates.io/crates/block2/block2-0.6.2.crate)                                                             | `cdeb9d870516001442e364c5220d3574d2da8dc765554b4a617230d33fa58ef5` | [`b4167b5`](https://github.com/madsmtm/objc2/tree/b4167b582b2f75f9a1be75495c41b765344fd03c) | MIT                       |
| [`dispatch2@0.3.1`](https://static.crates.io/crates/dispatch2/dispatch2-0.3.1.crate)                                                    | `1e0e367e4e7da84520dedcac1901e4da967309406d1e51017ae1abfb97adbd38` | [`8852b42`](https://github.com/madsmtm/objc2/tree/8852b424193ca41602281b3d7540d7c8ed51e49a) | Zlib OR Apache-2.0 OR MIT |
| [`objc2@0.6.4`](https://static.crates.io/crates/objc2/objc2-0.6.4.crate)                                                                | `3a12a8ed07aefc768292f076dc3ac8c48f3781c8f2d5851dd3d98950e8c5a89f` | [`8852b42`](https://github.com/madsmtm/objc2/tree/8852b424193ca41602281b3d7540d7c8ed51e49a) | MIT                       |
| [`objc2-app-kit@0.3.2`](https://static.crates.io/crates/objc2-app-kit/objc2-app-kit-0.3.2.crate)                                        | `d49e936b501e5c5bf01fda3a9452ff86dc3ea98ad5f283e1455153142d97518c` | [`7b1abfd`](https://github.com/madsmtm/objc2/tree/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b) | Zlib OR Apache-2.0 OR MIT |
| [`objc2-application-services@0.3.2`](https://static.crates.io/crates/objc2-application-services/objc2-application-services-0.3.2.crate) | `69282c2b5bc58fba07cb9de2113619532eb551e98efe3d8d695509ef45fbd53b` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-av-foundation@0.3.2`](https://static.crates.io/crates/objc2-av-foundation/objc2-av-foundation-0.3.2.crate)                      | `478ae33fcac9df0a18db8302387c666b8ef08a3e2d62b510ca4fc278a384b6c0` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-avf-audio@0.3.2`](https://static.crates.io/crates/objc2-avf-audio/objc2-avf-audio-0.3.2.crate)                                  | `13a380031deed8e99db00065c45937da434ca987c034e13b87e4441f9e4090be` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-cloud-kit@0.3.2`](https://static.crates.io/crates/objc2-cloud-kit/objc2-cloud-kit-0.3.2.crate)                                  | `73ad74d880bb43877038da939b7427bba67e9dd42004a18b809ba7d87cee241c` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-core-audio@0.3.2`](https://static.crates.io/crates/objc2-core-audio/objc2-core-audio-0.3.2.crate)                               | `e1eebcea8b0dbff5f7c8504f3107c68fc061a3eb44932051c8cf8a68d969c3b2` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-core-audio-types@0.3.2`](https://static.crates.io/crates/objc2-core-audio-types/objc2-core-audio-types-0.3.2.crate)             | `5a89f2ec274a0cf4a32642b2991e8b351a404d290da87bb6a9a9d8632490bd1c` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-core-data@0.3.2`](https://static.crates.io/crates/objc2-core-data/objc2-core-data-0.3.2.crate)                                  | `0b402a653efbb5e82ce4df10683b6b28027616a2715e90009947d50b8dd298fa` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-core-foundation@0.3.2`](https://static.crates.io/crates/objc2-core-foundation/objc2-core-foundation-0.3.2.crate)                | `2a180dd8642fa45cdb7dd721cd4c11b1cadd4929ce112ebd8b9f5803cc79d536` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-core-graphics@0.3.2`](https://static.crates.io/crates/objc2-core-graphics/objc2-core-graphics-0.3.2.crate)                      | `e022c9d066895efa1345f8e33e584b9f958da2fd4cd116792e15e07e4720a807` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-core-image@0.3.2`](https://static.crates.io/crates/objc2-core-image/objc2-core-image-0.3.2.crate)                               | `e5d563b38d2b97209f8e861173de434bd0214cf020e3423a52624cd1d989f006` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-core-media@0.3.2`](https://static.crates.io/crates/objc2-core-media/objc2-core-media-0.3.2.crate)                               | `05ec576860167a15dd9fce7fbee7512beb4e31f532159d3482d1f9c6caedf31d` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-core-services@0.3.2`](https://static.crates.io/crates/objc2-core-services/objc2-core-services-0.3.2.crate)                      | `583300ad934cba24ff5292aee751ecc070f7ca6b39a574cc21b7b5e588e06a0b` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-core-text@0.3.2`](https://static.crates.io/crates/objc2-core-text/objc2-core-text-0.3.2.crate)                                  | `0cde0dfb48d25d2b4862161a4d5fcc0e3c24367869ad306b0c9ec0073bfed92d` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-core-video@0.3.2`](https://static.crates.io/crates/objc2-core-video/objc2-core-video-0.3.2.crate)                               | `d425caf1df73233f29fd8a5c3e5edbc30d2d4307870f802d18f00d83dc5141a6` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-encode@4.1.0`](https://static.crates.io/crates/objc2-encode/objc2-encode-4.1.0.crate)                                           | `ef25abbcd74fb2609453eb695bd2f860d389e457f67dc17cafc8b8cbc89d0c33` | [`8d214f5`](https://github.com/madsmtm/objc2/tree/8d214f5477365ffcbcbb7de058c86ed9a518efb7) | MIT                       |
| [`objc2-foundation@0.3.2`](https://static.crates.io/crates/objc2-foundation/objc2-foundation-0.3.2.crate)                               | `e3e0adef53c21f888deb4fa59fc59f7eb17404926ee8a6f59f5df0fd7f9f3272` | `7b1abfd`                                                                                   | MIT                       |
| [`objc2-image-io@0.3.2`](https://static.crates.io/crates/objc2-image-io/objc2-image-io-0.3.2.crate)                                     | `32b0446e98cf4a784cc7a0177715ff317eeaa8463841c616cfc78aa4f953c4ea` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-io-surface@0.3.2`](https://static.crates.io/crates/objc2-io-surface/objc2-io-surface-0.3.2.crate)                               | `180788110936d59bab6bd83b6060ffdfffb3b922ba1396b312ae795e1de9d81d` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-media-toolbox@0.3.2`](https://static.crates.io/crates/objc2-media-toolbox/objc2-media-toolbox-0.3.2.crate)                      | `edd9fdde720df3da7046bb9097811000c1e7ab5cd579fa89d96b27d56781fb30` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-metal@0.3.2`](https://static.crates.io/crates/objc2-metal/objc2-metal-0.3.2.crate)                                              | `a0125f776a10d00af4152d74616409f0d4a2053a6f57fa5b7d6aa2854ac04794` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-quartz-core@0.3.2`](https://static.crates.io/crates/objc2-quartz-core/objc2-quartz-core-0.3.2.crate)                            | `96c1358452b371bf9f104e21ec536d37a650eb10f7ee379fff67d2e08d537f1f` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-security@0.3.2`](https://static.crates.io/crates/objc2-security/objc2-security-0.3.2.crate)                                     | `709fe137109bd1e8b5a99390f77a7d8b2961dafc1a1c5db8f2e60329ad6d895a` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |
| [`objc2-system-configuration@0.3.2`](https://static.crates.io/crates/objc2-system-configuration/objc2-system-configuration-0.3.2.crate) | `7216bd11cbda54ccabcab84d523dc93b858ec75ecfb3a7d89513fa22464da396` | `7b1abfd`                                                                                   | Zlib OR Apache-2.0 OR MIT |

This is the exact lock-selected objc2 family. It does not independently prove which members the final linker retained; #515's broader target-closure limitation remains as recorded in `NATIVE-AUDIT.md`.

## License history and what the later clarification proves

### Pinned state

All four pinned source commits contain byte-identical [`LICENSE.md`](https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md), SHA-256 `7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54`. It says:

> The crates `objc2`, `block2`, `objc2-foundation` and `objc2-encode` are currently licensed under the MIT license.

> All other crates are trio-licensed under the Zlib, Apache-2.0 or MIT license, at your option.

It then says:

> Furthermore, the crates are (usually automatically) derived from Apple SDKs, and that may have implications for licensing…

> From reading the license, it is unclear whether distributing derived works such as these crates are allowed?

The file linked the MIT, Apache-2.0, and Zlib steward pages, but did not contain their text. The published archives had SPDX expressions but no copied license/notice file.

The repository's exact history is short and traceable:

1. [`9961247c1a82027d6edbe6c516011b1363b9354c`](https://github.com/madsmtm/objc2/commit/9961247c1a82027d6edbe6c516011b1363b9354c) added `LICENSE.txt` in 2016. The last pre-removal bytes at [`757cd841d0293341dbefd9b99d7548dec244ffde`](https://github.com/madsmtm/objc2/blob/757cd841d0293341dbefd9b99d7548dec244ffde/LICENSE.txt) are a full MIT notice with `Copyright (c) Steven Sheldon`, SHA-256 `e353f37b12aefbb9f9b29490e837cfee05d9bda70804b3562839a3285c1df1e5`.
2. [`cfb199226661ec6e4939fcd7cd7531b3c5453076`](https://github.com/madsmtm/objc2/commit/cfb199226661ec6e4939fcd7cd7531b3c5453076) on 2025-01-22 removed that full file and added the current licensing map/Apple uncertainty in `LICENSE.md`. It explicitly kept `objc2`, `block2`, `objc2-foundation`, and `objc2-encode` on MIT pending [#23](https://github.com/madsmtm/objc2/issues/23), while saying future contributions were under the trio.
3. [`bf3bd63cbb97fba7426f941c4a154c8aa3d7b60b`](https://github.com/madsmtm/objc2/commit/bf3bd63cbb97fba7426f941c4a154c8aa3d7b60b) later that day moved `dispatch2` into the trio.
4. [`1c29ca7c60d549610c62471cdf3d79ee97a14aa1`](https://github.com/madsmtm/objc2/commit/1c29ca7c60d549610c62471cdf3d79ee97a14aa1) on 2025-04-29 added only the warning that examples may have narrower terms.
5. [`ee9a7ada2131f5944b8750428e265c15632f2a19`](https://github.com/madsmtm/objc2/commit/ee9a7ada2131f5944b8750428e265c15632f2a19) on 2026-03-18 added repository-level files and changed `LICENSE.md`'s three links from external sites to those local files. The Apple SDK section was unchanged.

### Exact later files

| File at `ee9a7…`                                                                                                          | What it contains                                                                                                            | SHA-256                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`LICENSE-MIT.txt`](https://github.com/madsmtm/objc2/blob/ee9a7ada2131f5944b8750428e265c15632f2a19/LICENSE-MIT.txt)       | Complete MIT permission, condition, warranty and liability text; `Copyright 2026 Mads Marquart`                             | `f6a2e783669a0dd7a2c3b8a4f76db40ae49033e66e1bdc30f3aa25fe5577b070` |
| [`LICENSE-APACHE.txt`](https://github.com/madsmtm/objc2/blob/ee9a7ada2131f5944b8750428e265c15632f2a19/LICENSE-APACHE.txt) | Apache License 2.0 operative sections 1-9 through `END OF TERMS AND CONDITIONS`, followed by `Copyright 2026 Mads Marquart` | `0c9a5f6fe28e27015e12506ffe58c9e007cead169af9670ec15c1df0d14e4f2a` |
| [`LICENSE-ZLIB.txt`](https://github.com/madsmtm/objc2/blob/ee9a7ada2131f5944b8750428e265c15632f2a19/LICENSE-ZLIB.txt)     | Complete Zlib warranty, grant and three restrictions; `Copyright 2026 Mads Marquart`                                        | `fced3e7fedc235fa83ed0108b0df74d86b435d06436356f46917a903cbadd80a` |

Issue [#826](https://github.com/madsmtm/objc2/issues/826) asked for missing complete license files and a copyright notice. The owner first asked whether SPDX was enough and explicitly preferred files “just being in the repo” rather than distributed to crates.io users. After the commit, the [owner wrote](https://github.com/madsmtm/objc2/issues/826#issuecomment-4084918376) on 2026-03-18: “I think I've fixed this in ee9a7ada…”. That is strong first-party evidence that the commit supplies the repository's intended full text set. It is not a statement that the files were republished into old crates or that the 2026 notices apply retroactively to named old releases.

Issue [#23](https://github.com/madsmtm/objc2/issues/23), “Relicense under trio MIT/Apache-2.0/Zlib,” remains open. Its owner says permission is still needed from Steven Sheldon and many inherited contributors; the [owner comment](https://github.com/madsmtm/objc2/issues/23#issuecomment-1234168076) says a response from Sheldon was still required. This explains why the pinned core crates remain MIT-only. The new 2026 MIT file does not mention Steven Sheldon and does not say it replaces the 2016 notice.

**Assessment:**

- Source-backed: the later owner commit supplies complete current repository text bodies for all three named licenses.
- Source-backed: it postdates all pinned sources, is absent from every pinned archive, leaves the Apple warning unchanged, and does not mention prior tags/releases.
- Inference only: treating its `Copyright 2026 Mads Marquart` notices as the complete authoritative notices for old published bytes.
- Conservative evidence bundle, if retained for this row: exact pinned `LICENSE.md`; all three `ee9a7…` files; the pre-removal Steven Sheldon MIT notice; crate manifests/checksums; and an explicit note that `ee9a7…` is later repository clarification rather than a source-matched republish. This organizes the available primary evidence; it is not a legal conclusion about which notices must be delivered.

## Which Apple SDK era actually produced these framework crates

The requested Xcode 15.4/macOS 14.5 review is historically identifiable, but it is **not the generation version of framework crates 0.3.2**.

- Apple's official [Xcode 15.4 release notes data](https://developer.apple.com/tutorials/data/documentation/xcode-release-notes/xcode-15_4-release-notes.json) says: “Xcode 15.4 includes SDKs for … macOS Sonoma 14.5…”. Captured JSON SHA-256: `5d41e222eb22444c5361ac894ce85a38666cfb9992d522032393d06034dded2c`.
- objc2's immutable [framework changelog at `7b1abfd…`](https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/crates/objc2/src/topics/FRAMEWORKS_CHANGELOG.md) associates Xcode 15.4 with framework crates `0.2.1` (2024-05-21), then records `0.3.0` moving to Xcode 16.2, `0.3.1` to 16.3, and exact `0.3.2` to **Xcode 26.0.1**.
- The same pinned source's [`objc2/src/lib.rs`](https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/crates/objc2/src/lib.rs) states: “The framework bindings are generated from the SDKs in Xcode 26.0.1.”
- The pinned [`header-translator/README.md`](https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/crates/header-translator/README.md) tells regenerators to use that documented Xcode version and says: “We do not redistribute SDKs, to hopefully avoid a license violation.”

Accordingly, the Xcode 15.4 agreement is relevant to the historical generation line and to the wording of the project's concern, but the agreement in force around the 0.3.2 release is the closer exact-version comparator.

## Apple agreements and exact clauses

Apple publishes the Xcode agreement at one mutable URL, [`https://www.apple.com/legal/sla/docs/xcode.pdf`](https://www.apple.com/legal/sla/docs/xcode.pdf). The historical links below are timestamped captures of bytes served by that official Apple URL; the authority is Apple's document, while the archive supplies immutable retrieval. No third-party interpretation is used.

### Xcode 15.4/macOS 14.5 period

An official-URL capture on **2024-05-15** contains **EA1863, dated 08/18/2023**, SHA-256 `040163ca824cc1a1d45f1b90d56114bc546903074a3082a29b4edf0461ab3fb8`: [immutable capture](https://web.archive.org/web/20240515134637id_/https://www.apple.com/legal/sla/docs/xcode.pdf). An independent 2024-04-08 capture has identical bytes. This establishes the Apple text being served while Xcode 15.4/macOS 14.5 was current, but an SDK version alone cannot prove which agreement a particular person accepted.

Apple later issued **EA1879, dated 06/10/2024**. Captures on 2025-08-13 and 2025-12-03 are byte-identical, SHA-256 `27c4f7023b30c84b98438baf21743c82efe72deaa6fbc568c2979233fac56e17`: [immutable capture](https://web.archive.org/web/20250813131419id_/https://www.apple.com/legal/sla/docs/xcode.pdf). This revision was also served throughout the publication period for the exact `0.3.2`/`0.6.x` packages: archive captures with the same digest bracket their 2025-2026 source dates. It is therefore the stronger period-specific comparator for the pinned framework 0.3.2 source generated with Xcode 26.0.1.

EA1863 and EA1879 contain the following material clauses (wording quoted from EA1863 where unchanged):

- **Headers and API definitions are inside the licensed SDK.** Section 1 defines Apple SDKs as including “header files, APIs, libraries, simulators, and software (source code and object code),” and defines the macOS SDK the same way.
- **Permitted SDK use.** Section 2.2(A)(i)-(ii): “You may use the Xcode Developer Tools to test and develop application and other software” and “You may use the macOS SDKs to test and develop application and other software.”
- **macOS distribution, conditionally.** Section 2.4: “For clarity, macOS applications and libraries may be distributed without entering into a separate written agreement with Apple so long as such applications and libraries comply with the terms of this Agreement.”
- **SDK copy restrictions.** Section 2.5: “You may copy only the entire package or piece of the Apple Software and Services in its entirety and only for use as permitted herein,” and “You may not alter the Apple Software or Services in any way in such copy,” including separate SDK use.
- **Ownership boundary.** Section 2.6: “Apple retains all rights, title, and interest in and to the Apple Software and Apple Services.” It also says the agreement “does not give Apple any ownership interest in Your Applications.”
- **Redistribution and derived works.** Section 2.7 says that, unless Apple expressly permits it in writing, the user may not “sell, redistribute, or sublicense the Apple Software and Apple Services, in whole or in part,” and may not “copy … modify, decrypt, or create derivative works of the Apple Software or Services, or any part thereof,” subject to the stated applicable-law/open-source/sample-code exceptions. It ends: “All licenses not expressly granted in this Agreement are reserved and no other licenses, immunity or rights, express or implied are granted by Apple, by implication or otherwise.”
- **Specifically named distributable material.** Section 2.13 of EA1863 expressly allows continued distribution of “System-Provided Images as used within Applications You developed using the Apple Software,” subject to the section's limits. The agreement contains no parallel statement naming generated bindings, SDK metadata, API declarations, or headers as distributable output.

EA1879 adds a generated-content clause in Section 2.14(D):

> You agree that content (including code) generated in response to Your use of Apple Software and Services is Your responsibility. Notwithstanding Apple’s prior rights, Apple does not claim any ownership rights in the generated content. It is entirely your responsibility to test the content; ensure the content does not violate, misappropriate, or infringe any Apple or third-party copyrights, trademarks, rights of privacy and publicity, trade secrets, patents, or other proprietary or legal rights; and appropriately attribute content as required.

This clause is not an express redistribution license. It preserves “Apple's prior rights,” places rights/attribution responsibility on the user, and does not mention mechanically translated SDK declarations or Rust bindings. Whether it covers a third-party translator reading SDK headers is not answered by the text.

### Current official terms - comparison only

The live Apple URL returned **EA2002, dated 06/08/2026**, on 2026-09-24; PDF SHA-256 `5e6bd16bcba3dd591bde1c57f7c6f19f08a194c84cdc54485c4660f90e2a26ec`. It retains the same relevant structure:

- Apple SDKs include “header files, APIs, libraries, simulators, and software (source code and object code).”
- Section 2.2 still authorizes use of the macOS SDKs “to test and develop application and other software.”
- Section 2.4 still says macOS applications and libraries may be distributed if they comply with the agreement.
- Sections 2.5 and 2.7 retain the whole-package copy rule, no-redistribution rule, no-derivative-work rule, and reservation of ungranted rights.
- Section 2.10 still grants the specifically bounded System-Provided Images distribution right.
- Section 2.14(F) retains the generated-content language, including “Notwithstanding Apple’s prior rights” and the user's responsibility to ensure rights and attribution.

Apple's current public [Developer Program License Agreement](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/) is comparison only (captured HTML SHA-256 `1918c06dcd0c605448c4e75e37162a63ed8b33e3a0c97be4b3676899573817d9`). Section 7.5 permits development/distribution of iOS-family libraries only for Apple-branded products and says this does not prohibit macOS libraries. Section 7.6 says no other distribution of programs/applications developed using Apple Software is authorized except its enumerated paths. It likewise contains no generated-Rust-binding grant.

### “Redistributable Components”

The exact capitalized term **“Redistributable Components” is not defined or used** in EA1863, EA1879, EA2002, or the current public Developer Program License Agreement. The inspected agreements instead identify specific distributable categories - macOS applications/libraries, program-governed libraries, and System-Provided Images under stated limits. No inspected Apple text designates SDK headers, API definitions, extracted metadata, or generated Rust bindings as a redistributable component.

That absence is not used as evidence of prohibition or permission.

## Answer to the express-authorization question

**No inspected official Apple source or Apple statement expressly authorizes distributing generated Rust bindings derived from Apple SDK metadata or headers.**

The closest language is:

1. permission to use the macOS SDK to develop “application and other software”;
2. conditional permission to distribute macOS applications and libraries; and
3. the later statement that Apple does not claim ownership in generated content, “Notwithstanding Apple’s prior rights.”

None names generated bindings, says API/header-derived declarations may be copied or translated and redistributed, classifies such output as the developer's library rather than Apple Software/a derivative, or waives the copy/derivative/reserved-right clauses. Selecting one classification would be an inference beyond the source.

The objc2 owner has not supplied an Apple clarification. The pinned license says the answer is unclear, and `ee9a7…` leaves that statement unchanged. Issue #826 concerns only missing open-source license files. Issue #23 concerns contributor relicensing. Neither contains an Apple statement or resolves SDK-derived rights.

## Exact residual question

The unresolved fact needed for this #515 row is:

> An Apple-authored, version-applicable written term or statement that expressly permits a developer who lawfully used the relevant Xcode SDK to distribute source and compiled Rust bindings mechanically derived from SDK headers/API metadata, including any platform, attribution, notice, or redistribution conditions; or an equally authoritative statement classifying that output within an already granted distributable category and reconciling that classification with the SDK-copy, derivative-work, and reserved-right clauses.

A source-matched objc2 notice bundle would separately need to say whether the 2026 Mads Marquart notices apply to the pinned releases and what historical contributor notice(s), including Steven Sheldon's, accompany their MIT portions. The later repository files are useful complete text bodies, but they do not say this.

## Research limits and retained evidence

- Sources were limited to Apple-hosted agreements/documentation, immutable `madsmtm/objc2` commits, first-party repository issues, exact crates.io archives, and the already-retained source-matched Cargo evidence. Search-engine results were used only for discovery and are not cited as evidence.
- GitHub issues/comments are editable. The 2026-09-24 API captures bind the observations to SHA-256 `da1b18cbf645f89642cee7bff02bb280768c76000368e91d2ef36afac2f5e91b` (issue #826), `b62cd5a6e0e282d2ab00871202aa7aef4517135e47c983026064dd39e171b2f1` (#826 comments), `5c8cf530c8adac81ed82466be311cb465505e279fceefb4a223bc05e65b53b63` (issue #23), and `ed62d6cd1d43c6f75ac27aa1f143a7d8e9d43d429cd4c2292489ba92cd1fb40c` (#23 comments).
- Apple's live Xcode SLA URL is mutable. Historical conclusions use byte-hashed captures of documents originally served by Apple's URL and identify the internal agreement code/date. No authenticated Apple service was used.
- No Apple or maintainer contact was made. No GitHub write, Firecrawl request, dependency/tool installation, native execution, build, or tracked code change occurred.
- Key local captures and a verification receipt are retained under `evidence/objc2-apple-sdk/`; temporary discovery/download scratch was removed after verification.
