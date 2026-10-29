# Contributing to AI Meter

Read this before opening a pull request, whether you are a person or a coding agent. It is short on purpose.

## What this is

A GNOME Shell extension (GJS, ES modules) that shows Claude Pro/Max usage in the top bar. It reads the login that Claude Code stores at `~/.claude/.credentials.json` and calls `https://api.anthropic.com/api/oauth/usage`, the endpoint behind Claude Code's `/usage`. Nothing else leaves the machine, nothing is written back.

Layout:

- `src/usage.js`: fetch and parse. No GNOME Shell import, so it runs under plain `gjs`.
- `src/extension.js`: the indicator, the dropdown, the polling loop.
- `src/prefs.js` and `src/schemas/`: the settings window and its GSettings schema.
- `install.sh`, `Makefile`, `ci.yml`: install, checks, release.
- `test/`: `parse.js` offline, `fetch.js` against the real endpoint.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body, optional>
```

- `type`: `feat`, `fix`, `docs`, `refactor`, `test`, `ci`, `build`, `chore`. `perf` and `style` are fine too.
- `scope`, optional: `extension`, `prefs`, `usage`, `install`, `ci`, `readme`.
- `subject`: imperative, lowercase, no trailing period, at most 72 characters. Say what changes, not how.
- Body only when the why is not obvious from the diff. One blank line after the subject.
- A breaking change (settings key renamed, minimum GNOME version raised) gets a `!` after the type and a `BREAKING CHANGE:` footer.

Examples:

```
feat(extension): show the weekly percentage in the top bar
fix(usage): read the raw status code, 429 is not in the Soup.Status enum
docs(readme): add a screenshot
chore: bump version to 0.2.0
```

No `Co-Authored-By` or tool trailers.

## Branches and pull requests

- Branch from the latest `main`, name it `<type>/<short-topic>` (`fix/rate-limit`, `feat/weekly-in-panel`).
- One topic per PR. A fix and a refactor are two PRs.
- The PR description says what changed, why, and how it was tested: GNOME Shell version, Wayland or X11, and what you looked at. A visual change gets a screenshot.
- CI must be green. `main` is never force-pushed.
- Squash-merge is fine when the branch is a chain of fixups; otherwise keep the commits, each one buildable.

## Code rules

- Style is enforced by `eslint.config.js`: 4 spaces, single quotes, semicolons, `const` by default. Run `npm run lint` or `make lint`.
- Target GNOME Shell 45 to 49. No API that only exists on one of them without a fallback. Check `shell-version` in `src/metadata.json` when you rely on something new.
- Everything created in `enable()` or `_init()` is torn down in `disable()` or `destroy()`: timers (`GLib.source_remove`), signal handlers, the Soup session. A GNOME reviewer rejects leaks.
- No synchronous I/O or spawning in the Shell process. `src/usage.js` is async end to end; keep it free of Shell imports so `gjs -m test/parse.js` keeps working.
- The usage endpoint rate-limits per account and Claude Code polls it too. Never fetch twice within 30 seconds, always honour `Retry-After`, keep showing the last good values on error.
- Never write to the credentials file, never log the token, never add a network call to another host.
- User-visible text is plain English, sentence case, no jargon from the API (`weekly_scoped` is "Weekly, Fable" to the user).
- No runtime dependencies. `node_modules` is for the linter only; the extension ships as plain files.

## Settings

A new setting touches four places, in one commit: the schema in `src/schemas/`, the row in `src/prefs.js`, the code that reads it, and the table in `README.md`. Pick a default that works for everyone without opening the settings window.

## Testing before a PR

```sh
make check            # eslint, schema validation, offline tests
gjs -m test/fetch.js  # live call with your own Claude Code login
make install          # then log out and back in (Wayland) or Alt+F2, r (X11)
journalctl -b -o cat /usr/bin/gnome-shell | grep -i ai-meter
```

Click the indicator, open Settings, change something, and try one error state (rename `~/.claude/.credentials.json` for a minute) to see the message.

## Releases

Semantic versioning. Bump `version-name` in `src/metadata.json` and `version` in `package.json` in a `chore: bump version to X.Y.Z` commit, then tag `vX.Y.Z` on `main`. CI builds the zip and publishes the GitHub release.

## For coding agents

- Run the checks above before opening a PR, and say in the PR which ones you ran.
- Do not install the extension into a running desktop session unless the user asked for it.
- Keep PRs small and do not change defaults (thresholds, interval, position) without stating why in the PR.
- `ci.yml` lives at the repo root only because the bot that started this repo could not write under `.github/workflows/`; the real file is `.github/workflows/ci.yml`. Edit both, or ask the maintainer to copy.
