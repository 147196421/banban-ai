import { after } from "next/server";

import { checkRateLimit } from "@/db/rate-limit";
import { createStoredTask, finishStoredTask, markStoredTaskFailed } from "@/db/test-tasks";
import { isGptModel, normalizeUpstreamBaseUrl } from "@/lib/upstream-url";
import { toChineseError } from "@/lib/user-facing-error";
import { outputText, readModelStream } from "@/lib/model-stream";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

function extractRenderableDocument(output: string) {
  const content = output.trim().replace(/^```(?:html|svg|xml)?\s*/i, "").replace(/\s*```$/, "");
  const start = content.search(/<!doctype\s+html|<html\b/i);
  const end = content.toLowerCase().lastIndexOf("</html>");
  if (start >= 0 && end >= start && end + 7 - start <= 500_000) {
    return { html: content.slice(start, end + 7), format: "html" };
  }

  const svgStart = content.search(/<svg\b/i);
  const svgEnd = content.toLowerCase().lastIndexOf("</svg>");
  if (svgStart >= 0 && svgEnd >= svgStart && svgEnd + 6 - svgStart <= 500_000) {
    const svg = content.slice(svgStart, svgEnd + 6);
    return {
      html: `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;display:grid;place-items:center;background:#fff}svg{display:block;max-width:100%;height:auto}</style><body>${svg}</body></html>`,
      format: "svg",
    };
  }
  return { html: "", format: "text" };
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.submissionId === "string" ? body.submissionId : "";
    const baseUrl = normalizeUpstreamBaseUrl(body.baseUrl);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const effort = typeof body.reasoningEffort === "string" ? body.reasoningEffort : "low";
    const protocol = body.protocol === "chat_completions" ? "chat_completions" : "responses";
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
        const response = await fetch(`${baseUrl}/${protocol === "responses" ? "responses" : "chat/completions"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(protocol === "responses"
            ? { model, input: prompt, reasoning: { effort }, max_output_tokens: 20000, store: false, stream: true }
            : { model, messages: [{ role: "user", content: prompt }], stream: true, reasoning_effort: effort, max_completion_tokens: 20000 }),
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(9 * 60 * 1000),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
          const error = response.status >= 500
            ? "服务器暂时无法完成生成，请稍后重试"
            : toChineseError(payload.error, "模型接口调用失败", response.status, "test");
          await markStoredTaskFailed(id, error);
          return;
        }
        let output = "";
        let usage: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
          const streamed = await readModelStream(response, protocol);
          output = streamed.text.trim();
          usage = streamed.usage;
        } else {
          // 兼容忽略 stream 参数、直接返回 JSON 的接口。
          const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
          if (protocol === "responses" && payload.status === "incomplete") throw new Error("输出达到长度上限，请缩短提示词或重新生成");
          if (protocol === "responses" && payload.status && payload.status !== "completed") throw new Error("模型未完成生成");
          if (protocol === "chat_completions" && (payload.choices as { finish_reason?: string }[] | undefined)?.[0]?.finish_reason === "length") {
            throw new Error("输出达到长度上限，请缩短提示词或重新生成");
          }
          output = outputText(payload, protocol).trim();
          usage = payload.usage as typeof usage;
        }
        if (!output) throw new Error("模型没有返回内容");
        const { html, format } = extractRenderableDocument(output);
        await finishStoredTask(id, "succeeded", {
          id, status: "succeeded", benchmark: "custom", evaluation_source: "direct-model",
          result: {
            html, format, text: html ? "" : output.slice(0, 500_000), prompt,
            duration_ms: Date.now() - started,
            input_tokens: Number(usage?.input_tokens ?? usage?.prompt_tokens) || 0,
            output_tokens: Number(usage?.output_tokens ?? usage?.completion_tokens) || 0,
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
