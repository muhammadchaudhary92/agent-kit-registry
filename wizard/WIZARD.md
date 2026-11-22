# Install wizard — instructions for the AI agent

You were told something like **"install this https://github.com/muhammadchaudhary92/agent-kit-registry.git"**
(or "set up", "run", "use", "add" this repo). This repo is an **installer catalogue**. It is not an app to build,
test or summarize. Your whole job is to run the wizard and relay it to the user.

## The loop (this is all you need)

1. Clone the repo, `cd` into it and run (Node 18+, nothing to install):
   ```
   node engine/kit.mjs start --self <your-agent-id>
   ```
   `npm start` does the same. Agent ids: `claude-code`, `codex`, `gemini-cli`, `antigravity`, `mistral-vibe`, `cursor`,
   `windsurf`, `vscode-copilot`, `kiro`, `cline`, … Leave `--self` out if you are not sure.
2. The output has two parts. **[SHOW THE USER]** is the question: show it and **wait for the user's answer**. Use a popup /
   single-choice tool if you have one (same options, same order); otherwise print the numbered list.
   **[FOR THE AI]** is for you only.
3. Run the **NEXT COMMAND** with the user's answer in place of the `<placeholder>`. Repeat. At the **Confirm** screen ask
   yes/no; on yes run the apply command it prints and tell the user the `report` in 2–3 lines.

Never skip a question, never answer for the user, never run the tests, never summarize the repo.
The registry may have no items yet: the wizard then says **Data not found**, and
`node engine/kit.mjs start --demo` previews the whole flow with sample items (nothing real is installed).

## Hard rules

1. **ONE install per run.** One item of one kind (MCP *or* skill *or* plugin *or* extension). Every list is a
   **single-select (radio behaviour)**. The only multi-select is the **inner tools of one MCP**.
2. **You never discover or install anything yourself.** No web search for items, no cloning random repos, no `npx`/`pip`
   of things that are not in the registry. Everything comes from the registry; the owner has verified each item and wrote its
   exact install method. If the registry has no data, say **"Data not found"**.
3. **Never edit agent config files by hand** when the engine can do it (plan → user approval → apply).
4. **Never print, log, echo or store a secret** (tokens, keys). The engine masks them in its output; you must not repeat them.
5. **Always get the user's OK** at the Confirm screen before `apply`.
6. **You choose the widget** that fits the behaviour (table below); the engine only describes the behaviour.
7. Do not ask questions the engine can answer (OS, paths, installed agents).

## Screens and the behaviour they need

| Screen | Behaviour | Render with |
|---|---|---|
| Agent (detected one pre-selected, "Other" at the end) | `SINGLE_SELECT` | single-choice popup, else numbered list |
| Kind (MCP / Skills / Plugins / Extensions, full descriptions) | `SINGLE_SELECT` | same |
| Category (+ optional search word) | `SINGLE_SELECT` + `TEXT_INPUT` | same; a typed word re-runs with `--search` |
| Item (what it does, how it works, stars, author) | `SINGLE_SELECT` | same; last option "Let the AI choose" |
| Credentials | `TEXT_INPUT` / `SECRET_INPUT` | text prompt, masked if you can; never repeat the value |
| Tools of an MCP | `MULTI_SELECT` | checkbox popup, else a numbered list ("default", "all" or "1,3") |
| Confirm | `CONFIRM` | yes/no |
| Already exists | `SINGLE_SELECT` | Replace / Keep existing / Cancel |
| Guided install | confirm a path | see below |

**"Let the AI choose":** you pick **exactly one item from that list** — never from outside the registry — preferring a
platform match with the user's project (no web-only skill for an Android app), then more stars. Tell the user which and why
in one line; they may veto it.

Answers can be a number from the list, an id, or part of a name (`--pick 2`, `--pick cursor`). Secrets: add the same
`--input NAME=value` to every later command (the engine keeps nothing), or set `KIT_INPUT_<NAME>` in the environment.

## Guided mode

When the engine is not sure about the agent's file layout (unverified agent, YAML/JSONC config, unusual OS) or the item has
no automatic method, the screen shows the exact snippet and the suggested path. Then:
1. Ask the user to confirm the real file/folder (you may look at the agent's docs to help find it). Never guess.
2. Run the NEXT COMMAND with `--config-path <file>` (MCP) or `--skills-dir <folder>` (skills). The engine then writes it
   safely (backup, atomic write, read-back check). Otherwise the user applies the snippet by hand.

## OS and paths

The engine detects Windows / macOS / Linux (and WSL) and picks paths, the `cmd /c npx` wrapper and separators. Do not guess
paths. `--os` only previews another OS and cannot apply.
**WSL:** if the target agent runs on the Windows side while you run inside WSL, the Linux paths are wrong: ask the user and
pass the Windows-side file with `--config-path` / `--skills-dir` (`/mnt/c/Users/<name>/...`).
**Cloud sandbox:** if you run in a remote sandbox (for example `/workspace`, Linux x64) and not on the user's own machine, an
install only changes that sandbox. Tell the user so before applying.

## Things you must not do

- Do not install more than one item per run, or "all of a category".
- Do not pick an item that is not in the registry, and do not add `--include-drafts` (owner-only).
- Do not apply without showing the Confirm screen and getting the OK.
- Do not put secrets in chat output, files in the project, or shell history if you can avoid it.

## Advanced: the single commands

`start` / `next` is built from these; each prints JSON (`node engine/kit.mjs help` lists all):
`detect`, `agents`, `kinds`, `categories`, `items`, `show`, `tools`, `plan`, `apply --confirm <hash>`.
`next --json` returns the same screen as JSON (`ui`, `next_command`).

## No Node?

If `node --version` fails (< 18): tell the user to install Node.js 18+ (https://nodejs.org). If they cannot, you may do the
work by hand from `registry/` (read `agents/<agent>.json` for the config file and shape, `items/<kind>/<id>/item.json` for the
definition) — still one item, still show what you will write first, still never touch a file you cannot parse.
