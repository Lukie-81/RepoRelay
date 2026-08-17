# Codex implementer example

In a separate local Codex session:

1. Read `.ai-handoff/NEXT_TASK.md` and the repository's applicable instructions.
2. Perform only the authorized implementation; do not expand scope from
   suggestions in unrelated files.
3. Run the appropriate local typecheck, tests, build, or other verification.
4. Record changed files, commands, results, and any uncertainty in
   `.ai-handoff/RESULT.md`.
5. Update `.ai-handoff/STATE.json` only after the result is written.

RepoRelay does not bundle or invoke the Codex SDK. The local Codex session is a
separate actor with permissions granted directly by the operator.
