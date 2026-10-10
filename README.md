# agent-guard-hooks

[![test](https://github.com/Kanji-Miyatani/agent-guard-hooks/actions/workflows/test.yml/badge.svg)](https://github.com/Kanji-Miyatani/agent-guard-hooks/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[日本語](README.ja.md)

This repository holds safety hooks, permission rules and tests for running Claude Code (an AI coding agent) in a Next.js / TypeScript repository. The hooks are plain Node.js scripts. They need no dependencies and come with 149 tests.

> **Unofficial.** This project is not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
>
> **The hook messages and the templates are written in Japanese for now.** The full Japanese guide is a free book on Zenn: [AIコーディングエージェントの安全な初期設定](https://zenn.dev/yakankun/books/claude-code-starter-kit-nextjs).

## What it stops

| Hook | Runs on | What it does |
|---|---|---|
| `guard-bash.mjs` | `PreToolUse`, `Bash` and `PowerShell` | Inspects each shell command before it runs. Dangerous commands are denied. Risky ones need your confirmation. |
| `guard-files.mjs` | `PreToolUse`, `Edit`, `Write` and `NotebookEdit` | Blocks edits to files the agent should not touch. |
| `format-lint.mjs` | `PostToolUse`, `Edit` and `Write` | After each edit it runs your project's own Prettier and ESLint on that one file. ESLint errors go back to the agent so it can fix them. If Prettier or ESLint is not installed, nothing happens. |
| `session-context.mjs` | `SessionStart` | Tells the agent the current branch, the number of uncommitted files and the package manager. |

**`guard-bash` denies these commands:**

- `sudo`
- Recursive deletes that point at the root, a home directory, an absolute path, a parent directory, a wildcard, a variable or `.git`. Deleting build output such as `node_modules`, `.next` or `dist` is allowed. Any other recursive delete needs your confirmation.
- Force pushes: `--force`, `-f`, `+refspec` and `--mirror`.
- `git reset --hard`, `git clean -f`, `git filter-branch` and `git filter-repo`.
- `npm`/`pnpm`/`yarn`/`bun publish` and `unpublish`.
- `chmod -R 777`.
- Piping a downloaded script into a shell, such as `curl … | sh` or `irm … | iex`.
- Reading `.env` files, for example `cat .env.local`. `.env.example` is allowed.
- `shutdown`, `reboot`, `mkfs` and `dd of=/dev/…`.

**`guard-bash` asks for your confirmation on these commands:**

- `--force-with-lease`
- Deleting a remote branch
- `git checkout -- .` and `git restore .`
- `git stash drop` and `git branch -D`
- `find -delete`
- Printing all environment variables
- `prisma migrate reset`
- `DROP` or `TRUNCATE` through `psql` and similar tools
- PowerShell `-EncodedCommand`

`guard-bash` also checks commands nested inside other commands:

- Commands joined with `&&`, `||`, `;`, `|` or `&`
- Subshells, `$( … )` and backticks
- `bash -c`, `eval` and `xargs`
- Heredocs passed to a shell
- PowerShell `-Command` and `Invoke-Expression`
- `cmd /c`

**`guard-files` denies edits to these files:**

- `.env*` files, except `.env.example`
- Private keys
- Anything inside `.git/`, `node_modules/` or `.next/`
- Lockfiles
- `next-env.d.ts`

It asks for your confirmation before an edit to `.claude/settings.json` or `.claude/hooks/`.

**`.claude/settings.json`** registers the four hooks above. It also contains:

- Allow rules for read-only git commands and for lint, typecheck, test and build
- Ask rules for commands such as `git push`, package installs, `npx`, `curl` and deploy CLIs
- Deny rules for reading `.env` files, keys, `~/.ssh` and `~/.aws`
- A setting that turns off bypass-permissions mode (`disableBypassPermissionsMode`)

The repository also includes:

- 4 skills: `/team-review`, `/test-fix`, `/pr-description` and `/explain`
- A review subagent that has no file-editing tools
- Folder-specific rules for the App Router and for tests

### Limits

These are string-based checks. They are not a complete defense. A command written in an unusual way can get past them. Use them together with the deny rules, sandboxing and backups.

## Requirements

- Claude Code. Tested with 2.1.295.
- Node.js 22 or 24. The tests also pass on Node.js 20, but Node.js 20 stopped receiving support on 2026-04-30.
- git

## Install

Run these commands from your project root. On Windows, run them in Git Bash, which comes with Git for Windows.

```bash
tmp=$(mktemp -d)
git clone --depth 1 https://github.com/Kanji-Miyatani/agent-guard-hooks.git "$tmp"
cp -r "$tmp/.claude" .
[ -e CLAUDE.md ] || cp "$tmp/templates/CLAUDE.md" CLAUDE.md
cat "$tmp/templates/gitignore-additions.txt" >> .gitignore
rm -rf "$tmp"
```

> **If your project already has a `.claude/settings.json`,** `cp -r` overwrites it. Back up your file first, then merge the two files by hand. An existing `CLAUDE.md` is left alone.

1. Fill in the blanks (`【記入：…】`) in `CLAUDE.md`, and delete the lines you don't need.
2. Run the hook tests in your project:

   ```bash
   node --test .claude/hooks/__tests__/hooks.test.mjs
   ```

   You should see 148 passing tests and 1 skipped. The skipped test checks `examples/`, which you don't copy into your project.
3. Start Claude Code and run `/hooks` to check that the four hooks are registered.

If you work on Windows without Git for Windows, Claude Code uses PowerShell, and the `Bash(...)` rules in `settings.json` don't apply. In that case, copy `examples/settings.local.powershell.example.json` to `.claude/settings.local.json`. The hooks themselves check PowerShell commands as well.

## What has been tested

- **Unit tests.** The tests feed each hook the same JSON that Claude Code sends and check the exit code and the output. All 149 tests passed on Linux with Node.js 20.20.0, 22.22.0 and 24.21.0. GitHub Actions also runs them on Linux, macOS and Windows; the badge above shows the latest result.
- **A real Claude Code session.** On 2026-10-10, Claude Code 2.1.295 ran headless (`claude -p`) in a test repository. In that session:
  - guard-bash stopped `git push --force origin main` before it ran.
  - A deny rule in the settings stopped a write to `.env.local`.
  - format-lint returned an ESLint parse error to the agent.
  - session-context passed the branch name to the agent.

**Not tested yet:**

- The interactive UI
- A real Next.js application
- Running the hooks inside Claude Code on macOS or Windows

## Repository layout

| Path | What it is | Copy into your project? |
|---|---|---|
| `.claude/settings.json` | Permission rules and hook registration | Yes |
| `.claude/hooks/` | The four hooks and their tests | Yes. You can delete the tests. |
| `.claude/skills/`, `.claude/agents/`, `.claude/rules/` | Skills, the review subagent and folder rules | Yes. Delete the ones you don't need. |
| `templates/CLAUDE.md` | Project instructions template | Yes, as `CLAUDE.md` |
| `templates/gitignore-additions.txt` | Lines to append to `.gitignore` | Append them |
| `examples/` | Example personal settings, including PowerShell rules | Optional, as `.claude/settings.local.json` |

## Customize

- To change which files are protected, edit `PROTECTED_RULES` in `.claude/hooks/guard-files.mjs`.
- To change which build-output folders may be deleted, edit `SAFE_RM_TARGETS` in `.claude/hooks/guard-bash.mjs`.
- Run the tests again after every change.

## License

[MIT](LICENSE)
