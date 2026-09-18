# Contributing to V3Code

Thanks for helping improve V3Code.

## Before you start

- Search existing issues before opening another one.
- Keep pull requests focused on one problem.
- Read [LICENSING.md](LICENSING.md). This is a mixed-license, source-available
  project rather than a uniformly Open Source repository.
- Do not remove existing copyright, license, SPDX, or attribution notices.
- Do not include credentials, private code, copied product assets, or material you
  cannot legally contribute.

Security reports do not belong in public issues. Follow [SECURITY.md](SECURITY.md).

## Build

Use Node 22 and the version pinned in `.nvmrc`:

```bash
nvm use
npm ci
npm run buildreact
npm run compile
```

Run the focused tests for the area you changed. For editor changes, also exercise
the affected workflow in a development build. Tell reviewers exactly what you ran
and what you did not run.

## Pull requests

- Explain the problem and the change in plain language.
- Link the issue when one exists.
- Include screenshots or a short recording for visible interface changes.
- Preserve existing behavior outside the requested change.
- Add tests for fixes and new behavior when practical.
- Disclose third-party sources and licenses in the pull request and update
  `NOTICE.txt` when required.
- Disclose material AI assistance and confirm you reviewed the resulting code.

Before a pull request can merge, its author must accept [CLA.md](CLA.md) through
the repository's recorded acceptance flow. Opening a pull request alone is not
acceptance.

## Review

Maintainers may ask for a smaller change, more evidence, attribution corrections,
or a different implementation. Passing CI does not guarantee merge. Be direct and
respectful; disagreement about code is fine, personal attacks are not.
