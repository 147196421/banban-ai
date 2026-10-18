import { after } from "next/server";

import {
  createStoredTask,
  getStoredTask,
  markStoredTaskActive,
  markStoredTaskFailed,
  removeExpiredTasks,
} from "@/db/test-tasks";
import { isGptModel, normalizeUpstreamBaseUrl } from "@/lib/upstream-url";
import { toChineseError } from "@/lib/user-facing-error";
import { detectorTransportFailure, inspectDetectorResponse } from "@/lib/detector-diagnostics";
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
    const body = (await request.json()) as Record<string, unknown>;
    const submissionId = typeof body.submissionId === "string" ? body.submissionId.trim() : "";
    const baseUrl = normalizeUpstreamBaseUrl(body.baseUrl);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const benchmark = body.benchmark === "frontend"
      ? body.freeCreation === true ? "creative" : "pelican"
      : "candy";
    // Current public API uses Responses internally and rejects protocol/random_scene.
    // Ignore old clients' protocol selection rather than forwarding removed fields.
    const service = getDetectorService("manxue");
    if (!service) {
      return Response.json({ error: "检测服务暂未配置" }, { status: 503 });
    }
    // 固定为满血 AI 对应测试的推理程度；忽略旧版客户端传入的选择。
    const effort = benchmark === "candy" ? "medium" : "low";

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) {
      return Response.json({ error: "检测任务编号无效" }, { status: 400 });
    }

    if (apiKey.length < 6 || apiKey.length > 4096) {
      return Response.json({ error: "API Key 无效" }, { status: 400 });
    }
    if (!isGptModel(model)) {
      return Response.json({ error: "目前仅支持 GPT 系列模型" }, { status: 400 });
    }
    if (benchmark !== "candy" && model !== "gpt-6-astra") {
      return Response.json({ error: "满血 AI 的鹈鹕骑行和自由创作目前仅支持 gpt-6-astra，请选择该模型" }, { status: 400 });
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
      const diagnosticSecrets = [apiKey, baseUrl, ...Object.values(service.headers)];
      const reportFailure = (failure: ReturnType<typeof detectorTransportFailure>) => {
        // Never include the request, API Key, session cookie, or full response.
        console.error("[detector-create-failed]", JSON.stringify({
          submissionId, source: service.source, benchmark, protocol: "responses",
          ...failure.diagnostic,
        }));
        return markStoredTaskFailed(submissionId, `${failure.userMessage}（诊断编号：${submissionId}）`);
      };
      try {
        const requestBody = JSON.stringify({
          benchmark,
          base_url: baseUrl,
          api_key: apiKey,
          model,
          reasoning_effort: effort,
        });
        // 满血 AI 的公开接口支持同 IP、同请求体使用 Idempotency-Key 去重。
        // 创建请求遇到短暂拥堵时，可安全重试一次；不要对已开始生成的任务重新提交。
        let response: Response | undefined;
        for (let attempt = 0; attempt < (service.source === "manxue" ? 2 : 1); attempt++) {
          try {
            response = await fetch(service.url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...service.headers,
                ...(service.source === "manxue" ? { "Idempotency-Key": submissionId } : {}),
              },
              body: requestBody,
              cache: "no-store",
              redirect: "manual",
              signal: AbortSignal.timeout(20_000),
            });
          } catch (error) {
            if (attempt === 0 && service.source === "manxue" && error instanceof Error
              && ["TimeoutError", "TypeError"].includes(error.name)) {
              await new Promise((resolve) => setTimeout(resolve, 1500));
              continue;
            }
            throw error;
          }
          if (attempt === 0 && service.source === "manxue" && [429, 503].includes(response.status)) {
            const retryAfter = Number(response.headers.get("retry-after"));
            // 本站的任务创建等待上限是 60 秒，较长的限流需让用户稍后再试。
            if (!Number.isFinite(retryAfter) || retryAfter < 0 || retryAfter > 8) break;
            await new Promise((resolve) => setTimeout(resolve, Math.max(1500, retryAfter * 1000)));
            continue;
          }
          break;
        }
        if (!response) throw new Error("检测服务响应超时，请稍后重试");

        const inspected = await inspectDetectorResponse(response, diagnosticSecrets);
        if (inspected.failure) {
          await reportFailure(inspected.failure);
          return;
        }

        await markStoredTaskActive(submissionId, storedDetectorTask(service.source, inspected.id));
        await removeExpiredTasks().catch(() => undefined);
      } catch (error) {
        await reportFailure(detectorTransportFailure(error, diagnosticSecrets));
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
