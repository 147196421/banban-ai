import { after } from "next/server";

import {
  createStoredTask,
  getStoredTask,
  markStoredTaskActive,
  markStoredTaskFailed,
  removeExpiredTasks,
} from "@/db/test-tasks";
import { isGptModel, normalizeUpstreamBaseUrl } from "@/lib/upstream-url";
import { localizeErrorPayload, toChineseError } from "@/lib/user-facing-error";
import { checkRateLimit } from "@/db/rate-limit";
import { getDetectorService, storedDetectorTask } from "@/lib/detector-service";

export const dynamic = "force-dynamic";

function storedTaskResponse(task: Awaited<ReturnType<typeof getStoredTask>>) {
  if (!task) return null;
  if (task.payload_json) {
    try {
      return { ...(JSON.parse(task.payload_json) as Record<string, unknown>), id: task.id };
    } catch {
      return { id: task.id, status: "failed", error: "已保存的检测结果无法读取，请重新检测" };
    }
  }
  if (task.status === "failed" || task.status === "cancelled") {
    return { id: task.id, status: task.status, error: task.error || "检测任务未能完成" };
  }
  return {
    id: task.id,
    status: task.status === "creating" ? "queued" : "running",
    phase: task.status === "creating" ? "creating" : "generating",
  };
}

export async function POST(request: Request) {
  try {
    const service = getDetectorService();
    if (!service) {
      return Response.json({ error: "检测服务暂未配置" }, { status: 503 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const submissionId = typeof body.submissionId === "string" ? body.submissionId.trim() : "";
    const baseUrl = normalizeUpstreamBaseUrl(body.baseUrl);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const benchmark = body.benchmark === "frontend" ? "pelican" : "candy";
    const effort = typeof body.reasoningEffort === "string" ? body.reasoningEffort : "high";

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) {
      return Response.json({ error: "检测任务编号无效" }, { status: 400 });
    }

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

    const rateLimit = await checkRateLimit(request, "test-create", 12, 60 * 60 * 1000);
    if (!rateLimit.allowed) {
      return Response.json(
        { error: "检测提交过于频繁，请稍后再试" },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      );
    }

    const stored = await createStoredTask(submissionId);
    if (!stored.task) {
      return Response.json({ error: "检测任务保存失败，请重新尝试" }, { status: 503 });
    }
    if (!stored.inserted) {
      return Response.json(storedTaskResponse(stored.task), { status: 200 });
    }

    after(async () => {
      try {
        const response = await fetch(service.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...service.headers,
          },
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
        const localized = localizeErrorPayload(payload, "检测任务创建失败，请稍后重试", response.status, "test");
        const upstreamTaskId = payload && typeof payload === "object" && "id" in payload
          ? String((payload as { id?: unknown }).id ?? "")
          : "";

        if (!response.ok || !upstreamTaskId) {
          const error = localized && typeof localized === "object" && "error" in localized
            ? String((localized as { error?: unknown }).error ?? "检测任务创建失败")
            : "检测任务创建失败";
          await markStoredTaskFailed(submissionId, error);
          return;
        }

        await markStoredTaskActive(submissionId, storedDetectorTask(service.source, upstreamTaskId));
        await removeExpiredTasks().catch(() => undefined);
      } catch (error) {
        const timeout = error instanceof Error && error.name === "TimeoutError";
        await markStoredTaskFailed(
          submissionId,
          timeout ? "检测服务响应超时，请稍后重试" : toChineseError(error, "检测任务创建失败，请稍后重试", undefined, "test"),
        );
      }
    });

    return Response.json({ id: submissionId, status: "queued", phase: "creating" }, { status: 202 });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    const unavailable = error instanceof Error && /数据库.*不可用/.test(error.message);
    return Response.json(
      { error: unavailable ? "检测任务服务暂时不可用，请稍后重试" : timeout ? "检测服务响应超时，请稍后重试" : toChineseError(error, "检测任务创建失败，请稍后重试", undefined, "test") },
      { status: unavailable ? 503 : 400 },
    );
  }
}
