import { expect, mock, test } from "claude-code/testing"

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
    const request = JSON.parse(e.init?.body ?? "{}")
    expect(request.model).toBe("glm-5.3-flash")
    expect(request.reasoning_effort).toBe("low")
    expect(request.messages[0].content).toContain("natural English")
    expect(e.init?.headers?.Authorization).toBe("Bearer example-token")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: "glm-5.3-flash", choices: [{ finish_reason: "stop", message: { content: "Change the button. Keep __GLM_KEEP_0__." } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  const result = await $.prompt.submit({ text: "修改按钮。保留 /tmp/demo.txt。", origin: { kind: "composer" }, wait: false })
  expect(result.text).toBe("修改按钮。保留 /tmp/demo.txt。")
  const row = await $.session.append({ door: "prompt", origin: { kind: "composer" }, uuid: "protected-prompt", message: { type: "user", content: [{ type: "text", text: result.text ?? "" }] } })
  expect(row.message?.content).toEqual([{ type: "text", text: "Change the button. Keep /tmp/demo.txt." }])
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

test("preserves leading identifiers and allows an existing path at the start", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    const request = JSON.parse(e.init?.body ?? "{}")
    expect(request.messages[1].content).toBe("请保留 __GLM_KEEP_0__。")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: "glm-5.3-flash", choices: [{ message: { content: "__GLM_KEEP_0__を保持してください。" } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, origin: e.origin }))
  const result = await $.prompt.submit({ text: "TASK_001: 请保留 /tmp/demo.txt。", origin: { kind: "sdk" }, wait: false })
  expect(result.text).toBe("TASK_001: /tmp/demo.txtを保持してください。")
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

test("routes Chinese, Japanese, French, and English input through the translator", async ($, on) => {
  on("config.list", () => ({ value: [] }))
  on("env.get", () => ({ value: "example-token" }))
  on("http.fetch", (_, e) => {
    const request = JSON.parse(e.init?.body ?? "{}")
    expect(request.messages[0].content).toContain("Detect the input language")
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: "glm-5.3-flash", choices: [{ message: { content: "Change the button." } }] }) } }
  })
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  for (const text of ["修改按钮。", "ボタンを変更してください。", "Modifier le bouton.", "Change the button."]) {
    const result = await $.prompt.submit({ text, origin: { kind: "sdk" }, wait: false })
    expect(result.text).toBe("Change the button.")
    expect(result.context?.[0]).toContain("Reply in natural English")
  }
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
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
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
  const ui = await $.ui.mount({ plugin: "interaction-translator", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} } })
  expect((await ui.find({ type: "Text", text: /翻译失败/ }))?.text).toContain("原文未发送")
  await clock.advance(6000)
  expect((await ui.find({ type: "Text", text: /翻译失败/ }))?.text).toContain("原文未发送")
  await $.prompt.submit({ text: "/help", origin: { kind: "composer" }, wait: false })
  expect(await ui.find({ type: "Text", text: /翻译失败/ })).toBe(undefined)
  await ui.unmount()
})
