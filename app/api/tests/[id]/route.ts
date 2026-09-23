import { finishStoredTask, getStoredTask, markStoredTaskFailed } from "@/db/test-tasks";
import { localizeErrorPayload } from "@/lib/user-facing-error";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return Response.json({ error: "检测任务 ID 无效" }, { status: 400 });
  }

  try {
    const testsUrl = process.env.BANBAN_TEST_SERVICE_URL?.trim().replace(/\/+$/, "");
    if (!testsUrl?.startsWith("https://")) {
      return Response.json({ error: "检测服务暂未配置" }, { status: 503 });
    }

    const stored = await getStoredTask(id);
    if (stored?.payload_json) {
      try {
        const payload = JSON.parse(stored.payload_json) as Record<string, unknown>;
        return Response.json({ ...payload, id }, { status: 200 });
      } catch {
        return Response.json({ id, status: "failed", error: "已保存的检测结果无法读取，请重新检测" });
      }
    }
    if (stored?.status === "failed" || stored?.status === "cancelled") {
      return Response.json({ id, status: stored.status, error: stored.error || "检测任务未能完成" });
    }
    if (stored?.status === "creating") {
      if (Date.now() - stored.created_at > 60_000) {
        const error = "服务器创建检测任务超时，请重新检测";
        await markStoredTaskFailed(id, error);
        return Response.json({ id, status: "failed", error });
      }
      return Response.json({ id, status: "queued", phase: "creating" });
    }

    const upstreamTaskId = stored?.upstream_task_id || id;

    const response = await fetch(`${testsUrl}/${encodeURIComponent(upstreamTaskId)}`, {
      headers: {
        Accept: "application/json",
        ...(process.env.BANBAN_TEST_SERVICE_TOKEN ? { "X-Banban-Service-Token": process.env.BANBAN_TEST_SERVICE_TOKEN } : {}),
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({ error: "检测服务返回了无效响应" }));
    const localized = localizeErrorPayload(payload, "暂时无法查询检测结果", response.status, "poll");
    if (stored && response.ok && localized && typeof localized === "object") {
      const status = String((localized as { status?: unknown }).status ?? "");
      if (["succeeded", "failed", "cancelled"].includes(status)) {
        await finishStoredTask(id, status as "succeeded" | "failed" | "cancelled", localized);
      }
    }
    return Response.json(
      localized && typeof localized === "object" ? { ...(localized as Record<string, unknown>), id } : localized,
      { status: response.status },
    );
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return Response.json(
      { error: timeout ? "查询检测结果超时" : "暂时无法查询检测结果" },
      { status: 502 },
    );
  }
}
