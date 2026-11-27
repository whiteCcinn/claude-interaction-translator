import type { Language } from "./languages"
import { MAX_CODEX_TIMEOUT_SECONDS } from "./configuration"
import type { MarkerValidation } from "./protected-text"
import type { SegmentValidation } from "./protected-segments"

// Only plugin-owned categories and numeric metadata may reach the display.
// Never attach stderr, thrown messages, credentials, or source text here.
export type TranslationFailure =
  | { kind: "timeout"; seconds: number }
  | { kind: "codex-exit"; code: number }
  | { kind: "api-http"; status: number }
  | { kind: "markers"; validation?: MarkerValidation }
  | { kind: "segments"; validation: SegmentValidation }
  | { kind: "codex-process" | "empty" | "truncated" | "configuration" | "credentials" | "api-url" | "api-request" | "api-response" | "api-length" | "command-prefix" | "input-question" | "input-handoff" | "queue" | "capacity" | "unknown" }

const ERROR_CODES: Record<TranslationFailure["kind"], string> = {
  timeout: "TR_CLI_TIMEOUT", "codex-exit": "TR_CLI_EXIT", "codex-process": "TR_CLI_PROCESS",
  empty: "TR_CLI_EMPTY", truncated: "TR_CLI_TRUNCATED", markers: "TR_TEXT_INVALID", segments: "TR_SEGMENT_INVALID",
  configuration: "TR_CONFIG", credentials: "TR_API_KEY", "api-url": "TR_API_URL",
  "api-http": "TR_API_HTTP", "api-request": "TR_API_REQUEST", "api-response": "TR_API_RESPONSE", "api-length": "TR_API_LENGTH",
  "command-prefix": "TR_INPUT_PREFIX", "input-question": "TR_INPUT_QUESTION", "input-handoff": "TR_INPUT_HANDOFF", queue: "TR_QUEUE", capacity: "TR_CAPACITY", unknown: "TR_UNKNOWN",
}

export function translationFailureCode(failure: TranslationFailure): string { return ERROR_CODES[failure.kind] }

export function translationFailureHint(failure: TranslationFailure, language: Language): string {
  switch (failure.kind) {
    case "segments": return {
      cn: `译文文本块不完整：预期 ${failure.validation.expected}，有效 ${failure.validation.observed}，仍缺 ${failure.validation.missing}。已尝试补译；原文和保护内容仍保留。请复制错误信息反馈。`,
      en: `Translated text segments are incomplete: expected ${failure.validation.expected}, valid ${failure.validation.observed}, unresolved ${failure.validation.missing}. Repair was attempted; the original and protected content remain preserved. Copy the error information.`,
      jp: `翻訳テキストが不完全です：期待 ${failure.validation.expected}、有効 ${failure.validation.observed}、未解決 ${failure.validation.missing}。補完を試みました。原文と保護内容は保持されています。`,
      fr: `Segments de traduction incomplets : attendus ${failure.validation.expected}, valides ${failure.validation.observed}, manquants ${failure.validation.missing}. Une réparation a été tentée ; l’original et le contenu protégé sont conservés.`,
    }[language]
    case "api-http": return {
      cn: `翻译接口返回 HTTP ${failure.status}。${failure.status === 401 || failure.status === 403 ? "请检查 API Key 和访问权限。" : failure.status === 429 ? "请求受限，请检查服务额度或稍后重试。" : failure.status >= 500 ? "服务端暂时异常，请稍后重试。" : "请检查接口地址、模型及请求配置。"}`,
      en: `Translation API returned HTTP ${failure.status}. Check credentials, access, service limits and provider availability, then retry.`,
      jp: `翻訳 API が HTTP ${failure.status} を返しました。認証、権限、利用制限、サービスの状態を確認してください。`,
      fr: `L’API de traduction a renvoyé HTTP ${failure.status}. Vérifiez les identifiants, les droits, les limites et la disponibilité du service.`,
    }[language]
    case "configuration": return {
      cn: "翻译配置无法读取或存在无效值。请检查插件设置，保存后重新加载插件。",
      en: "Translation settings could not be read or contain an invalid value. Check the plugin settings, save and reload.",
      jp: "翻訳設定を読み取れないか、値が無効です。プラグイン設定を確認して保存し、再読み込みしてください。",
      fr: "Les paramètres de traduction sont illisibles ou invalides. Vérifiez-les, enregistrez et rechargez le plugin.",
    }[language]
    case "credentials": return {
      cn: "缺少翻译 API Key。请在插件设置或 .env 中填写。",
      en: "Translation API Key is missing. Set it in the plugin settings or .env.",
      jp: "翻訳 API Key がありません。プラグイン設定または .env に設定してください。",
      fr: "La clé API de traduction est absente. Configurez-la dans le plugin ou dans .env.",
    }[language]
    case "api-url": return {
      cn: "翻译 API 地址无效，请填写完整的 HTTP 或 HTTPS 接口地址。",
      en: "Invalid translation API URL. Enter a complete HTTP or HTTPS endpoint.",
      jp: "翻訳 API の URL が無効です。完全な HTTP または HTTPS のアドレスを入力してください。",
      fr: "L’URL de l’API est invalide. Saisissez une adresse HTTP ou HTTPS complète.",
    }[language]
    case "api-request": return {
      cn: "翻译 API 请求未能完成。请检查网络、代理和服务状态后重试。",
      en: "The translation API request could not complete. Check the network, proxy and service, then retry.",
      jp: "翻訳 API のリクエストを完了できませんでした。ネットワーク、プロキシ、サービスを確認してください。",
      fr: "La requête de traduction n’a pas abouti. Vérifiez le réseau, le proxy et le service.",
    }[language]
    case "api-response": return {
      cn: "翻译接口返回无效响应或空译文，请检查接口兼容性和模型。",
      en: "The translation API returned an invalid response or empty translation. Check API compatibility and the model.",
      jp: "翻訳 API の応答が無効か空です。API の互換性とモデルを確認してください。",
      fr: "La réponse de l’API est invalide ou vide. Vérifiez la compatibilité de l’API et le modèle.",
    }[language]
    case "api-length": return {
      cn: "翻译接口的输出达到长度限制，译文不完整。请缩短文本后重试。",
      en: "The translation reached the API output length limit. Shorten the text and retry.",
      jp: "翻訳が API の出力長上限に達しました。テキストを短くして再試行してください。",
      fr: "La traduction a atteint la limite de sortie de l’API. Raccourcissez le texte et réessayez.",
    }[language]
    case "command-prefix": return {
      cn: "译文引入了额外命令前缀，已阻止提交。请重试。",
      en: "The translation introduced a command prefix. Submission was blocked; retry.",
      jp: "翻訳に新しいコマンド接頭辞が含まれたため、送信を停止しました。再試行してください。",
      fr: "La traduction a ajouté un préfixe de commande. L’envoi a été bloqué ; réessayez.",
    }[language]
    case "input-question": return {
      cn: "译文未保留原问题的问句形式，已阻止提交。请重试。",
      en: "The translation did not preserve the input as a question. Retry the translation.",
      jp: "元の質問が疑問文として翻訳されなかったため、送信を停止しました。再試行してください。",
      fr: "La traduction n’a pas conservé la forme interrogative du texte source. Réessayez.",
    }[language]
    case "input-handoff": return {
      cn: "输入译文交付失败或等待队列已满，请处理待发送消息后重试。",
      en: "The input translation could not be handed off or its queue is full. Process pending messages and retry.",
      jp: "入力翻訳を引き渡せないか、キューが満杯です。保留中のメッセージを処理して再試行してください。",
      fr: "Le transfert de la traduction a échoué ou la file est pleine. Traitez les messages en attente, puis réessayez.",
    }[language]
    case "queue": return {
      cn: "翻译等待队列已满，请稍后重试。", en: "The translation queue is full. Retry shortly.",
      jp: "翻訳の待機キューが満杯です。後で再試行してください。", fr: "La file de traduction est pleine. Réessayez plus tard.",
    }[language]
    case "capacity": return {
      cn: "文本或译文超过显示缓存容量，请缩短文本后重试。", en: "The text or translation exceeds the display cache capacity. Shorten the text and retry.",
      jp: "テキストまたは翻訳が表示キャッシュの上限を超えています。短くして再試行してください。", fr: "Le texte ou la traduction dépasse la capacité d’affichage. Raccourcissez le texte et réessayez.",
    }[language]
    case "unknown": return {
      cn: "翻译遇到未分类错误，请复制错误信息以便反馈排查。", en: "An unclassified translation error occurred. Copy the error information for troubleshooting.",
      jp: "未分類の翻訳エラーです。調査のためエラー情報をコピーしてください。", fr: "Erreur de traduction non classée. Copiez les informations d’erreur pour le diagnostic.",
    }[language]
    case "timeout": {
      const seconds = failure.seconds
      const increase = seconds < MAX_CODEX_TIMEOUT_SECONDS
      return {
        cn: `Codex CLI 翻译等待超过 ${seconds} 秒。${increase ? "可在插件设置中增大 codex_timeout_seconds（最多 600 秒）后重试。" : "已达到 600 秒上限，请缩短文本或使用更快的翻译配置后重试。"}`,
        en: `Codex CLI translation timed out after ${seconds} seconds. ${increase ? "Increase codex_timeout_seconds in the plugin settings (up to 600 seconds) and retry." : "The 600-second limit was reached. Shorten the text or use faster translation settings and retry."}`,
        jp: `Codex CLI の翻訳が ${seconds} 秒でタイムアウトしました。${increase ? "プラグイン設定の codex_timeout_seconds を増やして（最大600秒）再試行してください。" : "600秒の上限です。テキストを短くするか、より速い翻訳設定で再試行してください。"}`,
        fr: `La traduction Codex CLI a expiré après ${seconds} secondes. ${increase ? "Augmentez codex_timeout_seconds dans les paramètres du plugin (600 secondes maximum), puis réessayez." : "La limite de 600 secondes est atteinte. Raccourcissez le texte ou choisissez des paramètres de traduction plus rapides."}`,
      }[language]
    }
    case "codex-exit": return {
      cn: `Codex CLI 异常退出（退出码 ${failure.code}）。请检查 Codex 的登录状态、模型和服务配置后重试。`,
      en: `Codex CLI exited with code ${failure.code}. Check its login, model and service configuration, then retry.`,
      jp: `Codex CLI が終了コード ${failure.code} で終了しました。ログイン、モデル、サービス設定を確認してください。`,
      fr: `Codex CLI s’est arrêté avec le code ${failure.code}. Vérifiez la connexion, le modèle et la configuration du service.`,
    }[language]
    case "codex-process": return {
      cn: "Codex CLI 未能启动或完成。请检查可执行文件路径、登录状态和配置后重试。",
      en: "Codex CLI could not start or finish. Check the executable path, login and configuration, then retry.",
      jp: "Codex CLI を開始または完了できませんでした。実行ファイルのパス、ログイン、設定を確認してください。",
      fr: "Codex CLI n’a pas pu démarrer ou terminer. Vérifiez le chemin de l’exécutable, la connexion et la configuration.",
    }[language]
    case "empty": return {
      cn: "Codex CLI 返回空译文，请检查翻译模型后重试。",
      en: "Codex CLI returned an empty translation. Check the translation model and retry.",
      jp: "Codex CLI が空の翻訳を返しました。翻訳モデルを確認して再試行してください。",
      fr: "Codex CLI a renvoyé une traduction vide. Vérifiez le modèle de traduction, puis réessayez.",
    }[language]
    case "truncated": return {
      cn: "Codex CLI 译文被截断，请缩短文本后重试。",
      en: "Codex CLI output was truncated. Shorten the text and retry.",
      jp: "Codex CLI の翻訳が途中で切れました。テキストを短くして再試行してください。",
      fr: "La traduction Codex CLI a été tronquée. Raccourcissez le texte, puis réessayez.",
    }[language]
    case "markers": {
      if (failure.validation) {
        const v = failure.validation
        return {
          cn: `路径或代码的保护标记校验失败：预期 ${v.expected}，收到 ${v.observed}；缺失 ${v.missing}，重复 ${v.duplicate}，未知或格式错误 ${v.unexpected}。请重试；持续失败时复制错误信息反馈。`,
          en: `Protected-token validation failed: expected ${v.expected}, observed ${v.observed}; missing ${v.missing}, duplicate ${v.duplicate}, unexpected or malformed ${v.unexpected}. Retry; copy error information if it persists.`,
          jp: `保護トークンの検証に失敗しました：期待 ${v.expected}、受信 ${v.observed}、欠落 ${v.missing}、重複 ${v.duplicate}、不明または形式不正 ${v.unexpected}。再試行し、続く場合はエラー情報をコピーしてください。`,
          fr: `Validation des marqueurs échouée : attendus ${v.expected}, reçus ${v.observed}, manquants ${v.missing}, doublons ${v.duplicate}, inconnus ou mal formés ${v.unexpected}. Réessayez ; copiez les informations si l’erreur persiste.`,
        }[language]
      }
      return {
      cn: "译文校验失败：路径或代码未完整保留，或选择面板格式有误。请重试。",
      en: "Translation validation failed: protected paths or code were not preserved, or the question format was invalid. Retry.",
      jp: "翻訳の検証に失敗しました。パスやコードが保持されていないか、質問の形式が無効です。再試行してください。",
      fr: "La validation de la traduction a échoué : chemins ou code non conservés, ou format de question invalide. Réessayez.",
      }[language]
    }
  }
}
