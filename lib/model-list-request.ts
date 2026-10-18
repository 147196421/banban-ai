const transientStatuses = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const networkCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH",
  "EHOSTUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

function networkCode(error: unknown, depth = 0): string {
  if (!error || typeof error !== "object" || depth > 4) return "";
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof value.code === "string" && networkCodes.has(value.code)) return value.code;
  return networkCode(value.cause, depth + 1)
    || (Array.isArray(value.errors) ? value.errors.map((item) => networkCode(item, depth + 1)).find(Boolean) : "") || "";
}

export class ModelListConnectionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(error: unknown) {
    const code = networkCode(error);
    const timeout = (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
      || /TIMEOUT|TIMEDOUT/.test(code);
    super(timeout
      ? "服务器读取模型列表超时，已自动重试，请稍后再试"
      : "服务器暂时无法连接模型接口，已自动重试，请稍后再试；也可手动填写模型名称");
    this.name = "ModelListConnectionError";
    this.status = timeout ? 504 : 502;
    // Keep only an allowlisted code, never the original error or request URL.
    this.code = code || (timeout ? "TIMEOUT" : "NETWORK_ERROR");
  }
}

function hasModelEntries(payload: unknown) {
  if (Array.isArray(payload)) return payload.length > 0;
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  const entries = Array.isArray(record.data) ? record.data : record.models;
  return Array.isArray(entries) && entries.length > 0;
}

export async function requestModelList(
  baseUrl: string,
  apiKey: string,
  dependencies: {
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const fetchRequest = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // At most two read-only requests, each bounded by 20 seconds. Do not retry
  // authentication, rate-limit or redirect responses, or follow credentials elsewhere.
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetchRequest(`${baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Cache-Control": "no-cache" },
        cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(20_000),
      });
      // Reading the body belongs inside the retry boundary too: connections can
      // fail after the headers arrive. Invalid JSON is treated as an invalid list.
      const text = await response.text();
      let payload: unknown = null;
      try { payload = JSON.parse(text); } catch { /* Gateways may return HTML. */ }
      if (attempt === 0 && (transientStatuses.has(response.status) || (response.ok && !hasModelEntries(payload)))) {
        const retryAfter = response.headers.get("retry-after");
        // Honor a provider asking us to wait longer instead of immediately retrying.
        if (retryAfter !== null && (!Number.isFinite(Number(retryAfter)) || Number(retryAfter) > 1 || Number(retryAfter) < 0)) {
          return { ok: response.ok, status: response.status, payload };
        }
        await sleep(retryAfter === null ? 500 : Math.max(500, Number(retryAfter) * 1000));
        continue;
      }
      return { ok: response.ok, status: response.status, payload };
    } catch (error) {
      if (response && !response.ok && !transientStatuses.has(response.status)) {
        return { ok: false, status: response.status, payload: null };
      }
      const retryable = networkCode(error) || (error instanceof Error && ["TypeError", "TimeoutError", "AbortError"].includes(error.name));
      if (!retryable) throw error;
      if (attempt === 1) throw new ModelListConnectionError(error);
      await sleep(500);
    }
  }
  throw new ModelListConnectionError(undefined);
}
