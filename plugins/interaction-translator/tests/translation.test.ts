import { expect, mock, test } from "claude-code/testing"
import { segmentResponse } from "./segmented-fixtures"

import { envToken, languageCode, LANGUAGES, protectText, restoreText, translatedText } from "../hooks/register"

test("defaults to English and accepts the four requested language codes", () => {
  expect(languageCode(undefined)).toBe("en")
  expect(languageCode("unknown")).toBe("en")
  for (const code of ["en", "jp", "cn", "fr"] as const) {
    expect(languageCode(code)).toBe(code)
    expect(LANGUAGES[code].name).toBeDefined()
  }
})

test("reads the text from an OpenAI-compatible GLM response", () => {
  expect(translatedText({ choices: [{ message: { content: "Présentez le projet." } }] })).toBe("Présentez le projet.")
})

test("rejects malformed or empty GLM responses", () => {
  for (const value of [null, {}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: "" } }] }]) {
    expect(translatedText(value)).toBe(undefined)
  }
})

test("reads a token without executing shell content", () => {
  expect(envToken('# comment\nexport TRANSLATOR_API_KEY="example-token"\nOTHER=ignored')).toBe("example-token")
  expect(envToken("TRANSLATOR_API_KEY=example-token # comment")).toBe("example-token")
  expect(envToken("TRANSLATOR_API_KEY=replace-with-your-api-key")).toBe(undefined)
  expect(envToken('TRANSLATOR_API_KEY="unclosed')).toBe(undefined)
})

test("loads a plugin-local API key and sends the OpenAI-compatible request", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  mock.clock(on)
  on("env.get", () => ({ value: undefined }))
  on("fs.read", (_, e) => {
    if (e.path.endsWith("/.env")) return { value: "TRANSLATOR_API_KEY=example-token" }
    throw new Error("File not found")
  })
  on("ui.invalidate", () => ({ value: undefined }))
  on("http.fetch", (_, e) => {
    const request = JSON.parse(typeof e.init?.body === "string" ? e.init.body : "")
    expect(request.model).toBe("glm-5.3-flash")
    expect(request.reasoning_effort).toBe("low")
    expect(request.messages[0].content).toContain("natural English")
    expect(e.init?.headers?.Authorization).toBe("Bearer example-token")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: "glm-5.3-flash", choices: [{ finish_reason: "stop", message: { content: segmentResponse(request.messages[1].content, "Change the button. Keep __GLM_KEEP_0__.") } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  const result = await $.prompt.submit({ text: "修改按钮。保留 /tmp/demo.txt。", origin: { kind: "composer" }, wait: false })
  expect(result.text).toBe("修改按钮。保留 /tmp/demo.txt。")
  const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "protected-prompt", message: { type: "user", content: [{ type: "text", text: result.text ?? "" }] } })
  expect(row.message?.content).toEqual([{ type: "text", text: "Change the button. Keep /tmp/demo.txt。" }])
  expect(result.context?.[0]).toContain("Reply in natural English")
})

test("accepts a provider response that resolves the requested model to an alias", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: "glm-5.3-flash-snapshot", choices: [{ message: { content: "Bonjour." } }] }) } }))
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const result = await $.prompt.submit({ text: "你好", origin: { kind: "sdk" }, wait: false })
  expect(result.text).toBe("Bonjour.")
})

test("rejects a translation that introduces a command prefix", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: "glm-5.3-flash", choices: [{ message: { content: "/Change the button." } }] }) } }))
  const result = await $.prompt.submit({ text: "修改按钮", origin: { kind: "sdk" }, wait: false })
  expect(result.drop).toContain("command prefix")
})

test("Codex does not submit an answer as the translation of a setting question", { options: { backend: "codex-cli" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  mock.clock(on)
  on("ui.invalidate", () => ({ value: undefined }))
  const source = "RetryLimit = [2, 5] 是干嘛的"
  const question = "What does `RetryLimit = [2, 5]` do?"
  let output = "`RetryLimit = [2, 5]` 表示在达到 **2 和 5** 时触发重试。"
  let forwarded = 0
  on("process.run", (_, e) => {
    expect(e.init?.stdin).toBe(source)
    return { value: { exitCode: 0, stdout: output, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on("prompt.submit", (_, e) => { forwarded++; return { text: e.text } })
  for (const answer of [output, "重试上限是什么意思?", "It configures the retry limit.", "It configures retries. Would you like an example?"]) {
    output = answer
    const rejected = await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
    expect(rejected.drop).toContain("TR_INPUT_QUESTION")
    expect(forwarded).toBe(0)
  }
  output = question
  const accepted = await $.prompt.submit({ text: source, origin: { kind: "composer" }, wait: false })
  expect(accepted.drop).toBe(undefined)
  expect(forwarded).toBe(1)
  const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "setting-question", message: { type: "user", content: [{ type: "text", text: source }] } })
  expect(row.message?.content).toEqual([{ type: "text", text: question }])
})

test("API accepts a French setting question and leaves embedded-question instructions alone", { options: { backend: "api", language: "fr" } }, async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  let output = "À quoi sert RetryLimit ?"
  on("http.fetch", (_, e) => {
    const request = JSON.parse(String(e.init?.body))
    expect(request.messages[0].content.includes("one standalone question")).toBe(output.endsWith("?"))
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { content: output } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text }))
  expect((await $.prompt.submit({ text: "RetryLimit 有什么用？", origin: { kind: "sdk" }, wait: false })).text).toBe(output)
  output = "Expliquez à quoi sert RetryLimit."
  expect((await $.prompt.submit({ text: "请解释 RetryLimit 有什么用。", origin: { kind: "sdk" }, wait: false })).text).toBe(output)
})

test("preserves leading identifiers and allows an existing path at the start", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    const request = JSON.parse(typeof e.init?.body === "string" ? e.init.body : "")
    expect(JSON.parse(request.messages[1].content).map((row: { text: string }) => row.text)).toEqual(["请保留"])
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: "glm-5.3-flash", choices: [{ message: { content: segmentResponse(request.messages[1].content, "保持してください：__GLM_KEEP_0__。") } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const result = await $.prompt.submit({ text: "TASK_001: 请保留 /tmp/demo.txt。", origin: { kind: "sdk" }, wait: false })
  expect(result.text).toBe("TASK_001: 保持してください： /tmp/demo.txt。")
})

test("restores paths, URLs, and code exactly and rejects lost markers", () => {
  const source = "查看 /tmp/demo.txt 和 https://example.com/a?x=1，并运行 `echo $HOME`。\n```sh\ncat /tmp/demo.txt\n```"
  const protectedText = protectText(source)
  expect(protectedText.values).toEqual(["/tmp/demo.txt", "https://example.com/a?x=1", "`echo $HOME`", "```sh\ncat /tmp/demo.txt\n```"])
  expect(restoreText(protectedText.text, protectedText)).toBe(source)
  expect(restoreText(protectedText.text.replace("__GLM_KEEP_0__", "changed"), protectedText)).toBe(undefined)
})

test("passes commands and empty prompts without a translation request", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("ui.invalidate", () => ({ value: undefined }))
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  for (const text of ["/help 中文", "!echo 中文", "", "   "]) {
    const result = await $.prompt.submit({ text, origin: { kind: "composer" }, wait: false })
    expect(result.text).toBe(text)
  }
})

test("translates foreign input and bypasses already-English input", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  let calls = 0
  on("http.fetch", (_, e) => {
    calls += 1
    const request = JSON.parse(typeof e.init?.body === "string" ? e.init.body : "")
    expect(request.messages[0].content).toContain("Detect the input language")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: "glm-5.3-flash", choices: [{ message: { content: "Change the button." } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  for (const text of ["修改按钮。", "ボタンを変更してください。", "Modifier le bouton.", "Change the button."]) {
    const result = await $.prompt.submit({ text, origin: { kind: "sdk" }, wait: false })
    expect(result.text).toBe("Change the button.")
    expect(result.context?.[0]).toContain("Reply in natural English")
  }
  expect(calls).toBe(3)
})

test("stops a prompt when no token is configured", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  mock.clock(on)
  on("env.get", () => ({ value: undefined }))
  on("fs.read", () => { throw new Error("File not found") })
  on("ui.invalidate", () => ({ value: undefined }))
  const result = await $.prompt.submit({ text: "你好", origin: { kind: "composer" }, wait: false })
  expect(result.drop).toContain("API Key")
})

test("animates the loading card and removes the completed preview", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const clock = mock.clock(on)
  on("env.get", () => ({ value: "example-token" }))
  on("ui.render", ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on("http.fetch", async () => {
    await clock.sleep(1200)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: "glm-5.3-flash", choices: [{ message: { content: "Change the button." } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const submission = $.prompt.submit({ text: "修改按钮", origin: { kind: "composer" }, wait: false })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
  expect((await ui.find({ type: "Text", text: /翻译中/ }))?.text).toContain("翻译中.")
  await clock.advance(500)
  expect((await ui.find({ type: "Text", text: /翻译中/ }))?.text).toContain("翻译中...")
  expect((await ui.find({ type: "Text", text: /翻译中/ }))?.text).toContain("0.5 秒")
  await clock.advance(700)
  expect((await submission).text).toBe("修改按钮")
  expect((await ui.find({ type: "Text", text: /翻译完成/ }))?.text).toContain("1.2 秒")
  expect((await ui.find({ type: "Text", text: "Change the button." }))?.text).toBe("Change the button.")
  await clock.advance(3000)
  expect(await ui.find({ type: "Text", text: /翻译完成/ })).toBe(undefined)
  await ui.unmount()
})

test("keeps the failure card until the next input", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  const clock = mock.clock(on)
  on("env.get", () => ({ value: undefined }))
  on("fs.read", () => { throw new Error("File not found") })
  on("ui.render", ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const result = await $.prompt.submit({ text: "修改按钮", origin: { kind: "composer" }, wait: false })
  expect(result.drop).toContain("API Key")
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
  expect((await ui.find({ type: "Text", text: /翻译失败/ }))?.text).toContain("原文未发送")
  await clock.advance(6000)
  expect((await ui.find({ type: "Text", text: /翻译失败/ }))?.text).toContain("原文未发送")
  await $.prompt.submit({ text: "/help", origin: { kind: "composer" }, wait: false })
  expect(await ui.find({ type: "Text", text: /翻译失败/ })).toBe(undefined)
  await ui.unmount()
})
