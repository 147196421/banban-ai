type ErrorContext = "models" | "test" | "poll" | "general";

function extractMessage(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  for (const candidate of [record.message, record.detail, record.error_description, record.error]) {
    const message = extractMessage(candidate);
    if (message) return message;
  }
  return "";
}

function extractCode(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  return extractCode(record.error);
}

export function toChineseError(
  value: unknown,
  fallback = "操作失败，请稍后重试",
  status?: number,
  context: ErrorContext = "general",
) {
  const message = extractMessage(value);
  const text = message.toLowerCase();

  // 旧版本把所有 404 都记成“没有这个模型”；历史任务已丢失原始错误，无法追溯原因。
  if (message === "接口中没有这个模型，请重新读取模型列表后再选择") {
    return "这条历史记录没有保存具体的接口错误；请重新生成以查看新的提示";
  }

  if (status === 401 || /(unauthori[sz]ed|authentication|incorrect api key|invalid api key|invalid.*token|api key.*invalid)/i.test(text)) {
    return "API Key 无效或已失效，请检查后重新填写";
  }
  if (status === 403 || /(forbidden|permission|insufficient.scope|access denied)/i.test(text)) {
    if (/(model|模型)/i.test(text)) return "这个 API Key 没有该模型的使用权限，请换一个模型";
    return "这个 API Key 没有访问权限，请检查账户或密钥权限";
  }
  if (context === "poll" && status === 404) {
    return "没有找到这次检测任务，请重新发起检测";
  }
  if (/(model.{0,100}not found|no such model|unknown model|model.{0,100}does not exist)/i.test(text)
    || /^(model_not_found|unknown_model)$/i.test(extractCode(value))) {
    return "当前请求无法使用所选模型，请检查请求协议或稍后重试";
  }
  if (status === 404) {
    return context === "models"
      ? "模型列表地址不存在，请检查接口地址"
      : "接口返回 404，请检查接口地址或切换请求协议后重试";
  }
  if (status === 429 || /(rate.limit|too many requests|requests too quickly)/i.test(text)) {
    return "请求过于频繁，请稍等一会儿再试";
  }
  if (/(quota|billing|credit|balance|insufficient_quota|exceeded your current)/i.test(text)) {
    return "接口账户额度不足或已用完，请检查账户余额";
  }
  if (/(does not have access|not have access|model access|not allowed to use)/i.test(text)) {
    return "这个 API Key 没有该模型的使用权限，请换一个模型";
  }
  if (/(reasoning.*effort|unsupported.*effort|invalid.*effort|unsupported value)/i.test(text)) {
    return "当前模型不支持此请求的推理设置，请尝试切换请求协议或模型";
  }
  if (/(context.length|maximum context|too many tokens|token limit)/i.test(text)) {
    return "模型请求内容超过限制，请换一个模型或稍后重试";
  }
  if ([504, 522, 524].includes(status ?? 0) || /\b(?:http\s*)?(?:504|522|524)\b/i.test(text)) {
    return "模型服务等待超时，请稍后重试";
  }
  if (/(timeout|timed out|aborterror|time.?out)/i.test(text)) {
    return context === "poll" ? "查询检测结果超时，请稍后重试" : "接口响应超时，请稍后重试";
  }
  if (/(certificate|ssl|tls|self.signed)/i.test(text)) {
    return "接口证书异常，暂时无法安全连接";
  }
  if (/(failed to fetch|fetch failed|network|econnrefused|enotfound|socket|connection)/i.test(text)) {
    return "无法连接接口地址，请检查地址是否正确或稍后再试";
  }
  if (status && status >= 500) {
    return context === "models" ? "模型接口暂时不可用，请稍后再试" : "检测服务暂时不可用，请稍后再试";
  }

  // 已经是面向用户编写的中文错误时直接保留；未知英文不直接暴露给用户。
  if (/[㐀-鿿]/.test(message)) return message;
  return fallback;
}

export function localizeErrorPayload(
  payload: unknown,
  fallback: string,
  status?: number,
  context: ErrorContext = "general",
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: toChineseError(payload, fallback, status, context) };
  }

  const record = payload as Record<string, unknown>;
  if (record.error || (status && status >= 400) || record.status === "failed" || record.status === "cancelled") {
    return { ...record, error: toChineseError(record.error ?? record, fallback, status, context) };
  }
  return record;
}
