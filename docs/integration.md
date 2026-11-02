# 模型接入说明

## 先选择翻译方式

插件配置中的 **Translation backend** 支持：

| 值 | 调用方式 | 认证来源 |
| --- | --- | --- |
| `api`（默认） | OpenAI 兼容 HTTP 接口 | 插件配置、环境变量或 `.env` 中的翻译 API Key |
| `codex-cli` | 本地 `codex exec` 子进程 | Codex CLI 已保存的登录态和服务配置 |

两种模式均用于输入翻译和输出翻译，共用代码片段保护和失败拦截。不会在两种模式之间自动回退。

## 四段独立语言

| 字段 | 配置键 | 默认 | 说明 |
| --- | --- | --- | --- |
| Input language | `input_language` | `cn` | 输入语言，也可选 `auto` 自动识别 |
| Claude prompt language | `language` | `en` | 输入翻译后发给 Claude 的语言，保留原有配置键 |
| Claude reply language | `claude_language` | `same-as-prompt` | Claude 正文回复语言，可单独指定；默认跟随提示词语言 |
| Output language | `output_language` | `cn` | 最终输出语言；`same-as-claude` 跳过输出翻译 |
| Output translation mode | `output_mode` | `display-only` | 界面显示译文，模型历史保留原始回复；`conversation` 兼容旧版历史改写 |

各语言支持 `cn / en / jp / fr`。默认链路为：中文输入 → 英文提示词 → Claude 英文回复 → 中文输出。中文输入、法文输出可仅修改 `output_language=fr`。输入语言为提示，翻译模型仍会处理混合语言。

原有 `language` 配置继续作为提示词语言。Claude 回复语言默认跟随它，最终输出新增为默认中文；想保留直接显示 Claude 原文的行为，可将 **Output language** 设为 `same-as-claude`。

从 0.3.0 起，默认 `display-only` 使用原生 `AssistantMessage` 渲染钩子，只替换界面正文。`turn.step` 的原始块、返回值和错误原样通过，模型历史保留原始回复；默认语言链路下就是英文。工具调用、参数、工具结果和思考块保持原有流程。Claude 回复语言通过指令引导，不保证所有回复严格遵循语言要求。

显示翻译等待正在生成的响应结束，后台翻译当前可见的完整文本块，不阻塞界面绘制。摘要只翻译实际显示的摘要，不会拿完整回复替换它，也不会恢复被界面隐藏的内容。代码、路径和 URL 保持字面值；纯代码或代码边界不完整的可见块保留原文。多块回复可能增加多次翻译调用，重复重绘复用缓存；同语言或 `same-as-claude` 不翻译。

旧行为可通过 `output_mode=conversation` 显式选择。该模式仍缓冲完整主会话响应、保护跨 chunk 代码块，同时改写显示和 transcript；后续模型会读到译文。`claude -p` 在 `display-only` 下直接输出原始回复、没有输出翻译调用；需要无界面译文时使用 `conversation`。

默认模式不持久化译文缓存。插件重载或会话恢复后，可见内容会按需重译；后台子代理不因生成回复而自动翻译，但用户主动查看其对话时可翻译可见正文。翻译失败只影响界面，并提供显式重试，原始模型历史不变。当前保留原始会话记录；已经存入的旧中文历史不会被自动改写。其他中文入口见 [上下文语言边界](context-language-boundaries.md)。

## 安装时选择与后续修改

安装后，在 Claude Code 中运行 `/plugin configure interaction-translator@claude-interaction-translator`，按顺序选择翻译方式、四段语言，再填写该模式需要的配置。这个入口也可以从 `/plugin` 的 Installed 标签进入：选择本插件，再选择 **Configure options**。

也可以在安装命令中直接指定配置，以下参数已在 Claude Code 2.1.316 验证：

```bash
claude plugin install interaction-translator@claude-interaction-translator \
  --config backend=codex-cli \
  --config input_language=cn \
  --config language=en \
  --config claude_language=en \
  --config output_language=fr
```

上例会安装为中文输入、英文提示词、Claude 英文回复、法文最终输出。后续通过同一配置入口或 `/config` 随时切换后端和语言。两种后端的配置分别保留，切换不会清空另一种模式的字段。API Key 只在 API 模式使用，不影响 Codex CLI 的配置和运行。

在交互会话中保存配置后，Claude Code 会重新加载插件。若使用终端命令 `claude plugin configure ... --values-stdin` 在会话外修改配置，则按命令提示重启 Claude Code，或在会话中重新加载插件。

## Codex CLI 模式

在运行 Claude Code 的同一机器、用户和环境中确认：

```bash
codex --version
codex login status
```

尚未登录时，先运行 `codex login` 完成登录。插件不会读取或复制 Codex 的凭据文件。

在插件配置中把 **Translation backend** 设为 `codex-cli`，**Codex executable** 默认显示“跟随本地配置”，使用 Claude Code 进程的 `PATH` 中的 `codex`。命令不可见时选择“手动输入”，在下一行填写可执行文件的绝对路径。路径可以包含空格，不额外加引号，也不拼接参数。SSH 会话调用的是远端机器上的 CLI。

CLI 模式不读取翻译 API Key，**API URL / Translation model / Reasoning effort** 均不参与该模式。CLI 使用下面的独立选项：

| 字段 | 配置键 | 默认 | 用途 |
| --- | --- | --- | --- |
| Codex executable | `codex_path_selection` | 跟随本地配置 | 使用 PATH 中的 `codex`；手动输入时读取下一行 `codex_path` |
| Codex translation model | `codex_model_selection` | 跟随本地配置 | 继承本地模型，或选模型预设；手动输入时读取下一行 `codex_model` |
| Codex reasoning effort | `codex_reasoning_effort` | 跟随本地配置 | 可选 `low / medium / high / xhigh / max`；手动输入时读取 `codex_reasoning_effort_manual`，以模型支持为准 |
| Codex Fast mode | `codex_fast_mode` | 跟随本地配置 | `on` 请求 Fast，`off` 为翻译关闭 Fast |

模型选择顺序为“跟随本地配置” → `gpt-6.1-sol / gpt-6.1-terra / gpt-6-astra / gpt-6-luna` → “手动输入”。预设根据 2026-11-01 的 [Codex 官方模型说明](https://learn.chatgpt.com/docs/models) 整理，不保证每个账号或自定义服务都可用；其他模型 ID 使用手动输入。

显式模型通过 `--model` 传给 `codex exec`，显式推理等级通过 `-c model_reasoning_effort="low"` 等参数传入；只影响本次子进程，输入和输出翻译都会使用，不会写回 Codex 配置。选择“跟随本地配置”时省略对应参数，旧的推理/Fast 值 `default` 仍按继承处理。API 的 `model` 和 `reasoning_effort` 字段保持独立，后者默认仍为 `low`。

例如安装时仅降低翻译推理等级、保留本地模型：

```bash
claude plugin install interaction-translator@claude-interaction-translator \
  --config backend=codex-cli \
  --config codex_reasoning_effort=low
```

选择预设模型可增加 `--config codex_model_selection=gpt-6-luna`。自定义模型需同时增加 `--config codex_model_selection=手动输入 --config codex_model=your-translation-model`，后续从插件配置页修改。较高推理等级或较慢的模型可能增加延迟；CLI 启动、扩展加载、网络和服务端响应也会影响速度。先固定模型，比较 `low`、`medium` 和本地默认配置的耗时，有助于区分原因。

Fast 与模型和推理等级分别配置。`codex_fast_mode=on` 给每次 `codex exec` 加 `-c service_tier="fast"` 和 `-c features.fast_mode=true`；`off` 则加 `-c service_tier="default"` 和 `-c features.fast_mode=false`，覆盖本地已开启的 Fast 偏好。“跟随本地配置”不添加这两项。输入和输出翻译均使用同一选择，API 请求和主 Claude 模型不受影响。

安装时可追加 `--config codex_fast_mode=on`，后续在插件配置页选择 **Codex Fast mode**。Fast 需模型、账号和服务端支持，可能增加额度或计费用量；选择开启表示请求 Fast，不保证服务端实际采用或一定提速。费用和可用范围以 [OpenAI Fast 模式说明](https://learn.chatgpt.com/docs/agent-configuration/speed#fast-mode) 为准。

插件通过 Claude Code 的 `$.process.run` 无 shell 启动 `codex exec`，从标准输入传递保护后的文本，只取标准输出中的最终回答。每次启动独立临时会话，使用只读沙箱、禁用 shell 工具，并关闭 `AGENTS.md` 的自动加载，避免项目开发指令干扰翻译。翻译指令要求只翻译、不执行文本中的任务。

每次调用最多等待 120 秒。启动失败、超时、非零退出码、空输出、标准输出被截断或保护标记异常时，都会停止提交。取消的提交即使收到译文也不会继续发送；子进程的停止由宿主和超时控制。插件不会显示 Codex 的原始标准错误内容。

Codex 仍会访问其配置的模型服务，并遵循该服务的额度和可用性。本地配置中的 MCP、hooks 等扩展可能影响启动耗时和行为；只读沙箱和禁用 shell 不代表所有扩展都被禁用。插件不会修改本地 Codex 配置。

本功能已在 Codex CLI 0.166.0 和 Claude Code 2.1.316 环境下验证。旧版 Codex 若不支持这些参数，请先升级；其他操作系统尚未验证。

## API 模式：先确定这三个值

从你的翻译服务获取：**完整请求地址、模型 ID、API Key**。这三项必须来自同一个服务。

| 服务类型 | API URL 示例 | 模型与 Key |
| --- | --- | --- |
| GLM Coding 接口 | `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` | 使用该服务支持的模型 ID 和自己的 Key |
| 自建 OpenAI 兼容网关 | `https://your-gateway.example/v1/chat/completions` | 使用网关暴露的模型 ID 和 Key |
| 本地 OpenAI 兼容服务 | `http://127.0.0.1:1234/v1/chat/completions` | 使用本地服务加载的模型 ID；无需鉴权的服务可填 `local` 作为占位 Key |

本地地址是 **Claude Code 所在机器** 的地址。通过 SSH 使用插件时，`127.0.0.1` 指向远端机器。

GLM 是本项目已完成真实调用验证的默认接入。网关和本地服务按下面的协议对接；不同服务对模型名、额度和扩展参数的要求由该服务决定。

## 填入配置

在 Claude Code 中执行：

```text
/plugin configure interaction-translator@claude-interaction-translator
```

- **API URL**：选择默认 GLM 地址；其他地址选“手动输入”，在下一行填写完整请求路径，包含 `chat/completions` 或网关的等效路径。
- **Translation backend**：选择 `api`。
- **Translation model**：选择默认模型；其他模型选“手动输入”，在下一行填写模型 ID。
- **API Key source**：默认“自动读取凭据”；选“手动输入”时只使用下方安全存储中的 Key，缺失时停止，不回退到环境变量。
- **API Key**：填写翻译服务密钥。
- **Input language / Claude prompt language / Claude reply language / Output language**：分别设置输入、提示词、Claude 回复和最终输出语言。
- **Reasoning effort**：默认 `low`；接口不支持时选 `default`。

`/config` 也可以修改非敏感选项。语言变化自动重新加载插件，不需要反复手动启动。

主选项都有明确默认值。原生配置使用单独的“手动值”行，只在选择“手动输入”时要求填写；未使用时可以留空。API Key 保留原生遮罩和安全存储。旧版的自定义路径、模型和 API 地址继续沿用，在会话内首次打开配置时会补齐缺失的选择项；显式选择继承或预设后，保留的手动值不会覆盖该选择。会话外配置命令不执行这一步初始化；自动化修改时应同时传入选择项和对应的手动值。

## API 接口需要支持什么

插件向 **API URL 原样发起 POST**，不会自动补 `/v1` 或其他路径。

```http
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

输入翻译的请求形状：

```json
{
  "model": "your-model-id",
  "messages": [
    { "role": "system", "content": "Translation instructions..." },
    { "role": "user", "content": "Text to translate..." }
  ],
  "max_tokens": 1024,
  "stream": false
}
```

选择 `low / medium / high / max` 时，会额外发送相应的 `reasoning_effort`。选择 `default` 时省略该字段。

输出翻译使用相同协议，系统提示要求翻译 Claude 回复，输出预算为 `max_tokens: 8192`；输入翻译保留 `1024` 的预算。需要供应商支持对应的输出长度。

响应形状：

```json
{
  "model": "your-model-id-or-resolved-alias",
  "choices": [
    {
      "finish_reason": "stop",
      "message": { "content": "Translated text..." }
    }
  ]
}
```

需要 HTTP 2xx、有效 JSON、非空文本；返回 `finish_reason: length` 时停止提交。模型别名可由服务端解析为实际版本名，插件接受这种响应。

这个入口使用 `chat/completions` 协议。仅提供 Anthropic `messages` 或 OpenAI `responses` 协议的地址，需要先通过网关转换。

## API 环境变量和 .env

推荐通过插件配置填写 Key。自动化环境也可以提供 `TRANSLATOR_API_KEY`。

**API Key source** 为“自动读取凭据”时，加载顺序：**插件配置的 API Key → 进程环境变量 → 插件目录的 `.env`**；为“手动输入”时，仅使用插件配置的 API Key。

本地开发时：

```bash
cp plugins/interaction-translator/.env.example plugins/interaction-translator/.env
chmod 600 plugins/interaction-translator/.env
```

用编辑器填写这一行：

```dotenv
TRANSLATOR_API_KEY=your-api-key
```

`.env` 只用于 Key。接口、模型、语言和推理档位在插件配置里填写。插件安装目录可能随更新改变，因此日常安装优先使用插件安全存储，而不是在安装缓存里维护 `.env`。

## 手动安装或使用 Release ZIP

完整安装、更新、停用及卸载步骤见 [中文 README](../README.md) 和 [English README](../README.en.md)。插件的完整 ID 为 `interaction-translator@claude-interaction-translator`。

临时加载源码：

```bash
claude --plugin-dir ./plugins/interaction-translator
```

这是源码开发入口；日常接入优先用 README 中的插件安装命令。相同插件不要同时用两种方式安装。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 提示没有 API Key | 检查当前插件 ID 的配置，或 `TRANSLATOR_API_KEY` |
| Codex CLI 无法启动或超时 | 检查 **Codex executable**、Claude Code 的 `PATH`、`codex login status` 和本地 Codex 配置；最长等待 120 秒 |
| Codex CLI 非零退出码 | 在相同环境单独检查 Codex 的登录、额度、服务配置和版本 |
| Codex CLI 输出为空或被截断 | 缩短输入后重试，检查本地 Codex 是否能正常完成非交互任务 |
| HTTP 401 / 403 | Key、接口与账号权限是否匹配 |
| HTTP 404 | 是否填了完整请求路径 |
| HTTP 400 | 模型 ID、`max_tokens` 和 `reasoning_effort` 是否被接口接受；可把推理档位设为 `default` |
| HTTP 429 | 检查服务额度或限流，稍后重试 |
| 输入 API 译文过长 | 缩短输入；输入翻译 API 预算为 1024 tokens |
| 输出翻译失败 | 检查翻译后端；输出 API 预算为 8192 tokens。默认显示模式单块上限 256 KiB，最多缓存 128 项、4 MiB，排队 16 项、并发 2 项；旧 `conversation` 模式的缓冲上限为 256 KiB 序列化 chunk 数据或 10,000 个 chunk |
| 路径或代码标记未完整保留 | 模型没有完整保留标记；换翻译模型或缩短输入 |
| 没有加载提示框 | 用 `claude plugin list` 检查插件状态；确认当前打开的是会话，不是后台任务列表 |
| 出现 `Your conversation moved to the background` | 这是 Claude Code 的后台会话视图。选中对应会话按 Enter，或按 Esc 返回；普通会话可在 `/config` 关闭 `leftArrowOpensAgents` |

最后一项是 Claude Code 自身的导航行为，插件不会修改这些快捷键设置。

`display-only` 的显示队列、缓存和单块大小有上限；超限或翻译失败只在界面提示，不改写响应流。原始响应中断时保留中断状态，不补造正常结束标记。`conversation` 的输出缓冲超限时，则在后续正文块显示失败提示；若响应流随后中断，同样不补造结束标记或重复调用主模型。

## 已验证的范围

双向翻译的开发基线为 Claude Code 2.1.316。插件的请求、密钥读取、四段语言路由、代码片段保护、响应流协议保留、失败拦截和输入提示框状态有自动检查。输入 API 模式的 GLM 端点曾完成真实翻译和 Claude 收到译文的回读验证；这不代表本轮已真实验证输出 API 的每个供应商。

Codex CLI 后端已验证：mock 测试覆盖参数、标准输入、语言路由、代码片段还原、异常拦截和提示框；另在本机通过实际提交处理函数启动真实 Codex 子进程，确认英文译文、代码路径还原和回复语言 context。该检查不包含真实 Claude 模型接收译文后的回答，也不包含 CLI 模式的完整交互界面验收。

双向链路另通过实际输入和响应 hook 启动两次真实 Codex 子进程：中文输入译成英文，模拟的英文 Claude 回复译成日文，两次均还原代码路径。主模型回复在该检查中为模拟文本；完整的真实 Claude 会话仍需单独验收。

输入和输出的交互进度框分别显示阶段、方向、目标语言、后端和翻译耗时。输出计时从实际翻译调用开始，不计入主模型生成时间。成功提示 3 秒后收起；取消和被新操作替代时清理定时器。`claude -p` 不创建这些 UI 定时器，同语言和纯工具回复也不触发输出进度。

显示模式另通过真实 Claude Code 界面连接本地模拟模型与翻译服务验证：界面显示中文，下一次模型请求包含上一轮英文原文，不包含界面译文。测试使用独立配置目录和假密钥，不调用真实模型。清空会话和插件重载后的可见正文重译也完成检查；这不等于已验证所有桌面端或提供商。

同一模拟模型消息的两个文本块也分别显示译文，宿主为它们分配独立的渲染 ID。另在真实界面使用本地 CLI 桩程序完成两轮交互，验证定时任务可以启动子进程并保持英文历史；该检查未调用真实 Codex 模型，不验证翻译质量或速度。

CLI 模型和推理覆盖参数已通过 mocked hook 测试，安装配置的保存和继承切换也在隔离目录验证；本轮未调用真实模型比较这些档位的速度或翻译质量。

原生选择项另在临时配置目录完成安装、四个模型预设、手动输入、继承切换、Fast 和后端切换验证。真实交互配置中同时补齐旧模型和旧路径的选择项，保存后两项均保留，项目配置未被写入；测试目录随后删除。此检查没有调用真实模型。

Fast 的开启、关闭、默认继承、双向调用及 API 隔离有 hook 回归测试。另用 Codex CLI 0.166.0 向本地模拟服务发送测试请求：开启对应请求中的 `priority`，关闭时不发送 Fast tier。模拟服务在捕获请求后立即返回测试错误；这仅验证参数映射，没有调用真实模型，也不代表已验证实际 Fast 加速或计费。

接口形状兼容不等于每个供应商、模型和桌面端都已测试。完整 Windows / Claude Desktop 视觉效果未在本项目中验证。

## 官方参考

- [插件安装与配置](https://code.claude.com/docs/en/plugins/install)
- [userConfig 字段与安全存储](https://code.claude.com/docs/en/plugins-reference#user-configuration)
- [Mods API](https://code.claude.com/docs/en/plugins/mods/api)
- [Codex 非交互模式](https://developers.openai.com/codex/noninteractive)
- [后台会话导航](https://code.claude.com/docs/en/agent-view#switch-sessions-without-leaving-the-terminal)
