import { isGptModel, normalizeUpstreamBaseUrl } from "@/lib/upstream-url";
import { toChineseError } from "@/lib/user-facing-error";
import { checkRateLimit } from "@/db/rate-limit";

export const dynamic = "force-dynamic";

type ModelItem = { id?: unknown; name?: unknown; model?: unknown } | string;

function extractModelIds(payload: unknown) {
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];

  return [...new Set(
    (candidates as ModelItem[])
      .map((item) => typeof item === "string" ? item : item.id ?? item.name ?? item.model)
      .filter(isGptModel),
  )].sort((a, b) => {
    const rank = (id: string) =>
      id.includes("gpt-6-astra") ? 0 : id.includes("gpt-5.6-sol") ? 1 : 2;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { baseUrl?: unknown; apiKey?: unknown };
    const baseUrl = normalizeUpstreamBaseUrl(body.baseUrl);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

    if (apiKey.length < 6 || apiKey.length > 4096) {
      return Response.json({ error: "API Key 无效" }, { status: 400 });
    }

    const rateLimit = await checkRateLimit(request, "models", 30, 10 * 60 * 1000);
    if (!rateLimit.allowed) {
      return Response.json(
        { error: "读取模型过于频繁，请稍后再试" },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      );
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });

      const payload = await response.json().catch(() => null) as
        | { data?: ModelItem[]; models?: ModelItem[]; error?: unknown }
        | ModelItem[]
        | null;

      if (!response.ok) {
        const status = response.status;
        const error = payload && !Array.isArray(payload) ? payload.error : payload;
        const message = toChineseError(error, "读取模型失败，请检查接口地址和 API Key", status, "models");
        return Response.json({ error: message }, { status: [400, 401, 403, 404, 429].includes(status) ? status : 502 });
      }

      const models = extractModelIds(payload);
      if (models.length) {
        return Response.json({ models });
      }

      if (attempt === 0) {
        // 个别兼容接口会偶发返回 200 空列表，短暂等待后重试一次。
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }

    return Response.json(
      { error: "接口暂时没有返回模型列表，请稍后再点一次读取" },
      { status: 502 },
    );
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return Response.json(
      { error: timeout ? "接口响应超时，请稍后重试" : toChineseError(error, "无法读取模型，请检查接口地址和网络", undefined, "models") },
      { status: 400 },
    );
  }
}
