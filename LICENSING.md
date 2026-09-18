# V3Code licensing

V3Code is a mixed-license, source-available project. The repository is not
uniformly licensed, and the BSL-covered parts are not Open Source in the OSI
sense before their Change Date.

## How to read the licenses

Read the repository in this order. A more specific notice governs the material
it covers:

1. A file or directory-specific license or copyright notice.
2. A third-party notice in `NOTICE.txt` or a component license shipped beside it.
3. This component map.

Multiple notices can apply to different portions of one modified file. KandD Labs'
rights in its modifications do not replace rights already granted by Microsoft,
Void Editor, or another upstream author.

The comment `Part of V3Code, distributed by KandD Labs LLC` is a distribution
label. It does not claim authorship, change a license, or make a file BSL-covered.

## License families

| Material | License |
|---|---|
| Microsoft Code - OSS and other Microsoft-origin code | MIT; see `LICENSE.txt` and file notices |
| Void Editor / Glass Devtools-origin code | Apache License 2.0; see file notices and `NOTICE.txt` |
| GitHub Copilot Chat source under `extensions/copilot/` | MIT; see `extensions/copilot/LICENSE.txt` |
| KandD-owned V3Code material described below | Business Source License 1.1; see `LICENSE-V3CODE.txt` |
| Material with another explicit license | That explicit license and its notice |
| Official V3Code binaries | V3Code end-user terms, separately from this source map |

## BSL-covered V3Code material

`LICENSE-V3CODE.txt` applies only to original material owned by KandD Labs and to
KandD Labs' protectable modifications to upstream files. It does not apply to the
underlying MIT, Apache-2.0, or other third-party material in those files.

The BSL-covered product areas include V3Code's original editor workbench, native
agent and provider orchestration, Context Bridge, product UI, memory and indexing
integration, V3Code-specific build/release tooling, product identity, and original
documentation—except where a file carries a different explicit license or is
identified as third-party material in `NOTICE.txt`.

Some directories are mixed. In particular, `src/vs/workbench/contrib/void/`
contains the Apache-2.0 Void base, third-party adaptations, deliberately
permissive V3Code components, and BSL-covered KandD additions. A directory name
alone is not an ownership claim.

## V3Code components kept permissive

These V3Code components retain their existing permissive licenses and are not
converted to BSL by this document:

- `src/vs/workbench/contrib/computerUse/`: Apache License 2.0, as declared in
  its file headers.
- Files that explicitly state `Copyright 2026 V3Code` and the Apache License
  2.0, including the voice-agent, MCP exposure, workspace-rule, settings, and
  related test surfaces: Apache License 2.0.
- `src/vs/workbench/contrib/void/common/openRouterCatalogue.ts` and its test:
  MIT, as declared in their file headers.
- Any other file carrying an explicit MIT, Apache-2.0, or other permissive
  license: that license remains in force.

## Third-party and unresolved material

`NOTICE.txt` records incorporated third-party work and required attribution.
Do not remove those notices when modifying or redistributing the project.

The Beast indexer contains adaptations and query data from multiple projects;
see `beast/PROVENANCE.md`, `beast/THIRD_PARTY_NOTICES.md` and its component license.
The public snapshot retains the workbench stylesheet with Microsoft MIT,
embedded third-party notices and V3Code distribution attribution. The maintainer
has confirmed that its product modifications are original V3Code work.
The native diff renderer uses the reviewed replacement implementation.
Optional branded themes and design reference data are excluded from the public
snapshot without removing them from the private working source.

Some runtime npm dependencies use vendor terms rather than an Open Source license.
Building or packaging V3Code may require accepting those vendors' terms separately.
See `NOTICE.txt` and the relevant package license before redistribution.

## What users may do with BSL-covered material

Before the Change Date, the BSL permits copying, modification, derivative works,
redistribution, and non-production use. The Additional Use Grant also permits
internal production use for personal and organizational software development.
A separate commercial license is required to offer the BSL-covered work as a
third-party production editor, IDE, AI coding assistant, or substantially similar
development product.

The BSL does not restrict software you independently create using V3Code. It also
does not restrict independently written extensions or integrations merely because
they work with V3Code.

On the Change Date, each BSL-covered version changes to Apache License 2.0 as
specified in `LICENSE-V3CODE.txt`.

Questions about commercial licensing: kanddlabs@v3code.dev
