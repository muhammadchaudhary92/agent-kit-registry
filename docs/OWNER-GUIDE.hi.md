# Owner guide (हिंदी)

यह framework (parent) पूरा तैयार है। इसमें **कोई skill / MCP / plugin / extension नहीं है**। आपको रोज़ सिर्फ़ नए items ढूंढकर, खुद verify करके, `registry/items/` में files जोड़नी हैं। Engine का code बदलने की कभी ज़रूरत नहीं।

## रोज़ का काम (5 steps)

| # | काम | Command / जगह |
|---|---|---|
| 1 | GitHub पर item ढूंढो और खुद जाँचो (license, code, tokens, कौन से agent/OS पर चलता है) | – |
| 2 | Draft बनाओ | `node engine/kit.mjs scaffold item --kind mcp --id figma --category ui --from-github owner/repo` |
| 3 | `TODO` भरो: description, how_it_works, install method, inputs (token), tools | `registry/items/mcp/figma/item.json` |
| 4 | असली agent में test करो | `node engine/kit.mjs plan --include-drafts --agent cursor --kind mcp --item figma --input FIGMA_TOKEN=xxx` फिर `apply ... --confirm <hash>` |
| 5 | `"status": "verified"` करो, check चलाओ, push करो | `npm run check` → `git add . && git commit && git push` |

Kinds के हिसाब से:

* **MCP** → `items/mcp/<id>/item.json` + हर tool की अलग file `tools/<tool>.json` (`scaffold tool --item <id> --id <tool>`).
* **Skill** → `items/skill/<id>.json`; source GitHub folder (`path` + commit `ref`) या अपनी files `items/skill/<id>/files/` में (`SKILL.md` ज़रूरी).
* **Plugin / Extension** → `variants[].steps` में हर agent का install command (जैसे `claude plugin install`, `agy plugin install`, `gemini extensions install`, `code --install-extension`).
* नई category → `node engine/kit.mjs scaffold category --id games --name "Games"`.

पूरे fields और examples: `docs/ADDING-ITEMS.md` और `docs/DATA-MODEL.md`।

## Verify करने की checklist

- [ ] License ठीक है और repo archived नहीं है
- [ ] Code पढ़ा (खासकर जो commands चलाता है या network पर data भेजता है)
- [ ] Token/API key क्या चाहिए, `inputs` में `secret: true` डाला
- [ ] Skill के लिए `ref` में पूरा commit SHA pin किया
- [ ] कम से कम एक असली agent में install करके चलाकर देखा (Windows और Linux/macOS दोनों हों तो बेहतर)
- [ ] `platforms` सही लिखे (web / android / ios / backend ...) ताकि AI गलत platform का item न चुने
- [ ] `how_it_works`, `author`, `source` भरे; `npm run check` pass है

## एक काम के कई items (जैसे UI के 5 tools)

सबको add करो और हर एक के `platforms` और `tags` सच-सच लिखो। Wizard में user खुद एक चुनता है, या **"Let the AI choose"** चुनता है। तब AI सिर्फ़ इसी list में से **एक** item चुनता है और project के platform से मिलाता है (Android app के लिए web-only skill नहीं चुनेगा)। AI खुद कुछ ढूंढकर install नहीं करता।

## Wizard खुद देखो और test करो

| क्या | Command |
|---|---|
| Sample items के साथ पूरा flow (कुछ install नहीं होता) | `npm run demo` |
| असली registry का flow | `node engine/kit.mjs start --self <agent-id>` |
| अपना draft item flow में देखना | `node engine/kit.mjs start --include-drafts --self cursor` |

* Engine खुद popup नहीं बनाता। हर सवाल numbered menu की तरह print होता है और AI उसे अपने app के हिसाब से दिखाता है: native choice dialog हो तो वही, नहीं तो chat में list। Popup आएगा या नहीं, यह उस agent के app पर निर्भर है।
* कोई AI सवाल पूछे बिना tests चला दे तो उसे यह prompt दो: *"Clone the repo, run `node engine/kit.mjs start`, show me exactly the question it prints and wait for my answer."*
* AI अगर remote cloud sandbox (`/workspace`, Linux x64) में चल रहा है, तो install आपके फ़ोन/PC में नहीं, उसी sandbox में होगा।
* GitHub Actions (CI) चाहिए तो `docs/ci-validate.yml.example` को `.github/workflows/validate.yml` में कॉपी करो। Push के लिए token में `workflow` scope चाहिए।

## नया agent या agent का format बदला

`registry/agents/<agent>.json` खोलो: config file का path (Windows/macOS/Linux अलग), format (JSON/TOML), `shape`, scope। Test से पहले `support: "guided"` रखो; असली machine पर चलाकर देख लो तब `"auto"` करो और `verified` में तारीख + confidence लिखो। Code नहीं बदलता।

## क्या अपने आप होता है, क्या नहीं (सीधी बात)

* **Auto (engine खुद लिखता है, backup + read-back check):** MCP — Claude Code, Codex, Gemini CLI, Antigravity, Mistral Vibe, Cursor, Windsurf, Kiro, Cline। Skills — Claude Code, Antigravity। Plugin/Extension — जहाँ item में steps दिए हों।
* **Guided (exact snippet मिलता है, AI user से path confirm कराता है, फिर `--config-path` / `--skills-dir` से engine लिख देता है):** VS Code, Copilot CLI, Qwen, Roo, Kilo, Continue, Zed, Amp, OpenCode, Goose, बाकी सब "Other", और कई agents के skills।
* **Test कहाँ हुआ:** automated tests में temp HOME, नकली `claude` CLI, mock GitHub server और Windows/macOS path simulation। **असली Cursor/Codex/Antigravity/Vibe वगैरह पर install test इस sandbox में नहीं हो सका**; हर adapter की `verified.confidence` इसी बात को दिखाती है। पहली बार हर agent पर एक असली install करके देखो।
* Agent अपना format बदल दे तो adapter JSON ठीक करना पड़ेगा (code नहीं)।
* `status: draft` items users को नहीं दिखते।

## Secrets और सुरक्षा

* Engine सिर्फ़ home / config / project folders में लिखता है; tokens output में `***` दिखते हैं।
* Project scope में token की जगह environment variable का reference लिखा जाता है; plan में `env_to_set` बताता है कि कौन सा variable set करना है।
* पुरानी file का backup `~/.agent-kit/backups/` में बनता है। Comments वाली JSON file को engine कभी rewrite नहीं करता (guided हो जाता है)।

## अक्सर आने वाली दिक्कतें

| दिक्कत | हल |
|---|---|
| `validate` में `category ... does not exist` | `scaffold category` से बनाओ |
| `item_not_verified` | `status` अभी `draft` है; test के लिए `--include-drafts` लगाओ |
| `incompatible` | उस agent के लिए adapter `support: none` है, transport match नहीं, या plugin/extension में उस agent का `variant` नहीं |
| `GitHub rate limit` | `GITHUB_TOKEN` environment variable set करो |
| Windows पर MCP start नहीं हो रहा | adapter में `windows_wrap` देखो (`cmd` default है); npx वाले commands अपने आप `cmd /c npx` बनते हैं |
