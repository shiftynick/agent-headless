# Contributing and release operations

This is the fresh-session maintainer runbook. Keep changes focused, preserve
unrelated working-tree edits, and make the release evidence reproducible.

## Start here

1. Read `README.md` and `skills/agent-headless/SKILL.md`.
2. Inspect `git status --short --branch`, open pull requests, the GitHub remote,
   and the current npm version before changing anything.
3. Install and validate:

   ```powershell
   npm ci
   bun run check
   npm pack --dry-run
   npm run audit:prod
   ```

`bun run check` runs TypeScript, mocked/unit tests, builds `dist/`, and launches
the compiled CLI from outside the repository for no-configuration help/version
coverage. The live provider tests are opt-in (`AGENT_HEADLESS_LIVE=1`),
answer-only, and read-only. Run them only with provider authentication supplied
through its own CLI or a secret store; never commit `.env` or print credentials.

This repository tracks both `bun.lock` and `package-lock.json`: update both when
changing dependencies, then rerun the complete gate above.

## Day-to-day changes

- Branch from up-to-date `main` as `agent/<short-description>`.
- Keep each pull request scoped. In a mixed tree, stage explicit paths rather
  than `git add -A`.
- Before every PR, run the complete local gate from **Start here**.
- Open a ready PR against `main` and wait for the GitHub CI matrix to pass on
  all supported Node versions.
- Squash-merge only after green CI, verify the post-merge `main` run, then
  delete the merged remote and local branch. Do not delete a branch until its
  commits have been checked against `main`.

## Versioning and npm publishing

Published npm versions are immutable. Use a new semantic version and keep all
three version sources synchronized:

- `package.json` and the root package entry in `package-lock.json`
- `src/version.ts`
- the compiled CLI assertion in `test/node-runtime.test.mjs`

The last test compares `agent-headless --version` from `dist/` with
`package.json`, preventing CLI/package drift from reaching the registry.

Before publishing, confirm the target is unused and the checked-out commit is
the intended green `main` revision:

```powershell
npm view agent-headless@<version> version --json
git status --short --branch
```

The manual **Publish npm package** workflow only runs on `main`; it executes
`npm ci`, the complete tests, package dry-run, production dependency audit, and
`npm publish` via OIDC. It intentionally contains no `NPM_TOKEN`.

### First release and Trusted Publishing

npm must know about a package before it can attach a trusted publisher. For the
first version only, a maintainer must publish interactively from the exact
green `main` commit with npm 11.5.1+ and 2FA enabled:

```powershell
npm publish --access public
```

Complete the 2FA prompt locally; do not paste a one-time code or token into
chat. Once the package exists, open npmjs.com → **agent-headless** →
**Settings** → **Trusted Publisher** and add:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `shiftynick` |
| Repository | `agent-headless` |
| Workflow filename | `publish.yml` |
| Allowed action | `npm publish` |

The package's `repository.url` must remain exactly
`git+https://github.com/shiftynick/agent-headless.git`. After the trusted
publisher succeeds, keep 2FA enabled and do not add an automation token or an
`NPM_TOKEN` repository secret. GitHub-hosted runners with `id-token: write`
receive a short-lived OIDC identity, and npm automatically adds provenance for
this public package.

For subsequent releases, run **Publish npm package** from `main`. After every
publish, verify both the registry and a clean outside-repository invocation:

```powershell
npm view agent-headless@<version> version dist-tags.latest gitHead --json
Set-Location (New-Item -ItemType Directory -Path ([IO.Path]::Combine($env:TEMP, "agent-headless-npx-<version>")) -Force).FullName
npx --yes agent-headless@<version> --version
```

## GitHub tags and releases

npm publication does not make a GitHub Release. Use the `gitHead` recorded in
npm metadata—not a guessed branch tip—to create the matching tag and release:

```powershell
$gitHead = npm view agent-headless@<version> gitHead
gh release create v<version> --target $gitHead --title "v<version>" --generate-notes
```

Then verify the tag target and release URL, return to a clean synchronized
`main`, and delete the merged implementation branch locally and remotely.

## Authentication and live verification

- `doctor` and `capabilities` only probe configured provider executables; they
  do not send a prompt.
- Provider authentication belongs to the provider's official CLI. Store any
  credentials in its supported local store, a secret manager, or an ephemeral
  shell environment.
- Never put credentials in `.env`, source files, GitHub Actions secrets for npm
  publishing, or chat. `.env` and common local variants are ignored.
- Begin automation with `answer-only` or `inspect`. `edit-workspace` and
  `edit-isolated` are explicit authority choices; this package never enables
  provider flags that bypass approvals or sandboxes.
