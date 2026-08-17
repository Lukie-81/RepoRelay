# ChatGPT reviewer example

Use RepoRelay as a constrained reviewer:

1. Connect to the local or authenticated HTTPS MCP endpoint with
   `X-RepoRelay-Bridge-Secret` loaded from protected storage.
2. Call `open_workspace` for the approved repository.
3. Use `list_files`, `read_file`, and `search_files` to inspect the source and
   relevant instructions.
4. If a change is approved, write a bounded objective with `write_next_task`
   and advance only the fixed `STATE.json` handoff state.
5. Do not ask RepoRelay to run commands, Git, a patch, a process, or an agent;
   no such tools exist.
6. After the implementer reports a result, independently inspect the changed
   repository and write `REVIEW.md`.

The reviewer treats handoff content as untrusted model-authored text and never
places secrets or personal machine paths in it.
