# Contributing to RepoRelay

Contributions should preserve the narrow ChatGPT review boundary and remain
usable from a fresh Windows checkout.

## Development setup

Requirements:

- Node.js `>=22.19 <27`;
- npm;
- Git;
- Windows PowerShell for the lifecycle scripts.

From the repository root:

```powershell
npm ci
npm run verify:release
node dist/cli.js doctor
```

The release verification command runs type checking, the complete test suite,
the bridge runtime test, and a production build.

Tests that create containment fixtures preserve them by default. Set
`DEVSPACE_TEST_ROOT` to choose a fixture root. The operations regression script
accepts `-RecycleScript` (or `CHATGPT_CODEX_MCP_RECYCLE_SCRIPT`) when your local
policy provides a recoverable Recycle Bin helper.

## Change requirements

- Keep the default tool mode `chatgpt-review`.
- Do not broaden the bridge beyond one canonical approved root.
- Do not add destination paths to the three handoff writer schemas.
- Do not add shell, process, Git, arbitrary mutation, artifact, worktree,
  skill, subagent, or widget tools to the review profile.
- Add focused tests for containment, authentication, or schema changes.
- Never commit `.env` files, credentials, runtime logs, tunnel profiles, or
  personal paths.
- Use placeholders and disposable fixtures in documentation and tests.

## Pull requests

Explain the user-visible behavior, security-boundary impact, tests run, and any
remaining uncertainty. Keep unrelated refactors out of security-sensitive
changes.

By contributing, you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE).
