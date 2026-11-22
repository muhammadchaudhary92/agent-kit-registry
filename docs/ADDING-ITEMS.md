# Adding items (the daily owner workflow)

Rule: **you verify, you add the files, nothing else changes.** The AI never finds or installs anything by itself.

## 1. Find and check a candidate

Open its GitHub page. Check: it does what it claims, license, last commit, stars, how the author says to install it,
what permissions/tokens it needs, which agents/OS it works on. Read the code of anything that runs commands.

## 2. Create a draft

```bash
node engine/kit.mjs scaffold item --kind mcp   --id figma --category ui --from-github owner/repo
node engine/kit.mjs scaffold item --kind mcp   --id remote-thing --template http
node engine/kit.mjs scaffold item --kind skill --id ui-review --category ui --from-github owner/repo
node engine/kit.mjs scaffold item --kind plugin|extension --id my-plugin
node engine/kit.mjs scaffold tool  --item figma --id get-file        # MCP tools, one file each
node engine/kit.mjs scaffold category --id games --name "Games"
```
`--from-github` pre-fills author, license, description and stars. The draft has `TODO` markers; fill all of them.

## 3. Fill it in

Example MCP that needs a token (illustrative values, verify the real package before you publish anything):

```json
{
  "id": "figma", "kind": "mcp", "name": "Figma", "status": "draft",
  "summary": "Read Figma files so the agent can build UI from real designs.",
  "description": "Gives the agent read access to Figma files, frames and styles ...",
  "how_it_works": "Runs locally through npx and calls the Figma API with your personal access token.",
  "categories": ["ui"], "platforms": ["web", "android", "ios"], "tags": ["design"],
  "author": "GLips", "source": { "repo": "GLips/Figma-Context-MCP", "license": "MIT" },
  "requires": { "commands": [ { "name": "node", "min": "18", "hint": "Install Node.js 18+ from https://nodejs.org" } ] },
  "inputs": [ { "id": "FIGMA_TOKEN", "label": "Figma personal access token", "secret": true,
                "help": "Figma > Settings > Security > Personal access tokens", "example": "figd_xxxxxxxx" } ],
  "install": { "mcp": { "transport": "stdio", "command": "npx", "args": ["-y", "figma-developer-mcp", "--stdio"],
                        "env": { "FIGMA_API_KEY": "{input:FIGMA_TOKEN}" } } }
}
```
Tools: `items/mcp/figma/tools/get-figma-data.json` → `{ "id": "get-figma-data", "name": "get_figma_data", "description": "...", "risk": "read" }`.

Skill from GitHub: `"install": { "skill": { "name": "ui-review", "source": { "type": "github", "repo": "owner/repo", "path": "skills/ui-review", "ref": "<full commit sha>" } } }`
Bundled skill: put the folder (with `SKILL.md`) in `items/skill/<id>/files/` and use `"source": { "type": "bundled" }` (folder form `items/skill/<id>/item.json`).

Plugin / extension: write the install commands per agent as `variants[].steps` (see `templates/plugin.item.json`, `templates/extension.item.json`
and [DATA-MODEL.md](DATA-MODEL.md)). Steps use the vendor's own commands (for example `claude plugin install`, `agy plugin install`, `gemini extensions install`, `code --install-extension`).

## 4. Test it for real (draft mode)

```bash
node engine/kit.mjs start --include-drafts --self cursor     # the user's wizard, with your drafts visible
node engine/kit.mjs plan --include-drafts --agent cursor --kind mcp --item figma --input FIGMA_TOKEN=xxx
node engine/kit.mjs apply --include-drafts <same args> --confirm <hash>
```
Then open the agent and make sure the server/skill/plugin works. Test at least one agent per transport and, if you can, Windows and Linux/macOS
(`--os windows` only previews). Use a throw-away `--home <folder>` first if you do not want to touch your real config.

## 5. Publish

1. Set `"status": "verified"` and `"verified": { "date": "YYYY-MM-DD", "by": "<you>" }`.
2. `npm run check` (validate --strict + tests). Strict mode rejects leftover `TODO`s and missing author/how_it_works/source.
3. `node engine/kit.mjs refresh-stars` (optional, keeps star counts current).
4. Commit and push. Users get it immediately.

## Several items for one task

Add them all, and tag each honestly with `platforms` (`web`, `android`, ...) and good `tags`/`categories`.
In the wizard the user either picks one, or lets the AI choose **one from this list**; the AI filters by the project's platform, so a web-only skill is never picked for an Android project.
A tool that works everywhere uses `"platforms": ["any"]` (the default).

## Making an item agent-specific

* Works only on some agents: `"compat": { "agents": ["claude-code", "cursor"] }` (or `exclude_agents`).
* Works only on some OSes: `"os": ["linux", "macos"]`.
* Different command per agent/OS: `variants` (first match wins). `"unsupported": true` hides it for a combination.

## Adding or fixing an agent

Copy a similar file in `registry/agents/`, change the paths/shape, set `verified` (date, confidence, source URL) and run `validate`.
Use `support: "guided"` until you have really tested the layout on a machine. If an agent changes its config format, only its adapter changes.

## Removing or hiding

Set `"status": "draft"` to hide an item without deleting it, or delete the file/folder.
