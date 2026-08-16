# RepoRelay dependencies and reproducible installation

## Runtime prerequisites

- Windows 10 or 11
- PowerShell 5.1 or newer (PowerShell 7 is recommended)
- Node.js 22.19 through 26
- npm (included with Node.js)
- Git for Windows
- an HTTPS tunnel provider for ChatGPT Web connectivity

The tunnel provider is intentionally not installed or provisioned by `npm ci`.
Choose and secure it separately.

## Source installation

```powershell
git clone https://github.com/Lukie-81/reporelay.git
Set-Location reporelay
npm ci
npm run verify:release
```

`package-lock.json` is committed and is the reproducible dependency source.
Use `npm ci` for clean installs. `npm audit` should be run before each release,
but a zero-vulnerability result does not replace code review or containment
tests.

`node-pty` is optional and belongs to privileged compatibility modes. It is not
used by the hardened `chatgpt-review` tool surface.

## Updating dependencies

Keep updates scoped, inspect the lockfile diff, run `npm audit`, and execute the
complete release verification suite. Security-related overrides in
`package.json` must not be removed without checking the original advisory and
the resolved transitive version.
