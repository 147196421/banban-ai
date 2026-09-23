import { after } from "next/server";

import { checkRateLimit } from "@/db/rate-limit";
import { createStoredTask, finishStoredTask, markStoredTaskFailed } from "@/db/test-tasks";
import { isGptModel, normalizeUpstreamBaseUrl } from "@/lib/upstream-url";
import { toChineseError } from "@/lib/user-facing-error";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

function outputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output.flatMap((item) => {
    const message = item as { content?: { type?: string; text?: string }[] };
    return Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "output_text").map((part) => part.text ?? "")
      : [];
  }).join("\n");
}

function extractHtml(output: string) {
  const content = output.trim().replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "");
  const start = content.search(/<!doctype\s+html|<html\b/i);
  const end = content.toLowerCase().lastIndexOf("</html>");
  return start >= 0 && end >= start && end + 7 - start <= 500_000
    ? content.slice(start, end + 7) : "";
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.submissionId === "string" ? body.submissionId : "";
    const baseUrl = normalizeUpstreamBaseUrl(body.baseUrl);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const effort = typeof body.reasoningEffort === "string" ? body.reasoningEffort : "medium";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return Response.json({ error: "任务编号无效" }, { status: 400 });
    if (apiKey.length < 6 || apiKey.length > 4096 || !isGptModel(model))
      return Response.json({ error: "请检查 API Key 和 GPT 模型" }, { status: 400 });
    if (!prompt || prompt.length > 12000)
      return Response.json({ error: "请输入不超过 12000 字的提示词" }, { status: 400 });
    if (!["low", "medium", "high"].includes(effort))
      return Response.json({ error: "当前推理程度不受支持" }, { status: 400 });

    const rate = await checkRateLimit(request, "custom-generation", 6, 60 * 60 * 1000);
    if (!rate.allowed) return Response.json({ error: "生成过于频繁，请稍后重试" }, { status: 429 });
    const stored = await createStoredTask(id);
    if (!stored.task) return Response.json({ error: "生成任务保存失败" }, { status: 503 });
    if (!stored.inserted) return Response.json({ id, status: stored.task.status });

    after(async () => {
      const started = Date.now();
      try {
        const response = await fetch(`${baseUrl}/responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, input: prompt, reasoning: { effort }, max_output_tokens: 16000, store: false }),
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(7 * 60 * 1000),
        });
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) {
          await markStoredTaskFailed(id, toChineseError(payload.error, "模型接口调用失败", response.status, "test"));
          return;
        }
        if (payload.status === "incomplete") throw new Error("输出达到长度上限，请缩短提示词或重新生成");
        if (payload.status && payload.status !== "completed") throw new Error("模型未完成生成");
        const output = outputText(payload).trim();
        if (!output) throw new Error("模型没有返回内容");
        const html = extractHtml(output);
        const usage = payload.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        await finishStoredTask(id, "succeeded", {
          id, status: "succeeded", benchmark: "custom", evaluation_source: "direct-model",
          result: {
            html, text: html ? "" : output.slice(0, 500_000), prompt,
            duration_ms: Date.now() - started,
            input_tokens: Number(usage?.input_tokens) || 0,
            output_tokens: Number(usage?.output_tokens) || 0,
          },
        });
      } catch (error) {
        await markStoredTaskFailed(id, toChineseError(error, "生成失败，请稍后重试", undefined, "test"));
      }
    });
    return Response.json({ id, status: "queued", phase: "creating" }, { status: 202 });
  } catch (error) {
    return Response.json({ error: toChineseError(error, "无法创建生成任务", undefined, "test") }, { status: 400 });
  }
}
