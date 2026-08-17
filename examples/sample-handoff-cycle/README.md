# Sample handoff cycle

This disposable example shows the coordination files only. It contains no
secrets, personal paths, or executable instructions.

```text
ChatGPT reviewer
      ↓
NEXT_TASK.md
      ↓
Codex or Claude implementer
      ↓
RESULT.md
      ↓
ChatGPT review
      ↓
REVIEW.md + STATE.json
```

The files are intentionally generic and concise:

- [`NEXT_TASK.md`](NEXT_TASK.md) — bounded objective;
- [`RESULT.md`](RESULT.md) — implementation evidence;
- [`REVIEW.md`](REVIEW.md) — independent review;
- [`STATE.json`](STATE.json) — phase and status.
