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
or chat. `.env` remains ignored. Configuration comes from the executable-path
overrides listed above and the update-check environment settings below.

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
agent-headless check-updates

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

### Package update notices

`run` and `doctor` automatically check npm for a newer stable agent-headless
release. When one is available, they print a notice on stderr. `run --json`
also includes an `update` object, so supervisors can inspect it directly:

```json
{
  "currentVersion": "0.7.0",
  "status": "checked",
  "latestVersion": "0.8.0",
  "updateAvailable": true
}
```

These versions are illustrative. `agent-headless check-updates` prints just
this JSON object; add `--force` to refresh it immediately. An unreachable
registry reports `status: "unavailable"`, with no `updateAvailable` value;
it does not claim the installation is current. Checks never install anything
or change provider results or exit codes.

Successful checks are cached for 24 hours; failed checks for one hour. The
registry request has a 1.5-second deadline and runs alongside the provider.
Only public package metadata is requested from
`https://registry.npmjs.org/agent-headless/latest`; no prompts, project paths,
or provider credentials are sent. The cache lives in
`$XDG_CACHE_HOME/agent-headless`, `%LOCALAPPDATA%/agent-headless` on Windows,
or `~/.cache/agent-headless` otherwise. Cache write failures are harmless.

Set `AGENT_HEADLESS_NO_UPDATE_CHECK=1` to disable both automatic and explicit
checks (including `--force`). Help, `--version`, `models`, and `capabilities`
do not check for updates. `doctor` retains its existing capability JSON shape
and puts update notices only on stderr.

Library calls have no automatic registry traffic by default. Call the exported
`checkForUpdates()` directly, or use
`runAgent(request, { checkForUpdates: true })` to include `result.update`.
An update notice means the consuming repo should review and update its
dependency and lockfile. Model IDs remain free-form even when the package
version is pinned.

The CLI exits `0` on success, `2` when the provider exited cleanly but its
output could not be read (`status: "unparsed"` - the work may have completed,
so check the reported workspace before retrying), and `1` for every other
non-success outcome.
On POSIX, SIGINT and SIGTERM cancel the provider process group and wait for
cleanup before exiting with `130` or `143`. Library callers cancel with
`request.signal`; on Windows cancellation terminates the provider process tree.

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

Failures, timeouts, and cancellations retain any session ID and model identity
already reported by the provider. A failed fork never substitutes the original
session's ID for the new session's ID. Provider errors are included in warnings,
printed on stderr for non-success CLI runs, and included in `assertSucceeded`
errors when stderr is empty.

### Structured output and output limits

Claude's schema-constrained payload is available as `result.structuredOutput`,
including when its text result is empty. Without `--json`, the CLI prints this
payload as JSON; with `--json`, it remains a field of the normalized result.

Provider output is bounded by default: 16 MiB of stdout and 1 MiB of stderr.
Set `request.outputLimits: { stdoutBytes, stderrBytes }`, or the CLI options
`--max-stdout-bytes` and `--max-stderr-bytes`, to change these positive limits.
Exceeding either stops the provider, retains bounded partial output and events,
and returns `failed` with an explicit incomplete-output warning. A terminal
success marker before overflow does not turn the truncated run into success.
Cancellation and timeout statuses take precedence if they also occurred.

Structured events are decoded as they arrive and reused for final parsing.
`onEvent` receives the live events; the returned event list is still retained
within the output limit. A throwing synchronous callback is reported as a
warning and does not terminate provider execution. This is a bounded in-memory
transcript, not an unlimited streaming archive.

### The model catalog is a hint, not a gate

`agent-headless models <provider>` prints the model IDs this runner knows about,
and `SUPPORTED_MODELS` / `supportedModels` expose the same lists. A model that is
not on a list is still passed to the provider CLI unchanged: the provider is the
authority on its own catalog, so a model released after this package does not
need a release here or a downstream patch. If the provider does not accept the
name, the run fails normally with the provider's own message.

Two refusals are policy rather than catalog and still fail before launch:
Cursor's `auto`, which names no accountable model, and Cursor Grok `*-fast`
variants.

An off-catalog run is labelled rather than quietly trusted. `result.modelUncatalogued`
is `true` and `result.warnings` carries `model "<id>" is not in agent-headless's
known <provider> catalog; passed through unverified - check modelObserved`.
Claude's `fable` / `opus` / `sonnet` aliases count as catalogued, and Antigravity -
whose catalog is read live through `agy models` - never sets the flag.

Because the requested ID is no longer checked against anything, a caller that
needs exact attribution must compare `result.modelRequested` with
`result.modelObserved` rather than trusting what it asked for. Runs that persist
no rollout - ephemeral Codex runs - report no `modelObserved` at all, so an
uncatalogued model on that path is unverifiable from the result alone.

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

Codex's JSON event stream carries no model field at all, so its `modelObserved`
is recovered from the session rollout file, which records the effective model
on every `turn_context` line; the last one wins. Runs that persist no rollout
report no observed model rather than echoing the requested one.
Rollout lookup uses the run's effective environment, including `CODEX_HOME`
overrides and deletions. It scans at most 10,000 entries and reads only the last
2 MiB of a matching rollout. If the relevant metadata falls outside these
bounds, attribution is omitted rather than guessed.

### Isolated worktrees are always located

Claude now generates a unique worktree name when none is provided and reports
that name even on failure. Explicit `providerOptions.claude.worktreeName`
continues to win. Its location is reported when the provider discloses it.

Recent Codex CLIs support `edit-isolated` through native `--worktree` with the
`workspace-write` sandbox. These runs default to persistent sessions so their
provider-created checkout can be recovered from session metadata; explicitly
ephemeral isolated runs are rejected. The path is reported when the provider's
events or rollout disclose it. A launch that fails before creating metadata may
have no recoverable path. `doctor codex` checks the installed CLI's help for this
feature; older CLIs may reject it and should be upgraded.

For Claude and Codex, `session: { mode: "resume", id, fork: true }` starts a
separate conversation using the provider's native fork operation. The CLI form
is `--resume <id> --fork`. Cursor and Antigravity explicitly reject forks.
Codex forks, like resumes, use `access: "inherit-session"`.

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
| Isolated worktree edits | yes | recent CLI; persistent session | yes | unavailable |
| Ephemeral sessions | yes | yes | unavailable | unavailable |
| Resume | yes | yes | yes | yes |
| Fork session | yes | recent CLI | unavailable | unavailable |
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
Reports also include `detectedFeatures` from read-only help probes and
`supportsFork`. Optional Codex worktree/fork support is detected from the selected
executable's `exec --help`; model/schema flags are checked against help rather
than assumed present. A failed help probe reports no detected features. The
base access/session mappings still describe the adapter's contract; probes do
not authenticate or perform model calls. Explicit runs pass supported adapter
flags to the provider, which remains the final authority on acceptance.

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
model invocation and asks for an exact model ID. That resolution reads the
catalog, so an off-catalog Cursor model keeps the ID the caller gave and
receives the effort as a `[effort=...]` parameter instead.

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

CI runs Node 20, 22, and 24 on both Linux and Windows. Native process regression
tests cover early stdin closure, process-tree cancellation, output limits, and
CLI rendering. POSIX signal tests run on Linux; Windows tests exercise taskkill
and `.cmd` execution. Versioned provider protocol fixtures and captured help
snapshots live in `test/fixtures/protocols/`; their README records provenance.

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
