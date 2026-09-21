export const dynamic = "force-dynamic";

const MANXUE_TESTS_URL = "https://manxue.ai/api/v1/tests";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return Response.json({ error: "检测任务 ID 无效" }, { status: 400 });
  }

  try {
    const response = await fetch(`${MANXUE_TESTS_URL}/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({ error: "检测服务返回了无效响应" }));
    return Response.json(payload, { status: response.status });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return Response.json(
      { error: timeout ? "查询检测结果超时" : "暂时无法查询检测结果" },
      { status: 502 },
    );
  }
}
