# agent-headless

One typed, scriptable interface for running Claude Code, Codex, and Cursor
Agent headlessly. The package normalizes the intent common to all three CLIs
while rejecting unsupported combinations instead of silently dropping them.

## Install and requirements

- Node.js 20 or newer
- One or more authenticated provider CLIs: `claude`, `codex`, or Cursor's
  `agent`

Until the package is published to npm, install a released GitHub checkout or a
local clone:

```powershell
npm install --global N:\agent-headless
# after a release tag is pushed:
npm install --global github:shiftynick/agent-headless#v0.2.0
```

Bun is used only to build and test this repository. Consumers execute the
checked-in `dist/` package with Node.

Environment overrides are supported for nonstandard installs:
`CLAUDE_BIN`, `CODEX_BIN`, and `CURSOR_AGENT_BIN`.

## CLI

```powershell
agent-headless capabilities
agent-headless models cursor

agent-headless run `
  --provider codex `
  --cwd N:\some-project `
  --access inspect `
  --effort medium `
  --prompt "Summarize the repository architecture."

agent-headless run `
  --provider cursor `
  --cwd N:\some-project `
  --model gpt-5.3-codex-low `
  --access answer-only `
  --prompt-file review.txt `
  --json
```

Prompts can also be piped over stdin. `--json` prints the normalized result;
without it the CLI prints only the final answer.

The CLI exits `0` on success, `2` when the provider exited cleanly but its
output could not be read (`status: "unparsed"` - the work may have completed,
so check the reported workspace before retrying), and `1` for every other
non-success outcome.

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

### Result status and workspace

`result.status` is one of `succeeded`, `failed`, `unparsed`, `timed-out`, or
`cancelled`. `unparsed` means the provider exited `0` but its output could not be
interpreted - either nothing parsed at all, or a readable stream that carries no
terminal marker. Unreadable output is not evidence of failure, and the run's
changes may well exist. A failure the provider states outright - a Codex
`turn.failed`, or a top-level `error` event from any provider - is `failed` even
on a clean exit, and `result.warnings` carries the provider's own wording. When a
stream holds more than one terminal marker, the last one decides: a success
result followed by an `error` is `failed`, and an `error` followed by a later
success result is `succeeded`.
Individual unparseable JSONL lines never discard the rest of a stream; they are
reported as bounded entries in `result.warnings`.

Every run reports `result.workspace` - required on `AgentResult`, so no null
check is needed - carrying the `cwd` the provider ran in, the effective `access`
mode, and for isolated runs the `worktreeName`/`worktreeBase` the runner chose
plus the observed `worktree` path when the provider disclosed one (read only
from a session/init event, never from a tool or status event's `cwd`). That
makes delegated work locatable even when the stream is unreadable.

### Cursor's default model

Cursor no longer requires an explicit model. When a request names none, the
runner uses the exported constant `CURSOR_DEFAULT_MODEL`
(`cursor-grok-4.5-medium`) - read the constant rather than hardcoding the string.
An explicit `--model` / `request.model` always wins; `auto` is still refused,
because a run must be attributable to a named model.

A defaulted run is labelled: `result.modelDefaulted` is `true` and
`result.modelRequested` carries the effective model, so both "which model ran"
and "who chose it" are answerable. Callers that require an operator-chosen model
- cold code review, where independence means the reviewing model's family was
deliberately picked to differ from the implementer's - must reject a result with
`modelDefaulted === true` instead of comparing strings against the constant.

If Cursor rejects the model, the result's `warnings` say so and point at
`agent-headless models cursor`; when the rejected model was the default, the
live model list is fetched once and included, since the caller never chose it.
No model listing happens on any other path.

### Isolated worktrees are always named

Cursor accepts a bare `--worktree` and then names the worktree itself without
reporting the choice, which loses the work when the stream is unreadable. The
runner therefore never sends a bare `--worktree`: if `edit-isolated` is requested
without `providerOptions.cursor.worktreeName`, it generates
`agent-headless-<time>-<random>`, passes it explicitly, and reports it as
`result.workspace.worktreeName` on every outcome, failures and timeouts included.
A caller-supplied name is used and reported unchanged. Tests can pin the
generated name with the `generateWorktreeName` option of `runAgent`.

## Compatibility matrix

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

The same matrix is available programmatically alongside executable status.
Unsupported edges are rejected rather than ignored: Cursor has no ephemeral
session or schema output; Codex cannot change access or additional directories
when resuming and has no `max` effort mapping.

The library never enables provider flags that bypass approvals or sandboxes.
New sessions default to `answer-only`; inspection and write access must be
requested explicitly.

Capability probing is runtime evidence, not a static promise. Each report says
whether the configured executable is `available`, `missing`, or `unusable`, and
includes the resolved executable path. Provider events retain their raw payload
while also receiving a stable lifecycle `kind` suitable for supervisors and
logs.

Codex does not let a resumed invocation replace the original sandbox policy.
Accordingly, Codex resume calls use `access: "inherit-session"`; asking a
resumed session to claim a new read or write boundary is rejected.

Cursor workspace trust is also explicit: pass `--trust-workspace` (or
`providerOptions.cursor.trustWorkspace`) only after the caller has established
that the selected workspace is trusted. Cursor persists sessions because its
CLI does not offer an ephemeral mode.

On Windows, Cursor's worktree isolates checkout edits but does not sandbox
arbitrary shell effects. Treat `edit-isolated` as real host-write authority and
do not delegate the write when that residual risk is unacceptable.

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

`bun run check` also loads the built package under Node and exercises it with a
deterministic injected executor. Applications can use the same optional second
argument to `runAgent` to test without spawning a provider:

```ts
await runAgent(request, { execute: fakeExecutor });
```

Live tests are opt-in because they use authenticated model calls:

```powershell
$env:AGENT_HEADLESS_LIVE = "1"
bun test test/live.test.ts
```
