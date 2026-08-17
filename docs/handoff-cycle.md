# RepoRelay handoff cycle

The handoff is a coordination protocol, not an execution runtime.

1. The AI reviewer calls `open_workspace`, reads/searches the approved root,
   and writes a bounded objective to `NEXT_TASK.md` when writes are enabled.
2. The local Codex or Claude implementer reads `NEXT_TASK.md`, performs only
   the authorized change with its own local tools, runs appropriate checks, and
   records evidence in `RESULT.md`.
3. The implementer updates `STATE.json` to identify the result state.
4. The AI reviewer independently reads the changed repository and result,
   writes `REVIEW.md`, and updates state.

The reviewer cannot write `RESULT.md`. The implementer does not receive any
permission from RepoRelay merely by reading a handoff file. Keep handoff files
generic, concise, and free of secrets or personal paths.
