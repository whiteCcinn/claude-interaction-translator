import { francAll } from "./vendor/franc-min.mjs"
import type { Language } from "./languages"
import { protectText } from "./protected-text"

export const MAX_LANGUAGE_SOURCE_CHARS = 8192
// franc samples at most 2048 characters. Never let unseen prose decide bypass.
export const MAX_LANGUAGE_PROSE_CHARS = 2048
const ISO = { en: "eng", fr: "fra", cn: "cmn", jp: "jpn" } as const

const english = new Set(("a an the this that these those i we you he she it they me us my your our their its is are am was were be been being have has had do does did can could will would should must may might not no yes please hello hi thank thanks goodbye and or but if then else so as at by for from in into of on to up with without about after before again all any both each every only same other more most new old already also now just still very what which who when where why how " +
  "add change check commit push pull create delete remove update fix review test tests code bug bugs button file files path paths run read write explain translate send keep preserve use using want need needs implement feature function input output text english french language written unchanged error errors retry request response version project configuration settings cache build install start stop continue resume done describe image documentation improve report show find help work works working world good morning evening night okay ok steps tasks summary requirements implementation plan example examples notes").split(/\s+/))
const french = new Set(("a un une le la les ce cet cette ces de du des et ou mais si alors dans sur sous par pour avec sans en au aux est sont suis être ete été pas non oui nous vous votre vos notre nos leur leurs mon ma mes ton ta tes il elle ils elles on que qui quoi quand où comment pourquoi plus même nouveau nouvelle déjà encore seulement maintenant " +
  "bonjour salut merci beaucoup veuillez pouvez pourriez voulez pouvons expliquer expliquez modifier modifiez vérifier vérifiez corriger corrigez ajouter ajoutez supprimer supprimez changer changez utiliser utilisez traduire traduisez répondre répondez envoyer envoyez conserver conservez code test tests bouton fichier fichiers chemin chemins erreur erreurs problème réponse réponses requête version projet configuration paramètres fonction fonctionnalité français française texte écrit").split(/\s+/))
const neutral = new Set("api http https url urls sql json xml yaml yml css html js ts jsx tsx utf git github gitlab cli sdk codex claude openai node nodejs npm pnpm redis mysql postgresql typescript javascript python golang java kotlin swift react".split(" "))
const chineseEvidence = /请|这个|这些|那个|我们|你们|他们|这是|怎么|什么|可以|不要|帮我|一下|需要|已经|中文|简体|翻译|检查|修改|你好|谢谢|修复|设置|按钮|服务器|数据库|请求|响应|启动|代码/
// A narrow Simplified Chinese alphabet avoids silently treating Traditional
// characters or Kanji-only Japanese as an already-converted Chinese prompt.
const chineseCharacters = new Set("中英文句字文字体代码功能检查修改按钮回复请求响应界面输入输出配置服务缓存队列重试超时错误日志测试分支提交推送版本升级本地项目文件路径保留完成失败成功这个那个你我我们他们你们是的了和与在请帮一下需要可以怎么什么已经不要没有谢谢你好设置翻译开始结束启动停止删除添加创建查询数据数据库语言系统模型接口运行使用方法".split(""))

function detectionProse(source: string): { text: string; hadLetters: boolean } {
  // Detection only: protectText's ASCII path matcher can leave Unicode tails.
  // Require a path boundary so bare foreign words or "English/中文" stay visible.
  const pathsMasked = source.replace(/(^|[\s"'`(])(?:[A-Za-z]:\\|~\/|\.{1,2}\/|\/)[^\s"'`<>，。！？；：、（）]+/gmu, "$1 ")
  const protectedText = protectText(pathsMasked)
  const unprotected = protectedText.text.replace(new RegExp(protectedText.prefix + "\\d+__", "g"), " ")
  const text = unprotected.replace(/\b[A-Za-z][A-Za-z0-9_]*\b/g, word => {
      const lower = word.toLowerCase()
      if (neutral.has(lower)) return " "
      if (!english.has(lower) && !french.has(lower) && (/_|\d/.test(word) || /[a-z][A-Z]/.test(word) && /(?:Service|Controller|Handler|Manager|Client|Server|Middleware|Factory|Repository|Provider|Options|Config|Request|Response|DTO)$/.test(word))) return " "
      return word
    }).normalize("NFC").trim()
  return { text, hadLetters: /\p{L}/u.test(unprotected) }
}

function sentenceMatches(prose: string, target: Language): boolean {
  const han = /\p{Script=Han}/u.test(prose)
  const kana = /\p{Script=Hiragana}|\p{Script=Katakana}|[ーｰ]/u.test(prose)
  const latin = /\p{Script=Latin}/u.test(prose)
  const otherLetters = /\p{L}/u.test(prose.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Latin}\p{M}ーｰ]/gu, ""))
  if (otherLetters) return false
  if (target === "jp") return kana && !latin && !chineseEvidence.test(prose) && !/[这请们为吗没让对给从将与语说码设译简问个软钮帮复务]/u.test(prose)
  if (target === "cn") return han && !kana && !latin && (prose.match(/\p{Script=Han}/gu) ?? []).every(char => chineseCharacters.has(char)) && chineseEvidence.test(prose)
  if (han || kana) return false

  const words = prose.toLowerCase().match(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu) ?? []
  const own = target === "en" ? english : french
  const foreign = target === "en" ? french : english
  if (words.some(word => foreign.has(word) && !own.has(word))) return false
  if (words.length && words.every(word => own.has(word)) && words.some(word => !foreign.has(word))) return true
  if (words.length < 4 || prose.replace(/[^\p{L}]/gu, "").length < 20) return false

  const ranked = francAll(prose)
  const first = ranked[0]
  const second = ranked[1]
  // All supported profiles compete; a rank gap is evidence, not a probability.
  return first?.[0] === ISO[target] && Boolean(second) && first[1] - (second?.[1] ?? 1) >= 0.15
}

// This is an optimization decision, not an authoritative language label.
export function canSkipInputTranslation(source: string, target: Language): boolean {
  if (!source.trim() || source.length > MAX_LANGUAGE_SOURCE_CHARS) return false
  try {
    const { text, hadLetters } = detectionProse(source)
    if (text.length > MAX_LANGUAGE_PROSE_CHARS) return false
    if (!/\p{L}/u.test(text)) return !hadLetters
    // A dominant language cannot vouch for a short foreign trailing sentence.
    const sentences = text.split(/[.!?。！？;；,，、:\r\n]+/u).filter(part => /\p{L}/u.test(part))
    return sentences.length > 0 && sentences.every(part => sentenceMatches(part, target))
  } catch {
    return false
  }
}
