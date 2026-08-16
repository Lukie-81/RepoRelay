# ChatGPT and Codex handoff workflow

ChatGPT Web is the reviewer and coordinator; Codex remains the local execution
agent. The hardened MCP bridge deliberately separates those roles.

## Review cycle

1. Initialize the repository's fixed `.ai-handoff` files with the bundled
   PowerShell script.
2. ChatGPT calls `open_workspace` and inspects bounded repository content with
   `read_file`, `list_files`, and `search_files`.
3. ChatGPT writes `.ai-handoff/NEXT_TASK.md` and updates
   `.ai-handoff/STATE.json` for a user-authorized task.
4. Codex implements and verifies approved changes locally, then records its
   result in `.ai-handoff/LUNA_RESULT.md`.
5. ChatGPT writes `.ai-handoff/REVIEW.md` after independently reviewing the
   current repository state.

The bridge never executes Codex, a shell, Git, or another process. It also does
not provide ChatGPT with generic editing. The three optional writer tools map
to `NEXT_TASK.md`, `REVIEW.md`, and `STATE.json` and use integrity checks to detect a
swapped handoff directory.

To change the repository being reviewed, stop the service and restart it with a
different single approved root. A client cannot switch to an unapproved path.

Older generic tool modes in this codebase support upstream use cases but are
outside this workflow and must not be exposed to ChatGPT as a trusted boundary.
