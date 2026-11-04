# Claude Interaction Translator

[English](README.en.md) · 简体中文

由 [whiteCcinn](https://github.com/whiteCcinn) 维护的 Claude Code 交互翻译插件。分别配置输入语言、交给 Claude 的语言、Claude 回复语言和最终显示语言，翻译后端可选本地 Codex CLI 或 OpenAI 兼容 API。

项目仓库：[whiteCcinn/claude-interaction-translator](https://github.com/whiteCcinn/claude-interaction-translator)。安装时使用以下标识：

| 标识 | 名称 |
| --- | --- |
| 项目 / marketplace | `claude-interaction-translator` |
| 插件名 | `interaction-translator` |
| 完整安装 ID | `interaction-translator@claude-interaction-translator` |

```text
中文输入 → 英文提示词 → Claude 英文回复 → 中文界面
                         └→ 模型历史保留原始英文回复
```

四段语言均可修改；支持中文、英文、日文、法文，输入还支持自动识别。默认保留输出原文，点击按钮才翻译；`display-only` 的译文只在界面显示，不写回模型历史。

## 1. 准备环境

- 安装并登录 Claude Code。当前验证基线为 **Claude Code 2.1.316**；后续版本需兼容其原生 Mods API。
- 使用 Codex CLI 翻译时，在运行 Claude Code 的同一环境中安装并登录 Codex。当前调用方式在 Codex CLI 0.166.0 上验证。
- 使用 API 翻译时，准备翻译服务的接口地址、模型 ID 和 API Key。Claude 自己的登录与模型配置继续按原来的方式使用。

## 2. 安装：先选择一种翻译后端

下面的命令在系统终端执行。先添加 marketplace：

```bash
claude plugin marketplace add whiteCcinn/claude-interaction-translator
```

然后选择下面一种安装方式。默认安装到用户范围；需要项目范围时追加 `--scope project`。

### 方式 A：本地 Codex CLI

检查 Codex 状态；尚未登录时先运行 `codex login`：

```bash
codex --version
codex login status
claude plugin install interaction-translator@claude-interaction-translator \
  --config backend=codex-cli
```

该模式通过 `codex exec` 复用本地 Codex 的认证和服务配置，不需要填写翻译 API Key。CLI 仍会访问其配置的模型服务，本地 CLI 模式不等于离线推理。

### 方式 B：翻译 API

```bash
claude plugin install interaction-translator@claude-interaction-translator \
  --config backend=api
```

随后按下一节配置接口和密钥。不指定 `backend` 时，插件默认使用 `api`。

安装完成后运行 `claude`。已有会话可输入 `/reload-plugins` 加载插件。查看安装状态：

```bash
claude plugin list
```

## 3. 首次配置和后续修改

在 **Claude Code 会话内**输入：

```text
/plugin configure interaction-translator@claude-interaction-translator
```

也可以通过 `/plugin` → Installed → 本插件 → Configure options，或 `/config` 修改。选择后端、语言和对应字段，最后保存。保存后按提示重新加载；在会话外修改配置时，重新启动 Claude 或运行 `/reload-plugins`。

### 通用语言配置

| 配置项 | 配置键 | 默认值 / 用途 |
| --- | --- | --- |
| Input language | `input_language` | `cn`；输入语言，也可选 `auto` |
| Claude prompt language | `language` | `en`；输入翻译后交给 Claude 的语言 |
| Claude reply language | `claude_language` | `same-as-prompt`；默认要求英文回复 |
| Output language | `output_language` | `cn`；你在界面读到的语言 |
| Output translation mode | `output_mode` | `display-only`；界面译文与模型历史分离 |
| Display translation trigger | `output_trigger` | `manual`；点击翻译，改为 `auto` 可自动翻译新回复；仅 `display-only` 生效 |

语言代码：`cn` 简体中文、`en` 英文、`jp` 日文、`fr` 法文。例如中文输入、日文输出，只需把 Output language 改为 `jp`。选择 `same-as-claude`，或将回复语言和输出语言设为相同值，可跳过输出翻译。

### Codex CLI 配置

将 Translation backend 设为 `codex-cli`：

| 配置项 | 选择方式 |
| --- | --- |
| Codex executable | 默认“跟随本地配置”，使用 `PATH` 中的 `codex`；也可手动指定可执行文件绝对路径 |
| Codex translation model | 默认“跟随本地配置”；也可选模型预设或“手动输入” |
| Codex reasoning effort | 默认“跟随本地配置”；可选 `low / medium / high / xhigh / max` 或手动值 |
| Codex Fast mode | 默认“跟随本地配置”；`on` 请求 Fast，`off` 关闭本次翻译的 Fast |

选择“手动输入”后，在紧邻的“手动值”行填写内容。可执行文件只填路径，不加引号或参数；手动值行在未启用时可以留空。

当前模型预设为 `gpt-6.1-sol / gpt-6.1-terra / gpt-6-astra / gpt-6-luna`。模型、推理等级和 Fast 的支持情况取决于你的账号、模型和服务；手动输入可使用其他模型 ID。Fast 可能增加用量，不保证实际提速。

例如在安装时为翻译单独指定较低推理等级：

```bash
claude plugin install interaction-translator@claude-interaction-translator \
  --config backend=codex-cli \
  --config codex_reasoning_effort=low
```

这些选项同时作用于输入和输出翻译，不修改本地 Codex 配置文件，也不修改 Claude 的主模型。每次 CLI 翻译使用临时会话，超时 120 秒；失败不会回退到 API。

### API 配置

将 Translation backend 设为 `api`：

| 配置项 | 选择方式 |
| --- | --- |
| API URL | 默认 GLM 地址，或选择“手动输入”并填写完整 `chat/completions` URL |
| Translation model | 默认 `glm-5.3-flash`，或手动填写模型 ID |
| API Key source | 默认“自动读取凭据”；手动模式只使用原生安全输入框中的 Key |
| API Key | 填写翻译服务的 Key，使用原生遮罩与安全存储 |
| Reasoning effort | 仅 API 使用，默认 `low`；`default` 表示不发送该字段 |

内置 API 地址：`https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`。更换服务时，URL 和模型都选择“手动输入”，再填写各自的手动值。接口需兼容 OpenAI Chat Completions，并返回 `choices[0].message.content`。

自动凭据来源依次为安全配置、`TRANSLATOR_API_KEY` 环境变量、插件目录的 `.env`。推荐使用原生安全输入框，避免把密钥写入仓库。更多接入方式见[模型接入说明](docs/integration.md)。

## 4. 日常使用和显示模式

完成安装和配置后，日常直接运行 `claude`，正常发送问题即可。例如“请用两句话解释 HTTP”。输入框上方会显示输入翻译进度，随后 Claude 生成回复。默认 **不自动翻译输出**，原文直接显示，只有点击“翻译”才调用翻译后端。等待和翻译期间仍可阅读原文，完整译文通过校验后再替换对应正文。

全屏界面可以直接点击回复旁的“翻译”。普通终端使用输入框上方的“翻译回复”：按 `Ctrl+X` 后按 `Tab` 聚焦按钮，再按 `t`；有多条待译回复时，用“上一条 / 下一条”（`p / n`）选择，上方短句显示本次目标。插件不会翻译整段聊天记录。需要恢复自动翻译时，在配置里将 **Display translation trigger** 改为 `auto`。

输入框中按 ↑ / ↓ 回看历史时，会保留你输入时的原文；Claude 收到的正文仍是译文。排队输入和正常插件热重载也保留这一行为。之前已经存成译文的历史不会自动恢复。

输入翻译前会在本地检查正文语言。能明确判断输入已是目标提示词语言时，直接保留原文，不调用翻译 API 或 Codex，也不显示输入翻译进度。例如目标为英文时，英文输入可以直接发送；Claude 的回复语言仍按配置执行。代码、路径和 URL 不参与语言判断；混合语言、判断不确定或超过本地检测范围的输入继续走正常翻译。

| 模式 | 交互界面 | 模型历史 | `claude -p` |
| --- | --- | --- | --- |
| `display-only`（默认） | 默认保留原文，点击后翻译；`auto` 自动翻译新回复 | 保留 Claude 原始回复，默认英文 | 输出原始回复，不调用输出翻译 |
| `conversation` | 显示译文 | 写入译文，后续模型会读到译文 | 输出译文 |

回复语言通过指令引导；保留原始回复并不保证模型生成的每个字符都是英文。显示翻译不改写已保存的会话内容，验证显示模式时建议使用新会话。

输入翻译失败会停止本次提交；显示翻译失败会保留原文并提示错误，可按按钮重试，重试期间也保留原文。代码、路径和 URL 会保护并还原；纯代码或代码边界不完整的可见块保留原文。命令、空输入和以 `! / #` 开头的输入直接放行。

如果宿主改变输入结构，导致已准备的译文无法对应正文，插件会显示错误，并向 Claude 交付英文重试提示，原始正文不会被发送。取消大量排队消息后若提示等待队列已满，请先处理剩余队列；仍无法发送时可重启会话。

显示缓存仅在内存中保留，重绘复用缓存。手动模式每次只翻译选中的可见文本块；恢复的历史也可主动点击翻译，滚动、展开、重绘均不会触发翻译。缓存最多保留 128 个条目和 4 MiB；手动模式容量满时回收旧条目，之后再次查看可能显示原文，须重新点击翻译。`auto` 模式只自动翻译本次新追加的回复，resume 或插件重载后的已有历史仍保持原样。CLAUDE.md、Skill、工具结果和图片不会自动翻译，具体范围见[上下文语言边界](docs/context-language-boundaries.md)。

原生选择面板（`AskUserQuestion`）默认也保留原文，全屏界面可点击“翻译问题”。普通终端在选择面板打开时无法聚焦插件按钮，因此显示原文和说明；需要问题自动翻译时，可事先将 `output_trigger` 设为 `auto`。显式 `conversation` 模式仍保持旧的自动翻译行为。原始选项名称会保留，译名显示在说明中；有右侧预览时，问题下方会补充带序号的选项译文，代码预览保持原样。提交的选择不变。如果你已经开始选择或输入，Claude Code 可能固定本次面板内容，保留原文以保护当前选择；`Submit` 等原生按钮文字不属于翻译范围。

### 确认 display-only 已生效

1. 确认提示词和 Claude 回复语言为英文，输出语言为中文，模式为 `display-only`。
2. 在新会话发送一句普通问题，点击“翻译回复”，等界面显示中文译文。
3. 在 Claude 会话中输入 `/export /tmp/interaction-translator-check.txt`，查看导出文本中对应的助手回复。

**界面中文、导出的同一条回复仍为英文，说明这条回复的显示与历史已分离。** 两种模式都有进度框，单看进度框无法区分。

## 5. 更新、临时停用和重新启用

更新，在系统终端执行：

```bash
claude plugin marketplace update claude-interaction-translator
claude plugin update interaction-translator@claude-interaction-translator
```

更新后在当前 Claude 会话运行 `/reload-plugins`，或重新启动 Claude。

临时停用 / 重新启用，在终端分别执行：

```bash
claude plugin disable interaction-translator@claude-interaction-translator
claude plugin enable interaction-translator@claude-interaction-translator
```

在 Claude 会话中也可打开 `/plugin` → Installed → 本插件，选择 Disable / Enable，再按提示重新加载。停用会停止后续翻译，不会改写已有历史。

## 6. 卸载

在终端执行：

```bash
claude plugin uninstall interaction-translator@claude-interaction-translator
```

需要保留原生插件持久化数据目录时追加 `--keep-data`。项目或本地范围安装需使用对应的 `--scope project` 或 `--scope local`，并在对应项目目录执行。卸载后重新加载插件或重启 Claude。

若不再使用这个 marketplace，可另外移除它：

```bash
claude plugin marketplace remove claude-interaction-translator
```

## 7. 从本地源码加载或安装

```bash
git clone https://github.com/whiteCcinn/claude-interaction-translator.git
cd claude-interaction-translator
claude --plugin-dir ./plugins/interaction-translator
```

这是仅当前运行加载的开发方式。会话内配置 ID 为：

```text
/plugin configure interaction-translator@inline
```

长期从本地目录安装，可在仓库根目录运行 `claude plugin marketplace add ./`，再按上面的完整 marketplace 插件 ID 安装。同名 marketplace 的本地源与 GitHub 源选择其一；用 `claude plugin marketplace list` 检查来源，避免重复加载已安装版和开发版。

开发检查与 CI 说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 8. 常见问题

| 现象 | 处理 |
| --- | --- |
| Claude 中找不到 Codex | 检查启动环境的 `PATH`，或在 Codex executable 的手动值中填写绝对路径 |
| 翻译耗时较长 | 检查 CLI 继承的模型和推理等级；可指定翻译专用模型及 `low / medium`，再比较耗时 |
| 配置变化没有体现 | 确认使用正确的完整插件 ID，保存后重新加载或重启 Claude |
| 出现两次翻译 | 检查已安装版和 `--plugin-dir` 开发版是否同时启用 |
| `claude -p` 没有输出译文 | 默认 `display-only` 保留原文；需要无界面译文时显式选择 `conversation` |

## 许可和维护

维护者：[whiteCcinn](https://github.com/whiteCcinn)。使用 [MIT License](LICENSE)。

参考：[Claude Code 插件安装](https://code.claude.com/docs/en/plugins/install) · [Mods API](https://code.claude.com/docs/en/plugins/mods/api) · [Codex 非交互模式](https://developers.openai.com/codex/noninteractive)
