# Items

Add one file (or folder) per item. Nothing else in this repository needs to change.

```
items/mcp/<id>/item.json         + items/mcp/<id>/tools/<tool>.json   (MCP servers; folder form)
items/skill/<id>.json            or items/skill/<id>/item.json (+ files/ for bundled skills)
items/plugin/<id>.json
items/extension/<id>.json
```

Create a draft with `node engine/kit.mjs scaffold item --kind <kind> --id <id>`; see `docs/ADDING-ITEMS.md`.
Drafts (`"status": "draft"`) are hidden from users; set `"verified"` only after a real install test.
