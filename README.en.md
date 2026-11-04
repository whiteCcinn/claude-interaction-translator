# Claude Interaction Translator

English · [简体中文](README.md)

A Claude Code interaction translation plugin maintained by [whiteCcinn](https://github.com/whiteCcinn). Configure the input language, the language sent to Claude, Claude's reply language, and the language displayed to you independently. Use a local Codex CLI or an OpenAI-compatible API for translation.

Repository: [whiteCcinn/claude-interaction-translator](https://github.com/whiteCcinn/claude-interaction-translator). Use these installation identifiers:

| Identifier | Name |
| --- | --- |
| Project / marketplace | `claude-interaction-translator` |
| Plugin name | `interaction-translator` |
| Complete installation ID | `interaction-translator@claude-interaction-translator` |

```text
Chinese input → English prompt → Claude's English reply → Chinese UI
                                   └→ Original English reply in model history
```

All four languages are configurable. Supported languages are Chinese, English, Japanese, and French; input also supports automatic detection. Output stays original by default until you press Translate. The default `display-only` mode keeps translations out of model history.

## 1. Prerequisites

- Install Claude Code and sign in. The current validation baseline is **Claude Code 2.1.316**; later versions must remain compatible with its native Mods API.
- For Codex CLI translation, install and authenticate Codex in the same environment used to launch Claude Code. The invocation has been verified with Codex CLI 0.166.0.
- For API translation, prepare your translation endpoint, model ID, and API key. Keep using your existing Claude authentication and main-model configuration.

## 2. Install: choose a translation backend

Run these commands in your system terminal. First add the marketplace:

```bash
claude plugin marketplace add whiteCcinn/claude-interaction-translator
```

Then choose one installation method below. The default scope is your user account; add `--scope project` for a project installation.

### Option A: local Codex CLI

Check Codex authentication; run `codex login` first if you are not signed in:

```bash
codex --version
codex login status
claude plugin install interaction-translator@claude-interaction-translator \
  --config backend=codex-cli
```

This backend invokes `codex exec` and reuses your local Codex authentication and provider configuration. It does not require a translation API key. Codex still contacts its configured model service; local CLI mode does not imply offline inference.

### Option B: translation API

```bash
claude plugin install interaction-translator@claude-interaction-translator \
  --config backend=api
```

Configure the endpoint and key in the next section. The plugin defaults to `api` when `backend` is not specified.

Run `claude` after installation. In an existing session, use `/reload-plugins` to load the plugin. To inspect installed plugins:

```bash
claude plugin list
```

## 3. Initial configuration and later changes

Enter this command **inside a Claude Code session**:

```text
/plugin configure interaction-translator@claude-interaction-translator
```

You can also use `/plugin` → Installed → this plugin → Configure options, or `/config`. Choose a backend, languages, and the relevant fields, then save. Follow the reload prompt. After changing settings outside the session, restart Claude or run `/reload-plugins`.

### Language settings

| Setting | Configuration key | Default / purpose |
| --- | --- | --- |
| Input language | `input_language` | `cn`; your input language, or `auto` |
| Claude prompt language | `language` | `en`; translated input sent to Claude |
| Claude reply language | `claude_language` | `same-as-prompt`; requests English replies by default |
| Output language | `output_language` | `cn`; the language you read in the interface |
| Output translation mode | `output_mode` | `display-only`; separates UI translations from model history |
| Display translation trigger | `output_trigger` | `manual`; press to translate, or select `auto` for new replies; applies only to `display-only` |

Language codes: `cn` Simplified Chinese, `en` English, `jp` Japanese, and `fr` French. For Chinese input and Japanese output, change only Output language to `jp`. Select `same-as-claude`, or use the same reply and output language, to skip output translation.

### Codex CLI settings

Set Translation backend to `codex-cli`:

| Setting | Selection |
| --- | --- |
| Codex executable | Defaults to `跟随本地配置` (follow local configuration), using `codex` from `PATH`; you can enter an absolute executable path manually |
| Codex translation model | Follow local configuration, choose a preset, or select manual input |
| Codex reasoning effort | Follow local configuration, choose `low / medium / high / xhigh / max`, or enter a manual value |
| Codex Fast mode | Follow local configuration; `on` requests Fast, `off` disables Fast for translation |

The native pickers use `跟随本地配置` for inheritance and `手动输入` for manual input. After choosing manual input, fill in the adjacent manual-value row. Enter executable paths without extra quotes or arguments. Unused manual-value rows can remain empty.

Model presets are `gpt-6.1-sol / gpt-6.1-terra / gpt-6-astra / gpt-6-luna`. Availability of models, reasoning levels, and Fast depends on your account and provider. Manual input accepts other model IDs. Fast may consume more usage and does not guarantee a speed improvement.

For example, select a lower translation reasoning level during installation:

```bash
claude plugin install interaction-translator@claude-interaction-translator \
  --config backend=codex-cli \
  --config codex_reasoning_effort=low
```

These options apply to both input and output translation. They do not modify your local Codex configuration file or Claude's main model. Each CLI translation uses an ephemeral session with a 120-second timeout; failures do not fall back to the API backend.

### API settings

Set Translation backend to `api`:

| Setting | Selection |
| --- | --- |
| API URL | Default GLM endpoint, or a manually entered complete `chat/completions` URL |
| Translation model | Default `glm-5.3-flash`, or a manual model ID |
| API Key source | Automatic credential lookup by default; manual mode uses only the native secure input value |
| API Key | Your translation service key, using native masking and secure storage |
| Reasoning effort | API only; defaults to `low`; `default` omits this request field |

Built-in endpoint: `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`. To use another service, choose manual input for both endpoint and model, then fill in their manual values. The endpoint must support OpenAI Chat Completions and return `choices[0].message.content`.

Automatic credential lookup checks the secure setting, `TRANSLATOR_API_KEY`, and then a `.env` file in the plugin directory. Prefer the native secure input and keep keys out of the repository. See the [integration guide](docs/integration.md) for further details (Chinese).

## 4. Daily use and output modes

After installation and configuration, run `claude` as usual and send a normal question. Input translation progress appears above the composer. Output stays original by default, with no output translation request until you press Translate. The selected block remains readable while queued or running and is replaced only when its complete translation is ready.

In fullscreen, click Translate beside a reply. In the classic terminal, use Translate above the composer: press `Ctrl+X`, then `Tab`, then `t`. Previous/Next (`p / n`) selects among available replies; the snippet identifies the target. This does not translate the whole transcript. Set **Display translation trigger** to `auto` to translate new replies automatically.

Up/Down input recall keeps the exact original you typed, while Claude still receives the translated prompt. This also applies to queued input and normal plugin hot reloads. Previously rewritten history entries are not restored.

Before input translation, a local check examines the natural-language instructions. Confident matches to the prompt language pass through unchanged, without a translation API/Codex call or input progress card. For example, English input can go directly to an English prompt target; Claude's reply language still follows its separate setting. Code, paths and URLs do not influence detection. Mixed, uncertain or oversized input keeps the normal translation path.

| Mode | Interactive UI | Model history | `claude -p` |
| --- | --- | --- | --- |
| `display-only` (default) | Original by default; press to translate, or opt into `auto` | Claude's original reply, English by default | Original reply; no output translation call |
| `conversation` | Translated text | Translated reply, visible to later model turns | Translated reply |

Reply language is requested through instructions; preserving the original response does not guarantee that every character generated by Claude is English. Display translation leaves saved conversation content unchanged. Use a new session when verifying the display mode.

Input translation failure stops submission. Display translation failure keeps the original response visible with an error and a retry button; the original also remains visible during retry. Code, paths, and URLs are protected and restored; code-only or incomplete-code visible blocks remain original. Commands, blank input, and input beginning with `! / #` bypass translation.

If the host changes the input structure so the prepared translation cannot be matched to its prompt, the plugin shows an error and sends Claude an English retry notice instead of the original text. If cancelling many queued prompts fills the pending limit, process the remaining queue or restart the session.

Display translations are cached only in memory. Manual mode translates the selected visible block; restored history can also be translated explicitly. Scrolling, expanding and repainting never start manual translation. The cache holds at most 128 entries and 4 MiB. Manual entries may be evicted under pressure; revisiting an evicted translation shows the original until you press Translate again. In `auto`, only newly appended replies translate automatically; resumed/reloaded history remains original. CLAUDE.md, skills, tool results, and images are not automatically translated; see [context language boundaries](docs/context-language-boundaries.md) for details (Chinese).

Native choice dialogs (`AskUserQuestion`) also stay original by default. In fullscreen, click Translate above the dialog. Classic terminal dialogs cannot focus plugin buttons, so they show the original and an explanation; select `output_trigger=auto` beforehand for automatic question translation. Explicit `conversation` mode retains automatic translation. Original option names remain selectable, with translated titles in their descriptions. Preview layouts receive a numbered translated choice guide below the question; code previews stay unchanged. Submitted choices are unchanged. Once you start selecting or typing, Claude Code may freeze that dialog's presentation to preserve your input. Native button text such as `Submit` is outside the translation scope.

### Verify display-only behavior

1. Set prompt and Claude reply languages to English, output to Chinese, and mode to `display-only`.
2. Ask a normal question in a new session, press Translate, and wait for its Chinese translation in the UI.
3. Run `/export /tmp/interaction-translator-check.txt` in Claude and inspect the corresponding assistant reply in the exported text.

**Chinese in the interface and the original English reply in the export confirm that this reply's display and history are separate.** Both modes show progress cards, so a progress card alone does not identify the active mode.

## 5. Update, disable, and enable

Update from your system terminal:

```bash
claude plugin marketplace update claude-interaction-translator
claude plugin update interaction-translator@claude-interaction-translator
```

Then run `/reload-plugins` in the current Claude session or restart Claude.

To disable temporarily or enable again, run the corresponding terminal command:

```bash
claude plugin disable interaction-translator@claude-interaction-translator
claude plugin enable interaction-translator@claude-interaction-translator
```

Inside Claude, you can also open `/plugin` → Installed → this plugin and choose Disable / Enable, then follow the reload prompt. Disabling stops future translation without rewriting existing history.

## 6. Uninstall

Run in your terminal:

```bash
claude plugin uninstall interaction-translator@claude-interaction-translator
```

Add `--keep-data` to preserve the native plugin data directory. For project or local installations, use the matching `--scope project` or `--scope local` from that project directory. Reload plugins or restart Claude afterward.

If you no longer need the marketplace, remove it separately:

```bash
claude plugin marketplace remove claude-interaction-translator
```

## 7. Load or install local source

```bash
git clone https://github.com/whiteCcinn/claude-interaction-translator.git
cd claude-interaction-translator
claude --plugin-dir ./plugins/interaction-translator
```

This development method loads the source for the current run only. Configure it inside the session using:

```text
/plugin configure interaction-translator@inline
```

For a persistent local-directory installation, run `claude plugin marketplace add ./` from the repository root, then install the complete marketplace plugin ID documented above. Choose either the local or GitHub source for a marketplace with this name. Inspect sources with `claude plugin marketplace list`, and avoid loading both an installed and a development copy.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and CI troubleshooting.

## 8. Troubleshooting

| Symptom | Action |
| --- | --- |
| Claude cannot find Codex | Check the launch environment's `PATH`, or enter an absolute executable path in the manual-value field |
| Translation is slow | Inspect the inherited CLI model and reasoning level; choose a translation model and `low / medium`, then compare timings |
| A configuration change has no effect | Verify the complete plugin ID, save, and reload or restart Claude |
| Text is translated twice | Check for simultaneous installed and `--plugin-dir` development copies |
| `claude -p` returns untranslated text | Default `display-only` preserves original output; select `conversation` explicitly for headless translation |

## License and maintenance

Maintainer: [whiteCcinn](https://github.com/whiteCcinn). Released under the [MIT License](LICENSE).

References: [Claude Code plugin installation](https://code.claude.com/docs/en/plugins/install) · [Mods API](https://code.claude.com/docs/en/plugins/mods/api) · [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
