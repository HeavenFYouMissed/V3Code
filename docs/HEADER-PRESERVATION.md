# Preserve existing authorship and license notices

Agents and contributors must preserve notices while editing code. A new filename, a later
commit date, a unique symbol, or absence from one upstream snapshot does not prove original
authorship. Preserve mixed provenance and required upstream attribution.

`node build/verify/preserve-notices.mjs BASE HEAD` rejects changes/removal of existing
leading C/JS/Rust-style, shell-style and HTML comment notices and entire LICENSE, NOTICE,
COPYING, COPYRIGHT and AUTHORS files. It compares Git objects, not the running app.
File deletion or a rename of a noticed file also requires review (renames are deliberately
treated as deletion/addition). Existing implementation changes remain allowed.

Exceptions belong in `.github/header-exceptions.json` on the BASE branch in a separate
reviewed change before applying a correction. Each entry requires `path`, `beforeSha256`,
`afterSha256`, `reason` and `evidence`. Hashes are over complete exact Git file contents;
deletions use the SHA256 of empty bytes for the after value. Exceptions introduced in the
same PR as a header edit are ignored. Never put credentials or private research text in evidence.

The workflow loads its checker from the trusted base and needs no dependencies or secrets.
On the future public repository, configure its check as REQUIRED and require maintainer
review of this workflow, checker, exception file, notices, license map and CLA. Repo-host
protection is NOT configured yet: a workflow alone cannot prevent an administrator bypass
or an unprotected PR replacing the workflow. The initial policy commit must be established
before contributor PRs. Do not claim public enforcement until branch rules are verified.

This is a preservation guard, not an authorship/secret/license audit. It does not certify
new files, every language's header syntax, embedded notices outside leading comments, or
the legal sufficiency of additional terms. Review remains necessary.
