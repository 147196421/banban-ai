import { isGptModel, normalizeUpstreamBaseUrl } from "@/lib/upstream-url";
import { toChineseError } from "@/lib/user-facing-error";

export const dynamic = "force-dynamic";

type ModelItem = { id?: unknown };

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { baseUrl?: unknown; apiKey?: unknown };
    const baseUrl = normalizeUpstreamBaseUrl(body.baseUrl);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

    if (apiKey.length < 6 || apiKey.length > 4096) {
      return Response.json({ error: "API Key 无效" }, { status: 400 });
    }

    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });

    const payload = (await response.json().catch(() => null)) as
      | { data?: ModelItem[]; error?: { message?: string } }
      | null;

    if (!response.ok) {
      const status = response.status;
      const message = toChineseError(payload?.error, "读取模型失败，请检查接口地址和 API Key", status, "models");
      return Response.json({ error: message }, { status: [400, 401, 403, 404, 429].includes(status) ? status : 502 });
    }

    const models = Array.isArray(payload?.data)
      ? payload.data
          .map((item) => item.id)
          .filter(isGptModel)
          .sort((a, b) => {
            const rank = (id: string) =>
              id.includes("gpt-6-astra") ? 0 : id.includes("gpt-5.6-sol") ? 1 : 2;
            return rank(a) - rank(b) || a.localeCompare(b);
          })
      : [];

    return Response.json({ models: [...new Set(models)] });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return Response.json(
      { error: timeout ? "接口响应超时，请稍后重试" : toChineseError(error, "无法读取模型，请检查接口地址和网络", undefined, "models") },
      { status: 400 },
    );
  }
}
