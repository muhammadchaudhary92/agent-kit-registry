# Instructions for AI agents (AGENTS.md)

You are probably here because a user said: **"install this https://github.com/muhammadchaudhary92/agent-kit-registry.git"**
(or "set up" / "run" this repo).

**Do this and nothing else:** run `node engine/kit.mjs start` (add `--self <your-agent-id>` if you know it; `npm start` is the same),
show the question it prints to the user, wait for the answer, run the command it prints, repeat.
This repo is an installer catalogue: do **not** run the tests, do **not** summarize the repo, do **not** choose for the user.

1. `wizard/WIZARD.md` has the details (screens, UI behaviours, guided mode). The commands print plain text; `--json` gives JSON.
2. Install **one** item per run. Use only what is in `registry/`. Never search the web for items, never install anything
   that is not in the registry, never edit agent config files by hand when `plan`/`apply` can do it.
3. If a list is empty, say **Data not found** (`npm run demo` previews the flow with sample items).
4. Show the Confirm screen and get the user's OK before `apply`. Never print secrets.

If you are instead maintaining this repository (the owner asked you to add or fix something):

* The engine in `engine/` is stable and contains no data. New skills/MCPs/plugins/extensions are **new files under `registry/items/`**
  (use `node engine/kit.mjs scaffold ...`, see `docs/ADDING-ITEMS.md`). Do not change engine code to add an item.
* Agent differences live in `registry/agents/<agent>.json`; update them when an agent changes its config layout.
* Only the owner marks an item `"status": "verified"` (after a real install test).
* Run `npm run check` (validate --strict + tests) before committing.
* Code comments, UI labels and docs in English; the owner guide `docs/OWNER-GUIDE.hi.md` is Hindi.
