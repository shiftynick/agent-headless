# Changelog

## 0.4.0

- `models <claude|codex|cursor>` prints a curated supported-model list instead of
  probing Cursor's live catalog (Claude and Codex previously had no listing).
- Off-list `--model` values fail before the provider launches. Supported IDs:
  Claude `claude-fable-5` / `claude-opus-5` / `claude-sonnet-5` (aliases
  `fable` / `opus` / `sonnet`); Codex `gpt-5.6-sol` / `gpt-5.6-terra` /
  `gpt-5.6-luna`; Cursor Grok `cursor-grok-4.5-low|medium|high` plus
  `composer-2.5` and `composer-2.5-fast`. Cursor Grok `*-fast` variants are
  refused. Default Cursor model remains `cursor-grok-4.5-medium`.
- Claude Fable defaults `--effort low` when the caller names Fable and omits
  effort.
- Exported `SUPPORTED_MODELS` / `supportedModels` for callers that need the
  same lists.

## 0.3.0

- JSONL parsing is tolerant: an unparseable line is skipped and reported as a
  bounded warning instead of discarding the rest of the stream. A stream-level
  error is raised only when nothing at all parsed.
- New `unparsed` run status separates "the provider exited 0 but we could not
  read its output" from "the provider failed". The CLI exits `2` for it. A
  failure the provider states explicitly - a Codex `turn.failed`, or a top-level
  `error` event from any provider - is reported as `failed` even on a clean exit
  and carries the provider's own wording. `unparsed` covers both output that
  could not be read at all and a readable stream with no terminal marker.
- Where a stream holds more than one terminal marker, the last one decides, for
  every provider: a success result followed by an `error` is `failed`, and an
  `error` followed by a later success result is `succeeded`.
- Every run reports `result.workspace` (cwd, access, and for isolated runs the
  worktree name, the `--worktree-base` Git ref, and the worktree path itself), so
  delegated work is locatable on success, failure, timeout, and cancellation
  alike. The field is required on `AgentResult`, so consumers need no null check.
  Only a session/init event's differing `cwd` is read as the worktree; a tool or
  status event's `cwd` is not.
- `workspace.worktree` no longer depends on parsing the provider's stream, which
  made it absent in exactly the cases it exists for. When the provider discloses
  no path, the runner derives one from the worktree name it pinned and Cursor's
  fixed layout (`<CURSOR_WORKTREES_ROOT|~/.cursor/worktrees>/<repo-slug>/<name>`),
  so an `unparsed`, `failed`, `timed-out` or `cancelled` isolated Cursor run
  still reports an absolute path. New `workspace.worktreeSource`
  (`reported` | `derived`) says which, and `workspace.worktreeRoot` accompanies a
  derived path. Nothing is guessed: the path is omitted when no worktree can
  exist. `cursorWorktreePath`, `cursorWorktreesRoot` and `cursorRepoSlug` are
  exported so callers can compute the same location.
- `listModels(provider, options)` accepts the executable and env to list from,
  and the listing offered after a rejected default model is resolved against the
  failed run's own `request.env` rather than process-global config.
- Cursor no longer requires an explicit model. A request that names none uses the
  exported `CURSOR_DEFAULT_MODEL` (`cursor-grok-4.5-medium`); an explicit model
  always wins and `auto` is still refused.
- New `result.modelDefaulted` reports whether the runner picked the model. It is
  `true` only when the caller named none, and `modelRequested` now always carries
  the effective model. Callers that require an operator-chosen model - cold
  review, where the reviewing model's family must be deliberately different from
  the implementer's - must reject `modelDefaulted === true`.
- A Cursor failure that looks like a rejected model now says so and points at
  `agent-headless models cursor`; when the rejected model was the default, the
  live list is fetched once and included. No other path lists models.
- Isolated Cursor runs are never launched with a bare `--worktree`. When no
  `worktreeName` is supplied the runner generates one
  (`agent-headless-<time>-<random>`), passes it explicitly, and reports the
  effective name in `result.workspace.worktreeName` on every outcome - so the
  worktree stays locatable even when the stream is unreadable. Tests can pin the
  name with the new `generateWorktreeName` run option.

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
- New sessions default to least-privilege `answer-only`; inspection and write
  access are explicit.

## 0.1.0

- Initial Claude Code, Codex CLI, and Cursor Agent adapters.
