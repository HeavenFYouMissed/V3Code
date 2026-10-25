# V3Code licensing

V3Code is open source.

| Material | License |
|---|---|
| V3Code's own code (KandD Labs) | Apache License 2.0, see `LICENSE` |
| Void Editor / Glass Devtools-origin code | Apache License 2.0, see file notices and `NOTICE.txt` |
| Microsoft Code - OSS and other Microsoft-origin code | MIT, see `LICENSE.txt` and file notices |
| GitHub Copilot Chat source under `extensions/copilot/` | MIT, see `extensions/copilot/LICENSE.txt` |
| Material with another explicit license | That license and its notice |
| Official V3Code binaries | V3Code end-user terms (https://v3code.dev/terms), separately from this source map |

## How to read the licenses

A more specific notice governs the material it covers, in this order:

1. A file- or directory-specific license or copyright notice.
2. A third-party notice in `NOTICE.txt` or a component license shipped beside it.
3. This map.

Several upstream licenses can apply to different parts of one modified file. Keep
every existing copyright, license, SPDX and attribution notice when you copy,
modify or redistribute V3Code.

## Components with their own licenses

- `src/vs/workbench/contrib/computerUse/`: Apache License 2.0, as its file headers state.
- `src/vs/workbench/contrib/void/common/openRouterCatalogue.ts` and its test: MIT, as their file headers state.
- The Beast indexer contains adaptations and query data from multiple projects; see
  `beast/PROVENANCE.md`, `beast/THIRD_PARTY_NOTICES.md` and its component license.
- Some runtime npm dependencies use vendor terms rather than an open source license.
  Building or packaging V3Code may require accepting those vendors' terms separately.
  See `NOTICE.txt` and the relevant package license before redistribution.

## Trademarks

The Apache License does not grant rights to the V3Code name, the V3 logo or other
V3Code branding (Apache License 2.0, section 6). Forks should use their own name and logo.

## Contributions

Contributions are accepted under the Apache License 2.0 (section 5): anything you
submit in a pull request is licensed under the same terms as the project. No separate
agreement is needed.

Questions: kanddlabs@v3code.dev
