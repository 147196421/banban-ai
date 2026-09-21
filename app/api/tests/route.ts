import { isGptModel, normalizeUpstreamBaseUrl } from "@/lib/upstream-url";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const testsUrl = process.env.BANBAN_TEST_SERVICE_URL?.trim().replace(/\/+$/, "");
    if (!testsUrl?.startsWith("https://")) {
      return Response.json({ error: "检测服务暂未配置" }, { status: 503 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const baseUrl = normalizeUpstreamBaseUrl(body.baseUrl);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const benchmark = body.benchmark === "frontend" ? "pelican" : "candy";
    const effort = typeof body.reasoningEffort === "string" ? body.reasoningEffort : "medium";

    if (apiKey.length < 6 || apiKey.length > 4096) {
      return Response.json({ error: "API Key 无效" }, { status: 400 });
    }
    if (!isGptModel(model)) {
      return Response.json({ error: "目前仅支持 GPT 系列模型" }, { status: 400 });
    }

    const allowedEfforts = benchmark === "candy"
      ? ["low", "medium", "high", "xhigh", "max", "ultra"]
      : ["low", "medium", "high"];
    if (!allowedEfforts.includes(effort)) {
      return Response.json({ error: "当前测试不支持这个推理程度" }, { status: 400 });
    }

    const response = await fetch(testsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        benchmark,
        base_url: baseUrl,
        api_key: apiKey,
        model,
        reasoning_effort: effort,
        ...(benchmark === "pelican" ? { protocol: "responses" } : {}),
      }),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });

    const payload = await response.json().catch(() => ({ error: "检测服务返回了无效响应" }));
    return Response.json(payload, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "检测任务创建失败";
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return Response.json({ error: timeout ? "检测服务响应超时" : message }, { status: 400 });
  }
}
