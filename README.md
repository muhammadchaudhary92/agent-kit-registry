> **🤖 AI agent: the user asked you to "install", "set up" or "run" this repo. Do exactly this and nothing else.**
> This repo is an *installer catalogue*, not an app to build or test.
>
> 1. Clone it, `cd` into it (Node 18+ needed, nothing to install).
> 2. Run `node engine/kit.mjs start` (`npm start` is the same). If you know which agent you are, add `--self <id>`, for example `node engine/kit.mjs start --self mistral-vibe`.
> 3. It prints ONE question at a time. Show it to the user (popup / single-choice tool if you have one, else the numbered list), wait for the answer, then run the command it prints. Repeat until it says done.
>
> Do **not** run the tests, do **not** summarize the repo, do **not** choose for the user, do **not** search the web for items.
> No items yet? It says **Data not found**; `npm run demo` previews the whole flow with sample items (nothing real is installed).

# agent-kit-registry

A **registry-driven installer** for AI coding agents. A user tells their agent:

```
install this https://github.com/muhammadchaudhary92/agent-kit-registry.git
```

and the agent walks them through a short wizard:

```
Agent → Kind (MCP / Skills / Plugins / Extensions) → Category (+ search) → Item → [credentials] → [MCP tools] → Plan → OK → Install
```

* **One install per run.** Every list is single-select; only the inner tools of an MCP are multi-select.
* **Verified items only.** The owner tests each item and writes its exact install method. The AI never discovers or installs anything on its own.
* **No data, no guessing.** An empty list says **Data not found**.
* **Works on Windows, macOS, Linux (and WSL).** Paths, `cmd /c npx` wrappers and config formats are chosen per OS and per agent.
* **Zero dependencies.** One small Node ≥ 18 script (`engine/kit.mjs`); the registry is plain JSON files.

Popups: the engine never draws a popup itself. It prints each question as a ready-made numbered menu, and the AI shows it with whatever its app offers (a native choice dialog if it has one, otherwise the list in chat).

Try the whole flow before the registry has real items: `npm run demo` (sample items, a throw-away home folder, apply only shows what it would do).

## How it is built

| Layer | Path | Job |
|---|---|---|
| Wizard spec (for the AI) | `wizard/WIZARD.md` | the conversation, UI behaviours, rules |
| Engine (stable, no data) | `engine/` | `start`/`next` wizard driver, detect, plan, apply, validate, scaffold |
| Registry (data only) | `registry/` | agents, kinds, categories, items, tools |

The registry is a tiny **relational database made of files** (parent → child through ids, like MySQL tables, but just JSON):

```
registry/
  agents/<agent>.json            how each agent is configured (paths, formats, support level)
  kinds/<kind>.json              mcp | skill | plugin | extension (+ description shown to the user)
  categories/<category>.json     ui, backend, mobile, ...
  items/<kind>/<item>.json       or  items/<kind>/<item>/item.json + tools/<tool>.json
```

**Adding a new skill / MCP / plugin / extension = adding files. No engine change, ever.**
See [docs/ADDING-ITEMS.md](docs/ADDING-ITEMS.md) (English) and [docs/OWNER-GUIDE.hi.md](docs/OWNER-GUIDE.hi.md) (Hindi).

## Supported agents

`auto` = the engine writes the config itself (backup, atomic write, read-back check). `guided` = the AI gets the exact snippet and asks the user to confirm the path first (then it can still apply it with `--config-path` / `--skills-dir`).

| Agent | MCP | Skills | Plugins | Extensions |
|---|---|---|---|---|
| Claude Code | auto | auto | auto | – |
| OpenAI Codex CLI | auto | guided | – | – |
| Gemini CLI | auto | guided | – | auto |
| Google Antigravity | auto | auto | auto | guided |
| Mistral Vibe | auto | guided | – | – |
| Cursor | auto | guided | – | auto |
| Windsurf | auto | guided | – | guided |
| Kiro | auto | – | – | guided |
| Cline | auto | – | – | – |
| VS Code (Copilot) | guided | guided | – | auto |
| Copilot CLI, Qwen Code, Roo Code, Kilo Code, Continue, Zed, Amp, OpenCode, Goose | guided | – | – | – |
| Any other agent | guided (+ `--config-path`) | guided (+ `--skills-dir`) | guided | guided |

Every adapter records the date and confidence of its last check in `verified`. Agent file layouts change often: when one changes, edit its adapter JSON (no code).

## Quick start for the owner

```bash
node engine/kit.mjs scaffold item --kind mcp --id my-server --category ui --from-github owner/repo
# fill the TODOs, add tools:  node engine/kit.mjs scaffold tool --item my-server --id some-tool
# test it:                    node engine/kit.mjs plan --include-drafts --agent cursor --kind mcp --item my-server
# when it really works:       set "status": "verified"
npm run check                 # validate --strict + tests
```

## Safety model

* The engine only writes under the user's home / config / project folders (`--allow-outside` needs an explicit confirmation).
* `apply` needs the hash of the plan the user approved; a changed plan is rejected.
* Existing files are backed up (`~/.agent-kit/backups/<time>/`), written atomically and read back. A JSON file with comments is never rewritten (the plan turns guided).
* Secrets are masked in all output; project-scope installs use environment-variable references instead of raw secrets.
* Only `status: "verified"` items are offered. Pin skill sources to a full commit SHA.

## Layout of this repo

```
README.md  AGENTS.md  CLAUDE.md  GEMINI.md   entry points for humans / AI agents
wizard/WIZARD.md                              AI instructions
engine/kit.mjs, engine/lib/*.mjs              the installer (Node ≥ 18, no dependencies)
registry/                                     all data
templates/                                    starting points for new items
docs/                                         data model, adding items, owner guide (Hindi), CI example
tests/                                        node --test suite (+ sample items used by --demo)
```

License: MIT (see `package.json`). Registry items keep their own upstream licenses (recorded in each item).
