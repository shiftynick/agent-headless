---
name: agent-headless
description: Run Claude Code, Codex, Cursor Agent, or Antigravity through the agent-headless CLI with explicit access modes, safe provider authentication, and normalized results. Use when an agent needs to invoke one of these installed provider CLIs headlessly.
---

# agent-headless

`agent-headless` is a typed local runner over provider CLIs that are already
installed and authenticated. It is not an MCP server, a model host, or a way to
obtain credentials. Use `npx -y agent-headless@latest` when the binary is not
on `PATH`.

## Safe start

Never ask for, print, write, or commit provider credentials. Authenticate each
provider through its official CLI or the runtime's secret store. This package
only accepts optional executable-path overrides: `CLAUDE_BIN`, `CODEX_BIN`,
`CURSOR_AGENT_BIN`, and `AGY_BIN`.

Start with the read-only probe and compact command discovery:

```powershell
npx -y agent-headless@latest doctor
npx -y agent-headless@latest capabilities codex
npx -y agent-headless@latest models codex
npx -y agent-headless@latest --help
```

`doctor` is a capability probe: it reports whether an executable is usable and
does not send a model prompt. The `models` command may query the provider's
model catalog, so use it only after its ordinary CLI authentication is ready.

## Authority rules

- Default to `--access answer-only`; use `inspect` for explicit read-only
  workspace context.
- Use `edit-workspace` only when the user has authorized direct changes.
- Use Cursor `edit-isolated` only when a named isolated worktree is appropriate;
  it isolates checkout edits, not arbitrary host-side effects.
- Never add or emulate provider flags that bypass approvals or sandboxes. This
  package intentionally does not pass those flags.
- Give a specific `--cwd`, named `--model`, and bounded prompt for meaningful
  runs. Preserve the normalized result and check the reported workspace before
  retrying an `unparsed` result.

## Common forms

```powershell
# Read-only inspection; providers must already be authenticated.
npx -y agent-headless@latest run --provider codex --cwd N:\project --access inspect --effort medium --prompt "Summarize the repository architecture."

# Structured result for a supervisor or another program.
npx -y agent-headless@latest run --provider claude --cwd N:\project --model sonnet --access answer-only --prompt "List the focused test failures." --json

# Explicitly authorized isolated Cursor work.
npx -y agent-headless@latest run --provider cursor --cwd N:\project --model <model-id> --access edit-isolated --prompt "Implement the approved fix." --json
```

Exit `0` means success, `1` means a usage or provider failure, and `2` means a
provider exited cleanly but its output could not be interpreted. Exit `2` is
not proof that no work occurred—inspect the reported workspace first.
