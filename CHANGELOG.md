# Changelog

## 0.2.0

- The published and checked-in distribution now runs on Node 20; Bun remains a
  development tool rather than a consumer runtime requirement.
- Capability results report whether the selected executable is available,
  missing, or unusable, including the resolved Windows executable and a useful
  failure reason.
- Provider JSONL is classified into stable lifecycle event kinds: `session`,
  `message`, `tool`, `status`, `result`, `error`, and `unknown`.
- `runAgent` accepts an optional invocation executor so consumers can test their
  integration deterministically without launching or billing a model.
- Cancellation terminates the provider process tree and escalates on POSIX if a
  child ignores `SIGTERM`.
- Timed-out, cancelled, and failed runs retain parseable partial output for
  diagnosis.
- Cursor requests its CLI sandbox for isolated writes only where supported;
  Windows retains worktree isolation with an explicit host-write warning.
- The CLI uses a Node shebang, exposes `--version`, and validates provider names
  for capability and model queries.

## 0.1.0

- Initial Claude Code, Codex CLI, and Cursor Agent adapters.
