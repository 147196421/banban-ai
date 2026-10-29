// Only allowlisted error fields are inspected. Never log request bodies,
// validation `input`/`ctx`, cookies, headers, or complete upstream responses.
function messageFrom(value: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => messageFrom(item, depth + 1)).filter(Boolean).join("; ");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["message", "msg", "detail", "error_description", "error"]) {
    const message = messageFrom(record[key], depth + 1);
    if (message) return message;
  }
  return "";
}

export function redactDetectorMessage(message: string, secrets: string[]) {
  // Redact before truncating so a long key cannot be partially exposed.
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      message = message.split(variant).join("[REDACTED]");
    }
  }
  return message
    .replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 800);
}

export function detectorTransportFailure(error: unknown, secrets: string[]) {
  const name = error instanceof Error ? error.name : "UnknownError";
  const category = name === "TimeoutError" || name === "AbortError" ? "timeout" : "transport_error";
  return {
    userMessage: category === "timeout" ? "检测服务响应超时，请稍后重试" : "检测服务连接失败，请稍后重试；若持续发生请联系站点管理员",
    diagnostic: { category, message: redactDetectorMessage(messageFrom(error), secrets) },
  };
}

export async function inspectDetectorResponse(response: Response, secrets: string[]) {
  const text = await response.text();
  let payload: unknown;
  let validJson = true;
  try { payload = JSON.parse(text); } catch { validJson = false; }
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown> : undefined;
  const id = typeof record?.id === "string" ? record.id.trim()
    : typeof record?.id === "number" && Number.isFinite(record.id) ? String(record.id) : "";
  if (response.ok && id && !record?.error) return { id, failure: null };

  const status = response.status;
  const category = status >= 300 && status < 400 ? "redirect"
    : !response.ok ? "http_error" : !validJson ? "invalid_json" : record?.error ? "upstream_error" : "missing_task_id";
  let userMessage = `检测服务未能创建任务（HTTP ${status}），请联系站点管理员查看诊断日志`;
  if (status === 400 || status === 422) userMessage = `检测服务拒绝了提交参数（HTTP ${status}），请联系站点管理员检查接口兼容性`;
  else if (status === 401 || status === 403) userMessage = `检测服务拒绝访问（HTTP ${status}），需检查检测服务权限或访问限制`;
  else if (status === 429) userMessage = "检测服务请求过于频繁（HTTP 429），请稍后重试";
  else if (status >= 500) userMessage = `检测服务暂时不可用（HTTP ${status}），请稍后重试`;
  else if (category === "redirect") userMessage = `检测服务地址发生重定向（HTTP ${status}），请联系站点管理员检查接口地址`;
  else if (response.ok) userMessage = `检测服务返回格式异常（HTTP ${status}，${validJson ? "缺少有效任务编号或返回错误" : "不是 JSON"}），请联系站点管理员`;

  const contentType = response.headers.get("content-type") ?? "";
  const html = /text\/html/i.test(contentType) || /^\s*(?:<!doctype html|<html)/i.test(text);
  const validationFields = Array.isArray(record?.detail)
    ? [...new Set(record.detail.flatMap((item: unknown) => {
      if (!item || typeof item !== "object" || !("loc" in item) || !Array.isArray(item.loc)) return [];
      return item.loc.filter((field: unknown): field is string => typeof field === "string"
        && ["benchmark", "base_url", "api_key", "model", "reasoning_effort", "protocol", "random_scene"].includes(field));
    }))] : [];
  const plainErrorCode = /\berror code:\s*(\d{3,5})\b/i.exec(text)?.[1];
  return {
    id: "",
    failure: {
      userMessage,
      diagnostic: {
        category,
        status,
        responseFormat: validJson ? "json" : html ? "html" : "text",
        validationFields,
        // HTML may contain embedded credentials and scripts. Only note its format.
        message: html ? "HTML response omitted" : validJson
          ? redactDetectorMessage(messageFrom(payload), secrets)
          : plainErrorCode ? `error code: ${plainErrorCode}` : "Non-JSON response omitted",
      },
    },
  };
}
