# Data model

The registry is a small relational database stored as files. Rows are JSON files, foreign keys are ids,
and the engine discovers everything by folder convention, so **adding data never needs a code change**.

```
agents ─┐                        kind: mcp | skill | plugin | extension
        ├─< compatibility >──── items ──< tools   (tools only for MCP)
kinds ──┘                          └──> categories (many-to-many by id list)
```

| Table | File | Primary key | Foreign keys |
|---|---|---|---|
| agents | `registry/agents/<id>.json` | file name = `id` | `kinds.*` keys → kinds |
| kinds | `registry/kinds/<id>.json` | file name = `id` | – |
| categories | `registry/categories/<id>.json` | file name = `id` | – |
| items | `registry/items/<kind>/<id>.json` or `<id>/item.json` | folder `<kind>` + `id` | `kind` → kinds, `categories[]` → categories, `variants[].when.agent[]` → agents |
| tools | `registry/items/mcp/<id>/tools/<tool>.json` | parent item + file name | parent = the item folder |

Ids are lowercase letters, digits and dashes. `id` inside the file must equal the file/folder name. `node engine/kit.mjs validate` checks all keys.

## Item (common fields)

| Field | Required | Notes |
|---|---|---|
| `id`, `kind`, `name` | yes | `kind` must equal the folder (`mcp`, `skill`, ...) |
| `status` | yes | `draft` (hidden, `--include-drafts` to test) or `verified` |
| `summary` | yes | one line shown in the list |
| `description` | yes | what it does (shown on the detail card) |
| `how_it_works` | verified | how it runs / what data leaves the machine |
| `categories` | yes | ids from `registry/categories` |
| `platforms` | no | `any` (default), `web`, `android`, `ios`, `desktop`, `backend`, `cli`, `game`, `embedded`, `data`. Used to filter and for "AI choose" |
| `os` | no | restrict to `windows` / `linux` / `macos` |
| `author`, `source{repo,homepage,license}`, `stars{count,as_of}` | verified | `refresh-stars` fills stars/author/license from GitHub |
| `tags` | no | extra search words |
| `requires.commands[]` | no | `{name, min, hint}` checked before install (e.g. node >= 18) |
| `inputs[]` | no | values to ask the user: `{id, label, secret, required, help, example, pattern, default}`; `id` like `FIGMA_TOKEN` |
| `compat` | no | `{agents:[...]}` allow-list or `{exclude_agents:[...]}` |
| `verified` | verified | `{date, by}` set by the owner after a real test |
| `install`, `variants`, `steps` | by kind | see below |
| `notes` | no | extra text shown in the plan |

### `install.mcp` (kind `mcp`)

```json
{ "transport": "stdio", "command": "npx", "args": ["-y", "pkg@1.2.3"], "env": { "API_KEY": "{input:API_TOKEN}" },
  "server_name": "optional-name-in-the-config", "tool_selection": { "type": "args-join", "flag": "--tools", "sep": "," } }
```
```json
{ "transport": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer {input:TOKEN}" } }
```
`transport`: `stdio`, `http` (streamable HTTP) or `sse`. The definition is agent-neutral; the agent adapter turns it into that agent's format.
Windows: `npx`/`npm`/`pnpm`/`yarn` are wrapped as `cmd /c npx ...` automatically.

**`tool_selection`** (optional) says how the chosen tools reach the server: `args-join` (`--tools a,b`), `args-repeat`
(`--tool a --tool b`), `env-join` (`{"name":"ENABLED_TOOLS"}`) or `per-tool` (each `tools/*.json` has `enable:{args,env}`).
Without it the engine falls back to the agent's own allow-list key (`tool_filter`, e.g. Gemini `includeTools`); if neither exists the
plan warns that all tools stay available. Choosing **all** tools never adds a filter.

### Tools (child rows of an MCP)

`items/mcp/<id>/tools/<tool>.json`
```json
{ "id": "get-file", "name": "get_file", "description": "Read one design file.", "risk": "read", "default": true, "order": 1 }
```
`name` is the exact MCP tool name. `risk`: `read` | `write` | `destructive`. `default: false` → not pre-selected.

### `install.skill` (kind `skill`)

```json
{ "name": "my-skill", "source": { "type": "github", "repo": "owner/repo", "path": "skills/my-skill", "ref": "<40-char commit sha>" } }
```
Source types: `github` (contents API, no git needed), `git` (`url`, needs git), `bundled` (files in `items/skill/<id>/files/`, item must use the folder form).
The folder must contain `SKILL.md` or nothing is installed. Pin `ref` to a full commit SHA.

### `steps` (plugins, extensions, anything custom)

Steps run in order. Put them in `steps` (all agents) or per agent in `variants`.

| `type` | Fields |
|---|---|
| `command` | `command` (plain executable name), `args[]`, `cwd`, `allow_fail`, `timeout_sec`, `description` (no shell is used) |
| `write-file` | `path`, `content`, `mode` = `create` (default) / `overwrite` / `append` |
| `json-merge` | `file`, `root[]`, `key`, `value` |
| `copy-bundled` | `from` (inside the item folder), `to` |
| `fetch-dir` | `source` (like a skill source), `to` |
| `manual` | `instruction` (shown to the user) |

Every step accepts `when: {agent, os, arch}`.

### `variants` (per agent / OS exceptions)

```json
"variants": [
  { "when": { "agent": ["claude-code"] }, "note": "via marketplace", "steps": [ ... ] },
  { "when": { "os": ["windows"] }, "install": { "mcp": { "transport": "stdio", "command": "uvx", "args": ["pkg"] } } },
  { "when": { "agent": ["codex"], "os": ["windows"] }, "unsupported": true, "note": "needs WSL" }
]
```
The **first** variant whose `when` matches wins. `install` replaces the base install of that kind; `steps` replaces `steps`.
For plugins and extensions the item is only offered for agents that have steps (a matching variant or base `steps`).

### Placeholders

Allowed in strings of `install`, `variants` and `steps`:

`{input:ID}` value of an input · `{home}` `{project}` `{work}` `{tmp}` `{sep}` · `{appdata}` `{localappdata}` `{appsupport}` (OS app-data folder) · `{xdg_config}` `{xdg_data}` · `{os}` `{arch}` · `{name}` (server name) `{scope}` · `{env:NAME|default}`.
Unknown `{...}` words that do not look like placeholders (for example JSON) are left alone.

## Agent adapter (`registry/agents/<id>.json`)

```json
{ "id": "cursor", "name": "Cursor", "order": 60, "description": "...",
  "detect": { "env": [], "commands": ["cursor"], "paths": ["{home}/.cursor"] },
  "kinds": { "mcp": {...}, "skill": {...}, "plugin": {...}, "extension": {...} },
  "verified": { "date": "2026-11-20", "confidence": "high|medium|low", "sources": ["https://..."] } }
```

Each kind has `support`: `auto` (engine writes), `guided` (instructions + snippet; applies when the path is confirmed), `none` (not offered).

**`kinds.mcp`**

| Key | Meaning |
|---|---|
| `transports` | which of `stdio`/`http`/`sse` the agent can use |
| `shape` | entry layout per transport. `"{command}"`, `"{args}"`, `"{argv}"` (command+args array), `"{env}"`, `"{url}"`, `"{headers}"`, `"{name}"`; empty args/env/headers are dropped |
| `methods[]` | tried in order. `config-file`: `format` json (`root: [...]`) or toml (`table: [...]` or `array_table: [...]` + `name_field`), `scopes.user/project.file` (path template or OS map `windows/macos/linux/unix/all`), optional `require_dir`. `cli`: `command`, `args` (`{scope}` `{name}` `{json}`), `scopes` map, optional `replace_args`, `verify_args` |
| `default_scope` | `user` or `project` |
| `env_ref` | how the agent references an environment variable (`${env:__NAME__}`); needed for secrets in project scope |
| `windows_wrap` | `cmd` (default) wraps npx-style commands; `none` disables |
| `tool_filter` | `{allow_key}` agent-side allow-list key |
| `restart_required`, `post_install`, `notes` | shown to the user |

**`kinds.skill`**: `scopes.user.dir` / `scopes.project.dir` (path templates), `default_scope`.
**`kinds.plugin` / `kinds.extension`**: `support` only; the commands come from the item.

A `guided` adapter that lists a path is "one confirmation away" from automatic: `--config-path` / `--skills-dir`.

## Behaviour that comes from the data

* **Visible** = `status: verified` (unless `--include-drafts`).
* **Compatible** with an agent = adapter `support` is not `none`, the transport is supported, a variant is not `unsupported`, `os`/`compat` allow it, and (plugin/extension) steps exist.
* Lists show counts per kind/category; empty results are `Data not found`.
* State: `~/.agent-kit/installed.json` (history, no secrets) and `~/.agent-kit/backups/<time>/` (override with `--state-dir` / `KIT_STATE_DIR`).
* Environment overrides: `KIT_REGISTRY`, `KIT_OS`, `KIT_HOME_DIR`, `KIT_STATE_DIR`, `KIT_INPUT_<ID>`, `KIT_GITHUB_API`, `GITHUB_TOKEN`.
