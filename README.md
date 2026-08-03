# agent-headless

One typed, scriptable interface for running Claude Code, Codex, and Cursor
Agent headlessly. The package normalizes the intent common to all three CLIs
while rejecting unsupported combinations instead of silently dropping them.

## Requirements

- Bun 1.2 or newer
- One or more authenticated provider CLIs: `claude`, `codex`, or Cursor's
  `agent`

Environment overrides are supported for nonstandard installs:
`CLAUDE_BIN`, `CODEX_BIN`, and `CURSOR_AGENT_BIN`.

## CLI

```powershell
bun run src/cli.ts capabilities
bun run src/cli.ts models cursor

bun run src/cli.ts run `
  --provider codex `
  --cwd N:\some-project `
  --access inspect `
  --effort medium `
  --prompt "Summarize the repository architecture."

bun run src/cli.ts run `
  --provider cursor `
  --cwd N:\some-project `
  --model gpt-5.3-codex-low `
  --access answer-only `
  --prompt-file review.txt `
  --json
```

Prompts can also be piped over stdin. `--json` prints the normalized result;
without it the CLI prints only the final answer.

## Library

```ts
import { assertSucceeded, runAgent } from "agent-headless";

const result = await runAgent({
  provider: "claude",
  prompt: "Review this diff for correctness.",
  cwd: "N:\\some-project",
  model: "sonnet",
  effort: "high",
  access: "inspect",
  session: { mode: "ephemeral" },
});

assertSucceeded(result);
console.log(result.finalText, result.usage);
```

## Capability boundaries

| Capability | Claude | Codex | Cursor |
| --- | --- | --- | --- |
| Read-only inspection | yes | yes | yes |
| In-place workspace edits | yes | yes | intentionally unsupported |
| Isolated worktree edits | yes | unsupported | yes |
| Ephemeral sessions | yes | yes | unavailable |
| Resume | yes | yes | yes |
| Effort | native flag | config override | parameterized model ID |
| JSON Schema output | yes | file-based | unavailable |
| Per-run budget | yes | unavailable | unavailable |

The library never enables provider flags that bypass approvals or sandboxes.
Write access must be requested explicitly.

Codex does not let a resumed invocation replace the original sandbox policy.
Accordingly, Codex resume calls use `access: "inherit-session"`; asking a
resumed session to claim a new read or write boundary is rejected.

Cursor workspace trust is also explicit: pass `--trust-workspace` (or
`providerOptions.cursor.trustWorkspace`) only after the caller has established
that the selected workspace is trusted. Cursor persists sessions because its
CLI does not offer an ephemeral mode.

For Cursor, `effort` resolves to an available exact model variant such as
`gpt-5.6-terra-low`; it is not blindly appended to the model ID. If the
selected model family has no requested effort variant, the run fails before
model invocation and asks for an exact model ID.

## Development

```powershell
bun install
bun run check
bun run build
```

Live tests are opt-in because they use authenticated model calls:

```powershell
$env:AGENT_HEADLESS_LIVE = "1"
bun test test/live.test.ts
```
