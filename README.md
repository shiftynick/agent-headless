# agent-headless

One typed, scriptable interface for running Claude Code, Codex, Cursor Agent,
and Antigravity CLI headlessly. The package normalizes the intent common to all four CLIs
while rejecting unsupported combinations instead of silently dropping them.

It is for automation and agent supervisors that need one explicit, typed contract
over the provider CLIs already authenticated on the machine. It is not a new
model service, an MCP server, or an authentication proxy.

## Install and requirements

- Node.js 20 or newer
- One or more authenticated provider CLIs: `claude`, `codex`, Cursor's `agent`,
  or Antigravity's `agy`

Run it without a global install:

```powershell
npx -y agent-headless@latest --help
npx -y agent-headless@latest doctor
```

Or install it globally:

```powershell
npm install --global agent-headless
agent-headless doctor
```

Bun is used only to build and test this repository. Consumers execute the
checked-in `dist/` package with Node.

Environment overrides are supported for nonstandard installs:
`CLAUDE_BIN`, `CODEX_BIN`, `CURSOR_AGENT_BIN`, and `AGY_BIN`.

On Windows, when `AGY_BIN` is unset and `agy` is not on PATH, Antigravity also
uses the standard per-user installer path `%LOCALAPPDATA%\agy\bin\agy.exe`.
The runner does not modify PATH. Set `AGY_BIN` when the CLI is installed
elsewhere.

## For agents

When this package is added to a project, load the bundled
[`agent-headless` skill](skills/agent-headless/SKILL.md) before delegating work.
It describes the safe defaults and the access model shared by the provider
adapters. If the runtime cannot install project skills, read that file first.

This package uses the authentication already configured by each provider CLI;
it never accepts, stores, or prints provider tokens. Authenticate with the
provider's own supported flow or a runtime secret store, never in source control
or chat. `.env` remains ignored. The only configuration this package reads is
the optional executable-path overrides listed above.

Start with a read-only discovery check, then choose a named model before a
meaningful run:

```powershell
npx -y agent-headless@latest doctor
npx -y agent-headless@latest capabilities codex
npx -y agent-headless@latest models codex
npx -y agent-headless@latest --help
```

`doctor` is an alias for the read-only capability probe. It reports whether the
provider executable can be found and queried; it does not send a prompt or
enable a permission-bypass flag.

## CLI

```powershell
agent-headless capabilities
agent-headless models <claude|codex|cursor|antigravity>

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
mode, and for isolated runs the `worktreeName` the runner pinned, the
`worktreeBase` Git ref when one was requested, and the `worktree` path itself.
See [Isolated worktrees are always located](#isolated-worktrees-are-always-located)
for where that path comes from and when it can still be absent.

### Cursor's default model

Cursor no longer requires an explicit model. When a request names none, the
runner uses the exported constant `CURSOR_DEFAULT_MODEL`
(`cursor-grok-4.6-medium`) - read the constant rather than hardcoding the string.
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
supported model list is included, since the caller never chose it.
No model listing happens on any other path.

### Principal and helper model attribution

`result.modelObserved` identifies the principal model that produced the
provider response. For Claude structured runs, the top-level assistant stream
is authoritative, with session initialization and then `modelUsage` as
fallbacks. Claude may include internal helper models in `modelUsage`; these are
reported separately in `result.helperModelsObserved` and never replace the
principal attribution. Callers should use `modelObserved` for independence
checks and retain `helperModelsObserved` as supporting execution evidence. If a
usage-only result has no uniquely attributable principal, both fields are
omitted rather than inferred from object order.

### Isolated worktrees are always located

Cursor accepts a bare `--worktree` and then names the worktree itself without
reporting the choice, which loses the work when the stream is unreadable. The
runner therefore never sends a bare `--worktree`: if `edit-isolated` is requested
without `providerOptions.cursor.worktreeName`, it generates
`agent-headless-<time>-<random>`, passes it explicitly, and reports it as
`result.workspace.worktreeName` on every outcome, failures and timeouts included.
A caller-supplied name is used and reported unchanged. Tests can pin the
generated name with the `generateWorktreeName` option of `runAgent`.

A name is not a location, so the runner also reports `workspace.worktree`, an
absolute path, on every outcome:

- `workspace.worktreeSource === "reported"` - the provider disclosed the path and
  it wins, because the provider is authoritative about where it put the work. A
  disclosed path is made absolute first - a relative one resolves against the
  run's `cwd` - so the field is absolute whatever the provider printed; a
  disclosure with nothing to resolve falls back to the derived path.
- `workspace.worktreeSource === "derived"` - the runner constructed the path from
  the pinned name and Cursor's fixed layout,
  `<CURSOR_WORKTREES_ROOT|~/.cursor/worktrees>/<repo-slug>/<name>`, where
  `repo-slug` is the slugified base name of the repository root. Nothing is
  parsed, so the path is known before the provider writes a byte - which is what
  makes an `unparsed`, `failed`, `timed-out` or `cancelled` run locatable.
  `workspace.worktreeRoot` is reported alongside it and
  `join(worktreeRoot, worktreeName)` is exactly `worktree`. A derived path says
  where the worktree is *if the run got far enough to create one*; a run that
  died at launch leaves nothing there.

`providerOptions.cursor.worktreeBase` is Cursor's `--worktree-base`: the Git ref
the worktree branches from, **not** a directory. Cursor has no flag for the
location; export `CURSOR_WORKTREES_ROOT` (honoured through `request.env`) to
move it. `workspace.worktree` is omitted rather than guessed when no worktree can
exist - a `worktreeName` outside Cursor's `[A-Za-z0-9._-]+`, a `cwd` that
`git rev-parse --show-toplevel`, run under this request's `env`, does not resolve
to a repository root (so an empty or malformed `.git` entry derives nothing), or
no resolvable home directory - and, for Claude's `--worktree`,
whenever its output discloses no path, since Claude documents no fixed layout.

`cursorWorktreePath`, `cursorWorktreesRoot` and `cursorRepoSlug` are exported for
callers that want to compute or verify the location themselves.

## Compatibility matrix

| Capability | Claude | Codex | Cursor | Antigravity |
| --- | --- | --- | --- | --- |
| Read-only inspection | yes | yes | yes | plan mode |
| In-place workspace edits | yes | yes | intentionally unsupported | yes |
| Isolated worktree edits | yes | unsupported | yes | unavailable |
| Ephemeral sessions | yes | yes | unavailable | unavailable |
| Resume | yes | yes | yes | yes |
| Effort | native flag | config override | parameterized model ID | native flag (low/medium/high) |
| JSON Schema output | yes | file-based | unavailable | yes |
| Per-run budget | yes | unavailable | unavailable | unavailable |

The same matrix is available programmatically alongside executable status.
Antigravity uses AGY's `--print` / `--output-format stream-json` contract and
live-lists the authenticated account's models through `agy models`; its catalog
is intentionally not pinned in `SUPPORTED_MODELS`. Its `plan` mode is used for
`answer-only` and `inspect` requests, while explicit `edit-workspace` uses
`accept-edits`. AGY has no ephemeral-session or isolated-worktree mode. Its
terminal-command permissions are configured separately by AGY, so its plan mode
is not a filesystem sandbox; this library never enables AGY's
`--dangerously-skip-permissions` flag.

Unsupported edges are rejected rather than ignored: Cursor and Antigravity have no ephemeral
sessions; Cursor has no schema output; Codex cannot change access or additional directories
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

Live tests are read-only answer-only prompts. They run only when explicitly
enabled and use whichever provider CLIs are already authenticated; they never
read credentials from project files or print them.

## Maintainer release

Run the complete local gate before opening a pull request:

```powershell
npm ci
bun run check
npm pack --dry-run
npm run audit:prod
git diff --check
```

CI repeats those checks on supported Node releases. Publishing is deliberately
manual and uses npm Trusted Publishing with a short-lived GitHub Actions OIDC
credential—there is no `NPM_TOKEN` in this repository. The first npm release
must exist before npm can attach a trusted publisher, so it may require an
interactive, 2FA-protected maintainer publish. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the exact release, trusted-publisher,
registry verification, tag, and GitHub Release procedure.
