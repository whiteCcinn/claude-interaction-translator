import { expect, test } from "claude-code/testing"
import { canSkipInputTranslation, hasUntranslatedCjkInput, MAX_LANGUAGE_PROSE_CHARS, MAX_LANGUAGE_SOURCE_CHARS } from "../hooks/input-language"

test("wrong-language input validation requires prose, allowing preserved code and names", () => {
  expect(hasUntranslatedCjkInput("请检查 callback 和 scan 的数据。", "en")).toBe(true)
  expect(hasUntranslatedCjkInput("この設定を確認してください。", "fr")).toBe(true)
  expect(hasUntranslatedCjkInput("Check the label 请检查. Use `这条命令` and /tmp/设置.txt.", "en")).toBe(false)
  expect(hasUntranslatedCjkInput("`请检查这条命令`", "fr")).toBe(false)
  expect(hasUntranslatedCjkInput("上海浦东发展银行", "en")).toBe(false)
  expect(hasUntranslatedCjkInput("请检查 callback 和 scan 的数据。", "cn")).toBe(false)
})
import type { Language } from "../hooks/languages"

const same: Array<[Language, string]> = [
  ["en", "Hello world!"], ["en", "commit + push"],
  ["en", "This is already written in English. Please send it unchanged."],
  ["en", "Implement bounded concurrent caching for repository lookups."],
  ["en", "Please check /tmp/中文目录/日本語.ts and this API."],
  ["en", "Please check `中文` and https://example.com/日本語.\n```js\nconsole.log('你好');\n```"],
  ["fr", "Bonjour, pouvez-vous modifier ce bouton ?"],
  ["fr", "Veuillez vérifier le code et corriger cette erreur."],
  ["cn", "请修改这个按钮。"], ["cn", "请检查代码。"],
  ["jp", "このコードを確認してバグを修正してください。"],
  ["jp", "APIを修正してください。"],
]
for (const [target, text] of same) test(`local preflight recognizes ${target}: ${text.slice(0,42)}`, () => expect(canSkipInputTranslation(text, target)).toBe(true))

const uncertain: Array<[Language, string]> = [
  ["en", "Bonjour, pouvez-vous modifier ce bouton ?"],
  ["en", "Por favor, revisa este código y corrige el error."],
  ["en", "Bitte ändere diese Schaltfläche."],
  ["en", "HOLA"], ["en", "HoLa"], ["en", "Please HoLa"], ["en", "qwertyz"], ["en", "a"],
  ["en", "Please 修复按钮"], ["en", "Please explain 日本語"],
  ["en", "Fix this bug et expliquez pourquoi."],
  ["fr", "Please fix this bug et expliquer le résultat."],
  ["en", "Please explain English/中文"],
  ["cn", "修改代碼"], ["cn", "設定変更"],
  ["jp", "この代码を確認してください。"],
  ["jp", "このコードを確認してください。检查数据库。"],
  ["jp", "これはテストです。谢谢。"],
  ["jp", "こんにちは。你好。"],
  ["jp", "このままで。继续运行测试。"],
  ["fr", "react"], ["cn", "node"],
]
for (const [target, text] of uncertain) test(`local preflight keeps translation for ${target}: ${text}`, () => expect(canSkipInputTranslation(text, target)).toBe(false))

for (const tail of ["Borra todo.", "Effacez intégralement.", "Dziękuję bardzo."]) {
  test(`a strong English prefix cannot hide an independent foreign tail: ${tail}`, () => {
    const prefix = "The implementation must preserve existing behavior and gracefully handle concurrent requests without introducing new dependencies. "
    expect(canSkipInputTranslation(prefix + tail, "en")).toBe(false)
  })
}

test("local preflight does not sample past the bound and ignore a foreign tail", () => {
  expect(canSkipInputTranslation("Please check this code. ".repeat(MAX_LANGUAGE_PROSE_CHARS) + "中文", "en")).toBe(false)
  expect(canSkipInputTranslation("x".repeat(MAX_LANGUAGE_SOURCE_CHARS + 1), "en")).toBe(false)
})

test("protected-only code and literal punctuation need no language conversion", () => {
  for (const target of ["en", "fr", "cn", "jp"] as const) {
    expect(canSkipInputTranslation("```sh\necho '你好'\n```", target)).toBe(true)
    expect(canSkipInputTranslation("123 ✅", target)).toBe(true)
  }
})
